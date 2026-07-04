import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "./config.js";
import type { ChainInvoice, ChainPolicy, ChainResult, ChainStats } from "./chain.js";

/**
 * In-memory "chain" for the hosted public showcase. Reads come from a captured
 * seed snapshot of the REAL Casper Testnet contract (verifiable on cspr.live);
 * writes are simulated so visitors can exercise the live AI underwriter without
 * a Rust binary, secret keys, testnet gas, or 30–120s confirmation waits.
 * The seeded invoices keep their real deploy hashes; simulated writes get
 * placeholder hashes and are clearly transient demo state.
 */
export interface Seed {
  stats: ChainStats;
  onchain: ChainInvoice[];
  contract: string;
  explorer: string;
  policy?: ChainPolicy;
  personas?: Record<string, string>;
  records?: unknown[];
  feed?: unknown[];
}

let _seed: Seed | null = null;
export function getSeed(): Seed {
  if (!_seed) _seed = JSON.parse(fs.readFileSync(config.seedPath, "utf8")) as Seed;
  return _seed;
}

const pseudoHash = () => crypto.randomBytes(32).toString("hex");
const ok = <T>(result: T): ChainResult<T> => ({
  result,
  deployHashes: [pseudoHash()],
  raw: "showcase-simulated",
});
const big = (s: string) => BigInt(s);

export const showcaseChain = {
  stats: async (): Promise<ChainStats> => getSeed().stats,
  invoices: async (): Promise<ChainInvoice[]> => getSeed().onchain,
  invoice: async (id: number): Promise<ChainInvoice | null> =>
    getSeed().onchain.find((i) => i.id === id) ?? null,

  // Real testnet persona addresses (captured in the seed) so the showcase
  // shows the same accounts a live run uses; falls back to a labeled stub.
  caller: async (persona = "agent"): Promise<string> =>
    getSeed().personas?.[persona] ??
    "account-hash-025a06c0d1c3e2b4f6a8c0e2d4f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",

  register: async (a: {
    supplier: string;
    debtorTag: string;
    docHash: string;
    faceMotes: string;
    dueTs: number;
    risk: number;
    discountBps: number;
    decisionHash: string;
  }): Promise<ChainResult<{ invoiceId: number }>> => {
    const s = getSeed();
    const id = s.onchain.reduce((m, i) => Math.max(m, i.id), 0) + 1;
    const advance = (big(a.faceMotes) * BigInt(10_000 - a.discountBps)) / 10_000n;
    s.onchain.push({
      id,
      supplier: a.supplier,
      debtorTag: a.debtorTag,
      docHash: a.docHash,
      faceValue: a.faceMotes,
      dueTs: a.dueTs,
      riskScore: a.risk,
      discountBps: a.discountBps,
      decisionHash: a.decisionHash,
      state: 0,
      advance: advance.toString(),
      registeredTs: Date.now(),
      fundedTs: 0,
      closedTs: 0,
    });
    s.stats.invoiceCount += 1;
    return ok({ invoiceId: id });
  },

  fund: async (id: number): Promise<ChainResult<{ funded: number }>> => {
    const s = getSeed();
    const inv = s.onchain.find((i) => i.id === id);
    if (inv && inv.state === 0) {
      inv.state = 1;
      inv.fundedTs = Date.now();
      const adv = big(inv.advance);
      s.stats.liquid = (big(s.stats.liquid) - adv).toString();
      s.stats.deployed = (big(s.stats.deployed) + adv).toString();
      s.stats.totalFunded = (big(s.stats.totalFunded) + adv).toString();
    }
    return ok({ funded: 1 });
  },

  settle: async (id: number, amountMotes: string): Promise<ChainResult<{ settled: number }>> => {
    const s = getSeed();
    const inv = s.onchain.find((i) => i.id === id);
    if (inv && inv.state === 1) {
      inv.state = 2;
      inv.closedTs = Date.now();
      s.stats.deployed = (big(s.stats.deployed) - big(inv.advance)).toString();
      s.stats.liquid = (big(s.stats.liquid) + big(amountMotes)).toString();
      s.stats.totalSettled = (big(s.stats.totalSettled) + big(amountMotes)).toString();
    }
    return ok({ settled: 1 });
  },

  markDefault: async (id: number): Promise<ChainResult<{ defaulted: number }>> => {
    const s = getSeed();
    const inv = s.onchain.find((i) => i.id === id);
    if (inv && inv.state === 1) {
      inv.state = 3;
      inv.closedTs = Date.now();
      const adv = big(inv.advance);
      s.stats.deployed = (big(s.stats.deployed) - adv).toString();
      s.stats.totalDefaulted = (big(s.stats.totalDefaulted) + adv).toString();
    }
    return ok({ defaulted: 1 });
  },

  deposit: async (amountMotes: string): Promise<ChainResult<{ deposited: string }>> => {
    const s = getSeed();
    const m = big(amountMotes);
    const tvl = big(s.stats.liquid) + big(s.stats.deployed);
    const shares = big(s.stats.totalShares);
    const minted = tvl > 0n && shares > 0n ? (m * shares) / tvl : m;
    s.stats.liquid = (big(s.stats.liquid) + m).toString();
    s.stats.totalShares = (shares + minted).toString();
    return ok({ deposited: amountMotes });
  },

  attest: async (
    _kind: string,
    _subjectId: number,
    _payloadHash: string,
    _model: string,
    _persona = "agent",
  ): Promise<ChainResult<{ attestationId: number }>> => {
    const s = getSeed();
    s.stats.attestationCount += 1;
    return ok({ attestationId: s.stats.attestationCount });
  },

  // Mirrors the on-chain Policy defaults set at deploy (see contracts/src/lib.rs).
  policy: async (): Promise<ChainPolicy> =>
    getSeed().policy ?? {
      maxRiskScore: 70,
      minDiscountBps: 50,
      maxDiscountBps: 3000,
      maxSingleInvoiceBps: 5000,
      maxDebtorExposureBps: 6000,
    },
};
