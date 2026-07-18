/**
 * Persistent anti-abuse ledger for the Live Judge Mode.
 *
 * The desk signs real (testnet) transactions for anonymous visitors, so every
 * budget here must survive restarts — a JSON file beats an in-memory Map that a
 * crash would reset, and avoids native-module (sqlite) friction on the CentOS 7
 * host. Volume is tiny (a handful of records per day).
 *
 * What is tracked:
 *   - payouts     — committed wallet payouts (one per wallet & per IP per 24 h,
 *                   plus a global daily CSPR cap)
 *   - reservations— payout budget is RESERVED at session creation and committed
 *                   or released later, so concurrent sessions cannot overshoot
 *   - runs        — walkthrough sessions created (per-IP hourly + per-preset +
 *                   global daily rate limits)
 *   - deploys     — every signed on-chain step (global daily gas budget)
 *   - positions   — funded invoices whose settle step hasn't happened yet; a
 *                   cleanup worker settles abandoned ones with the debtor key
 *   - recent      — the last few completed walkthroughs (public receipts)
 *
 * Writes are atomic (temp file + rename). The payout RESERVE path fails closed:
 * if the ledger cannot be persisted, no new payout session is accepted.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

interface PayoutRecord {
  wallet: string;
  ip: string;
  cspr: number;
  ts: number;
}

interface Reservation {
  sessionId: string;
  wallet: string;
  ip: string;
  cspr: number;
  ts: number;
}

interface RunRecord {
  ip: string;
  preset: string;
  ts: number;
}

interface DeployRecord {
  kind: string;
  ts: number;
}

export interface OpenPosition {
  sessionId: string;
  displayId: string;
  invoiceId: number;
  faceMotes: string;
  fundedTs: number;
  /** bumped whenever the owning session shows signs of life */
  lastTouchTs: number;
}

export interface RecentRunStep {
  key: string;
  title: string;
  status: string;
  txHash?: string;
  explorerUrl?: string;
  result?: string;
}

export interface RecentRun {
  displayId: string;
  preset: string;
  title: string;
  endedTs: number;
  /** shortened wallet ("0202…9f1c") when the visitor connected one */
  wallet?: string;
  steps: RecentRunStep[];
}

interface LimitsFile {
  payouts: PayoutRecord[];
  reservations: Reservation[];
  runs: RunRecord[];
  deploys: DeployRecord[];
  positions: OpenPosition[];
  recent: RecentRun[];
}

const FILE = () => path.join(config.dataDir, "judge-limits.json");
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** All caps are env-tunable without a redeploy. */
export const CAPS = {
  /** Global wallet-payout budget per rolling 24 h (testnet CSPR). */
  dailyPayoutCspr: Number(process.env.JUDGE_DAILY_PAYOUT_CSPR ?? 10),
  /** Walkthrough sessions per IP per rolling hour (a judge may restart a few times). */
  runsPerIpPerHour: Number(process.env.JUDGE_RUNS_PER_IP_HOUR ?? 4),
  /** Walkthrough sessions per rolling 24 h, all visitors combined. */
  runsPerDay: Number(process.env.JUDGE_RUNS_PER_DAY ?? 24),
  /** Signed on-chain steps per rolling 24 h (gas budget), all visitors combined. */
  deploysPerDay: Number(process.env.JUDGE_DEPLOYS_PER_DAY ?? 60),
  /** Per-preset session caps per rolling 24 h. */
  perPresetPerDay: {
    happy: Number(process.env.JUDGE_HAPPY_PER_DAY ?? 12),
    "policy-block": Number(process.env.JUDGE_POLICY_PER_DAY ?? 10),
    x402: Number(process.env.JUDGE_X402_PER_DAY ?? 15),
  } as Record<string, number>,
};

/** Kept for compatibility with existing imports/UI copy. */
export const DAILY_PAYOUT_CAP_CSPR = CAPS.dailyPayoutCspr;

const EMPTY: LimitsFile = {
  payouts: [],
  reservations: [],
  runs: [],
  deploys: [],
  positions: [],
  recent: [],
};

function load(): LimitsFile {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8")) as Partial<LimitsFile>;
    return {
      payouts: Array.isArray(d.payouts) ? d.payouts : [],
      reservations: Array.isArray(d.reservations) ? d.reservations : [],
      runs: Array.isArray(d.runs) ? d.runs : [],
      deploys: Array.isArray(d.deploys) ? d.deploys : [],
      positions: Array.isArray(d.positions) ? d.positions : [],
      recent: Array.isArray(d.recent) ? d.recent : [],
    };
  } catch {
    /* first run or corrupt file — start clean */
  }
  return structuredClone(EMPTY);
}

let state = load();

/**
 * Atomic persist (temp + rename). Throws on failure — callers on the money
 * path treat that as FAIL CLOSED; best-effort callers catch it themselves.
 */
function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE());
}

function saveBestEffort() {
  try {
    save();
  } catch (e) {
    console.error("judge-limits: persist failed (non-fatal):", (e as Error).message);
  }
}

/** Drop expired records (rolling windows) — called before every read/decision. */
function prune() {
  const now = Date.now();
  state.payouts = state.payouts.filter((p) => now - p.ts < DAY_MS);
  // A reservation older than 2 h belongs to a long-dead session.
  state.reservations = state.reservations.filter((r) => now - r.ts < 2 * HOUR_MS);
  state.runs = state.runs.filter((r) => now - r.ts < DAY_MS);
  state.deploys = state.deploys.filter((d) => now - d.ts < DAY_MS);
  if (state.recent.length > 10) state.recent = state.recent.slice(-10);
}

// ---- payout budget (reserve → commit / release) -----------------------------

export function spentLast24h(): number {
  prune();
  return (
    state.payouts.reduce((a, p) => a + p.cspr, 0) +
    state.reservations.reduce((a, r) => a + r.cspr, 0)
  );
}

/** Pure pre-check (no reservation) — lets /health explain the budget. */
export function canPayout(
  wallet: string,
  ip: string,
  cspr: number,
): { ok: boolean; reason?: string } {
  prune();
  const taken = [...state.payouts, ...state.reservations];
  if (taken.some((p) => p.wallet === wallet))
    return {
      ok: false,
      reason:
        "This wallet already received a payout in the last 24 h — run with the demo supplier instead.",
    };
  if (taken.some((p) => p.ip === ip))
    return {
      ok: false,
      reason:
        "This connection already received a payout in the last 24 h — run with the demo supplier instead.",
    };
  if (spentLast24h() + cspr > CAPS.dailyPayoutCspr)
    return {
      ok: false,
      reason:
        "The desk's daily payout budget is spent — wallet payouts resume tomorrow (demo runs still work).",
    };
  return { ok: true };
}

/**
 * Atomically reserve payout budget for a session BEFORE any signing starts.
 * Concurrent sessions each hold a reservation, so the global cap cannot be
 * overshot between check and fund. FAILS CLOSED: a persistence error rejects
 * the reservation (throws).
 */
export function reservePayout(
  sessionId: string,
  wallet: string,
  ip: string,
  cspr: number,
  bypass = false,
): { ok: boolean; reason?: string } {
  prune();
  if (!bypass) {
    const gate = canPayout(wallet, ip, cspr);
    if (!gate.ok) return gate;
  } else if (spentLast24h() + cspr > CAPS.dailyPayoutCspr) {
    return { ok: false, reason: "daily payout budget exhausted" };
  }
  state.reservations.push({ sessionId, wallet, ip, cspr, ts: Date.now() });
  save(); // throws on failure — fail closed, caller surfaces 503
  return { ok: true };
}

/** Convert the session's reservation into a committed payout (fund confirmed). */
export function commitPayout(sessionId: string, actualCspr: number) {
  prune();
  const i = state.reservations.findIndex((r) => r.sessionId === sessionId);
  const r = i >= 0 ? state.reservations.splice(i, 1)[0] : undefined;
  state.payouts.push({
    wallet: r?.wallet ?? "unknown",
    ip: r?.ip ?? "unknown",
    cspr: actualCspr,
    ts: Date.now(),
  });
  // The transfer already happened on-chain — persistence here is best-effort,
  // but the record stays in memory either way.
  saveBestEffort();
}

/** Session ended without a payout — return the reserved budget. */
export function releaseReservation(sessionId: string) {
  const before = state.reservations.length;
  state.reservations = state.reservations.filter((r) => r.sessionId !== sessionId);
  if (state.reservations.length !== before) saveBestEffort();
}

// ---- walkthrough + deploy budgets ------------------------------------------

export function canStartRun(ip: string, preset: string): { ok: boolean; reason?: string } {
  prune();
  const now = Date.now();
  const byIpHour = state.runs.filter((r) => r.ip === ip && now - r.ts < HOUR_MS).length;
  if (byIpHour >= CAPS.runsPerIpPerHour)
    return {
      ok: false,
      reason: `Rate limit: ${CAPS.runsPerIpPerHour} walkthroughs per hour per visitor — please come back in a little while.`,
    };
  if (state.runs.length >= CAPS.runsPerDay)
    return {
      ok: false,
      reason: "The desk's daily walkthrough budget is used up — live runs resume tomorrow.",
    };
  const presetCap = CAPS.perPresetPerDay[preset];
  if (presetCap && state.runs.filter((r) => r.preset === preset).length >= presetCap)
    return {
      ok: false,
      reason:
        "This walkthrough's daily budget is used up — try another story or come back tomorrow.",
    };
  return { ok: true };
}

export function recordRun(ip: string, preset: string) {
  state.runs.push({ ip, preset, ts: Date.now() });
  saveBestEffort();
}

export function deploysLast24h(): number {
  prune();
  return state.deploys.length;
}

export function canSignDeploy(): { ok: boolean; reason?: string } {
  prune();
  if (state.deploys.length >= CAPS.deploysPerDay)
    return {
      ok: false,
      reason:
        "The desk's daily on-chain budget is exhausted — live signing resumes within 24 h. Every step so far stays verifiable on CSPR.live.",
    };
  return { ok: true };
}

/** Recorded BEFORE execution — attempted deploys spend budget too. */
export function recordDeploy(kind: string) {
  state.deploys.push({ kind, ts: Date.now() });
  saveBestEffort();
}

// ---- open funded positions (auto-settle safety net) -------------------------

export function addPosition(p: Omit<OpenPosition, "lastTouchTs">) {
  state.positions = state.positions.filter((x) => x.invoiceId !== p.invoiceId);
  state.positions.push({ ...p, lastTouchTs: Date.now() });
  saveBestEffort();
}

export function touchPosition(sessionId: string) {
  const p = state.positions.find((x) => x.sessionId === sessionId);
  if (p) p.lastTouchTs = Date.now(); // memory-only touch is fine (cleanup re-checks chain)
}

export function resolvePosition(invoiceId: number) {
  const before = state.positions.length;
  state.positions = state.positions.filter((x) => x.invoiceId !== invoiceId);
  if (state.positions.length !== before) saveBestEffort();
}

export function stalePositions(olderThanMs: number): OpenPosition[] {
  const now = Date.now();
  return state.positions.filter((p) => now - p.lastTouchTs > olderThanMs);
}

export function openPositionCount(): number {
  return state.positions.length;
}

// ---- public receipts of completed walkthroughs ------------------------------

export function recordRecentRun(run: RecentRun) {
  state.recent.push(run);
  if (state.recent.length > 10) state.recent = state.recent.slice(-10);
  saveBestEffort();
}

export function recentRuns(limit = 5): RecentRun[] {
  return state.recent.slice(-limit).reverse();
}
