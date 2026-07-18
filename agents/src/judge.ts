/**
 * Live Testnet Judge Mode — a guided, STEP-BY-STEP walkthrough.
 *
 * The finals judge asked for a real, clickable Casper Testnet workflow — but a
 * single click that then blocks for 6–10 minutes is a poor experience. So this
 * exposes the lifecycle as individual steps: the judge clicks one step, it signs
 * exactly ONE transaction (~30–120 s, or instant for the off-chain AI step),
 * shows the result + explorer link, and unlocks the next step. Short waits, real
 * transactions, full control over the pace.
 *
 * It drives the SAME tested code paths as `npm run e2e` (the LLM underwriter +
 * chain.* + the x402 buyer) behind a controlled, preset-only surface. Mounted
 * only when FAKTURA_JUDGE=1 and NOT in showcase mode. The public showcase (:4030)
 * is untouched.
 */
import crypto from "node:crypto";
import { Router, type Request } from "express";
import { config } from "./config.js";
import { chain } from "./chain.js";
import { underwrite as llmUnderwrite } from "./llm.js";
import { db, upsertInvoice, type InvoiceRecord } from "./store.js";
import { feed } from "./feed.js";
import { nativeTransfer, queryBalance, personaPublicKeyHex } from "./native-transfer.js";

const CSPR = 1_000_000_000n;
const toMotes = (c: number) => BigInt(Math.round(c * 1e9)).toString();
const cspr = (motes: string | bigint) => Number(BigInt(motes) / 1_000_000n) / 1000;
const explorer = config.explorerBase;
const deployUrl = (h?: string) => (h ? `${explorer}/deploy/${h}` : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const day = 86_400_000;

// ---- step / session model ---------------------------------------------------

type StepStatus = "locked" | "ready" | "running" | "done" | "reverted" | "failed";

interface JudgeStep {
  key: string;
  actor: string;
  title: string;
  /** one-line "what happens when you click this" */
  action: string;
  /** whether this step signs a Casper transaction (shows a wait hint) or is instant */
  kind: "compute" | "chain";
  status: StepStatus;
  txHash?: string;
  explorerUrl?: string;
  result?: string;
  what?: string;
  who?: string;
  why?: string;
  startedTs?: number;
  endedTs?: number;
}

interface StepDef extends Omit<JudgeStep, "status"> {
  run: (s: Session) => Promise<{ result: string; txHash?: string; reverted?: boolean }>;
}

interface Session {
  id: string;
  preset: string;
  title: string;
  subtitle: string;
  steps: JudgeStep[];
  defs: StepDef[];
  cursor: number; // index of the next runnable step
  status: "active" | "done" | "failed";
  startedTs: number;
  endedTs?: number;
  ip: string;
  note?: string;
  poolBefore?: PoolSnap;
  poolAfter?: PoolSnap;
  ctx: {
    record?: InvoiceRecord;
    invoiceId?: number;
    decisionHash?: string;
    amountCspr?: number;
    approved?: boolean;
    x402Nonce?: string;
    x402Proof?: string;
    /** Visitor's connected Casper wallet — the advance is paid HERE when set. */
    supplierOverride?: string;
  };
}

interface PoolSnap {
  liquid: number;
  deployed: number;
  totalFunded: number;
  totalSettled: number;
  totalDefaulted: number;
  invoiceCount: number;
}

const sessions = new Map<string, Session>();
const order: string[] = [];
let seq = 0;

function newId(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
  seq += 1;
  return `JUDGE-${ymd}-${String(seq).padStart(3, "0")}`;
}

function publicStep(d: StepDef, status: StepStatus): JudgeStep {
  const { run, ...rest } = d;
  return { ...rest, status };
}

function publicSession(s: Session) {
  return {
    id: s.id,
    preset: s.preset,
    title: s.title,
    subtitle: s.subtitle,
    steps: s.steps,
    cursor: s.cursor,
    status: s.status,
    startedTs: s.startedTs,
    endedTs: s.endedTs,
    note: s.note,
    poolBefore: s.poolBefore,
    poolAfter: s.poolAfter,
    wallet: s.ctx.supplierOverride ?? null,
    nextStep: s.cursor < s.steps.length ? s.steps[s.cursor] : null,
  };
}

// ---- pool snapshot + health (cached: livenet reads are ~60 s cold) ----------

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
  if (poolCache.snap) return { snap: poolCache.snap, ok: poolCache.ok };
  await poolInflight;
  return { snap: poolCache.snap, ok: poolCache.ok };
}

async function balanceWithTimeout(pubHex: string, ms = 12_000): Promise<number | null> {
  return Promise.race([
    queryBalance(pubHex).then((b) => cspr(b.toString())),
    new Promise<number | null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** On-chain single-invoice cap (bps), cached — policy is effectively static. */
let policyBpsCache: number | null = null;
async function cachedPolicyBps(): Promise<number> {
  if (policyBpsCache != null) return policyBpsCache;
  try {
    const p = await chain.policy();
    policyBpsCache = p.maxSingleInvoiceBps ?? 5000;
  } catch {
    policyBpsCache = 5000;
  }
  return policyBpsCache;
}

const PERSONAS = ["agent", "collector", "supplier", "investor", "debtor"] as const;
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
        balances[p] = null;
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
  const activeId = order.filter((id) => sessions.get(id)?.status === "active").at(-1);
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
    activeSession: activeId ? publicSession(sessions.get(activeId)!) : null,
  };
}

/**
 * Cached health so the polled endpoint and (critically) session creation return
 * instantly — the 5 balance RPC calls are the slow part. The frontend polls
 * every 30 s, keeping it warm; activeSession is patched in fresh so it never
 * goes stale.
 */
let healthCache: { ts: number; data: Awaited<ReturnType<typeof health>> | null } = {
  ts: 0,
  data: null,
};
let healthInflight: Promise<void> | null = null;
async function cachedHealth(ttlMs = 15_000) {
  const fresh = Date.now() - healthCache.ts < ttlMs;
  if (!fresh && !healthInflight) {
    healthInflight = health()
      .then((d) => {
        healthCache = { ts: Date.now(), data: d };
      })
      .catch(() => {})
      .finally(() => {
        healthInflight = null;
      });
  }
  if (!healthCache.data) await healthInflight; // cold start: must wait once
  const data = healthCache.data;
  if (!data) throw new Error("health unavailable");
  // always reflect the live active session
  const activeId = order.filter((id) => sessions.get(id)?.status === "active").at(-1);
  return { ...data, activeSession: activeId ? publicSession(sessions.get(activeId)!) : null };
}

// ---- underwriting (shared by the first step of the invoice presets) ---------

/** Fixed, preset-only demo invoices — no free-form input from the client. */
function intakeFor(preset: string, faceCspr: number, runId: string) {
  if (preset === "policy-block") {
    return {
      supplierName: "Baltic Freight Union",
      debtorName: "Aurora Retail AG",
      amountCspr: faceCspr,
      dueTs: Date.now() + 45 * day,
      invoiceNumber: runId,
      description: "Bulk logistics settlement, consolidated quarterly receivable",
      history: "8 prior invoices, all paid within terms, long-standing counterparty",
    };
  }
  return {
    supplierName: "Nordwind Logistics GmbH",
    debtorName: "Aurora Retail AG",
    amountCspr: faceCspr,
    dueTs: Date.now() + 30 * day,
    invoiceNumber: runId,
    description: "Freight services, 14 pallet shipments Hamburg to Vienna",
    history: "6 prior invoices, all paid within terms",
  };
}

async function doUnderwrite(s: Session): Promise<{ result: string; reverted?: boolean }> {
  // Size the face: happy path is small; policy-block is sized above the on-chain
  // single-invoice cap (from live pool value) so funding will revert on-chain.
  // Use the CACHED pool + policy (warmed at session creation) so this "instant"
  // step never blocks on a cold ~60 s livenet read.
  let faceCspr = 12;
  if (s.preset === "policy-block") {
    const liquid = (await cachedPool()).snap?.liquid ?? s.poolBefore?.liquid ?? 100;
    const capFrac = (await cachedPolicyBps()) / 10000;
    faceCspr = Math.max(
      Math.ceil(((capFrac + 0.12) * liquid) / 0.75) + 1,
      Math.round(0.9 * liquid),
    );
    s.note = `Pool ${liquid} CSPR · single-invoice cap ${(capFrac * 100).toFixed(0)}% → face ${faceCspr} CSPR. The advance will exceed the on-chain cap, so funding must revert.`;
  }
  const input = intakeFor(s.preset, faceCspr, s.id);
  const docHash = `sha256:${sha256(JSON.stringify(input))}`;
  const debtorTag = `debtor:${sha256(input.debtorName.toLowerCase()).slice(0, 16)}`;

  const { opinion, provider, model } = await llmUnderwrite({
    supplierName: input.supplierName,
    debtorName: input.debtorName,
    amountCspr: input.amountCspr,
    dueTs: input.dueTs,
    invoiceNumber: input.invoiceNumber,
    description: input.description,
    history: input.history,
  });

  // Policy clamp (tightest of TS prefilter + on-chain policy for discount/risk).
  const p = config.policy;
  let { approve, risk_score, discount_bps } = opinion;
  discount_bps = Math.max(p.minDiscountBps, Math.min(p.maxDiscountBps, discount_bps));
  if (risk_score > p.maxRiskScore) approve = false;

  const decisionHash = `sha256:${sha256(
    JSON.stringify({
      id: s.id,
      input,
      applied: { approve, risk_score, discount_bps },
      provider,
      model,
    }),
  )}`;

  const record: InvoiceRecord = {
    id: 0,
    intakeId: s.id,
    status: approve ? "approved" : "rejected",
    intake: {
      supplierName: input.supplierName,
      debtorName: input.debtorName,
      debtorTag,
      amountCspr: input.amountCspr,
      dueTs: input.dueTs,
      invoiceNumber: input.invoiceNumber,
      description: input.description,
      history: input.history,
      docHash,
      receivedTs: Date.now(),
    },
    decision: {
      approve,
      riskScore: risk_score,
      discountBps: discount_bps,
      rationale: opinion.rationale,
      redFlags: opinion.red_flags,
      policyNotes: [],
      model: "autonomous-ai-underwriter",
      decisionHash,
      decidedTs: Date.now(),
    },
    chain: { attestHashes: [] },
  };
  upsertInvoice(record);
  s.ctx.record = record;
  s.ctx.decisionHash = decisionHash;
  s.ctx.amountCspr = input.amountCspr;
  s.ctx.approved = approve;

  if (!approve) {
    return {
      result: `AI REJECTED — risk ${risk_score}/100 (${opinion.red_flags.join("; ") || "over policy"})`,
      reverted: true,
    };
  }
  return {
    result: `AI APPROVED — risk ${risk_score}/100, discount ${(discount_bps / 100).toFixed(2)}%, face ${input.amountCspr} CSPR. Decision hash ${decisionHash.slice(0, 20)}…`,
  };
}

// ---- step executors ---------------------------------------------------------

async function stepRegister(s: Session) {
  const r = s.ctx.record!;
  // If the visitor connected their Casper wallet, THEY are the supplier — the
  // advance lands in their own wallet. Otherwise the demo supplier receives it.
  const supplier = s.ctx.supplierOverride ?? (await chain.caller("supplier"));
  const reg = await chain.register({
    supplier,
    debtorTag: r.intake.debtorTag,
    docHash: r.intake.docHash,
    faceMotes: toMotes(r.intake.amountCspr),
    dueTs: r.intake.dueTs,
    risk: r.decision!.riskScore,
    discountBps: r.decision!.discountBps,
    decisionHash: r.decision!.decisionHash,
  });
  const tx = reg.deployHashes.at(-1);
  r.id = reg.result.invoiceId;
  r.chain.registerHash = tx;
  r.status = "approved";
  upsertInvoice(r);
  s.ctx.invoiceId = r.id;
  const who = s.ctx.supplierOverride
    ? ` — supplier: YOUR wallet ${s.ctx.supplierOverride.slice(0, 10)}…`
    : "";
  return { result: `Invoice #${r.id} registered on Casper Testnet${who}`, txHash: tx };
}

async function stepFund(s: Session) {
  const r = s.ctx.record!;
  try {
    const funded = await chain.fund(r.id);
    const tx = funded.deployHashes.at(-1);
    r.chain.fundHash = tx;
    r.status = "funded";
    upsertInvoice(r);
    const dest = s.ctx.supplierOverride
      ? `FUNDED — the advance just landed in YOUR wallet (${s.ctx.supplierOverride.slice(0, 10)}…). Check your balance.`
      : `FUNDED — advance streamed from the pool to the supplier`;
    return { result: dest, txHash: tx };
  } catch (e) {
    const err = normalizeRevert((e as Error).message);
    r.status = "policy_blocked";
    r.chain.fundError = err;
    upsertInvoice(r);
    return { result: `Contract REVERTED funding — ${err}`, reverted: true };
  }
}

async function stepAttest(s: Session) {
  const r = s.ctx.record!;
  const att = await chain.attest(
    "UNDERWRITE_APPROVE",
    r.id,
    r.decision!.decisionHash,
    "autonomous-ai-underwriter",
  );
  const tx = att.deployHashes.at(-1);
  r.chain.attestHashes.push(tx ?? "");
  upsertInvoice(r);
  return {
    result: `Decision memo hash anchored on-chain (attestation #${att.result.attestationId})`,
    txHash: tx,
  };
}

async function stepX402(s: Session) {
  const id = s.ctx.invoiceId!;
  const base = `http://127.0.0.1:${config.port}`;
  const first = await fetch(`${base}/api/risk/${id}`);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const offer = ((await first.json()) as any).accepts[0];
  const nonce: string = offer.extra.transferIdNonce;
  const proof = await nativeTransfer({
    fromKeyPath: config.keys.debtor,
    to: offer.payTo,
    motes: offer.maxAmountRequired,
    id: nonce,
  });
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const retry = await fetch(`${base}/api/risk/${id}`, {
      headers: { "PAYMENT-SIGNATURE": proof, "PAYMENT-NONCE": nonce },
    });
    if (retry.status === 200) {
      const rep = (await retry.json()) as any;
      return {
        result: `Report delivered for ${cspr(offer.maxAmountRequired)} CSPR — risk ${rep.riskScore}, decision ${String(rep.decisionHash).slice(0, 18)}…`,
        txHash: proof,
      };
    }
  }
  throw new Error("x402 payment did not settle in time");
}

async function stepSettle(s: Session) {
  const r = s.ctx.record!;
  const st = await chain.settle(r.id, toMotes(r.intake.amountCspr));
  const tx = st.deployHashes.at(-1);
  r.chain.settleHash = tx;
  r.status = "settled";
  upsertInvoice(r);
  s.poolAfter = await snap().catch(() => undefined);
  return {
    result: `Debtor paid ${r.intake.amountCspr} CSPR face value — the pool realizes its yield`,
    txHash: tx,
  };
}

function normalizeRevert(msg: string): string {
  const m = msg.match(/User error:\s*(\d+)/);
  const names: Record<string, string> = {
    "6": "InsufficientLiquidity",
    "13": "RiskAbovePolicy",
    "14": "DiscountOutOfPolicy",
    "15": "SingleInvoiceCapExceeded",
    "16": "DebtorExposureCapExceeded",
  };
  if (m) return `User error: ${m[1]} (${names[m[1]] ?? "see contracts/src/lib.rs"})`;
  return msg.slice(0, 160);
}

// ---- preset step definitions ------------------------------------------------

function happyDefs(): StepDef[] {
  return [
    {
      key: "underwrite",
      actor: "underwriter",
      kind: "compute",
      title: "AI underwrites the invoice",
      action: "Score & price it",
      what: "A clean receivable enters intake; the LLM returns a risk score, a price and a rationale, and the decision memo is hashed.",
      who: "Autonomous underwriter agent",
      why: "The model proposes; the contract will dispose. This step is instant — no gas.",
      run: (s) => doUnderwrite(s),
    },
    {
      key: "register",
      actor: "underwriter",
      kind: "chain",
      title: "Register the invoice on-chain",
      action: "Sign register_invoice",
      what: "register_invoice writes the receivable and its decision hash to the contract.",
      who: "Underwriter agent key",
      why: "The receivable now exists on Casper Testnet, tamper-evident.",
      run: stepRegister,
    },
    {
      key: "fund",
      actor: "underwriter",
      kind: "chain",
      title: "Pool funds the supplier",
      action: "Sign fund_invoice",
      what: "fund_invoice streams the advance from the native-CSPR pool to the supplier account.",
      who: "Underwriter agent key",
      why: "Capital moves autonomously — to the supplier, never the debtor.",
      run: stepFund,
    },
    {
      key: "attest",
      actor: "underwriter",
      kind: "chain",
      title: "Anchor the AI decision",
      action: "Sign attest",
      what: "The SHA-256 of the full decision memo is anchored on-chain.",
      who: "Underwriter agent key",
      why: "Autonomous underwriting you can audit later against the memo.",
      run: stepAttest,
    },
    {
      key: "x402",
      actor: "oracle",
      kind: "chain",
      title: "A buyer purchases the risk report (x402)",
      action: "Pay over HTTP 402",
      what: "A buyer agent hits the oracle, gets 402 Payment Required, settles with a native CSPR transfer carrying the nonce, and receives the verified report.",
      who: "Buyer agent (debtor key)",
      why: "Machine-payable data — the agent economy, settled on-chain.",
      run: stepX402,
    },
    {
      key: "settle",
      actor: "debtor",
      kind: "chain",
      title: "Debtor settles the invoice",
      action: "Sign settle_invoice",
      what: "The debtor repays face value; the pool realizes its yield and the LP share price reflects the gain.",
      who: "Debtor key",
      why: "Closes the credit loop end-to-end.",
      run: stepSettle,
    },
  ];
}

function policyBlockDefs(): StepDef[] {
  return [
    {
      key: "underwrite",
      actor: "underwriter",
      kind: "compute",
      title: "AI underwrites an oversized invoice",
      action: "Score & price it",
      what: "A clean but deliberately large receivable — sized above the on-chain single-invoice cap. The AI still approves it.",
      who: "Autonomous underwriter agent",
      why: "The whole point: a model-approved invoice about to hit a hard on-chain limit. Instant — no gas.",
      run: (s) => doUnderwrite(s),
    },
    {
      key: "register",
      actor: "underwriter",
      kind: "chain",
      title: "Register the invoice on-chain",
      action: "Sign register_invoice",
      what: "register_invoice succeeds — risk and discount are within policy, so the receivable is written.",
      who: "Underwriter agent key",
      why: "Registration is fine; the concentration limit bites at funding.",
      run: stepRegister,
    },
    {
      key: "fund",
      actor: "underwriter",
      kind: "chain",
      title: "Contract REJECTS the funding",
      action: "Sign fund_invoice",
      what: "fund_invoice reverts with User error 15 (SingleInvoiceCapExceeded).",
      who: "Underwriter agent key → contract",
      why: "The ace: a valid agent key with an AI approval STILL cannot exceed the on-chain policy. LLM proposes, contract disposes.",
      run: stepFund,
    },
  ];
}

function x402Defs(): StepDef[] {
  return [
    {
      key: "underwrite",
      actor: "underwriter",
      kind: "compute",
      title: "AI underwrites the invoice",
      action: "Score & price it",
      what: "A clean receivable is scored and priced so there is a report to sell.",
      who: "Autonomous underwriter agent",
      why: "The risk report only exists for an underwritten invoice. Instant — no gas.",
      run: (s) => doUnderwrite(s),
    },
    {
      key: "register",
      actor: "underwriter",
      kind: "chain",
      title: "Register the invoice on-chain",
      action: "Sign register_invoice",
      what: "register_invoice writes the receivable and decision hash.",
      who: "Underwriter agent key",
      why: "The report is anchored to a real on-chain invoice.",
      run: stepRegister,
    },
    {
      key: "fund",
      actor: "underwriter",
      kind: "chain",
      title: "Pool funds the supplier",
      action: "Sign fund_invoice",
      what: "fund_invoice advances the discounted amount to the supplier.",
      who: "Underwriter agent key",
      why: "A funded invoice is a live position worth pricing.",
      run: stepFund,
    },
    {
      key: "x402",
      actor: "oracle",
      kind: "chain",
      title: "Buyer purchases the risk report (x402)",
      action: "Pay over HTTP 402",
      what: "A buyer agent pays over HTTP 402 with native CSPR and gets the verified report with its on-chain decision hash.",
      who: "Buyer agent (debtor key)",
      why: "Machine-to-machine payment for verifiable data.",
      run: stepX402,
    },
  ];
}

function defsFor(preset: string): StepDef[] {
  if (preset === "happy") return happyDefs();
  if (preset === "policy-block") return policyBlockDefs();
  if (preset === "x402") return x402Defs();
  throw new Error(`unknown preset ${preset}`);
}

const PRESETS = [
  {
    id: "happy",
    title: "Full lifecycle",
    subtitle: "Underwrite → register → fund → attest → x402 → settle",
    steps: 6,
    defs: happyDefs,
  },
  {
    id: "policy-block",
    title: "Policy firewall",
    subtitle: "The AI approves; the contract rejects the funding",
    steps: 3,
    defs: policyBlockDefs,
  },
  {
    id: "x402",
    title: "x402 machine payment",
    subtitle: "A buyer agent pays over HTTP 402 for the risk report",
    steps: 4,
    defs: x402Defs,
  },
];

// ---- rate limiting ----------------------------------------------------------

const NEW_SESSION_COOLDOWN_MS = 8_000; // just debounces accidental double-submits
const SESSION_STALE_MS = 10 * 60_000;
const lastNewByIp = new Map<string, number>();
let STEPPING = false; // single in-flight chain step across all sessions

function clientIp(req: Request): string {
  const xf = (req.headers["x-forwarded-for"] as string) ?? "";
  return xf.split(",")[0].trim() || req.ip || "unknown";
}

function activeSession(): Session | undefined {
  const id = order.filter((i) => sessions.get(i)?.status === "active").at(-1);
  const s = id ? sessions.get(id) : undefined;
  if (
    s &&
    Date.now() - (s.steps[s.cursor]?.startedTs ?? s.startedTs) > SESSION_STALE_MS &&
    !STEPPING
  ) {
    s.status = "failed";
    s.note = (s.note ? s.note + " " : "") + "Session expired.";
    return undefined;
  }
  return s;
}

// ---- router -----------------------------------------------------------------

export function makeJudgeRouter(): Router {
  const r = Router();
  // Warm the pool + policy caches so the "instant" underwrite step never blocks
  // on a cold ~60 s livenet read.
  cachedPool().catch(() => {});
  cachedPolicyBps().catch(() => {});

  r.get("/health", async (_req, res) => {
    try {
      res.json(await cachedHealth());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message, mode: "live-testnet", paused: true });
    }
  });

  // Balance of any Casper public key — powers the connected-wallet chip and the
  // before/after balance story when the advance lands in the visitor's wallet.
  r.get("/balance/:pubkey", async (req, res) => {
    const pk = String(req.params.pubkey ?? "").trim();
    if (!/^0[12][0-9a-fA-F]{64,66}$/.test(pk)) {
      res.status(400).json({ error: "not a Casper public key hex" });
      return;
    }
    try {
      const bal = await balanceWithTimeout(pk.toLowerCase());
      res.json({ pubkey: pk.toLowerCase(), cspr: bal });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message.slice(0, 160) });
    }
  });

  r.get("/presets", (_req, res) => {
    res.json(
      PRESETS.map((p) => ({
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        steps: p.defs().map((d) => ({ key: d.key, actor: d.actor, title: d.title, kind: d.kind })),
      })),
    );
  });

  r.get("/session/:id", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.json(publicSession(s));
  });

  // Create a guided session (does not sign anything yet).
  r.post("/session", async (req, res) => {
    const preset = String(req.body?.preset ?? "").trim();
    const def = PRESETS.find((p) => p.id === preset);
    if (!def) {
      res.status(400).json({ error: "preset must be happy | policy-block | x402" });
      return;
    }
    // Optional: the visitor's connected Casper wallet public key. When present,
    // the advance is paid to THEIR wallet instead of the demo supplier. Only a
    // recipient address — we never ask the visitor to sign anything.
    const rawWallet = String(req.body?.supplierAddress ?? "").trim();
    let supplierOverride: string | undefined;
    if (rawWallet) {
      if (!/^0[12][0-9a-fA-F]{64,66}$/.test(rawWallet)) {
        res.status(400).json({
          error: "supplierAddress must be a Casper public key hex (01… or 02…)",
        });
        return;
      }
      supplierOverride = rawWallet.toLowerCase();
    }
    const ip = clientIp(req);
    const existing = activeSession();
    // Same visitor (e.g. refreshed the page) — abandon their old session and
    // start fresh, so they are never locked out. A DIFFERENT visitor mid-signing
    // is the only reason to wait (steps are globally single-flight).
    if (existing && existing.ip === ip) {
      existing.status = "failed";
      existing.note = "Replaced by a new walkthrough.";
    } else if (existing && existing.ip !== ip && STEPPING) {
      res.status(429).json({
        error: "Another judge is signing a live step right now — try again in a few seconds.",
      });
      return;
    }
    const h = await cachedHealth().catch(() => null);
    if (!h || h.paused) {
      res.status(503).json({
        error:
          "Live judge mode is temporarily paused — a key needs a top-up or the node is unreachable.",
        paused: true,
      });
      return;
    }
    // Light guard against accidental double-submits (session creation is gas-free).
    const wait = NEW_SESSION_COOLDOWN_MS - (Date.now() - (lastNewByIp.get(ip) ?? 0));
    if (wait > 0) {
      res
        .status(429)
        .json({ error: `One moment — starting your walkthrough…`, retryAfterMs: wait });
      return;
    }
    lastNewByIp.set(ip, Date.now());

    const defs = def.defs();
    const steps = defs.map((d, i) => publicStep(d, i === 0 ? "ready" : "locked"));
    const s: Session = {
      id: newId(),
      preset,
      title: def.title,
      subtitle: def.subtitle,
      steps,
      defs,
      cursor: 0,
      status: "active",
      startedTs: Date.now(),
      ip,
      poolBefore: (await cachedPool()).snap ?? undefined,
      ctx: { supplierOverride },
    };
    sessions.set(s.id, s);
    order.push(s.id);
    if (order.length > 60) sessions.delete(order.shift() as string);
    res.status(201).json(publicSession(s));
  });

  // Run the next step of a session — signs exactly one transaction.
  r.post("/session/:id/next", async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    if (s.status !== "active") {
      res.status(409).json({ error: `session is ${s.status}`, session: publicSession(s) });
      return;
    }
    if (STEPPING) {
      res
        .status(429)
        .json({ error: "Another step is signing right now — one transaction at a time." });
      return;
    }
    const i = s.cursor;
    const def = s.defs[i];
    const step = s.steps[i];
    if (!def || step.status !== "ready") {
      res.status(409).json({ error: "no step ready to run", session: publicSession(s) });
      return;
    }

    STEPPING = true;
    step.status = "running";
    step.startedTs = Date.now();
    try {
      const out = await def.run(s);
      step.result = out.result;
      if (out.txHash) {
        step.txHash = out.txHash;
        step.explorerUrl = deployUrl(out.txHash);
      }
      step.status = out.reverted ? "reverted" : "done";
      step.endedTs = Date.now();
      s.cursor = i + 1;

      // A revert on the fund step of policy-block is the intended finale.
      const intendedEnd = out.reverted && (s.preset === "policy-block" || !s.ctx.approved);
      if (s.cursor >= s.steps.length || intendedEnd) {
        s.status = "done";
        s.endedTs = Date.now();
        if (!s.poolAfter)
          s.poolAfter = (await cachedPool(1).catch(() => ({ snap: null }))).snap ?? undefined;
      } else {
        s.steps[s.cursor].status = "ready";
      }
      res.json(publicSession(s));
    } catch (e) {
      step.status = "failed";
      step.result = (e as Error).message.slice(0, 200);
      step.endedTs = Date.now();
      s.status = "failed";
      s.endedTs = Date.now();
      feed.publish({
        actor: "system",
        kind: "error",
        message: `judge step ${step.key} failed: ${step.result}`,
      });
      res.status(500).json({ error: step.result, session: publicSession(s) });
    } finally {
      STEPPING = false;
    }
  });

  return r;
}
