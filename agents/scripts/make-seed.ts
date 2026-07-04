/**
 * Captures the LIVE testnet contract state + the local underwriting records
 * into agents/data/seed.json — the read-only snapshot served by the hosted
 * showcase. Run right after `npm run e2e` against the same contract.
 *
 *   FAKTURA_CONTRACT=hash-... npx tsx scripts/make-seed.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chain } from "../src/chain.js";
import { config } from "../src/config.js";
import { db } from "../src/store.js";
import type { FeedEvent } from "../src/feed.js";

async function main() {
  if (config.showcase) throw new Error("run against the live chain (unset FAKTURA_SHOWCASE)");
  if (!config.contract) throw new Error("FAKTURA_CONTRACT not set");

  const [stats, onchain, policy] = await Promise.all([
    chain.stats(),
    chain.invoices(1, 200),
    chain.policy(),
  ]);
  const personas: Record<string, string> = {};
  for (const p of ["agent", "collector", "supplier", "investor", "debtor"] as const) {
    personas[p] = await chain.caller(p);
  }

  // Reconstruct a believable activity feed from the recorded pipeline runs —
  // every deployHash in it is a real testnet transaction.
  const feed: FeedEvent[] = [];
  const push = (e: Omit<FeedEvent, "ts"> & { ts: number }) => feed.push(e as FeedEvent);
  for (const r of [...db.invoices].sort((a, b) => a.intake.receivedTs - b.intake.receivedTs)) {
    push({
      ts: r.intake.receivedTs,
      actor: "underwriter",
      kind: "intake",
      message: `Intake ${r.intake.invoiceNumber}: ${r.intake.supplierName} → ${r.intake.debtorName}, ${r.intake.amountCspr} CSPR`,
    });
    if (r.decision) {
      push({
        ts: r.decision.decidedTs,
        actor: "underwriter",
        kind: "decision",
        message: r.decision.approve
          ? `APPROVED ${r.intake.invoiceNumber}: risk ${r.decision.riskScore}/100, discount ${(r.decision.discountBps / 100).toFixed(2)}% — registering on-chain`
          : `REJECTED ${r.intake.invoiceNumber}: ${r.decision.redFlags.join("; ") || r.decision.rationale.slice(0, 120)}`,
      });
    }
    if (r.chain.registerHash)
      push({
        ts: (r.decision?.decidedTs ?? r.intake.receivedTs) + 30_000,
        actor: "underwriter",
        kind: "onchain",
        message: `Invoice #${r.id} registered on Casper Testnet`,
        invoiceId: r.id,
        deployHash: r.chain.registerHash,
      });
    if (r.chain.fundHash)
      push({
        ts: (r.decision?.decidedTs ?? r.intake.receivedTs) + 75_000,
        actor: "underwriter",
        kind: "onchain",
        message: `Invoice #${r.id} FUNDED — advance paid from the pool to supplier ${(r.intake.supplierAddress ?? "").replace("entity-account-", "account-hash-").slice(0, 26)}…`,
        invoiceId: r.id,
        deployHash: r.chain.fundHash,
      });
    for (const h of r.chain.attestHashes.filter(Boolean))
      push({
        ts: (r.decision?.decidedTs ?? r.intake.receivedTs) + 110_000,
        actor: "underwriter",
        kind: "attest",
        message: `Decision memo hash anchored on-chain (${r.intake.invoiceNumber})`,
        invoiceId: r.id || undefined,
        deployHash: h,
      });
    if (r.chain.settleHash)
      push({
        ts: (r.decision?.decidedTs ?? r.intake.receivedTs) + 200_000,
        actor: "collector",
        kind: "reconcile",
        message: `Invoice #${r.id} settled on-chain — face value collected, yield realized by the pool`,
        invoiceId: r.id,
        deployHash: r.chain.settleHash,
      });
    if (r.chain.defaultHash)
      push({
        ts: (r.decision?.decidedTs ?? r.intake.receivedTs) + 260_000,
        actor: "collector",
        kind: "onchain",
        message: `Invoice #${r.id} written off on-chain by the collector; loss absorbed by pool share price`,
        invoiceId: r.id,
        deployHash: r.chain.defaultHash,
      });
  }
  feed.sort((a, b) => a.ts - b.ts);

  const seed = {
    capturedAt: new Date().toISOString(),
    contract: config.contract,
    explorer: config.explorerBase,
    stats,
    onchain,
    policy,
    personas,
    records: db.invoices,
    feed,
  };
  const out = config.seedPath;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(seed, null, 2));
  console.log(
    `seed written: ${out} — ${onchain.length} on-chain invoices, ${db.invoices.length} records, ${feed.length} feed events`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
