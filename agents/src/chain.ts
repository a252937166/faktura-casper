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
 * Runs the Rust livenet ops binary (contracts/bin/livenet.rs) with the key of
 * the given persona and parses the `RESULT {...}` line. All transaction
 * construction / signing / waiting stays inside the audited Odra host.
 */
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
  };

  return new Promise((resolve, reject) => {
    const child = spawn(config.livenetBin, args, { env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`livenet ${args[0]} timed out`));
    }, opts.timeoutMs ?? 240_000);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      const raw = out + "\n" + err;
      if (code !== 0) {
        reject(new Error(`livenet ${args.join(" ")} failed (${code}):\n${raw.slice(-2000)}`));
        return;
      }
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) {
        reject(new Error(`livenet ${args[0]}: no RESULT line:\n${raw.slice(-2000)}`));
        return;
      }
      const deployHashes = [...new Set(raw.match(/\b[0-9a-f]{64}\b/g) ?? [])].filter(
        (h) => !config.contract.includes(h),
      );
      resolve({
        result: JSON.parse(line.slice("RESULT ".length)) as T,
        deployHashes,
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
