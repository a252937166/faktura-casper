import { spawn } from "node:child_process";
import { config, type Persona } from "./config.js";
import { showcaseChain } from "./chain-showcase.js";

/** Result of a livenet CLI invocation. */
export interface ChainResult<T = unknown> {
  result: T;
  /** Deploy hashes observed in the client log output (explorer-linkable). */
  deployHashes: string[];
  raw: string;
}

/**
 * A livenet invocation that FAILED — including an on-chain revert, which is
 * still a real, explorer-linkable transaction. Callers that expect a revert
 * (the policy firewall) need the hash of the transaction that just failed,
 * not only the error text.
 */
export class LivenetError extends Error {
  deployHashes: string[];
  constructor(message: string, deployHashes: string[]) {
    super(message);
    this.name = "LivenetError";
    this.deployHashes = deployHashes;
  }
}

/**
 * Runs the Rust livenet ops binary (contracts/bin/livenet.rs) with the key of
 * the given persona and parses the `RESULT {...}` line. All transaction
 * construction / signing / waiting stays inside the audited Odra host.
 */
/**
 * Live progress channel for the CURRENTLY running livenet call (the judge
 * desk signs one step at a time, so a single sink is enough). Streams two
 * kinds of signal parsed from the CLI's output: a human phase note, and the
 * deploy hash the moment it appears — so the UI can show "submitted, waiting
 * for finality" with a clickable explorer link MINUTES before the step ends.
 */
type LiveProgress = { phase?: string; txHash?: string };
let progressSink: ((p: LiveProgress) => void) | null = null;
export function setLiveProgressSink(fn: ((p: LiveProgress) => void) | null) {
  progressSink = fn;
}

/** For non-livenet signers (the x402 native transfer) to feed the same UI. */
export function emitLiveProgress(p: LiveProgress) {
  progressSink?.(p);
}

/** Tracks the REAL tx hash across CLI output lines. The only full-hex
 * occurrence of it before finality is the `"hash"` field of the signed
 * transaction's debug dump (the `[WATCHER]` line abbreviates hashes, and the
 * first bare hex in the stream is the contract PACKAGE hash — linking that
 * was a real bug: a stable, explorer-dead address shown on every run). */
export type ProgressTrack = { hash: string | null; announced: boolean };

/** The tx hash as reported by the client's own success/failure log line —
 * the only hex in the stream whose MEANING is unambiguous. At debug level
 * the client also dumps query traffic (state roots, block hashes) after the
 * execution report, so "last hex wins" does not hold anymore. */
export function finalTxHash(raw: string): string | undefined {
  const m =
    /(?:Deploy(?:\s+V1)?|Transaction)\s+"([0-9a-f]{64})"\s+(?:successfully executed|failed with error)/.exec(
      raw,
    );
  return m?.[1];
}

export function parseProgressLine(line: string, track: ProgressTrack) {
  if (!progressSink) return;
  // `"hash": "<64hex>"` — the signed transaction's own hash (debug JSON dump,
  // printed just before submission). Remember it; announce only once the
  // watcher confirms the node accepted it.
  const built = /^\s*"hash"\s*:\s*"([0-9a-f]{64})"/.exec(line);
  if (built && !track.hash) {
    track.hash = built[1];
    progressSink({ phase: "signed — submitting to the network" });
    return;
  }
  if (/Calling\s+"/.test(line)) {
    progressSink({ phase: "building & signing the transaction" });
  } else if (/Starting to monitor for transaction/i.test(line) && track.hash && !track.announced) {
    track.announced = true;
    progressSink({ txHash: track.hash, phase: "submitted — waiting for on-chain finality" });
  } else if (/WATCHER|Monitoring|event/i.test(line)) {
    progressSink({ phase: "submitted — waiting for on-chain finality" });
  }
}

export async function livenet<T = unknown>(
  persona: Persona,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<ChainResult<T>> {
  const env = {
    ...process.env,
    ODRA_CASPER_LIVENET_SECRET_KEY_PATH: config.keys[persona],
    ODRA_CASPER_LIVENET_NODE_ADDRESS: config.nodeAddress,
    ODRA_CASPER_LIVENET_CHAIN_NAME: config.chainName,
    ODRA_CASPER_LIVENET_EVENTS_URL: config.eventsUrl,
    // debug is the ONLY level at which the client reveals the full tx hash
    // BEFORE finality (the signed transaction dump) — the live progress UI
    // links the explorer from it while the deploy is still settling.
    ODRA_LOG_LEVEL: process.env.ODRA_LOG_LEVEL ?? "debug",
  };

  return new Promise((resolve, reject) => {
    const child = spawn(config.livenetBin, args, { env });
    let out = "";
    let err = "";
    const track: ProgressTrack = { hash: null, announced: false };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // The deploy may already be submitted — surface the TRACKED tx hash so
      // the caller can reconcile instead of double-signing on retry.
      reject(
        new Error(
          `livenet ${args[0]} timed out` +
            (track.hash ? ` (submitted tx ${track.hash} may still land on-chain)` : ""),
        ),
      );
    }, opts.timeoutMs ?? 240_000);
    let outBuf = "";
    let errBuf = "";
    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      out += chunk;
      outBuf += chunk;
      let nl;
      while ((nl = outBuf.indexOf("\n")) >= 0) {
        parseProgressLine(outBuf.slice(0, nl), track);
        outBuf = outBuf.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      err += chunk;
      errBuf += chunk;
      let nl;
      while ((nl = errBuf.indexOf("\n")) >= 0) {
        parseProgressLine(errBuf.slice(0, nl), track);
        errBuf = errBuf.slice(nl + 1);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const raw = out + "\n" + err;
      // The ONLY trustworthy sources for the tx hash: the client's own
      // execution-report line, then the signed-transaction dump. A bare hex
      // scan is meaningless at debug level — the stream is full of state
      // roots, block hashes and argument bytes.
      const tx = finalTxHash(raw) ?? track.hash;
      if (code !== 0) {
        // A revert exits non-zero but its transaction DID land — keep the
        // hash so the caller can link the failed deploy on the explorer.
        reject(
          new LivenetError(
            `livenet ${args.join(" ")} failed (${code}):\n${raw.slice(-2000)}`,
            tx ? [tx] : [],
          ),
        );
        return;
      }
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) {
        reject(new Error(`livenet ${args[0]}: no RESULT line:\n${raw.slice(-2000)}`));
        return;
      }
      resolve({
        result: JSON.parse(line.slice("RESULT ".length)) as T,
        deployHashes: tx ? [tx] : [],
        raw,
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Serialized queues per persona: one in-flight transaction per account. */
const queues = new Map<Persona, Promise<unknown>>();

export function enqueue<T>(persona: Persona, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(persona) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(persona, next as Promise<unknown>);
  return next;
}

// ---- Typed helpers -------------------------------------------------------

export interface ChainInvoice {
  id: number;
  supplier: string;
  debtorTag: string;
  docHash: string;
  faceValue: string;
  dueTs: number;
  riskScore: number;
  discountBps: number;
  decisionHash: string;
  state: number;
  advance: string;
  registeredTs: number;
  fundedTs: number;
  closedTs: number;
}

export interface ChainStats {
  liquid: string;
  deployed: string;
  totalShares: string;
  totalFunded: string;
  totalSettled: string;
  totalDefaulted: string;
  invoiceCount: number;
  attestationCount: number;
}

export interface ChainPolicy {
  maxRiskScore: number;
  minDiscountBps: number;
  maxDiscountBps: number;
  maxSingleInvoiceBps: number;
  maxDebtorExposureBps: number;
}

const realChain = {
  stats: () => livenet<ChainStats>("agent", ["stats", config.contract]).then((r) => r.result),

  invoices: (from = 1, count = 200) =>
    livenet<ChainInvoice[]>("agent", [
      "invoices",
      config.contract,
      String(from),
      String(count),
    ]).then((r) => r.result),

  invoice: (id: number) =>
    livenet<ChainInvoice | null>("agent", ["invoice", config.contract, String(id)]).then(
      (r) => r.result,
    ),

  register: (a: {
    supplier: string;
    debtorTag: string;
    docHash: string;
    faceMotes: string;
    dueTs: number;
    risk: number;
    discountBps: number;
    decisionHash: string;
  }) =>
    enqueue("agent", () =>
      livenet<{ invoiceId: number }>("agent", [
        "register",
        config.contract,
        a.supplier,
        a.debtorTag,
        a.docHash,
        a.faceMotes,
        String(a.dueTs),
        String(a.risk),
        String(a.discountBps),
        a.decisionHash,
      ]),
    ),

  fund: (id: number) =>
    enqueue("agent", () =>
      livenet<{ funded: number }>("agent", ["fund", config.contract, String(id)]),
    ),

  settle: (id: number, amountMotes: string) =>
    enqueue("debtor", () =>
      livenet<{ settled: number }>("debtor", ["settle", config.contract, String(id), amountMotes]),
    ),

  // Defaults are written off by the COLLECTOR key — the underwriter key has no
  // mark_default permission on-chain (separation of duties, see set_agents).
  markDefault: (id: number) =>
    enqueue("collector", () =>
      livenet<{ defaulted: number }>("collector", ["default", config.contract, String(id)]),
    ),

  deposit: (amountMotes: string) =>
    enqueue("investor", () =>
      livenet<{ deposited: string }>("investor", ["deposit", config.contract, amountMotes]),
    ),

  attest: (
    kind: string,
    subjectId: number,
    payloadHash: string,
    model: string,
    persona: Persona = "agent",
  ) =>
    enqueue(persona, () =>
      livenet<{ attestationId: number }>(persona, [
        "attest",
        config.contract,
        kind,
        String(subjectId),
        payloadHash,
        model,
      ]),
    ),

  policy: () => livenet<ChainPolicy>("agent", ["policy", config.contract]).then((r) => r.result),

  caller: (persona: Persona) =>
    livenet<{ caller: string }>(persona, ["caller"]).then((r) => r.result.caller),
};

/**
 * In showcase mode the app runs on a public host with no Rust livenet binary
 * and no secret keys: reads are served from a real captured seed and writes are
 * simulated in-memory. Otherwise every call drives the audited Odra livenet host.
 */
export const chain = config.showcase ? (showcaseChain as unknown as typeof realChain) : realChain;
