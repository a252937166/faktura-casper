/**
 * Live Testnet Judge Mode — the finals-round orchestrator.
 *
 * A judge opens the site, clicks one preset, and every step signs a REAL Casper
 * Testnet transaction with an explorer link. This is the answer to the finals
 * feedback ("complete and real workflow on Testnet instead of 'simulated'"):
 * it drives the SAME tested code paths as `npm run e2e` (processIntake +
 * chain.* + the x402 buyer), but productionised behind a controlled, rate-
 * limited, preset-only HTTP surface so a public host can sign real value safely.
 *
 * Mounted only when FAKTURA_JUDGE=1 and NOT in showcase mode (real keys +
 * livenet binary required). The public showcase (:4030) is untouched.
 */
import { Router, type Request, type Response } from "express";
import { config } from "./config.js";
import { chain } from "./chain.js";
import { processIntake, type IntakeInput } from "./underwriter.js";
import { nativeTransfer, queryBalance, personaPublicKeyHex } from "./native-transfer.js";
import { feed, type FeedEvent } from "./feed.js";

const CSPR = 1_000_000_000n;
const toMotes = (c: number) => BigInt(Math.round(c * 1e9)).toString();
const cspr = (motes: string | bigint) => Number(BigInt(motes) / 1_000_000n) / 1000;
const explorer = config.explorerBase;
const deployUrl = (h?: string) => (h ? `${explorer}/deploy/${h}` : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- run / step model -------------------------------------------------------

type StepStatus =
  "pending" | "signing" | "submitted" | "confirmed" | "reverted" | "skipped" | "failed";

interface JudgeStep {
  key: string;
  actor: string;
  title: string;
  status: StepStatus;
  txHash?: string;
  explorerUrl?: string;
  result?: string;
  /** Three-line annotation shown when a judge expands the row. */
  what?: string;
  who?: string;
  why?: string;
  startedTs?: number;
  endedTs?: number;
}

interface PoolSnap {
  liquid: number;
  deployed: number;
  totalFunded: number;
  totalSettled: number;
  totalDefaulted: number;
  invoiceCount: number;
}

interface JudgeRun {
  runId: string;
  preset: string;
  status: "running" | "done" | "failed";
  steps: JudgeStep[];
  startedTs: number;
  endedTs?: number;
  error?: string;
  note?: string;
  poolBefore?: PoolSnap;
  poolAfter?: PoolSnap;
}

const runs = new Map<string, JudgeRun>();
const runOrder: string[] = [];
let seq = 0;

function newRunId(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
  seq += 1;
  return `JUDGE-${ymd}-${String(seq).padStart(3, "0")}`;
}

function step(run: JudgeRun, key: string): JudgeStep {
  const s = run.steps.find((x) => x.key === key);
  if (!s) throw new Error(`unknown step ${key}`);
  return s;
}
function begin(run: JudgeRun, key: string, status: StepStatus = "signing") {
  const s = step(run, key);
  s.status = status;
  s.startedTs = Date.now();
  return s;
}
function done(run: JudgeRun, key: string, status: StepStatus, result: string, txHash?: string) {
  const s = step(run, key);
  s.status = status;
  s.result = result;
  if (txHash) {
    s.txHash = txHash;
    s.explorerUrl = deployUrl(txHash);
  }
  s.endedTs = Date.now();
  return s;
}

async function snap(): Promise<PoolSnap> {
  const s = await chain.stats();
  return {
    liquid: cspr(s.liquid),
    deployed: cspr(s.deployed),
    totalFunded: cspr(s.totalFunded),
    totalSettled: cspr(s.totalSettled),
    totalDefaulted: cspr(s.totalDefaulted),
    invoiceCount: s.invoiceCount,
  };
}

/**
 * The livenet `stats` read spawns the Rust CLI cold (~60–70 s on testnet), far
 * too slow for a health endpoint the UI polls and gates the Run button on. Cache
 * the pool snapshot with a TTL and warm it at boot so health returns in ~1–2 s
 * (just the fast RPC balance queries).
 */
let poolCache: { ts: number; snap: PoolSnap | null; ok: boolean } = {
  ts: 0,
  snap: null,
  ok: false,
};
let poolInflight: Promise<void> | null = null;
async function cachedPool(ttlMs = 45_000): Promise<{ snap: PoolSnap | null; ok: boolean }> {
  const fresh = Date.now() - poolCache.ts < ttlMs;
  if (fresh && poolCache.snap) return { snap: poolCache.snap, ok: poolCache.ok };
  if (!poolInflight) {
    poolInflight = snap()
      .then((s) => {
        poolCache = { ts: Date.now(), snap: s, ok: true };
      })
      .catch(() => {
        poolCache = { ts: Date.now(), snap: poolCache.snap, ok: false };
      })
      .finally(() => {
        poolInflight = null;
      });
  }
  // If we have any prior snapshot, return it immediately and let the refresh run
  // in the background; only block when we have nothing at all (cold start).
  if (poolCache.snap) return { snap: poolCache.snap, ok: poolCache.ok };
  await poolInflight;
  return { snap: poolCache.snap, ok: poolCache.ok };
}

/** Balance query with a hard timeout so a slow RPC can never hang health. */
async function balanceWithTimeout(pubHex: string, ms = 12_000): Promise<number | null> {
  return Promise.race([
    queryBalance(pubHex).then((b) => cspr(b.toString())),
    new Promise<number | null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// ---- preset step templates --------------------------------------------------

const PERSONAS = ["agent", "collector", "supplier", "investor", "debtor"] as const;

function happySteps(): JudgeStep[] {
  return [
    {
      key: "liquidity",
      actor: "investor",
      title: "Ensure pool liquidity",
      status: "pending",
      what: "Top up the native-CSPR pool if it is low.",
      who: "Investor (LP) key",
      why: "Funding an advance needs liquid CSPR; LP shares mint at the current share price.",
    },
    {
      key: "submit",
      actor: "supplier",
      title: "Submit a clean invoice",
      status: "pending",
      what: "A real receivable enters intake.",
      who: "Demo supplier",
      why: "This is the raw input the autonomous underwriter must judge.",
    },
    {
      key: "underwrite",
      actor: "underwriter",
      title: "AI underwriter scores risk",
      status: "pending",
      what: "Deterministic pre-checks, then an LLM returns a risk score, price and rationale.",
      who: "Autonomous underwriter agent",
      why: "The model proposes; the chain disposes — every decision memo is hashed.",
    },
    {
      key: "policy",
      actor: "underwriter",
      title: "Policy guardrails applied",
      status: "pending",
      what: "Risk ceiling and discount band clamp the model output.",
      who: "Underwriter policy layer",
      why: "The agent can never price outside the contract's hard caps.",
    },
    {
      key: "register",
      actor: "underwriter",
      title: "Register invoice on-chain",
      status: "pending",
      what: "register_invoice writes the receivable with the decision hash.",
      who: "Underwriter agent key",
      why: "The receivable now exists on Casper Testnet, tamper-evident.",
    },
    {
      key: "fund",
      actor: "underwriter",
      title: "Pool funds the supplier",
      status: "pending",
      what: "fund_invoice streams the advance from the pool to the supplier.",
      who: "Underwriter agent key",
      why: "Capital moves autonomously — to the supplier account, never the debtor.",
    },
    {
      key: "attest",
      actor: "underwriter",
      title: "Anchor the AI decision",
      status: "pending",
      what: "The SHA-256 of the full decision memo is attested on-chain.",
      who: "Underwriter agent key",
      why: "Autonomous underwriting you can audit later against the memo.",
    },
    {
      key: "x402",
      actor: "oracle",
      title: "Buyer purchases risk report (x402)",
      status: "pending",
      what: "Another agent pays over HTTP 402 with native CSPR and gets the verified report.",
      who: "Buyer agent (debtor key)",
      why: "Machine-payable data — the agent economy, settled on-chain.",
    },
    {
      key: "settle",
      actor: "debtor",
      title: "Debtor settles the invoice",
      status: "pending",
      what: "settle_invoice repays face value; the pool realizes yield.",
      who: "Debtor key",
      why: "Closes the credit loop — the LP share price reflects the gain.",
    },
    {
      key: "accounting",
      actor: "system",
      title: "Pool accounting updated",
      status: "pending",
      what: "TVL, deployed and settled totals move.",
      who: "Contract state",
      why: "The whole run is visible in one on-chain balance sheet.",
    },
  ];
}

function policyBlockSteps(): JudgeStep[] {
  return [
    {
      key: "liquidity",
      actor: "investor",
      title: "Ensure pool liquidity",
      status: "pending",
      what: "Make sure the pool holds CSPR so the advance clears the liquidity prefilter.",
      who: "Investor (LP) key",
      why: "We WANT this invoice to reach the chain, so it must pass the off-chain liquidity sanity check first.",
    },
    {
      key: "submit",
      actor: "supplier",
      title: "Submit an oversized invoice",
      status: "pending",
      what: "A clean but deliberately large receivable — sized above the on-chain single-invoice cap.",
      who: "Demo supplier",
      why: "The amount is computed from live pool value so the advance exceeds the concentration limit.",
    },
    {
      key: "underwrite",
      actor: "underwriter",
      title: "AI underwriter APPROVES",
      status: "pending",
      what: "The model likes the counterparties and approves the invoice.",
      who: "Autonomous underwriter agent",
      why: "This is the whole point: a model-approved invoice about to hit a hard limit.",
    },
    {
      key: "policy",
      actor: "underwriter",
      title: "Off-chain checks pass",
      status: "pending",
      what: "Risk/discount are in band and the advance is below total liquidity.",
      who: "Underwriter policy layer",
      why: "Concentration caps are deliberately NOT checked off-chain — they belong to the contract.",
    },
    {
      key: "register",
      actor: "underwriter",
      title: "Register invoice on-chain",
      status: "pending",
      what: "register_invoice succeeds — the receivable is written.",
      who: "Underwriter agent key",
      why: "Registration is fine; the limit bites at funding.",
    },
    {
      key: "fund",
      actor: "underwriter",
      title: "Contract REJECTS funding",
      status: "pending",
      what: "fund_invoice reverts with User error 15 (SingleInvoiceCapExceeded).",
      who: "Underwriter agent key → contract",
      why: "The ace: a valid agent key with an AI approval still cannot exceed the on-chain policy. LLM proposes, contract disposes.",
    },
  ];
}

function x402Steps(): JudgeStep[] {
  return [
    {
      key: "prepare",
      actor: "underwriter",
      title: "Prepare a funded invoice",
      status: "pending",
      what: "Reuse the latest funded invoice, or fund a small one if none exists.",
      who: "Underwriter agent key",
      why: "A risk report only exists for an underwritten, funded receivable.",
    },
    {
      key: "challenge",
      actor: "oracle",
      title: "Request report → HTTP 402",
      status: "pending",
      what: "The oracle answers 402 Payment Required with an x402 PaymentRequirements + nonce.",
      who: "Faktura risk oracle",
      why: "Standard x402 wire format on casper-test — machine-payable by construction.",
    },
    {
      key: "pay",
      actor: "oracle",
      title: "Buyer settles on-chain",
      status: "pending",
      what: "The buyer signs a native CSPR transfer carrying the nonce as transfer id.",
      who: "Buyer agent (debtor key)",
      why: "Facilitator-less settlement — verifiable purely over RPC.",
    },
    {
      key: "report",
      actor: "oracle",
      title: "Verified report delivered",
      status: "pending",
      what: "The oracle verifies the transfer and returns the report with the on-chain decision hash.",
      who: "Faktura risk oracle",
      why: "The buyer gets data whose provenance is anchored on Casper.",
    },
  ];
}

function stepsFor(preset: string): JudgeStep[] {
  if (preset === "happy") return happySteps();
  if (preset === "policy-block") return policyBlockSteps();
  if (preset === "x402") return x402Steps();
  throw new Error(`unknown preset ${preset}`);
}

// ---- feed → live step motion (liveliness only; record is authoritative) -----

/**
 * While processIntake runs (one await that internally does register→fund→attest,
 * i.e. several testnet deploys), map its feed events onto step transitions so
 * the judge sees live motion. Tx hashes are reconciled from the returned record
 * afterwards, so a missed/renamed event never loses correctness.
 */
function attachIntakeFeed(run: JudgeRun): () => void {
  let onchainSeen = 0;
  const onEvent = (e: FeedEvent) => {
    try {
      if (e.kind === "intake") done(run, "submit", "confirmed", "Invoice received into intake");
      else if (e.kind === "llm") begin(run, "underwrite", "signing");
      else if (e.kind === "decision") {
        done(run, "underwrite", "confirmed", e.message.replace(/ —.*$/, ""));
        done(run, "policy", "confirmed", "Risk/discount within policy band");
      } else if (e.kind === "onchain") {
        onchainSeen += 1;
        if (/register/i.test(e.message) || onchainSeen === 1)
          done(run, "register", "confirmed", "Invoice registered on Casper Testnet", e.deployHash);
        else done(run, "fund", "confirmed", "Advance streamed to supplier", e.deployHash);
      } else if (e.kind === "policy_block") {
        // handled authoritatively from the record; mark motion here
        begin(run, "fund", "submitted");
      } else if (e.kind === "attest") {
        done(run, "attest", "confirmed", "Decision memo hash anchored", e.deployHash);
      }
    } catch {
      /* unknown step for this preset — ignore */
    }
  };
  feed.on("event", onEvent);
  return () => feed.off("event", onEvent);
}

// ---- the buyer flow (x402), in-process against our own risk route -----------

async function x402Buy(
  run: JudgeRun,
  invoiceId: number,
  keys: { challenge: string; pay: string; report: string },
): Promise<void> {
  const base = `http://127.0.0.1:${config.port}`;
  begin(run, keys.challenge, "signing");
  const first = await fetch(`${base}/api/risk/${invoiceId}`);
  if (first.status !== 402) {
    const t = await first.text();
    throw new Error(`expected 402 challenge, got ${first.status}: ${t.slice(0, 160)}`);
  }
  const offer = ((await first.json()) as any).accepts[0];
  const nonce: string = offer.extra.transferIdNonce;
  done(run, keys.challenge, "confirmed", `402 — ${cspr(offer.maxAmountRequired)} CSPR to oracle`);

  begin(run, keys.pay, "signing");
  const proof = await nativeTransfer({
    fromKeyPath: config.keys.debtor,
    to: offer.payTo,
    motes: offer.maxAmountRequired,
    id: nonce,
  });
  done(run, keys.pay, "submitted", "Buyer transfer submitted; awaiting finality", proof);

  begin(run, keys.report, "signing");
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const retry = await fetch(`${base}/api/risk/${invoiceId}`, {
      headers: { "PAYMENT-SIGNATURE": proof, "PAYMENT-NONCE": nonce },
    });
    if (retry.status === 200) {
      const rep = (await retry.json()) as any;
      done(run, keys.pay, "confirmed", "Buyer payment settled on-chain", proof);
      done(
        run,
        keys.report,
        "confirmed",
        `Report delivered — risk ${rep.riskScore}, decision ${String(rep.decisionHash).slice(0, 18)}…`,
      );
      return;
    }
  }
  throw new Error("x402 payment did not settle within ~2.5 min");
}

// ---- preset orchestrations --------------------------------------------------

const day = 86_400_000;

async function runHappy(run: JudgeRun): Promise<void> {
  // 1) liquidity
  begin(run, "liquidity");
  const before = await chain.stats();
  if (cspr(before.liquid) >= 40) {
    done(run, "liquidity", "confirmed", `Pool already liquid: ${cspr(before.liquid)} CSPR`);
  } else {
    const dep = await chain.deposit(toMotes(60));
    done(run, "liquidity", "confirmed", "Deposited 60 CSPR into the pool", dep.deployHashes.at(-1));
  }

  // 2-7) submit → underwrite → policy → register → fund → attest (one pipeline)
  begin(run, "submit", "signing");
  begin(run, "underwrite", "pending");
  const detach = attachIntakeFeed(run);
  let rec;
  try {
    rec = await processIntake({
      supplierName: "Nordwind Logistics GmbH",
      debtorName: "Aurora Retail AG",
      amountCspr: 12,
      dueTs: Date.now() + 30 * day,
      invoiceNumber: `JUDGE-${run.runId}`,
      description: "Freight services, 14 pallet shipments Hamburg to Vienna",
      history: "6 prior invoices, all paid within terms",
    });
  } finally {
    detach();
  }
  // reconcile authoritative tx hashes from the record
  if (rec.chain.registerHash)
    done(
      run,
      "register",
      "confirmed",
      "Invoice registered on Casper Testnet",
      rec.chain.registerHash,
    );
  if (rec.status === "funded") {
    done(run, "fund", "confirmed", "Advance streamed to supplier", rec.chain.fundHash);
    if (rec.chain.attestHashes.at(-1))
      done(
        run,
        "attest",
        "confirmed",
        "Decision memo hash anchored",
        rec.chain.attestHashes.at(-1),
      );
    else done(run, "attest", "submitted", "Attestation retrying (advance already on-chain)");
  } else if (rec.status === "policy_blocked") {
    done(run, "fund", "reverted", rec.chain.fundError ?? "Funding blocked by contract policy");
    done(run, "attest", "skipped", "Skipped — invoice was not funded");
  } else {
    // AI rejected — unusual for this clean invoice, but keep it honest
    done(run, "fund", "skipped", `Not funded (status ${rec.status})`);
    done(run, "attest", "confirmed", "Rejection memo anchored", rec.chain.attestHashes.at(-1));
    throw new Error(`clean invoice unexpectedly ${rec.status}`);
  }

  // 8) x402 purchase against the funded invoice
  if (rec.status === "funded" && rec.id > 0) {
    await x402Buy(run, rec.id, { challenge: "x402", pay: "x402", report: "x402" });
  } else {
    done(run, "x402", "skipped", "Skipped — no funded invoice to price");
  }

  // 9) settle
  if (rec.status === "funded" && rec.id > 0) {
    begin(run, "settle", "signing");
    const st = await chain.settle(rec.id, toMotes(rec.intake.amountCspr));
    done(
      run,
      "settle",
      "confirmed",
      `Debtor paid ${rec.intake.amountCspr} CSPR face value`,
      st.deployHashes.at(-1),
    );
  } else {
    done(run, "settle", "skipped", "Skipped — nothing to settle");
  }

  // 10) accounting
  begin(run, "accounting", "signing");
  const after = await snap();
  run.poolAfter = after;
  done(
    run,
    "accounting",
    "confirmed",
    `liquid ${after.liquid} · deployed ${after.deployed} · settled ${after.totalSettled} CSPR · ${after.invoiceCount} invoices`,
  );
}

async function runPolicyBlock(run: JudgeRun): Promise<void> {
  // 1) liquidity — need a known pool so the advance clears liquidity but exceeds the cap
  begin(run, "liquidity");
  let stats = await chain.stats();
  if (cspr(stats.liquid) < 30) {
    const dep = await chain.deposit(toMotes(60));
    done(run, "liquidity", "confirmed", "Deposited 60 CSPR into the pool", dep.deployHashes.at(-1));
    stats = await chain.stats();
  } else {
    done(run, "liquidity", "confirmed", `Pool liquid: ${cspr(stats.liquid)} CSPR`);
  }

  // Size the face from live pool value + the on-chain single-invoice cap so the
  // advance lands above the cap (revert) yet below total liquidity (clears the
  // off-chain prefilter). Robust across the AI's discount choice (<=25%).
  const liquid = cspr(stats.liquid);
  const policy = await chain.policy().catch(() => ({ maxSingleInvoiceBps: 5000 }) as any);
  const capFrac = (policy.maxSingleInvoiceBps ?? 5000) / 10000; // e.g. 0.5
  // face ≈ 0.9 * liquid → worst-case advance (25% discount) ≈ 0.675*face = 0.6*liquid > cap;
  // best-case advance (~0.5% discount) ≈ 0.9*liquid < liquid (prefilter ok).
  const faceCspr = Math.max(
    Math.ceil(((capFrac + 0.12) * liquid) / 0.75) + 1, // guarantee > cap even at max discount
    Math.round(0.9 * liquid),
  );
  run.note = `Pool ${liquid} CSPR · single-invoice cap ${(capFrac * 100).toFixed(0)}% → face ${faceCspr} CSPR (advance will exceed the cap on-chain).`;

  begin(run, "submit", "signing");
  begin(run, "underwrite", "pending");
  const detach = attachIntakeFeed(run);
  let rec;
  try {
    rec = await processIntake({
      supplierName: "Baltic Freight Union",
      debtorName: "Aurora Retail AG",
      amountCspr: faceCspr,
      dueTs: Date.now() + 45 * day,
      invoiceNumber: `JUDGE-${run.runId}`,
      description: "Bulk logistics settlement, consolidated quarterly receivable",
      history: "8 prior invoices, all paid within terms, long-standing counterparty",
    });
  } finally {
    detach();
  }
  if (rec.chain.registerHash)
    done(
      run,
      "register",
      "confirmed",
      "Invoice registered on Casper Testnet",
      rec.chain.registerHash,
    );
  if (rec.status === "policy_blocked") {
    done(
      run,
      "fund",
      "reverted",
      rec.chain.fundError ?? "User error: 15 (SingleInvoiceCapExceeded)",
    );
  } else if (rec.status === "funded") {
    // Pool was larger than expected and the advance fit — settle it back so we
    // don't leave capital deployed, and report honestly that no revert occurred.
    done(
      run,
      "fund",
      "confirmed",
      "Advance funded (pool was large enough — no revert this run)",
      rec.chain.fundHash,
    );
    run.note =
      (run.note ?? "") +
      " NOTE: the pool exceeded the estimate so the advance fit under the cap; re-run to see the revert.";
    if (rec.id > 0) await chain.settle(rec.id, toMotes(rec.intake.amountCspr)).catch(() => {});
  } else {
    done(run, "fund", "skipped", `Not funded (status ${rec.status}) — AI rejected before the cap`);
    throw new Error(`policy-block invoice was ${rec.status}, expected approve→revert`);
  }
}

async function runX402(run: JudgeRun): Promise<void> {
  // 1) locate a funded invoice; if none, fund a small one first
  begin(run, "prepare", "signing");
  let invId = 0;
  try {
    const onchain = await chain.invoices(1, 200);
    const funded = onchain.filter((i) => i.state === 1); // FUNDED
    if (funded.length) invId = funded[funded.length - 1].id;
  } catch {
    /* fall through to fresh fund */
  }
  if (!invId) {
    const before = await chain.stats();
    if (cspr(before.liquid) < 20) await chain.deposit(toMotes(40));
    const rec = await processIntake({
      supplierName: "Helios Solar Kft",
      debtorName: "Metro Utilities Zrt",
      amountCspr: 10,
      dueTs: Date.now() + 30 * day,
      invoiceNumber: `JUDGE-${run.runId}`,
      description: "Panel maintenance, Q1 service contract",
      history: "3 prior invoices paid on time",
    });
    if (rec.status !== "funded")
      throw new Error(`could not prepare a funded invoice (${rec.status})`);
    invId = rec.id;
  }
  done(run, "prepare", "confirmed", `Using funded invoice #${invId}`);

  // 2-4) challenge → pay → report
  await x402Buy(run, invId, { challenge: "challenge", pay: "pay", report: "report" });
}

async function orchestrate(run: JudgeRun): Promise<void> {
  run.poolBefore = await snap().catch(() => undefined);
  if (run.preset === "happy") await runHappy(run);
  else if (run.preset === "policy-block") await runPolicyBlock(run);
  else if (run.preset === "x402") await runX402(run);
  if (!run.poolAfter) run.poolAfter = await snap().catch(() => undefined);
}

// ---- health -----------------------------------------------------------------

const FLOORS: Record<string, number> = {
  agent: 8,
  collector: 8,
  supplier: 2,
  investor: 40,
  debtor: 40,
};

async function health() {
  const balances: Record<string, number | null> = {};
  let rpcOk = true;
  await Promise.all(
    PERSONAS.map(async (p) => {
      let hex: string;
      try {
        hex = personaPublicKeyHex(p);
      } catch {
        balances[p] = null; // key missing on this host
        return;
      }
      const bal = await balanceWithTimeout(hex);
      balances[p] = bal;
      if (bal == null) rpcOk = false;
    }),
  );
  const { snap: pool, ok: contractOk } = await cachedPool();
  const low = PERSONAS.filter((p) => balances[p] != null && (balances[p] as number) < FLOORS[p]);
  const paused = !rpcOk || !contractOk || low.length > 0;
  const last = runOrder.at(-1);
  return {
    mode: "live-testnet" as const,
    contract: config.contract,
    explorer,
    chain: config.chainName,
    node: config.nodeAddress,
    balances,
    floors: FLOORS,
    low,
    rpcOk,
    contractOk,
    paused,
    pool,
    x402Price: config.x402.priceMotes,
    lastRun: last ? (runs.get(last) ?? null) : null,
    busy: RUNNING,
  };
}

// ---- rate limiting / single-flight -----------------------------------------

let RUNNING = false;
const COOLDOWN_MS = 10 * 60_000;
const lastByIp = new Map<string, number>();

function clientIp(req: Request): string {
  const xf = (req.headers["x-forwarded-for"] as string) ?? "";
  return xf.split(",")[0].trim() || req.ip || "unknown";
}

// ---- router -----------------------------------------------------------------

export function makeJudgeRouter(): Router {
  const r = Router();
  // Warm the pool cache in the background so the first health call is fast.
  cachedPool().catch(() => {});

  r.get("/health", async (_req, res) => {
    try {
      res.json(await health());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message, mode: "live-testnet", paused: true });
    }
  });

  r.get("/presets", (_req, res) => {
    res.json([
      {
        id: "happy",
        title: "Happy path — full lifecycle",
        blurb: "Submit → AI underwrite → register → fund → attest → x402 purchase → settle.",
        est: "6–10 min",
        steps: happySteps().map((s) => ({ key: s.key, actor: s.actor, title: s.title })),
      },
      {
        id: "policy-block",
        title: "Policy firewall — AI approved, contract rejects",
        blurb: "An oversized invoice: the AI approves, the contract reverts funding on-chain.",
        est: "3–5 min",
        steps: policyBlockSteps().map((s) => ({ key: s.key, actor: s.actor, title: s.title })),
      },
      {
        id: "x402",
        title: "x402 — machine-payable risk report",
        blurb: "A buyer agent pays over HTTP 402 with native CSPR for the verified report.",
        est: "2–4 min",
        steps: x402Steps().map((s) => ({ key: s.key, actor: s.actor, title: s.title })),
      },
    ]);
  });

  r.get("/runs", (_req, res) => {
    res.json(
      runOrder
        .slice(-10)
        .reverse()
        .map((id) => runs.get(id)),
    );
  });

  r.get("/run/:id", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json(run);
  });

  r.post("/run", async (req, res) => {
    const preset = String(req.body?.preset ?? "").trim();
    if (!["happy", "policy-block", "x402"].includes(preset)) {
      res.status(400).json({ error: "preset must be happy | policy-block | x402" });
      return;
    }
    if (RUNNING) {
      res
        .status(429)
        .json({
          error: "A live run is already in progress — please wait for it to finish.",
          busy: true,
        });
      return;
    }
    // health gate: never start a run we can't finish
    const h = await health().catch(() => null);
    if (!h || h.paused) {
      res.status(503).json({
        error:
          "Live judge mode is temporarily paused — testnet keys need a top-up or the node is unreachable.",
        paused: true,
        health: h,
      });
      return;
    }
    const ip = clientIp(req);
    const last = lastByIp.get(ip) ?? 0;
    const waitMs = COOLDOWN_MS - (Date.now() - last);
    if (waitMs > 0) {
      res.status(429).json({
        error: `Rate limited — one live run per 10 minutes. Try again in ${Math.ceil(waitMs / 60000)} min.`,
        retryAfterMs: waitMs,
      });
      return;
    }

    // start
    RUNNING = true;
    lastByIp.set(ip, Date.now());
    const run: JudgeRun = {
      runId: newRunId(),
      preset,
      status: "running",
      steps: stepsFor(preset),
      startedTs: Date.now(),
    };
    runs.set(run.runId, run);
    runOrder.push(run.runId);
    if (runOrder.length > 50) runs.delete(runOrder.shift() as string);

    // fire-and-forget; the client polls /run/:id
    orchestrate(run)
      .then(() => {
        run.status = "done";
      })
      .catch((e) => {
        run.status = "failed";
        run.error = (e as Error).message.slice(0, 400);
        const active = run.steps.find((s) => s.status === "signing" || s.status === "submitted");
        if (active) done(run, active.key, "failed", (e as Error).message.slice(0, 160));
      })
      .finally(() => {
        run.endedTs = Date.now();
        RUNNING = false;
      });

    res.status(202).json({ runId: run.runId, preset });
  });

  return r;
}
