/**
 * Persistent anti-abuse limits for the Live Judge Mode payout path.
 *
 * The desk pays a real (testnet) advance to visitor wallets, so the budget
 * must survive restarts — a JSON file beats an in-memory Map that a crash
 * would reset, and avoids native-module (sqlite) friction on the CentOS 7
 * host. Volume is tiny (one record per payout).
 *
 * Rules enforced here:
 *   - one wallet payout per wallet per 24 h
 *   - one wallet payout per IP per 24 h
 *   - a global daily payout budget in CSPR
 * Demo-supplier walkthroughs are NOT counted (no external outflow).
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

interface LimitsFile {
  payouts: PayoutRecord[];
}

const FILE = () => path.join(config.dataDir, "judge-limits.json");
const DAY_MS = 24 * 3600_000;

/** Global payout budget per rolling 24 h window (testnet CSPR). */
export const DAILY_PAYOUT_CAP_CSPR = Number(process.env.JUDGE_DAILY_PAYOUT_CSPR ?? 10);

function load(): LimitsFile {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8")) as LimitsFile;
    if (Array.isArray(d.payouts)) return d;
  } catch {
    /* first run or corrupt file — start clean */
  }
  return { payouts: [] };
}

function save(d: LimitsFile) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(d));
  } catch {
    /* disk hiccup — limits degrade to in-memory for this process */
  }
}

let state = load();

function fresh(): PayoutRecord[] {
  const cutoff = Date.now() - DAY_MS;
  const live = state.payouts.filter((p) => p.ts >= cutoff);
  if (live.length !== state.payouts.length) {
    state = { payouts: live };
    save(state);
  }
  return live;
}

export function spentLast24h(): number {
  return fresh().reduce((a, p) => a + p.cspr, 0);
}

/** Pre-check BEFORE creating a wallet-payout session — fail fast with a reason. */
export function canPayout(
  wallet: string,
  ip: string,
  cspr: number,
): { ok: boolean; reason?: string } {
  const live = fresh();
  if (live.some((p) => p.wallet === wallet))
    return {
      ok: false,
      reason:
        "This wallet already received a payout in the last 24 h — run with the demo supplier instead.",
    };
  if (live.some((p) => p.ip === ip))
    return {
      ok: false,
      reason:
        "This connection already received a payout in the last 24 h — run with the demo supplier instead.",
    };
  if (spentLast24h() + cspr > DAILY_PAYOUT_CAP_CSPR)
    return {
      ok: false,
      reason:
        "The desk's daily payout budget is spent — wallet payouts resume tomorrow (demo runs still work).",
    };
  return { ok: true };
}

/** Record AFTER the fund transaction confirms. */
export function recordPayout(wallet: string, ip: string, cspr: number) {
  state.payouts.push({ wallet, ip, cspr, ts: Date.now() });
  save(state);
}
