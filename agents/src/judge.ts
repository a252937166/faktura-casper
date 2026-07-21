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
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import { Router, type Request } from "express";
import {
  CAPS,
  DAILY_PAYOUT_CAP_CSPR,
  addPosition,
  canPayout,
  clearOrphanReservations,
  canSignDeploy,
  canStartRun,
  commitPayout,
  presetRunBudget,
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
  type RecentRun,
} from "./judge-limits.js";
import { config } from "./config.js";
import { chain, LivenetError, setLiveProgressSink, emitLiveProgress } from "./chain.js";
import { underwrite as llmUnderwrite } from "./llm.js";
import {
  buildDecisionMemo,
  hashDecisionMemo,
  isCanonicalDecisionMemo,
  type CanonicalDecisionMemo,
} from "./decision-memo.js";
import { RELEASE } from "./release.js";
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

/** The BLOCK HASH once the node reports the transaction as executed, else
 * null. The explorer often shows the outcome tens of seconds before the
 * CLI's event watcher notices — past that point the waiting card must stop
 * claiming "waiting for finality" and start counting the catch-up instead. */
async function txExecuted(hash: string): Promise<string | null> {
  const rpc = `${config.nodeAddress.replace(/\/$/, "")}/rpc`;
  for (const variant of ["Version1", "Deploy"]) {
    try {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "info_get_transaction",
          params: { transaction_hash: { [variant]: hash } },
        }),
        signal: AbortSignal.timeout(6000),
      });
      const j = (await r.json()) as {
        result?: { execution_info?: { block_hash?: string } | null };
      };
      const info = j.result?.execution_info;
      if (info) return String(info.block_hash ?? "").slice(0, 10) || "confirmed";
    } catch {
      /* transient RPC hiccup — the next poll retries */
    }
  }
  return null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const day = 86_400_000;

// ---- step / session model ---------------------------------------------------

type StepStatus = "locked" | "ready" | "running" | "done" | "reverted" | "failed";

/**
 * The AI's judgment, made visible: not just a number, but the WHY — so the
 * walkthrough reads "the model formed an auditable credit opinion", not
 * "a black box emitted a score". Vendor-neutral by policy.
 */
export interface DecisionCard {
  verdict: "APPROVE" | "REJECT";
  riskScore: number;
  discountBps: number;
  rationale: string;
  redFlags: string[];
  model: string;
  decisionHash: string;
}

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
  /** Live sub-step note while RUNNING ("submitted — waiting for finality"). */
  phaseNote?: string;
  result?: string;
  /** structured AI decision (underwrite / consumer steps) */
  decision?: DecisionCard;
  what?: string;
  who?: string;
  why?: string;
  startedTs?: number;
  endedTs?: number;
}

interface StepDef extends Omit<JudgeStep, "status"> {
  run: (s: Session) => Promise<{
    result: string;
    txHash?: string;
    reverted?: boolean;
    decision?: DecisionCard;
  }>;
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
  /** HttpOnly client-cookie id — session OWNERSHIP (IP is rate-limit only). */
  ownerCid?: string;
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
    /** The purchased x402 risk report — consumed by the consumer-verdict step. */
    report?: {
      invoiceId: number;
      riskScore: number;
      discountBps: number;
      decisionHash: string;
      memo?: unknown;
    };
    /** The consumer agent's own verdict memo + hash — kept for the receipt. */
    consumerVerdict?: { memo: unknown; hash: string };
    /** On-chain invoice read started at the END of the x402 step, so the
     * consumer step's verification await is already warm (same live read,
     * just launched a click earlier). */
    invoicePrefetch?: Promise<import("./chain.js").ChainInvoice | null>;
    /** True while re-running a previously failed step — executors reconcile
     * against the chain first instead of blindly signing again. */
    retrying?: boolean;
    /** Payout committed for this session (guards double-commit on recovery). */
    payoutCommitted?: boolean;
    /** Deploy hashes seen in timeout errors, keyed by step — the tx may have
     * landed even though the client gave up waiting. */
    pendingTx?: Record<string, string>;
    /** True while a background poolAfter fill is in flight — the "done"
     * fallback must not beat it with a stale cached snapshot. */
    poolAfterPending?: boolean;
  };
}

interface PoolSnap {
  liquid: number;
  deployed: number;
  totalFunded: number;
  totalSettled: number;
  totalDefaulted: number;
  totalShares: number;
  invoiceCount: number;
}

/** Process boot time — a paused health inside the warm-up window is "still
 * waking up", not "the chain is down"; the copy must say so. */
const BOOT_TS = Date.now();
const WARMING_MS = 150_000;

const sessions = new Map<string, Session>();
const order: string[] = [];
let seq = 0;

function newDisplayId(id: string): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
  seq += 1;
  // 8 hex chars of the session uuid — 4 was short enough to collide across a
  // long judging day, and this id is the receipt's public lookup key.
  return `JUDGE-${ymd}-${id.slice(0, 8).toUpperCase()}`;
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

// ---- receipts: canonical proof documents, one file per run ------------------

const receiptsDir = () => path.join(config.dataDir, "receipts");

/** Canonical faktura.credit-receipt.v1: receiptHash is the SHA-256 of the
 * JSON body WITHOUT the receiptHash field (which is appended last, so
 * `const { receiptHash, ...body } = doc` reproduces the hashed bytes).
 * `npm run verify-receipt -- file.json` re-checks it offline; add `--online`
 * to also confirm every transaction against the chain. */
function buildReceipt(run: RecentRun) {
  const body = {
    schema: "faktura.credit-receipt.v1",
    displayId: run.displayId,
    preset: run.preset,
    title: run.title,
    endedTs: run.endedTs,
    wallet: run.wallet ?? null,
    invoiceId: run.invoiceId ?? null,
    faceCspr: run.faceCspr ?? null,
    decisionHash: run.decisionHash ?? null,
    memo: run.memo ?? null,
    consumerVerdict: run.consumerVerdict ?? null,
    poolBefore: run.poolBefore ?? null,
    poolAfter: run.poolAfter ?? null,
    steps: run.steps,
    contract: config.contract,
    chain: config.chainName,
    explorer,
    release: RELEASE,
  };
  const receiptHash = `sha256:${sha256(JSON.stringify(body))}`;
  return { ...body, receiptHash };
}

/** Best-effort per-run persistence — the ring keeps 10, the disk keeps all. */
function persistReceipt(run: RecentRun) {
  // Narrates only while a step's live sink is attached (no-op otherwise).
  emitLiveProgress({ phase: "writing the signed run receipt…" });
  try {
    fs.mkdirSync(receiptsDir(), { recursive: true });
    fs.writeFileSync(
      path.join(receiptsDir(), `${run.displayId}.json`),
      JSON.stringify(buildReceipt(run), null, 2),
    );
  } catch {
    /* a failed receipt write must never break the walkthrough itself */
  }
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
    totalShares: cspr(s.totalShares),
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
        // Cache a FAILURE for only ~10 s (not the full TTL) — one flaky read
        // must not pin the desk "paused" for 45 s.
        poolCache = {
          ts: Date.now() - Math.max(0, ttlMs - 10_000),
          snap: poolCache.snap,
          ok: false,
        };
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

/** Contract grace period (deploy arg was 30000 ms) + a settle-time buffer. */
const GRACE_MS = Number(process.env.FAKTURA_GRACE_MS ?? 30_000);

interface BookInvoice {
  id: number;
  state: number;
  dueTs: number;
  faceValue: string;
  /** On-chain anchored decision hash — the x402 predicates verify against it. */
  decisionHash: string;
}

/** The invoice book, cached like the pool (livenet reads are slow). Funded
 * ids and overdue-funded inventory both derive from ONE read. */
let bookCache: { ts: number; list: BookInvoice[] } = { ts: 0, list: [] };
let bookInflight: Promise<void> | null = null;
async function cachedBook(ttlMs = 90_000): Promise<BookInvoice[]> {
  const freshEnough = Date.now() - bookCache.ts < ttlMs;
  if (freshEnough) return bookCache.list;
  if (!bookInflight) {
    bookInflight = chain
      .invoices(1, 200)
      .then((list) => {
        bookCache = {
          ts: Date.now(),
          list: list.map((i) => ({
            id: i.id,
            state: i.state,
            dueTs: i.dueTs,
            faceValue: i.faceValue,
            decisionHash: i.decisionHash,
          })),
        };
      })
      .catch(() => {
        bookCache = { ...bookCache, ts: Date.now() - Math.max(0, ttlMs - 10_000) };
      })
      .finally(() => {
        bookInflight = null;
      });
  }
  if (bookCache.ts > 0) return bookCache.list;
  await bookInflight;
  return bookCache.list;
}

async function cachedFundedIds(ttlMs = 90_000): Promise<number[]> {
  return (await cachedBook(ttlMs)).filter((i) => i.state === 1).map((i) => i.id);
}

/** Funded invoices past due + grace — the default-workout inventory. */
function overdueFunded(list: BookInvoice[]): BookInvoice[] {
  const cutoff = Date.now() - GRACE_MS - 5_000;
  return list.filter((i) => i.state === 1 && i.dueTs < cutoff);
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
export function policyBlockPlan(
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
  x402: ["agent", "debtor"], // buyer pays with the debtor key; the verdict anchors with the agent key
  default: ["collector"],
  "ai-reject": ["agent"], // only the agent signs (the rejection attestation)
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
  // All four sources in PARALLEL — on a cold boot the pool/book livenet reads
  // take ~60 s each; run sequentially the first snapshot took their SUM.
  const [, { snap: pool, ok: contractOk }, book, capBps] = await Promise.all([
    Promise.all(
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
    ),
    cachedPool(),
    cachedBook().catch(() => [] as BookInvoice[]),
    cachedPolicyBps(),
  ]);
  const fundedIds = book.filter((i) => i.state === 1).map((i) => i.id);
  const overdueCount = overdueFunded(book).length;
  const low = PERSONAS.filter((p) => balances[p] != null && (balances[p] as number) < FLOORS[p]);
  // Global pause is reserved for "the chain is unreachable" — per-preset
  // problems (a low balance, an infeasible pool shape) only disable THAT preset.
  const paused = !contractOk;
  const liquid = pool?.liquid ?? 0;
  const plan = policyBlockPlan(pool, capBps);
  const deployBudget = canSignDeploy();
  const gate = (preset: string, extra: { ok: boolean; reason?: string }) => {
    if (!deployBudget.ok) return deployBudget;
    // Same run-budget math as session creation — a card the picker shows as
    // runnable must never answer a budget 429 when clicked.
    const runBudget = presetRunBudget(preset);
    if (!runBudget.ok) return runBudget;
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
      book.some((i) =>
        db.invoices.some((r) => r.id === i.id && verifiedMemoRecord(r, i.decisionHash)),
      )
        ? { ok: true }
        : {
            ok: false,
            reason:
              "no invoice with a verifiable canonical memo yet — run the Full lifecycle first",
          },
    ),
    default: gate(
      "default",
      overdueCount
        ? { ok: true }
        : (() => {
            // Inventory ripening: a funded invoice already exists whose due
            // date is imminent — tell the visitor WHEN, not "check back soon".
            const ripening = book
              .filter(
                (i) =>
                  i.state === 1 &&
                  i.dueTs + GRACE_MS + 5_000 >= Date.now() &&
                  i.dueTs < Date.now() + 5 * 60_000, // only short-dated seeds count
              )
              .sort((a, b) => a.dueTs - b.dueTs)[0];
            if (ripening) {
              const readyIn = Math.max(
                5,
                Math.ceil((ripening.dueTs + GRACE_MS + 5_000 - Date.now()) / 1000),
              );
              return {
                ok: false,
                reason: `the next overdue invoice is ripening — ready in ~${readyIn}s`,
              };
            }
            return {
              ok: false,
              reason: "no overdue funded invoice yet — the desk is preparing one",
            };
          })(),
    ),
    // Only needs the agent key + deploy budget: nothing is registered or funded.
    "ai-reject": gate("ai-reject", { ok: true }),
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
    uptimeSec: Math.round((Date.now() - BOOT_TS) / 1000),
    release: RELEASE,
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
  if (!healthCache.data && healthInflight) {
    // Cold start: give the first real snapshot a short budget, then answer
    // honestly as "warming" — a health endpoint must NEVER hang a visitor
    // (the pre-fix behavior: first /health after a restart blocked on cold
    // ~60 s livenet reads and the hero froze on "Checking live desk…").
    await Promise.race([healthInflight, new Promise((r) => setTimeout(r, 4_000))]);
  }
  const data = healthCache.data ?? warmingHealth();
  // always reflect the live active session
  const activeId = order.filter((id) => sessions.get(id)?.status === "active").at(-1);
  return { ...data, activeSession: activeId ? publicSession(sessions.get(activeId)!) : null };
}

/** Honest placeholder while boot-warmup is still reading the chain: paused +
 * young uptime renders as "DESK RESTARTING — ready in under a minute", which
 * is exactly what is happening. Replaced by the real snapshot within seconds
 * (the frontend re-probes every 5 s while unsettled). */
function warmingHealth(): Awaited<ReturnType<typeof health>> {
  const wait = { ok: false, reason: "the desk just restarted and is warming up" };
  return {
    mode: "live-testnet" as const,
    contract: config.contract,
    explorer,
    chain: config.chainName,
    node: config.nodeAddress,
    balances: {},
    floors: FLOORS,
    low: [],
    rpcOk: false,
    contractOk: false,
    paused: true,
    pool: null,
    x402Price: config.x402.priceMotes,
    uptimeSec: Math.round((Date.now() - BOOT_TS) / 1000),
    release: RELEASE,
    canRun: {
      happy: wait,
      policyBlock: wait,
      x402: wait,
      default: wait,
      "ai-reject": wait,
    },
    activeSession: null,
  };
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
  if (preset === "ai-reject") {
    // Deliberately bad paper: a shell-company debtor with a disputed history
    // and vague deliverables. The EXPECTED outcome is a rejection.
    return {
      supplierName: "QuickCash Factoring Ltd",
      debtorName: "Meridian Shelf Holdings BV",
      amountCspr: faceCspr,
      dueTs: Date.now() + 90 * day,
      invoiceNumber: runId,
      description: "Consulting services, scope unspecified, delivered per verbal agreement",
      history:
        "new counterparty, incorporated 5 weeks ago; one prior invoice disputed and unpaid; registered address is a mail-forwarding office",
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

async function doUnderwrite(
  s: Session,
): Promise<{ result: string; reverted?: boolean; decision?: DecisionCard }> {
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

  // One underwriting attempt: LLM call + policy clamp (tightest of TS prefilter
  // + on-chain policy for discount/risk). The policy-block preset narrows the
  // discount band further ([0.5%, 4%]) so the advance is deterministic enough
  // to clear the single-invoice cap no matter how the LLM prices it.
  const attemptOnce = async () => {
    const { opinion, provider, model } = await llmUnderwrite({
      supplierName: input.supplierName,
      debtorName: input.debtorName,
      amountCspr: input.amountCspr,
      dueTs: input.dueTs,
      invoiceNumber: input.invoiceNumber,
      description: input.description,
      history: input.history,
    });
    const p = config.policy;
    const policyNotes: string[] = [];
    let { approve, risk_score, discount_bps } = opinion;
    const dMax = s.preset === "policy-block" ? Math.min(400, p.maxDiscountBps) : p.maxDiscountBps;
    const clamped = Math.max(p.minDiscountBps, Math.min(dMax, discount_bps));
    if (clamped !== discount_bps)
      policyNotes.push(`discount clamped ${discount_bps} → ${clamped} bps`);
    discount_bps = clamped;
    if (risk_score > p.maxRiskScore) {
      approve = false;
      policyNotes.push(`risk ${risk_score} > prefilter max ${p.maxRiskScore}`);
    }
    return { opinion, provider, model, approve, risk_score, discount_bps, policyNotes };
  };

  // Every preset has an EXPECTED verdict (ai-reject expects the NO; the others
  // expect a YES). LLMs are not deterministic: an off-script verdict gets one
  // silent same-input retry; twice off-script fails the step RETRYABLE — the
  // walkthrough must never end as a false "done".
  const expectReject = s.preset === "ai-reject";
  const asExpected = (v: { approve: boolean }) => (expectReject ? !v.approve : v.approve);
  let verdict = await attemptOnce();
  if (!asExpected(verdict)) verdict = await attemptOnce();
  if (!asExpected(verdict)) {
    throw new Error(
      expectReject
        ? "The model approved this deliberately bad invoice — twice in a row. Testnet models have moods; hit Retry to ask again."
        : "The model declined this clean invoice — twice in a row. Testnet models have moods; hit Retry to ask again.",
    );
  }
  const { opinion, provider, model, approve, risk_score, discount_bps, policyNotes } = verdict;

  // The SAME canonical memo + hash as the production pipeline — the anchor
  // covers the WHOLE opinion (rationale, red flags), so rewriting any of it
  // after the fact breaks the on-chain match. The memo is an AUDIT artifact:
  // it records the REAL provider/model that produced this opinion (matching
  // processIntake); every UI surface keeps the vendor-neutral desk identity.
  const memo = buildDecisionMemo({
    intakeId: s.id,
    invoiceNumber: input.invoiceNumber,
    provider,
    model,
    opinion,
    applied: { approve, risk_score, discount_bps },
    policyNotes,
  });
  const decisionHash = hashDecisionMemo(memo);

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
      policyNotes,
      model: "autonomous-ai-underwriter",
      decisionHash,
      decidedTs: Date.now(),
    },
    memo,
    chain: { attestHashes: [] },
  };
  upsertInvoice(record);
  s.ctx.record = record;
  s.ctx.decisionHash = decisionHash;
  s.ctx.amountCspr = input.amountCspr;
  s.ctx.approved = approve;

  // The card the judge sees: the WHY, not only the number. Vendor-neutral.
  const card: DecisionCard = {
    verdict: approve ? "APPROVE" : "REJECT",
    riskScore: risk_score,
    discountBps: discount_bps,
    rationale: (opinion.rationale ?? "").slice(0, 420),
    redFlags: opinion.red_flags ?? [],
    model: "autonomous-ai-underwriter",
    decisionHash,
  };

  if (!approve) {
    // Only the ai-reject preset reaches this branch (an unexpected NO throws
    // above): the rejection IS the story, and the next step anchors it on-chain.
    return {
      result: `AI REJECTED — risk ${risk_score}/100 (${opinion.red_flags.join("; ") || "over policy"}). Decision hash ${decisionHash.slice(0, 20)}…`,
      decision: card,
    };
  }
  return {
    result: `AI APPROVED — risk ${risk_score}/100, discount ${(discount_bps / 100).toFixed(2)}%, face ${input.amountCspr} CSPR. Decision hash ${decisionHash.slice(0, 20)}…`,
    decision: card,
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
  return { result: `Invoice #${r.id} registered on Casper${who}`, txHash: tx };
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
        result: `Invoice #${inv.id} registered on Casper${who} (recovered — the earlier deploy landed)`,
        txHash: r.chain.registerHash,
      };
    }
  }
  return null;
}

/** Common post-fund bookkeeping — used by fresh funds AND timeout recovery. */
function fundBookkeeping(s: Session, tx?: string) {
  emitLiveProgress({ phase: "funds moved — recording the position for the cleanup worker…" });
  const r = s.ctx.record!;
  r.chain.fundHash = tx ?? r.chain.fundHash;
  r.status = "funded";
  upsertInvoice(r);
  bookCache.ts = 0; // the book just changed
  // Real capital left the pool — track the open position so an abandoned
  // walkthrough gets auto-settled by the cleanup worker (unless it goes
  // overdue first, in which case it becomes default-workout inventory).
  addPosition({
    sessionId: s.id,
    displayId: s.displayId,
    invoiceId: r.id,
    faceMotes: toMotes(r.intake.amountCspr),
    dueTs: r.intake.dueTs,
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
    emitLiveProgress({ phase: "payout confirmed — committing it to the wallet-budget ledger…" });
    commitPayout(s.id, advanceCspr, { wallet: s.ctx.supplierOverride, ip: s.ip });
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
        // The revert is a REAL transaction — link the one the judge just
        // triggered, not only the canonical example from the evidence pack.
        const revertTx = (e as LivenetError).deployHashes?.at(-1);
        r.chain.fundHash = revertTx;
        upsertInvoice(r);
        return {
          result: `Contract REVERTED funding — ${err}. The AI said yes; Casper said no. The invoice stays listed but unfunded.`,
          reverted: true,
          txHash: revertTx,
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

/**
 * Casper 2.0 RPC lookup for a submitted transaction (Odra signs Version1
 * transactions — the legacy info_get_deploy cannot see them). Used to
 * reconcile "the client timed out but the chain may have kept going".
 */
async function checkTxSuccess(hash: string): Promise<"success" | "failure" | "unknown"> {
  try {
    const res = await fetch(`${config.nodeAddress}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "info_get_transaction",
        params: { transaction_hash: { Version1: hash } },
      }),
    });
    const d = (await res.json()) as any;
    if (d.error) return "unknown";
    const er = d.result?.execution_info?.execution_result ?? {};
    const v = er.Version2 ?? er.Version1 ?? {};
    if (!d.result?.execution_info) return "unknown"; // still settling
    return v.error_message ? "failure" : "success";
  } catch {
    return "unknown";
  }
}

async function stepAttest(s: Session) {
  const r = s.ctx.record!;
  // Retry after a timeout: if the earlier attest deploy landed, recover it
  // instead of anchoring the same memo twice.
  const pending = s.ctx.pendingTx?.attest;
  if (s.ctx.retrying && pending) {
    const status = await checkTxSuccess(pending);
    if (status === "success") {
      r.chain.attestHashes.push(pending);
      upsertInvoice(r);
      return {
        result: `Decision memo hash anchored on-chain (recovered — the earlier deploy landed)`,
        txHash: pending,
      };
    }
  }
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

/** ai-reject finale: anchor the REJECTION memo. subject_id is 0 on purpose —
 * the invoice was declined before registration, so it never minted an id. */
async function stepAttestReject(s: Session) {
  const r = s.ctx.record!;
  const pending = s.ctx.pendingTx?.["attest-reject"];
  if (s.ctx.retrying && pending) {
    const status = await checkTxSuccess(pending);
    if (status === "success") {
      r.chain.attestHashes.push(pending);
      upsertInvoice(r);
      return {
        result: `Rejection memo hash anchored on-chain (recovered — the earlier deploy landed)`,
        txHash: pending,
      };
    }
  }
  const att = await chain.attest(
    "UNDERWRITE_REJECT",
    0,
    r.decision!.decisionHash,
    "autonomous-ai-underwriter",
  );
  const tx = att.deployHashes.at(-1);
  r.chain.attestHashes.push(tx ?? "");
  upsertInvoice(r);
  return {
    result: `Rejection anchored on-chain (attestation #${att.result.attestationId}) — the memo hash covers the rationale and every red flag, so even the NO is auditable`,
    txHash: tx,
  };
}

/**
 * Risk reports are priced per UNDERWRITTEN invoice, not per funded one — a
 * settled or even defaulted receivable still has a verifiable decision memo
 * worth buying (that's what a credit-history oracle is). So the pick is any
 * on-chain invoice with a decision memo, newest first, preferring live
 * positions for the nicer story.
 */
async function stepPickVerified(s: Session) {
  const book = await cachedBook();
  // STRICT pick: only invoices whose canonical memo re-hashes to the stored
  // decision hash AND to the on-chain anchor qualify — the consumer step
  // downstream REJECTS anything weaker, so never sell it a lemon.
  const withMemo = book.filter((i) =>
    db.invoices.some((r) => r.id === i.id && verifiedMemoRecord(r, i.decisionHash)),
  );
  if (!withMemo.length) {
    throw new Error(
      "No invoice with a verifiable canonical memo is on the book yet — run the Full lifecycle walkthrough once, then come back to buy its report.",
    );
  }
  const pick = [...withMemo].reverse().find((i) => i.state === 1) ?? withMemo[withMemo.length - 1];
  s.ctx.invoiceId = pick.id;
  const stateName = ["LISTED", "FUNDED", "SETTLED", "DEFAULTED"][pick.state] ?? `#${pick.state}`;
  return {
    result: `Picked verified invoice #${pick.id} (${stateName}) — its decision memo is anchored on-chain; buying the report creates zero new exposure`,
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
    emitLiveProgress({ phase: "402 received — signing the CSPR payment" });
    s.ctx.x402Proof = await nativeTransfer({
      fromKeyPath: config.keys.debtor,
      to: offer.payTo,
      motes: offer.maxAmountRequired,
      id: s.ctx.x402Nonce,
    });
    s.ctx.x402PaidTs = Date.now();
    emitLiveProgress({
      txHash: s.ctx.x402Proof,
      phase: "payment submitted — the oracle verifies it on-chain",
    });
  }
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const retry = await fetch(`${base}/api/risk/${id}`, {
      headers: { "PAYMENT-SIGNATURE": s.ctx.x402Proof, "PAYMENT-NONCE": s.ctx.x402Nonce! },
    });
    if (retry.status === 200) {
      const rep = (await retry.json()) as any;
      // Keep the report — the consumer-verdict step audits and acts on it.
      s.ctx.report = {
        invoiceId: id,
        riskScore: Number(rep.riskScore),
        discountBps: Number(rep.discountBps),
        decisionHash: String(rep.decisionHash),
        memo: rep.memo ?? null,
      };
      // Warm the NEXT step's on-chain verification read now — the consumer
      // step still awaits this same live read; it just started a click earlier.
      s.ctx.invoicePrefetch = chain.invoice(rep.invoiceId).catch(() => null);
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

/**
 * The half of the agent economy most demos skip: the BUYER acts on what it
 * bought. The consumer agent audits the memo hash against its local copy,
 * applies its own acceptance policy, and anchors its verdict on-chain —
 * closing the loop: produce → sell → verify → act.
 */
/**
 * The ONE definition of "verified invoice" for the x402 surface: the local
 * record must carry a canonical memo that re-hashes to its stored decision
 * hash (and to the on-chain anchor when the caller has it). canRun.x402 and
 * the pick step share this predicate, so the desk never advertises a report
 * it could not verifiably sell.
 */
export function verifiedMemoRecord(
  r: { memo?: unknown; decision?: { decisionHash: string } },
  onchainHash?: string,
): boolean {
  if (!r.decision || !r.memo || !isCanonicalDecisionMemo(r.memo)) return false;
  const rehash = hashDecisionMemo(r.memo);
  if (rehash !== r.decision.decisionHash) return false;
  return onchainHash === undefined || rehash === onchainHash;
}

/** The consumer's OWN verification policy — every check it performs, hashed
 * and anchored as ITS verdict (not a re-anchor of the underwriter's hash). */
export function consumerChecks(
  rep: {
    invoiceId: number;
    riskScore: number;
    discountBps: number;
    decisionHash: string;
    memo?: unknown;
  },
  local: { decisionHash: string; riskScore: number; discountBps: number } | null,
  onchain: { decisionHash: string; riskScore: number; discountBps: number } | null,
) {
  // Strongest check first: the memo DOCUMENT the oracle shipped must BE a
  // canonical memo AND re-hash to the claimed decision hash. No memo, no
  // deal — a report without the hashed document is unverifiable by
  // definition, and trusting the oracle's own hash claim would be circular.
  const recomputed =
    !!rep.memo &&
    isCanonicalDecisionMemo(rep.memo) &&
    hashDecisionMemo(rep.memo) === rep.decisionHash;
  const memo = recomputed ? (rep.memo as CanonicalDecisionMemo) : null;
  // Field binding INSIDE the memo: the numbers being sold must be the numbers
  // the hashed document itself carries. Without this, an agent could register
  // an invoice whose contract fields disagree with its memo (hash intact) and
  // every hash comparison would still pass.
  const memoRisk = !!memo && memo.applied.risk_score === rep.riskScore;
  const memoDiscount = !!memo && memo.applied.discount_bps === rep.discountBps;
  const localHash = !!local && local.decisionHash === rep.decisionHash;
  const chainHash = !!onchain && onchain.decisionHash === rep.decisionHash;
  // Field binding against the desk's record and the contract: a "keep the
  // hash, tweak the score" oracle fails here.
  const localRisk = !!local && local.riskScore === rep.riskScore;
  const chainRisk = !!onchain && onchain.riskScore === rep.riskScore;
  const localDiscount = !!local && local.discountBps === rep.discountBps;
  const chainDiscount = !!onchain && onchain.discountBps === rep.discountBps;
  const riskOk = rep.riskScore <= 35;
  const accepted =
    recomputed &&
    memoRisk &&
    memoDiscount &&
    localHash &&
    chainHash &&
    localRisk &&
    chainRisk &&
    localDiscount &&
    chainDiscount &&
    riskOk;
  return {
    recomputed,
    memoRisk,
    memoDiscount,
    localHash,
    chainHash,
    localRisk,
    chainRisk,
    localDiscount,
    chainDiscount,
    riskOk,
    accepted,
  };
}

async function stepConsumerVerdict(s: Session) {
  const rep = s.ctx.report;
  if (!rep) throw new Error("no purchased report in this session — run the x402 step first");
  // Idempotent retry: if the earlier verdict attest landed, recover it.
  const pending = s.ctx.pendingTx?.consumer;
  if (s.ctx.retrying && pending) {
    const status = await checkTxSuccess(pending);
    if (status === "success") {
      return {
        result: `Consumer verdict anchored (recovered — the earlier deploy landed)`,
        txHash: pending,
      };
    }
  }
  emitLiveProgress({
    phase: "verifying the purchased report — re-hashing the memo, reading the on-chain anchor…",
  });
  const local = db.invoices.find((r) => r.id === rep.invoiceId && r.decision);
  const onchainInv = await (s.ctx.invoicePrefetch ??
    chain.invoice(rep.invoiceId).catch(() => null));
  const c = consumerChecks(
    rep,
    local?.decision
      ? {
          decisionHash: local.decision.decisionHash,
          riskScore: local.decision.riskScore,
          discountBps: local.decision.discountBps,
        }
      : null,
    onchainInv
      ? {
          decisionHash: onchainInv.decisionHash,
          riskScore: onchainInv.riskScore,
          discountBps: onchainInv.discountBps,
        }
      : null,
  );
  const verdict = c.accepted ? "ACCEPT" : "REJECT";
  // The consumer anchors ITS OWN verdict memo — its checks, its policy, its
  // decision — not merely a re-anchor of the underwriter's hash.
  const verdictMemo = {
    schema: "faktura.consumer-verdict.v1",
    reportDecisionHash: rep.decisionHash,
    memoRecomputedMatch: c.recomputed,
    memoRiskMatch: c.memoRisk,
    memoDiscountMatch: c.memoDiscount,
    localHashMatch: c.localHash,
    onchainHashMatch: c.chainHash,
    riskFieldMatch: c.localRisk && c.chainRisk,
    discountFieldMatch: c.localDiscount && c.chainDiscount,
    riskScore: rep.riskScore,
    consumerMaxRisk: 35,
    verdict,
    decidedAt: new Date().toISOString(),
  };
  const verdictHash = `sha256:${sha256(JSON.stringify(verdictMemo))}`;
  s.ctx.consumerVerdict = { memo: verdictMemo, hash: verdictHash };
  // BOTH outcomes go on-chain — a rejection is a decision too.
  emitLiveProgress({
    phase: `checks done — anchoring the consumer's ${verdict} verdict on-chain…`,
  });
  const att = await chain.attest(
    c.accepted ? "CREDIT_REPORT_ACCEPTED" : "CREDIT_REPORT_REJECTED",
    rep.invoiceId,
    verdictHash,
    "consumer-agent",
  );
  const tx = att.deployHashes.at(-1);
  const checks = [
    `memo ${!rep.memo ? "MISSING" : c.recomputed ? "re-hash MATCH" : "re-hash MISMATCH"}`,
    `report↔memo fields ${c.memoRisk && c.memoDiscount ? "BOUND" : "MISMATCH"}`,
    `report↔desk ${c.localHash ? "MATCH" : "MISMATCH"}`,
    `report↔on-chain ${c.chainHash ? "MATCH" : "MISMATCH"}`,
    `risk/discount fields ${c.localRisk && c.chainRisk && c.localDiscount && c.chainDiscount ? "BOUND" : "MISMATCH"}`,
    `risk ${rep.riskScore} ${c.riskOk ? "≤" : ">"} 35`,
  ].join(" · ");
  return {
    result: `Consumer verdict: ${verdict} — ${checks} — verdict memo anchored (attestation #${att.result.attestationId})`,
    txHash: tx,
    decision: {
      verdict: (c.accepted ? "APPROVE" : "REJECT") as DecisionCard["verdict"],
      riskScore: rep.riskScore,
      discountBps: rep.discountBps,
      rationale: c.accepted
        ? "The consumer re-hashed the shipped memo document, matched it against the desk's copy AND the anchor read from the Casper contract, verified the risk/discount fields are hash-bound, and cleared its own policy (risk ≤ 35). Its verdict memo is anchored on-chain by the attestation relay."
        : `The purchased report failed the consumer agent's checks (${checks}) — the REJECTION is anchored on-chain too.`,
      redFlags: [
        ...(c.recomputed ? [] : [rep.memo ? "memo re-hash mismatch" : "canonical memo missing"]),
        ...(c.memoRisk && c.memoDiscount ? [] : ["report fields not bound to the memo document"]),
        ...(c.localHash ? [] : ["local memo hash mismatch"]),
        ...(c.chainHash ? [] : ["on-chain anchor mismatch"]),
        ...(c.localRisk && c.chainRisk ? [] : ["risk score not hash-bound"]),
        ...(c.localDiscount && c.chainDiscount ? [] : ["discount not hash-bound"]),
      ],
      model: "consumer-agent",
      decisionHash: verdictHash,
    },
  };
}

/**
 * Fill poolAfter WITHOUT blocking the step response: the cold livenet stats
 * read costs 40–80 s — the single biggest avoidable chunk of the "slow step"
 * feeling. The finish screen tolerates a late snapshot, and the persisted
 * receipt is re-written once it lands so the proof document stays complete.
 */
function fillPoolAfterInBackground(s: Session, expectChange = false) {
  s.ctx.poolAfterPending = true;
  void (async () => {
    try {
      const before = s.poolBefore ? JSON.stringify(s.poolBefore) : null;
      for (let attempt = 0; ; attempt++) {
        const p = await snap();
        // A settle/default just moved real money; if the RPC still returns the
        // pre-transaction numbers the global state query hasn't caught up with
        // the finalized deploy yet — retry instead of persisting a snapshot
        // that contradicts the step right above it on the finish screen.
        if (expectChange && before && JSON.stringify(p) === before && attempt < 3) {
          await new Promise((r) => setTimeout(r, 12_000));
          continue;
        }
        s.poolAfter = p;
        const run = recentRuns(10).find((x) => x.displayId === s.displayId);
        if (run) {
          run.poolAfter = p;
          persistReceipt(run);
        }
        return;
      }
    } catch {
      /* best effort — the receipt simply keeps poolAfter: null */
    } finally {
      s.ctx.poolAfterPending = false;
    }
  })();
}

/** Common post-settle bookkeeping — used by fresh settles AND timeout recovery. */
async function settleBookkeeping(s: Session, tx?: string, recovered = false) {
  const r = s.ctx.record!;
  r.chain.settleHash = tx ?? r.chain.settleHash;
  r.status = "settled";
  upsertInvoice(r);
  resolvePosition(r.id); // the pool is whole again — nothing left to clean up
  bookCache.ts = 0; // the book just changed
  fillPoolAfterInBackground(s, true);
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

/**
 * The loss half of the credit lifecycle: pick a funded invoice that blew past
 * due + grace, and let the COLLECTOR key write it off — the one entrypoint
 * the underwriter key cannot call.
 */
async function stepPickExpired(s: Session) {
  const book = await cachedBook();
  const inventory = overdueFunded(book);
  if (!inventory.length) {
    throw new Error(
      "No overdue funded invoice is on the book right now — the desk seeds one periodically; try again in a few minutes (or run the Full lifecycle and come back after its due date).",
    );
  }
  const inv = inventory[0];
  s.ctx.invoiceId = inv.id;
  s.ctx.amountCspr = cspr(inv.faceValue);
  const overdueSec = Math.max(0, Math.round((Date.now() - inv.dueTs) / 1000));
  return {
    result: `Invoice #${inv.id} (face ${cspr(inv.faceValue)} CSPR) is ${overdueSec}s past due — beyond the grace window, eligible for write-off`,
  };
}

async function stepDefault(s: Session) {
  const id = s.ctx.invoiceId!;
  const recover = async () => {
    const inv = await chain.invoice(id).catch(() => null);
    if (inv?.state === 3) {
      resolvePosition(id);
      bookCache.ts = 0;
      fillPoolAfterInBackground(s, true);
      return {
        result: `DEFAULTED — recovered (the earlier deploy landed). The pool booked the loss.`,
        txHash: s.ctx.pendingTx?.default,
      };
    }
    return null;
  };
  if (s.ctx.retrying) {
    const r = await recover();
    if (r) return r;
  }
  try {
    const d = await chain.markDefault(id);
    const tx = d.deployHashes.at(-1);
    resolvePosition(id);
    bookCache.ts = 0;
    const rec = db.invoices.find((x) => x.id === id);
    if (rec) {
      rec.status = "defaulted";
      rec.chain.defaultHash = tx;
      upsertInvoice(rec);
    }
    fillPoolAfterInBackground(s, true);
    return {
      result: `DEFAULTED — the advance is written off and LPs absorb the loss through the share price. Only the collector key can sign this.`,
      txHash: tx,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (/User error:\s*5\b/.test(msg)) {
      const r = await recover();
      if (r) return r;
    }
    throw new Error(`mark_default did not confirm — ${normalizeRevert(msg)}`);
  }
}

function normalizeRevert(msg: string): string {
  const m = msg.match(/User error:\s*(\d+)/);
  const names: Record<string, string> = {
    "5": "InvalidState",
    "6": "InsufficientLiquidity",
    "10": "NotDue",
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
      why: "The receivable now exists on Casper, tamper-evident.",
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
      key: "settle",
      actor: "debtor",
      kind: "chain",
      title: "Debtor settles the invoice",
      action: "Sign settle_invoice",
      what: "The debtor repays face value; the pool realizes its yield and the LP share price reflects the gain.",
      who: "Debtor key",
      why: "Closes the credit loop end-to-end. (The x402 report sale is its own side quest — settlement never depends on it.)",
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
      title: "Pick a verified invoice from the book",
      action: "Scan the book",
      what: "The oracle picks an invoice whose decision memo is anchored on-chain — funded, settled or defaulted, its credit history is verifiable and worth buying.",
      who: "Faktura risk oracle",
      why: "Reports are priced per underwriting, not per live position — buying one never creates new exposure. Instant — no gas.",
      run: stepPickVerified,
    },
    {
      key: "x402",
      actor: "oracle",
      kind: "chain",
      title: "Consumer agent buys the risk report (x402)",
      action: "Pay over HTTP 402",
      what: "The consumer agent hits the oracle, gets 402 Payment Required, settles with a native CSPR transfer carrying the nonce, and receives the verified report.",
      who: "Consumer agent — pays with the desk's buyer key (debtor persona)",
      why: "Machine-to-machine payment for verifiable data — the report carries the on-chain decision hash.",
      run: stepX402,
    },
    {
      key: "consumer",
      actor: "oracle",
      kind: "chain",
      title: "Consumer agent verifies & ACTS on the report",
      action: "Audit + anchor the verdict",
      what: "The consumer agent checks the report hash against BOTH the desk's memo and the on-chain anchor, applies its OWN acceptance policy (risk ≤ 35), and has the verdict anchored.",
      who: "Consumer agent decides; the desk's attestation relay anchors the verdict",
      why: "The other half of the agent economy: the buyer doesn't just pay — it verifies and takes its own on-chain action based on what it bought.",
      run: stepConsumerVerdict,
    },
  ];
}

function defaultDefs(): StepDef[] {
  return [
    {
      key: "pick-expired",
      actor: "collector",
      kind: "compute",
      title: "Find an overdue funded invoice",
      action: "Scan the book",
      what: "The collector scans the funded book for an invoice past its due date + grace window — real credit sometimes goes bad.",
      who: "Collector agent",
      why: "Yield is only half of credit; a real desk must also process losses. Instant — no gas.",
      run: stepPickExpired,
    },
    {
      key: "default",
      actor: "collector",
      kind: "chain",
      title: "Collector writes the invoice off",
      action: "Sign mark_default",
      what: "mark_default flags the invoice DEFAULTED, removes its advance from deployed capital and books the loss — LPs absorb it through the share price.",
      who: "Collector key — the ONLY key the contract accepts here",
      why: "Separation of duties, enforced on-chain: the underwriter cannot write off its own book.",
      run: stepDefault,
    },
  ];
}

function aiRejectDefs(): StepDef[] {
  return [
    {
      key: "underwrite",
      actor: "underwriter",
      kind: "compute",
      title: "AI underwrites a suspicious invoice",
      action: "Score & price it",
      what: "A shell-company debtor, a disputed payment history, vague deliverables — the model reads the paper and declines it, with reasons.",
      who: "Autonomous underwriter agent",
      why: "Gate 1 has two exits. This is the other one: an autonomous desk is only credible if it can say NO. Instant — no gas.",
      run: (s) => doUnderwrite(s),
    },
    {
      key: "attest-reject",
      actor: "underwriter",
      kind: "chain",
      title: "Anchor the REJECTION on-chain",
      action: "Sign attest",
      what: "attest writes UNDERWRITE_REJECT with the SHA-256 of the full decision memo — rationale and red flags included.",
      who: "Underwriter agent key",
      why: "An auditable desk proves what it declined, not only what it funded. Nothing was registered, nothing was paid — only the refusal is on the record.",
      run: stepAttestReject,
    },
  ];
}

function defsFor(preset: string): StepDef[] {
  if (preset === "happy") return happyDefs();
  if (preset === "policy-block") return policyBlockDefs();
  if (preset === "x402") return x402Defs();
  if (preset === "default") return defaultDefs();
  if (preset === "ai-reject") return aiRejectDefs();
  throw new Error(`unknown preset ${preset}`);
}

const PRESETS = [
  {
    id: "happy",
    title: "Full lifecycle",
    subtitle: "Underwrite → register → fund → attest → settle",
    steps: 5,
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
    subtitle: "A buyer agent pays over HTTP 402, verifies, and acts on the report",
    steps: 3,
    defs: x402Defs,
  },
  {
    id: "default",
    title: "Default workout",
    subtitle: "An overdue invoice is written off — LPs absorb the loss",
    steps: 2,
    defs: defaultDefs,
  },
  {
    id: "ai-reject",
    title: "AI declines",
    subtitle: "The model says no to bad paper — and even the no is anchored",
    steps: 2,
    defs: aiRejectDefs,
  },
];

// ---- rate limiting ----------------------------------------------------------

const NEW_SESSION_COOLDOWN_MS = 4_000; // just debounces accidental double-submits
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

/**
 * Session OWNERSHIP rides an HttpOnly cookie, not the IP: office/hotel NATs
 * put many people behind one address, and none of them should be able to see
 * or supersede each other's runs. The IP stays for rate limiting only. When
 * the cookie is absent (older clients, cross-origin dev), ownership falls
 * back to the IP — strictly no worse than before.
 */
function clientCid(req: Request, res?: { setHeader(n: string, v: string): void }): string {
  const m = /(?:^|;\s*)fj_cid=([a-f0-9-]{8,64})/.exec(String(req.headers.cookie ?? ""));
  if (m) return m[1];
  if (res) {
    const cid = crypto.randomUUID();
    // Secure only over HTTPS (production sits behind nginx TLS, trust proxy is
    // on) — adding it on plain-http localhost would make the browser drop it.
    const secure =
      req.secure || String(req.headers["x-forwarded-proto"] ?? "") === "https" ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `fj_cid=${cid}; Path=/api/judge; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`,
    );
    return cid;
  }
  return "";
}

/**
 * Pure ownership rule (unit-tested): a session that HAS a cookie-bound owner
 * is owned ONLY by that cookie — a request without it is a stranger, even
 * from the same IP (hotel/office NAT puts many visitors behind one address).
 * The IP comparison survives solely for sessions created by builds that
 * predate ownerCid.
 */
export function ownerMatch(
  ownerCid: string | undefined,
  ownerIp: string,
  reqCid: string,
  reqIp: string,
): boolean {
  if (ownerCid) return !!reqCid && reqCid === ownerCid;
  return ownerIp === reqIp;
}

/** True when the request provably belongs to the session's creator. */
function isOwner(s: Session, req: Request): boolean {
  return ownerMatch(s.ownerCid, s.ip, clientCid(req), clientIp(req));
}

/**
 * Pure abandon decision (unit-tested): what happens if the owner walks away
 * NOW. "settling" refuses (a signed transaction is in flight), "release"
 * ends cleanly pre-fund (reservation returns to the budget), "cleanup" ends
 * the session and leaves the funded position to the auto-settle worker.
 */
export function abandonOutcome(s: {
  status: string;
  steps: Array<{ status: string }>;
  ctx: { record?: { chain: { fundHash?: string } }; payoutCommitted?: boolean };
}): "already-ended" | "settling" | "release" | "cleanup" {
  if (s.status !== "active") return "already-ended";
  if (s.steps.some((st) => st.status === "running")) return "settling";
  if (s.ctx.record?.chain.fundHash || s.ctx.payoutCommitted) return "cleanup";
  return "release";
}

function endSession(s: Session, status: "done" | "failed", note?: string) {
  s.status = status;
  s.endedTs = Date.now();
  if (note) s.note = (s.note ? s.note + " " : "") + note;
  if (!s.ctx.payoutCommitted) releaseReservation(s.id);
}

/** The caller's OWN active walkthrough, if any — sessions are per-visitor
 * now; only the on-chain signing lock (STEPPING) is global. */
function myActiveSession(cid: string, ip: string): Session | undefined {
  for (let i = order.length - 1; i >= 0; i--) {
    const s = sessions.get(order[i]);
    if (s?.status === "active" && ownerMatch(s.ownerCid, s.ip, cid, ip)) return s;
  }
  return undefined;
}

/** Pure lifecycle decision — what to expire and what may be evicted. Kept
 * separate from the mutation so the rules are unit-testable:
 *  - an ACTIVE session with no running step, idle past the stale window → expire;
 *  - the store keeps at most `max` sessions, evicting OLDEST NON-ACTIVE first;
 *  - an active or mid-transaction session is NEVER silently deleted. */
export function prunePlan(
  list: { id: string; status: string; running: boolean; lastActivityTs: number }[],
  now: number,
  max = 60,
): { expire: string[]; evict: string[] } {
  const expire = list
    .filter((s) => s.status === "active" && !s.running && now - s.lastActivityTs > SESSION_STALE_MS)
    .map((s) => s.id);
  const expired = new Set(expire);
  const evictable = list.filter((s) => s.status !== "active" || expired.has(s.id));
  const overflow = Math.max(0, list.length - max);
  return { expire, evict: evictable.slice(0, overflow).map((s) => s.id) };
}

/** Sweep expired walkthroughs and cap the in-memory store. Called from the
 * cheap read paths (/health, create) and the cleanup tick — the 40-minute
 * expiry actually fires now (the per-visitor refactor had orphaned it). */
function pruneSessions(now = Date.now()) {
  const plan = prunePlan(
    order.map((id) => {
      const s = sessions.get(id);
      return {
        id,
        status: s?.status ?? "gone",
        running: !!s?.steps.some((st) => st.status === "running"),
        lastActivityTs: s?.lastActivityTs ?? 0,
      };
    }),
    now,
  );
  for (const id of plan.expire) {
    const s = sessions.get(id);
    if (s) endSession(s, "failed", "Session expired after inactivity.");
  }
  for (const id of plan.evict) {
    releaseReservation(id);
    sessions.delete(id);
    const at = order.indexOf(id);
    if (at >= 0) order.splice(at, 1);
  }
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
  cachedBook().catch(() => {});
  // Warm the FULL health snapshot too — otherwise the first ~70 s after a
  // restart answer every session-create with a misleading "node unreachable".
  cachedHealth().catch(() => {});
  // Any reservation that survived the restart is an orphan — free it so its
  // owner isn't locked out of wallet payouts by their own abandoned run.
  clearOrphanReservations();

  r.get("/health", async (req, res) => {
    try {
      pruneSessions();
      const h = await cachedHealth();
      // The active walkthrough (with its resume token) is only shown to the IP
      // that created it — strangers see a busy flag, not someone else's run.
      const active = myActiveSession(clientCid(req), clientIp(req)) ?? null;
      res.json({
        ...h,
        activeSession: active ? { ...publicSession(active), token: active.token } : null,
        // Retired: sessions are per-visitor now — nobody else's run can make
        // the desk "busy" for you. Kept for older cached frontends.
        deskBusy: false,
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
    if (s.status === "active" && (tok === s.token || isOwner(s, req))) {
      s.lastActivityTs = Date.now();
      touchPosition(s.id);
    }
    res.json(publicSession(s));
  });

  // Explicit owner-initiated abandon: closing the tab must not be the only
  // way to leave — this ends the session SERVER-SIDE, releasing the desk and
  // any payout reservation. Funded positions hand off to the cleanup worker.
  r.post("/session/:id/abandon", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const tok = String(req.headers["x-judge-token"] ?? "");
    if (tok !== s.token && !isOwner(s, req)) {
      res.status(403).json({ error: "not your walkthrough" });
      return;
    }
    const outcome = abandonOutcome(s);
    if (outcome === "already-ended") {
      res.json(publicSession(s));
      return;
    }
    // Only THIS session's own in-flight transaction blocks its abandon —
    // another visitor holding the signing mutex is none of our business
    // (sessions are per-visitor; the mutex only serializes signatures).
    if (outcome === "settling") {
      res.status(409).json({
        error: "a real transaction is still settling — keep the page open a moment and retry",
      });
      return;
    }
    endSession(s, "failed", "Abandoned by the visitor.");
    feed.publish({
      actor: "system",
      kind: "info",
      message:
        `walkthrough ${s.displayId} abandoned by its owner` +
        (outcome === "cleanup" ? " — funded position handed to the cleanup worker" : ""),
    });
    res.json({
      ...publicSession(s),
      ...(outcome === "cleanup" ? { cleanup: "scheduled" } : {}),
    });
  });

  // The last few completed walkthroughs — public receipts (no tokens, no IPs).
  r.get("/recent", (_req, res) => {
    res.json({ runs: recentRuns(5) });
  });

  // One receipt as a downloadable proof document (curl-able by a judge).
  // Served from the live ring when fresh; from the per-run file on disk once
  // the ring rolls over — a proof link handed to a judge must never die.
  r.get("/recent/:displayId", (req, res) => {
    const id = req.params.displayId;
    const run = recentRuns(10).find((x) => x.displayId === id);
    if (run) {
      res.setHeader("Content-Disposition", `attachment; filename="${run.displayId}.json"`);
      res.json(buildReceipt(run));
      return;
    }
    if (/^JUDGE-[0-9]{8}-[0-9A-F]{4,16}$/.test(id)) {
      try {
        const disk = fs.readFileSync(path.join(receiptsDir(), `${id}.json`), "utf8");
        res.setHeader("Content-Disposition", `attachment; filename="${id}.json"`);
        res.type("application/json").send(disk);
        return;
      } catch {
        /* fall through to 404 */
      }
    }
    res.status(404).json({ error: "no receipt with that id" });
  });

  // Create a guided session (does not sign anything yet).
  r.post("/session", async (req, res) => {
    const preset = String(req.body?.preset ?? "").trim();
    const def = PRESETS.find((p) => p.id === preset);
    if (!def) {
      res
        .status(400)
        .json({ error: "preset must be happy | policy-block | x402 | default | ai-reject" });
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
    const cid = clientCid(req, res);
    const smoke = isSmoke(req);
    // Expire stale walkthroughs FIRST — a 40-minute-old abandoned session
    // must not trigger the supersede/settling logic below.
    pruneSessions();
    // Sessions are PER-VISITOR: someone else's walkthrough never blocks
    // yours (judges must never find a locked door). The only global mutex is
    // the on-chain signing lock — steps colliding there get a retry-soon 429.
    const existing = myActiveSession(cid, ip);
    // Same visitor starting over (e.g. picked a new story) — replace their
    // old session, EXCEPT while a transaction is signing or settling:
    // superseding then would release a payout reservation whose transfer may
    // still land (ledger corruption).
    if (existing) {
      const settling = existing.steps.some((st) => st.status === "running");
      if (settling) {
        res.status(409).json({
          error:
            "Your existing walkthrough has a transaction still settling — resume it instead of starting a new one.",
          session: publicSession(existing),
        });
        return;
      }
      endSession(existing, "failed", "Replaced by a new walkthrough.");
    }
    const h = await cachedHealth().catch(() => null);
    if (!h || h.paused) {
      const warming = Date.now() - BOOT_TS < WARMING_MS;
      res.status(503).json({
        error: warming
          ? "The desk just restarted and is warming up — ready in under a minute, hang tight."
          : "Live judge mode is temporarily paused — the Casper node is unreachable.",
        paused: true,
        warming,
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
      ownerCid: cid || undefined,
      smoke,
      poolBefore: (await cachedPool()).snap ?? undefined,
      ctx: { supplierOverride },
    };
    sessions.set(s.id, s);
    order.push(s.id);
    // Store cap enforcement lives in pruneSessions — it never deletes an
    // active or mid-transaction walkthrough (the old blind shift() could).
    pruneSessions();
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
    const i = s.cursor;
    const def = s.defs[i];
    const step = s.steps[i];
    if (!def || (step.status !== "ready" && step.status !== "failed")) {
      res.status(409).json({ error: "no step ready to run", session: publicSession(s) });
      return;
    }
    // ONLY chain steps take the global signing mutex — AI underwriting and
    // other compute steps from different visitors run freely in parallel
    // ("one at a time" means one SIGNATURE, not one visitor).
    const needsSigner = def.kind === "chain";
    if (needsSigner && STEPPING) {
      res.status(429).json({
        error:
          "Another visitor's transaction is signing right now (one signature at a time on-chain) — you're next.",
        retryAfterMs: 4000,
      });
      return;
    }
    // Global daily gas budget for signed steps (reads are free).
    if (needsSigner && !s.smoke) {
      const gas = canSignDeploy();
      if (!gas.ok) {
        res.status(429).json({ error: gas.reason });
        return;
      }
    }

    if (needsSigner) STEPPING = true;
    // While the CLI's event watcher waits for finality, ask the node directly
    // every 8 s — visitors compare against the explorer, which indexes faster
    // than the event stream delivers ("CSPR.live shows success, why is this
    // still signing?" was a real user report).
    let confirmProbe: ReturnType<typeof setInterval> | undefined;
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
      // Live sub-step feed: phase notes + the deploy hash the moment the CLI
      // prints it — the visitor sees "submitted, tx 77a6…" while finality is
      // still pending instead of a silent bar. Chain steps only: the sink is
      // a single global slot, safe precisely BECAUSE of the signing mutex.
      step.phaseNote = needsSigner ? "preparing the transaction…" : undefined;
      if (needsSigner) {
        setLiveProgressSink((p) => {
          if (p.phase) step.phaseNote = p.phase;
          if (p.txHash && !step.txHash) {
            step.txHash = p.txHash;
            step.explorerUrl = deployUrl(p.txHash);
          }
        });
        // Phase 1: ask the node until it reports execution. Phase 2: tick a
        // visible catch-up counter (with the block hash) until the CLI's
        // event watcher delivers — or a later sub-operation takes over the
        // narration, at which point the probe retires.
        let confirmedTs = 0;
        let confirmedBlock = "";
        confirmProbe = setInterval(() => {
          if (step.status !== "running") return;
          if (confirmedTs) {
            if (step.phaseNote && !step.phaseNote.startsWith("confirmed on-chain")) {
              if (confirmProbe) clearInterval(confirmProbe);
              confirmProbe = undefined;
              return;
            }
            const secs = Math.round((Date.now() - confirmedTs) / 1000);
            step.phaseNote = `confirmed on-chain (block ${confirmedBlock}…) — the signer's event stream is catching up · ${secs}s`;
            return;
          }
          if (!step.txHash) return;
          void txExecuted(step.txHash).then((block) => {
            if (block && step.status === "running" && !confirmedTs) {
              confirmedTs = Date.now();
              confirmedBlock = block;
              step.phaseNote = `confirmed on-chain (block ${block}…) — the signer's event stream is catching up`;
            }
          });
        }, 5000);
      }
      const out = await def.run(s);
      step.result = out.result;
      if (out.decision) step.decision = out.decision;
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
        if (!s.poolAfter && !s.ctx.poolAfterPending) {
          // Best-effort from the warm cache — never block "done" on a cold read.
          // (When a background fill is already in flight — a settle/default just
          // changed the pool — the cache would resurrect the PRE-transaction
          // numbers and the finish panel would contradict the step above it;
          // let the fill land and the client polls it in.)
          s.poolAfter = (await cachedPool().catch(() => ({ snap: null }))).snap ?? undefined;
          if (!s.poolAfter) fillPoolAfterInBackground(s);
        }
        // Public receipt: the proof that a real walkthrough just happened.
        // Recorded in the ring for the homepage AND persisted per-run so the
        // proof link survives the ring rolling over.
        const run: RecentRun = {
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
          // credit-receipt.v1 enrichment — everything a verifier re-hashes
          invoiceId: s.ctx.record?.id ?? s.ctx.report?.invoiceId,
          faceCspr: s.ctx.record?.intake.amountCspr,
          memo: s.ctx.record?.memo ?? s.ctx.report?.memo ?? null,
          decisionHash: s.ctx.record?.decision?.decisionHash ?? s.ctx.report?.decisionHash,
          consumerVerdict: s.ctx.consumerVerdict,
          poolBefore: s.poolBefore ?? null,
          poolAfter: s.poolAfter ?? null,
        };
        recordRecentRun(run);
        persistReceipt(run);
      } else {
        s.steps[s.cursor].status = "ready";
      }
      try {
        res.json(publicSession(s));
      } catch {
        /* client refreshed/closed mid-step — state is saved; they reattach via GET */
      }
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
      try {
        res.json(publicSession(s));
      } catch {
        /* client gone — failure state is saved for reattach */
      }
    } finally {
      if (confirmProbe) clearInterval(confirmProbe);
      if (needsSigner) setLiveProgressSink(null);
      step.phaseNote = undefined;
      s.ctx.retrying = false;
      // Release ONLY if this call took the mutex — a compute step finishing
      // must never free another visitor's in-flight signing lock.
      if (needsSigner) STEPPING = false;
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

/**
 * Keep the default-workout preset ALWAYS playable: when neither an overdue
 * funded invoice nor a ripening short-dated seed exists, register + fund a
 * tiny 2 CSPR invoice due in 60 s. Rate-limited (one seed per 10 min) and it
 * spends the same daily gas budget as everything else.
 */
let lastSeedTs = 0;
const SEED_COOLDOWN_MS = 10 * 60_000;

async function replenishDefaultInventory(): Promise<boolean> {
  if (Date.now() - lastSeedTs < SEED_COOLDOWN_MS) return false;
  // Seeding signs TWO deploys (register + fund) — starting it with one budget
  // slot left would strand a registered-but-unfunded invoice.
  if (!canSignDeploy(2).ok) return false;
  const book = await cachedBook().catch(() => [] as BookInvoice[]);
  const hasOverdue = overdueFunded(book).length > 0;
  const hasRipening = book.some(
    (i) =>
      i.state === 1 &&
      i.dueTs + GRACE_MS + 5_000 >= Date.now() &&
      i.dueTs < Date.now() + 5 * 60_000,
  );
  if (hasOverdue || hasRipening) return false;
  // Re-check AFTER the async book read: a visitor may have taken the signing
  // mutex while we awaited — seeding anyway would run two signers at once
  // and narrate into their live progress feed.
  if (STEPPING) return false;
  if (!canSignDeploy(2).ok) return false;
  STEPPING = true;
  try {
    const supplier = await chain.caller("supplier");
    const now = Date.now();
    // REAL hashes, same canonical pipeline as every other invoice: a seed doc
    // that says exactly what this is, and a decision memo whose SHA-256 is the
    // on-chain decisionHash — so x402 buyers of THIS invoice's report get a
    // memo that re-hashes to the anchor, like any customer receivable.
    const seedDoc = {
      schema: "faktura.default-seed.v1",
      supplierName: "Faktura Desk — inventory seed",
      debtorName: "Overdue Demo Debtor Sp. z o.o.",
      amountCspr: 2,
      dueTs: now + 60_000,
      invoiceNumber: `seed-${now}`,
      description:
        "Short-dated 2 CSPR seed receivable: keeps the default-workout walkthrough playable by ripening into an overdue position within a minute.",
      history: "deliberately short-dated; expected to expire unpaid and be written off",
      createdAt: new Date(now).toISOString(),
    };
    const docHash = `sha256:${sha256(JSON.stringify(seedDoc))}`;
    const memo = buildDecisionMemo({
      intakeId: seedDoc.invoiceNumber,
      invoiceNumber: seedDoc.invoiceNumber,
      provider: "desk",
      model: "inventory-seeder",
      opinion: {
        approve: true,
        risk_score: 20,
        discount_bps: 200,
        rationale:
          "Inventory seed, not a customer receivable: a deliberately short-dated 2 CSPR invoice funded so the default-workout preset always has an overdue position for the collector to write off.",
        red_flags: ["short-dated by design", "expected to default"],
      },
      applied: { approve: true, risk_score: 20, discount_bps: 200 },
      policyNotes: ["inventory seed — auto-approved by the desk, sized at the demo minimum"],
    });
    const decisionHash = hashDecisionMemo(memo);
    recordDeploy("seed:register");
    const reg = await chain.register({
      supplier,
      debtorTag: "debtor:defaultseed",
      docHash,
      faceMotes: toMotes(2),
      dueTs: seedDoc.dueTs,
      risk: 20,
      discountBps: 200,
      decisionHash,
    });
    recordDeploy("seed:fund");
    const fund = await chain.fund(reg.result.invoiceId);
    // The local record makes the seed EXPLAINABLE: risk reports, receipts and
    // consumer verification read the memo + rationale from here.
    upsertInvoice({
      id: reg.result.invoiceId,
      intakeId: seedDoc.invoiceNumber,
      status: "funded",
      intake: {
        supplierName: seedDoc.supplierName,
        debtorName: seedDoc.debtorName,
        debtorTag: "debtor:defaultseed",
        amountCspr: seedDoc.amountCspr,
        dueTs: seedDoc.dueTs,
        invoiceNumber: seedDoc.invoiceNumber,
        description: seedDoc.description,
        history: seedDoc.history,
        docHash,
        receivedTs: now,
      },
      memo,
      decision: {
        approve: true,
        riskScore: 20,
        discountBps: 200,
        rationale: memo.opinion.rationale,
        redFlags: memo.opinion.red_flags,
        policyNotes: memo.policyNotes,
        model: "inventory-seeder",
        decisionHash,
        decidedTs: now,
      },
      chain: {
        registerHash: reg.deployHashes.at(-1),
        fundHash: fund.deployHashes.at(-1),
        attestHashes: [],
      },
    });
    bookCache.ts = 0;
    lastSeedTs = Date.now(); // full cooldown only after a SUCCESSFUL seed
    feed.publish({
      actor: "collector",
      kind: "onchain",
      message: `seeded default-workout inventory: invoice #${reg.result.invoiceId}, due in 60s`,
      deployHash: reg.deployHashes.at(-1),
    });
    return true;
  } catch (e) {
    // Short backoff (2 min) instead of the full cooldown: a transient RPC blip
    // must not leave the default preset unplayable for 10 minutes.
    lastSeedTs = Date.now() - SEED_COOLDOWN_MS + 2 * 60_000;
    feed.publish({
      actor: "system",
      kind: "error",
      message: `default-inventory seed failed: ${(e as Error).message.slice(-160)}`,
    });
    return false;
  } finally {
    STEPPING = false;
  }
}

async function cleanupTick() {
  pruneSessions();
  if (STEPPING) return;
  // First priority: keep the loss half of the story playable.
  if (await replenishDefaultInventory()) return;
  if (STEPPING) return;
  // Overdue positions are NOT settled away — they are the default-workout
  // preset's inventory (the loss half of the credit story).
  const stale = stalePositions(CLEANUP_IDLE_MS).filter(
    (p) => !(p.dueTs && p.dueTs + GRACE_MS + 5_000 < Date.now()),
  );
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
    bookCache.ts = 0;
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
