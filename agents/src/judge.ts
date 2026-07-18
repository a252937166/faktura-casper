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
import cors from "cors";
import { Router, type Request } from "express";
import {
  CAPS,
  DAILY_PAYOUT_CAP_CSPR,
  addPosition,
  canPayout,
  canSignDeploy,
  canStartRun,
  commitPayout,
  deploysLast24h,
  recentRuns,
  recordDeploy,
  recordRecentRun,
  recordRun,
  releaseReservation,
  reservePayout,
  resolvePosition,
  spentLast24h,
  stalePositions,
  touchPosition,
} from "./judge-limits.js";
import { config } from "./config.js";
import { chain } from "./chain.js";
import { underwrite as llmUnderwrite } from "./llm.js";
import { db, upsertInvoice, type InvoiceRecord } from "./store.js";
import { feed } from "./feed.js";
import {
  nativeTransfer,
  pubKeyToAccountHashStr,
  queryBalance,
  personaPublicKeyHex,
} from "./native-transfer.js";

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
  /** Unguessable id (uuid) — knowing it is required to read the session. */
  id: string;
  /** Human-friendly label for the UI (JUDGE-YYYYMMDD-XXXX). */
  displayId: string;
  /** Secret bearer for mutations; returned once at creation (and to the
   * creator's IP on resume). */
  token: string;
  preset: string;
  title: string;
  subtitle: string;
  steps: JudgeStep[];
  defs: StepDef[];
  cursor: number; // index of the next runnable step
  status: "active" | "done" | "failed";
  startedTs: number;
  endedTs?: number;
  /** Bumped on every sign of life (create/step start/step end/resume) —
   * expiry and desk-takeover decisions key off THIS, not startedTs. */
  lastActivityTs: number;
  ip: string;
  note?: string;
  poolBefore?: PoolSnap;
  poolAfter?: PoolSnap;
  /** Created via the smoke-test bypass header (self-test tooling). */
  smoke?: boolean;
  ctx: {
    record?: InvoiceRecord;
    invoiceId?: number;
    decisionHash?: string;
    amountCspr?: number;
    approved?: boolean;
    x402Nonce?: string;
    x402Proof?: string;
    x402PaidTs?: number;
    x402AmountMotes?: string;
    /** Visitor's connected Casper wallet — the advance is paid HERE when set. */
    supplierOverride?: string;
    /** True while re-running a previously failed step — executors reconcile
     * against the chain first instead of blindly signing again. */
    retrying?: boolean;
    /** Payout committed for this session (guards double-commit on recovery). */
    payoutCommitted?: boolean;
    /** Deploy hashes seen in timeout errors, keyed by step — the tx may have
     * landed even though the client gave up waiting. */
    pendingTx?: Record<string, string>;
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

function newDisplayId(id: string): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
  seq += 1;
  return `JUDGE-${ymd}-${id.slice(0, 4).toUpperCase()}`;
}

function publicStep(d: StepDef, status: StepStatus): JudgeStep {
  const { run, ...rest } = d;
  return { ...rest, status };
}

function publicSession(s: Session) {
  return {
    id: s.id,
    displayId: s.displayId,
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

/** Funded-invoice ids, cached like the pool (livenet reads are slow). */
let fundedCache: { ts: number; ids: number[] } = { ts: 0, ids: [] };
let fundedInflight: Promise<void> | null = null;
async function cachedFundedIds(ttlMs = 90_000): Promise<number[]> {
  const freshEnough = Date.now() - fundedCache.ts < ttlMs;
  if (freshEnough) return fundedCache.ids;
  if (!fundedInflight) {
    fundedInflight = chain
      .invoices(1, 200)
      .then((list) => {
        fundedCache = { ts: Date.now(), ids: list.filter((i) => i.state === 1).map((i) => i.id) };
      })
      .catch(() => {
        fundedCache = { ...fundedCache, ts: Date.now() };
      })
      .finally(() => {
        fundedInflight = null;
      });
  }
  if (fundedCache.ts > 0) return fundedCache.ids;
  await fundedInflight;
  return fundedCache.ids;
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

/**
 * Feasibility math for the policy-firewall preset. The contract checks, in
 * order: advance > liquid → InsufficientLiquidity(6); advance > poolValue ×
 * maxSingleInvoiceBps → SingleInvoiceCapExceeded(15) — where poolValue =
 * liquid + deployed. A clean error-15 revert therefore needs
 *     singleCap < advance ≤ liquid − margin,
 * which is impossible when most of the pool is deployed. Both /health (canRun)
 * and the underwrite step use THIS one function, so what the UI promises and
 * what the step does can never diverge.
 *
 * The preset clamps the discount to [50, 400] bps, so advance ∈
 * [0.96·face, 0.995·face]; face is sized so the WHOLE band clears the cap and
 * stays under liquidity.
 */
function policyBlockPlan(
  pool: PoolSnap | null,
  capBps: number,
): {
  feasible: boolean;
  faceCspr?: number;
  singleCap: number;
  maxAdvance: number;
  reason?: string;
} {
  const liquid = pool?.liquid ?? 0;
  const deployed = pool?.deployed ?? 0;
  const poolValue = liquid + deployed;
  const singleCap = (poolValue * capBps) / 10_000;
  const margin = Math.max(1, 0.03 * liquid);
  const maxAdvance = liquid - margin;
  const faceMin = singleCap / 0.96 + 0.5; // even at max discount, advance > cap
  const faceMax = maxAdvance / 0.995; //     even at min discount, advance ≤ liquid − margin
  if (!(poolValue > 0) || faceMin > faceMax) {
    return {
      feasible: false,
      singleCap,
      maxAdvance,
      reason: `Pool composition cannot produce a clean SingleInvoiceCapExceeded revert right now (liquid ${liquid.toFixed(1)} / deployed ${deployed.toFixed(1)} CSPR, cap ${(singleCap || 0).toFixed(1)} CSPR) — settle open positions or add liquidity first.`,
    };
  }
  const face = Math.min(faceMax, Math.max(faceMin * 1.04, faceMin + 1));
  return { feasible: true, faceCspr: Math.round(face * 100) / 100, singleCap, maxAdvance };
}

const PERSONAS = ["agent", "collector", "supplier", "investor", "debtor"] as const;
const FLOORS: Record<string, number> = {
  agent: 8,
  collector: 8,
  supplier: 2,
  investor: 40,
  debtor: 40,
};

/**
 * Which personas must be funded for each preset — a low collector balance must
 * never pause the policy firewall (the collector doesn't even sign in it).
 *   happy:        agent signs register/fund/attest; debtor pays x402 + settle
 *   policy-block: only the agent signs (register + the reverting fund)
 *   x402:         only the debtor signs (the buyer payment)
 */
const PRESET_NEEDS: Record<string, Array<(typeof PERSONAS)[number]>> = {
  happy: ["agent", "debtor"],
  "policy-block": ["agent"],
  x402: ["debtor"],
};

function personaGate(
  preset: string,
  balances: Record<string, number | null>,
): { ok: boolean; reason?: string } {
  for (const p of PRESET_NEEDS[preset] ?? []) {
    const bal = balances[p];
    if (bal == null)
      return {
        ok: false,
        reason: `balance check for the ${p} key is still pending — retry shortly`,
      };
    if (bal < FLOORS[p])
      return { ok: false, reason: `the ${p} key needs a faucet top-up (${bal} CSPR)` };
  }
  return { ok: true };
}

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
  const fundedIds = await cachedFundedIds().catch(() => [] as number[]);
  const capBps = await cachedPolicyBps();
  const low = PERSONAS.filter((p) => balances[p] != null && (balances[p] as number) < FLOORS[p]);
  // Global pause is reserved for "the chain is unreachable" — per-preset
  // problems (a low balance, an infeasible pool shape) only disable THAT preset.
  const paused = !contractOk;
  const liquid = pool?.liquid ?? 0;
  const plan = policyBlockPlan(pool, capBps);
  const deployBudget = canSignDeploy();
  const gate = (preset: string, extra: { ok: boolean; reason?: string }) => {
    if (!deployBudget.ok) return deployBudget;
    const personas = personaGate(preset, balances);
    if (!personas.ok) return personas;
    return extra;
  };
  const canRun = {
    happy: gate(
      "happy",
      liquid >= 5
        ? { ok: true }
        : { ok: false, reason: "pool liquidity too low for a funded lifecycle" },
    ),
    policyBlock: gate(
      "policy-block",
      plan.feasible ? { ok: true } : { ok: false, reason: plan.reason },
    ),
    x402: gate(
      "x402",
      fundedIds.length &&
        db.invoices.some((r) => r.decision && r.id > 0 && fundedIds.includes(r.id))
        ? { ok: true }
        : {
            ok: false,
            reason:
              "no funded invoice with a decision memo on the book — run the Full lifecycle first",
          },
    ),
  };
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
    canRun,
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
  let faceCspr = 2; // small on purpose: visitor payouts stay ~1.9 CSPR
  if (s.preset === "policy-block") {
    const pool = (await cachedPool()).snap ?? s.poolBefore ?? null;
    const capBps = await cachedPolicyBps();
    const plan = policyBlockPlan(pool, capBps);
    if (!plan.feasible || !plan.faceCspr) {
      throw new Error(plan.reason ?? "policy-block preset is not runnable right now");
    }
    faceCspr = plan.faceCspr;
    s.note = `Pool ${((pool?.liquid ?? 0) + (pool?.deployed ?? 0)).toFixed(1)} CSPR (liquid ${(pool?.liquid ?? 0).toFixed(1)} + deployed ${(pool?.deployed ?? 0).toFixed(1)}) · single-invoice cap ${(capBps / 100).toFixed(0)}% = ${plan.singleCap.toFixed(1)} CSPR → face ${faceCspr} CSPR. The advance lands ABOVE the cap but BELOW liquidity, so fund_invoice must revert with User error: 15.`;
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
  // The policy-block preset narrows the discount band further ([0.5%, 4%]) so
  // the advance is deterministic enough to clear the single-invoice cap no
  // matter how the LLM prices it (see policyBlockPlan).
  const p = config.policy;
  let { approve, risk_score, discount_bps } = opinion;
  const dMax = s.preset === "policy-block" ? Math.min(400, p.maxDiscountBps) : p.maxDiscountBps;
  discount_bps = Math.max(p.minDiscountBps, Math.min(dMax, discount_bps));
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
  // Retry after a timeout: the earlier deploy may have landed. Scan the ids
  // minted since this session started for our docHash before signing again —
  // otherwise a flaky RPC turns one invoice into two.
  if (s.ctx.retrying && r.id === 0) {
    const recovered = await reconcileRegister(s).catch(() => null);
    if (recovered) return recovered;
  }
  // If the visitor connected their Casper wallet, THEY are the supplier — the
  // advance lands in their own wallet. Otherwise the demo supplier receives it.
  const supplier = s.ctx.supplierOverride
    ? pubKeyToAccountHashStr(s.ctx.supplierOverride)
    : await chain.caller("supplier");
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

async function reconcileRegister(s: Session): Promise<{ result: string; txHash?: string } | null> {
  const r = s.ctx.record!;
  const before = s.poolBefore?.invoiceCount ?? 0;
  const stats = await chain.stats().catch(() => null);
  if (!stats) return null;
  for (let id = stats.invoiceCount; id > before && id > stats.invoiceCount - 4; id--) {
    const inv = await chain.invoice(id).catch(() => null);
    if (inv && inv.docHash === r.intake.docHash) {
      r.id = inv.id;
      r.chain.registerHash = r.chain.registerHash ?? s.ctx.pendingTx?.register;
      r.status = "approved";
      upsertInvoice(r);
      s.ctx.invoiceId = inv.id;
      const who = s.ctx.supplierOverride
        ? ` — supplier: YOUR wallet ${s.ctx.supplierOverride.slice(0, 10)}…`
        : "";
      return {
        result: `Invoice #${inv.id} registered on Casper Testnet${who} (recovered — the earlier deploy landed)`,
        txHash: r.chain.registerHash,
      };
    }
  }
  return null;
}

/** Common post-fund bookkeeping — used by fresh funds AND timeout recovery. */
function fundBookkeeping(s: Session, tx?: string) {
  const r = s.ctx.record!;
  r.chain.fundHash = tx ?? r.chain.fundHash;
  r.status = "funded";
  upsertInvoice(r);
  fundedCache.ts = 0; // the book just changed
  // Real capital left the pool — track the open position so an abandoned
  // walkthrough gets auto-settled by the cleanup worker.
  addPosition({
    sessionId: s.id,
    displayId: s.displayId,
    invoiceId: r.id,
    faceMotes: toMotes(r.intake.amountCspr),
    fundedTs: Date.now(),
  });
  if (s.preset === "policy-block") {
    // The demo's whole promise is a revert. A successful fund means the pool
    // moved mid-run — void the walkthrough loudly; the cleanup worker will
    // settle the position.
    s.status = "failed";
    throw new Error(
      "Funding unexpectedly SUCCEEDED — the pool composition changed mid-run, so the cap demo is void. The desk will auto-settle this position; start a fresh walkthrough.",
    );
  }
  let dest = `FUNDED — advance streamed from the pool to the supplier`;
  if (s.ctx.supplierOverride && !s.ctx.payoutCommitted) {
    dest = `FUNDED — the advance just landed in YOUR wallet (${s.ctx.supplierOverride.slice(0, 10)}…). Check your balance.`;
    const advanceCspr = (r.intake.amountCspr * (10_000 - (r.decision?.discountBps ?? 0))) / 10_000;
    commitPayout(s.id, advanceCspr);
    s.ctx.payoutCommitted = true;
  }
  return { result: dest, txHash: r.chain.fundHash };
}

async function stepFund(s: Session) {
  const r = s.ctx.record!;
  // Retry: if the earlier fund deploy landed while we timed out, the invoice
  // is already FUNDED — recover instead of signing a second transfer.
  if (s.ctx.retrying) {
    const inv = await chain.invoice(r.id).catch(() => null);
    if (inv?.state === 1) return fundBookkeeping(s, r.chain.fundHash ?? s.ctx.pendingTx?.fund);
  }
  try {
    const funded = await chain.fund(r.id);
    return fundBookkeeping(s, funded.deployHashes.at(-1));
  } catch (e) {
    if (s.preset === "policy-block" && s.status === "failed") throw e; // void-path from bookkeeping
    const msg = (e as Error).message;
    // Double-submit race: InvalidState(5) means "not LISTED any more" — read
    // the truth before declaring anything.
    if (/User error:\s*5\b/.test(msg)) {
      const inv = await chain.invoice(r.id).catch(() => null);
      if (inv?.state === 1) return fundBookkeeping(s, r.chain.fundHash ?? s.ctx.pendingTx?.fund);
    }
    const err = normalizeRevert(msg);
    if (s.preset === "policy-block") {
      if (/User error:\s*15\b/.test(msg)) {
        r.status = "policy_blocked";
        r.chain.fundError = err;
        upsertInvoice(r);
        return {
          result: `Contract REVERTED funding — ${err}. The AI said yes; Casper said no.`,
          reverted: true,
        };
      }
      // Any OTHER revert breaks the demo's promise — fail loudly, void the run.
      s.status = "failed";
      throw new Error(
        `Expected a clean User error: 15 (SingleInvoiceCapExceeded) revert, but the contract said: ${err}. The pool moved mid-run — this walkthrough is void; start a fresh one.`,
      );
    }
    // Happy path: a fund revert is a real, retryable failure — do NOT continue
    // the walkthrough around an unfunded invoice.
    throw new Error(`fund_invoice did not confirm — ${err}`);
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

async function stepPickFunded(s: Session) {
  const ids = await cachedFundedIds();
  if (!ids.length) {
    throw new Error(
      "No funded invoice is on the book right now — run the Full lifecycle walkthrough first, then come back to buy its report.",
    );
  }
  const id = ids[ids.length - 1];
  s.ctx.invoiceId = id;
  // the oracle needs an off-chain decision record for this invoice
  if (!db.invoices.some((r) => r.id === id && r.decision)) {
    const seeded = db.invoices.find((r) => r.decision && r.id > 0 && ids.includes(r.id));
    if (seeded) s.ctx.invoiceId = seeded.id;
    else
      throw new Error(
        "The desk has no decision memo for the funded invoices on this host yet — run the Full lifecycle walkthrough once, then retry.",
      );
  }
  return {
    result: `Reusing funded invoice #${s.ctx.invoiceId} — no new exposure is created for this purchase`,
  };
}

async function stepX402(s: Session) {
  const id = s.ctx.invoiceId!;
  const base = `http://127.0.0.1:${config.port}`;
  // A stored proof from a previous attempt that never verified within the
  // nonce TTL is dead — pay fresh instead of spinning on it.
  if (s.ctx.x402Proof && Date.now() - (s.ctx.x402PaidTs ?? 0) > 9 * 60_000) {
    s.ctx.x402Proof = undefined;
    s.ctx.x402Nonce = undefined;
  }
  // Retry after a timeout: the transfer may already be on-chain — verify the
  // SAME proof first; never pay twice for one report.
  if (!s.ctx.x402Proof) {
    const first = await fetch(`${base}/api/risk/${id}`);
    if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
    const offer = ((await first.json()) as any).accepts[0];
    s.ctx.x402Nonce = String(offer.extra.transferIdNonce);
    s.ctx.x402AmountMotes = String(offer.maxAmountRequired);
    s.ctx.x402Proof = await nativeTransfer({
      fromKeyPath: config.keys.debtor,
      to: offer.payTo,
      motes: offer.maxAmountRequired,
      id: s.ctx.x402Nonce,
    });
    s.ctx.x402PaidTs = Date.now();
  }
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const retry = await fetch(`${base}/api/risk/${id}`, {
      headers: { "PAYMENT-SIGNATURE": s.ctx.x402Proof, "PAYMENT-NONCE": s.ctx.x402Nonce! },
    });
    if (retry.status === 200) {
      const rep = (await retry.json()) as any;
      return {
        result: `Report delivered for ${cspr(s.ctx.x402AmountMotes ?? config.x402.priceMotes)} CSPR — risk ${rep.riskScore}, decision ${String(rep.decisionHash).slice(0, 18)}…`,
        txHash: s.ctx.x402Proof,
      };
    }
  }
  throw new Error(
    "x402 payment did not settle in time — Retry verifies the SAME transfer again, it never pays twice",
  );
}

/** Common post-settle bookkeeping — used by fresh settles AND timeout recovery. */
async function settleBookkeeping(s: Session, tx?: string, recovered = false) {
  const r = s.ctx.record!;
  r.chain.settleHash = tx ?? r.chain.settleHash;
  r.status = "settled";
  upsertInvoice(r);
  resolvePosition(r.id); // the pool is whole again — nothing left to clean up
  fundedCache.ts = 0; // the book just changed
  s.poolAfter = await snap().catch(() => undefined);
  return {
    result:
      `Debtor paid ${r.intake.amountCspr} CSPR face value — the pool realizes its yield` +
      (recovered ? " (recovered — the earlier deploy landed)" : ""),
    txHash: r.chain.settleHash,
  };
}

async function stepSettle(s: Session) {
  const r = s.ctx.record!;
  if (s.ctx.retrying) {
    const inv = await chain.invoice(r.id).catch(() => null);
    if (inv?.state === 2)
      return settleBookkeeping(s, r.chain.settleHash ?? s.ctx.pendingTx?.settle, true);
  }
  try {
    const st = await chain.settle(r.id, toMotes(r.intake.amountCspr));
    return await settleBookkeeping(s, st.deployHashes.at(-1));
  } catch (e) {
    const msg = (e as Error).message;
    if (/User error:\s*5\b/.test(msg)) {
      const inv = await chain.invoice(r.id).catch(() => null);
      if (inv?.state === 2)
        return settleBookkeeping(s, r.chain.settleHash ?? s.ctx.pendingTx?.settle, true);
    }
    throw new Error(`settle_invoice did not confirm — ${normalizeRevert(msg)}`);
  }
}

function normalizeRevert(msg: string): string {
  const m = msg.match(/User error:\s*(\d+)/);
  const names: Record<string, string> = {
    "5": "InvalidState",
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
      key: "pick",
      actor: "oracle",
      kind: "compute",
      title: "Pick a funded invoice from the book",
      action: "Scan the book",
      what: "The oracle reuses an invoice the pool has already funded — buying a report never creates new exposure.",
      who: "Faktura risk oracle",
      why: "Reports are priced per invoice; the book already has live positions to price. Instant — no gas.",
      run: stepPickFunded,
    },
    {
      key: "x402",
      actor: "oracle",
      kind: "chain",
      title: "Buyer purchases the risk report (x402)",
      action: "Pay over HTTP 402",
      what: "A buyer agent hits the oracle, gets 402 Payment Required, settles with a native CSPR transfer carrying the nonce, and receives the verified report.",
      who: "Buyer agent (debtor key)",
      why: "Machine-to-machine payment for verifiable data — the report carries the on-chain decision hash.",
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
/** Hard expiry on INACTIVITY — a judge reading explorer pages between steps
 * must never lose their run (5 chain txs × up to 2 min each, plus reading). */
const SESSION_STALE_MS = 40 * 60_000;
/** A different visitor may claim the desk once the current run has been idle
 * this long (nobody signing, nobody clicking). */
const IDLE_TAKEOVER_MS = 5 * 60_000;
const lastNewByIp = new Map<string, number>();
let STEPPING = false; // single in-flight chain step across all sessions

/** Smoke-test bypass for our own pre-freeze self-tests: skips rate limits
 * (never the signing itself) when the secret header matches. Unset = disabled. */
const SMOKE_SECRET = process.env.JUDGE_SMOKE_SECRET ?? "";
const isSmoke = (req: Request) =>
  !!SMOKE_SECRET && String(req.headers["x-judge-smoke"] ?? "") === SMOKE_SECRET;

function clientIp(req: Request): string {
  // With app.set("trust proxy", 1) express derives this from the rightmost
  // proxy hop — not from a client-forgeable header we parse ourselves.
  return req.ip || "unknown";
}

function endSession(s: Session, status: "done" | "failed", note?: string) {
  s.status = status;
  s.endedTs = Date.now();
  if (note) s.note = (s.note ? s.note + " " : "") + note;
  if (!s.ctx.payoutCommitted) releaseReservation(s.id);
}

function activeSession(): Session | undefined {
  const id = order.filter((i) => sessions.get(i)?.status === "active").at(-1);
  const s = id ? sessions.get(id) : undefined;
  if (s && Date.now() - s.lastActivityTs > SESSION_STALE_MS && !STEPPING) {
    endSession(s, "failed", "Session expired after inactivity.");
    return undefined;
  }
  return s;
}

// ---- router -----------------------------------------------------------------

const ALLOWED_ORIGINS = [
  "https://faktura.axiqo.xyz",
  "http://localhost:4034",
  "http://127.0.0.1:4034",
];

export function makeJudgeRouter(): Router {
  const r = Router();
  // These endpoints trigger real signatures — only the desk's own pages may
  // call them from a browser.
  r.use(
    cors({
      origin: (origin, cb) =>
        !origin || ALLOWED_ORIGINS.includes(origin)
          ? cb(null, true)
          : cb(new Error("origin not allowed")),
      methods: ["GET", "POST"],
    }),
  );
  // Warm the pool + policy caches so the "instant" underwrite step never blocks
  // on a cold ~60 s livenet read.
  cachedPool().catch(() => {});
  cachedPolicyBps().catch(() => {});
  cachedFundedIds().catch(() => {});

  r.get("/health", async (req, res) => {
    try {
      const h = await cachedHealth();
      // The active walkthrough (with its resume token) is only shown to the IP
      // that created it — strangers see a busy flag, not someone else's run.
      const mine = h.activeSession && sessions.get(h.activeSession.id)?.ip === clientIp(req);
      const active = mine ? sessions.get(h.activeSession!.id)! : null;
      res.json({
        ...h,
        activeSession: active ? { ...publicSession(active), token: active.token } : null,
        deskBusy: !!h.activeSession && !mine,
        budget: {
          capCspr: DAILY_PAYOUT_CAP_CSPR,
          spentCspr: spentLast24h(),
          deploysToday: deploysLast24h(),
          deployCap: CAPS.deploysPerDay,
        },
      });
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
    // Resuming counts as activity — only for the owner (token or creator IP),
    // so a stranger polling a leaked id cannot keep someone's session alive.
    const tok = String(req.headers["x-judge-token"] ?? "");
    if (s.status === "active" && (tok === s.token || s.ip === clientIp(req))) {
      s.lastActivityTs = Date.now();
      touchPosition(s.id);
    }
    res.json(publicSession(s));
  });

  // The last few completed walkthroughs — public receipts (no tokens, no IPs).
  r.get("/recent", (_req, res) => {
    res.json({ runs: recentRuns(5) });
  });

  // Create a guided session (does not sign anything yet).
  r.post("/session", async (req, res) => {
    const preset = String(req.body?.preset ?? "").trim();
    const def = PRESETS.find((p) => p.id === preset);
    if (!def) {
      res.status(400).json({ error: "preset must be happy | policy-block | x402" });
      return;
    }
    // Optional: the visitor's connected Casper wallet public key. Only the
    // happy-path walkthrough pays out; other presets ignore it (policy-block
    // reverts by design, x402 reuses an existing invoice). Only a recipient
    // address — we never ask the visitor to sign anything.
    const rawWallet = String(req.body?.supplierAddress ?? "").trim();
    let supplierOverride: string | undefined;
    if (rawWallet) {
      if (!/^0[12][0-9a-fA-F]{64,66}$/.test(rawWallet)) {
        res.status(400).json({
          error: "supplierAddress must be a Casper public key hex (01… or 02…)",
        });
        return;
      }
      if (preset === "happy") supplierOverride = rawWallet.toLowerCase();
    }
    const ip = clientIp(req);
    const smoke = isSmoke(req);
    const existing = activeSession();
    // Same visitor (e.g. refreshed the page) — abandon their old session and
    // start fresh, so they are never locked out. A DIFFERENT visitor holds the
    // desk while they are actively clicking; once idle past the takeover
    // window (and nothing is signing), the desk frees up.
    if (existing && existing.ip === ip) {
      endSession(existing, "failed", "Replaced by a new walkthrough.");
    } else if (existing && existing.ip !== ip) {
      const idleMs = Date.now() - existing.lastActivityTs;
      if (STEPPING || idleMs < IDLE_TAKEOVER_MS) {
        res.status(429).json({
          error:
            "Another judge is mid-walkthrough right now — the desk signs one story at a time. Try again in a few minutes.",
        });
        return;
      }
      endSession(existing, "failed", "Superseded after inactivity.");
    }
    const h = await cachedHealth().catch(() => null);
    if (!h || h.paused) {
      res.status(503).json({
        error: "Live judge mode is temporarily paused — the Casper node is unreachable.",
        paused: true,
      });
      return;
    }
    // The UI disables un-runnable presets, but the SERVER is the enforcement
    // point — deep links and raw curls hit the same wall.
    const canKey = preset === "policy-block" ? "policyBlock" : preset;
    const cr = (h.canRun as Record<string, { ok: boolean; reason?: string }>)[canKey];
    if (cr && !cr.ok && !smoke) {
      res.status(409).json({ error: cr.reason ?? "this walkthrough is not runnable right now" });
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
    // Persistent rate limits: per-IP hourly, per-preset and global daily.
    if (!smoke) {
      const rl = canStartRun(ip, preset);
      if (!rl.ok) {
        res.status(429).json({ error: rl.reason });
        return;
      }
    }

    const uuid = crypto.randomUUID();
    // Wallet payouts burn the daily budget — RESERVE it before any signing
    // starts, so concurrent sessions can never overshoot the cap together.
    // Fail closed: if the ledger cannot persist, no payout session starts.
    if (supplierOverride && preset === "happy") {
      try {
        const gate = reservePayout(uuid, supplierOverride, ip, 2, smoke);
        if (!gate.ok) {
          res.status(403).json({ error: gate.reason, payoutBlocked: true });
          return;
        }
      } catch {
        res.status(503).json({
          error:
            "The payout ledger is unavailable right now — wallet payouts are disabled. Run with the demo supplier instead.",
          payoutBlocked: true,
        });
        return;
      }
    }

    const defs = def.defs();
    const steps = defs.map((d, i) => publicStep(d, i === 0 ? "ready" : "locked"));
    const s: Session = {
      id: uuid,
      displayId: newDisplayId(uuid),
      token: crypto.randomBytes(32).toString("hex"),
      preset,
      title: def.title,
      subtitle: def.subtitle,
      steps,
      defs,
      cursor: 0,
      status: "active",
      startedTs: Date.now(),
      lastActivityTs: Date.now(),
      ip,
      smoke,
      poolBefore: (await cachedPool()).snap ?? undefined,
      ctx: { supplierOverride },
    };
    sessions.set(s.id, s);
    order.push(s.id);
    if (order.length > 60) {
      const evicted = order.shift() as string;
      releaseReservation(evicted);
      sessions.delete(evicted);
    }
    recordRun(ip, preset);
    res.status(201).json({ ...publicSession(s), token: s.token });
  });

  // Run the next step of a session — signs exactly one transaction.
  r.post("/session/:id/next", async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    // Mutations require the bearer issued at creation — a guessable URL alone
    // must never advance (or sabotage) someone's walkthrough.
    const token = String(req.headers["x-judge-token"] ?? "");
    if (token !== s.token) {
      res.status(403).json({ error: "invalid session token" });
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
    if (!def || (step.status !== "ready" && step.status !== "failed")) {
      res.status(409).json({ error: "no step ready to run", session: publicSession(s) });
      return;
    }
    // Global daily gas budget for signed steps (reads are free).
    if (def.kind === "chain" && !s.smoke) {
      const gas = canSignDeploy();
      if (!gas.ok) {
        res.status(429).json({ error: gas.reason });
        return;
      }
    }

    STEPPING = true;
    s.lastActivityTs = Date.now();
    touchPosition(s.id);
    const isRetry = step.status === "failed";
    // Retrying a failed step: clear the previous attempt's outcome.
    step.result = undefined;
    step.txHash = undefined;
    step.explorerUrl = undefined;
    step.status = "running";
    step.startedTs = Date.now();
    if (def.kind === "chain") recordDeploy(`${s.preset}:${def.key}`);
    try {
      s.ctx.retrying = isRetry;
      const out = await def.run(s);
      step.result = out.result;
      if (out.txHash) {
        step.txHash = out.txHash;
        step.explorerUrl = deployUrl(out.txHash);
      }
      step.status = out.reverted ? "reverted" : "done";
      step.endedTs = Date.now();
      s.lastActivityTs = Date.now();
      s.cursor = i + 1;

      // A revert on the fund step of policy-block is the intended finale.
      const intendedEnd = out.reverted && (s.preset === "policy-block" || !s.ctx.approved);
      if (s.cursor >= s.steps.length || intendedEnd) {
        endSession(s, "done");
        if (!s.poolAfter)
          s.poolAfter = (await cachedPool(1).catch(() => ({ snap: null }))).snap ?? undefined;
        // Public receipt: the proof that a real walkthrough just happened.
        recordRecentRun({
          displayId: s.displayId,
          preset: s.preset,
          title: s.title,
          endedTs: s.endedTs ?? Date.now(),
          wallet: s.ctx.supplierOverride
            ? `${s.ctx.supplierOverride.slice(0, 6)}…${s.ctx.supplierOverride.slice(-4)}`
            : undefined,
          steps: s.steps.map((st) => ({
            key: st.key,
            title: st.title,
            status: st.status,
            txHash: st.txHash,
            explorerUrl: st.explorerUrl,
            result: st.result,
          })),
        });
      } else {
        s.steps[s.cursor].status = "ready";
      }
      res.json(publicSession(s));
    } catch (e) {
      // Testnet hiccups happen — a failed step stays RETRYABLE and the
      // walkthrough stays active (unless the executor voided the session).
      // Keep the error TAIL: with long livenet output, the cause is at the end.
      const msg = (e as Error).message;
      const tail = msg.length > 320 ? `…${msg.slice(-320)}` : msg;
      // A timeout may still land on-chain — remember the submitted hash so the
      // retry reconciles instead of double-signing.
      const submitted = msg.match(/submitted tx ([0-9a-f]{64})/);
      if (submitted) s.ctx.pendingTx = { ...s.ctx.pendingTx, [step.key]: submitted[1] };
      step.status = "failed";
      step.result = tail;
      step.endedTs = Date.now();
      s.lastActivityTs = Date.now();
      if (s.status !== "active") {
        // Executor declared the walkthrough void (e.g. policy-block lost its
        // revert window) — settle the books for this session.
        endSession(s, "failed");
      }
      feed.publish({
        actor: "system",
        kind: "error",
        message: `judge step ${step.key} failed (retryable): ${tail.slice(0, 200)}`,
      });
      res.json(publicSession(s));
    } finally {
      s.ctx.retrying = false;
      STEPPING = false;
    }
  });

  startCleanupWorker();
  return r;
}

// ---- cleanup worker ---------------------------------------------------------

/**
 * Auto-settles funded invoices whose walkthrough went quiet (judge closed the
 * tab after the fund step). The debtor demo key repays face value, the pool is
 * whole again, and the next visitor starts from a clean book. Serialized with
 * live steps via the same STEPPING flag; one position per tick.
 */
const CLEANUP_IDLE_MS = 20 * 60_000;
const CLEANUP_TICK_MS = 3 * 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanupWorker() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void cleanupTick();
  }, CLEANUP_TICK_MS);
  cleanupTimer.unref?.();
}

async function cleanupTick() {
  if (STEPPING) return;
  const stale = stalePositions(CLEANUP_IDLE_MS);
  if (!stale.length) return;
  const pos = stale[0];
  const owner = sessions.get(pos.sessionId);
  if (owner && owner.status === "active" && Date.now() - owner.lastActivityTs < CLEANUP_IDLE_MS) {
    touchPosition(pos.sessionId); // owner is alive — give them time
    return;
  }
  if (!canSignDeploy().ok) return; // gas budget exhausted — wait for the window
  STEPPING = true;
  try {
    const inv = await chain.invoice(pos.invoiceId).catch(() => null);
    if (!inv || inv.state !== 1) {
      resolvePosition(pos.invoiceId); // already settled/defaulted elsewhere
      return;
    }
    recordDeploy("cleanup:settle");
    const st = await chain.settle(pos.invoiceId, pos.faceMotes);
    resolvePosition(pos.invoiceId);
    fundedCache.ts = 0;
    const rec = db.invoices.find((x) => x.id === pos.invoiceId);
    if (rec) {
      rec.status = "settled";
      rec.chain.settleHash = st.deployHashes.at(-1);
      upsertInvoice(rec);
    }
    if (owner && owner.status === "active") {
      endSession(
        owner,
        "done",
        "Walkthrough went idle after funding — the desk auto-settled the invoice to close the position.",
      );
    }
    feed.publish({
      actor: "collector",
      kind: "onchain",
      message: `cleanup: auto-settled idle judge invoice #${pos.invoiceId} (${pos.displayId})`,
      deployHash: st.deployHashes.at(-1),
    });
  } catch (e) {
    feed.publish({
      actor: "system",
      kind: "error",
      message: `cleanup settle failed for #${pos.invoiceId}: ${(e as Error).message.slice(-160)}`,
    });
    touchPosition(pos.sessionId); // back off one idle window before retrying
  } finally {
    STEPPING = false;
  }
}
