/**
 * Submit invoices through the REAL LLM (Claude via the local CLI) so the
 * on-chain attestations carry genuine model decisions, not the deterministic
 * mock. Registers + funds approved invoices and anchors the decision on-chain.
 *
 *   LLM_PROVIDER=claude-cli FAKTURA_CONTRACT=hash-... npx tsx src/real-ai.ts
 */
import { config } from "./config.js";
import { chain } from "./chain.js";
import { processIntake } from "./underwriter.js";
import { feed } from "./feed.js";

feed.on("event", () => {});
const day = 86_400_000;

const INTAKES = [
  {
    supplierName: "Nordwind Logistics GmbH",
    debtorName: "Aurora Retail AG",
    amountCspr: 60,
    dueTs: Date.now() + 30 * day,
    invoiceNumber: "INV-2026-AI1",
    description: "March freight services, 14 pallet shipments Hamburg to Vienna, delivered and signed.",
    history: "6 prior invoices with Aurora, all paid within terms.",
  },
  {
    supplierName: "QuickCash Trading FZE",
    debtorName: "Meridian Shelf Holdings Ltd",
    amountCspr: 55,
    dueTs: Date.now() + 85 * day,
    invoiceNumber: "INV-2026-AI2",
    description: "Advisory retainer, lump sum, no itemized deliverables provided.",
    history: "New counterparty; the single prior invoice was disputed and settled 40 days late.",
  },
];

async function main() {
  console.log(`LLM provider: ${config.llmProvider}  (expect real Claude)`);
  const before = await chain.stats();
  console.log(`pool liquid ${Number(BigInt(before.liquid) / 1_000_000_000n)} CSPR, invoices ${before.invoiceCount}`);

  for (const intake of INTAKES) {
    console.log(`\n=== ${intake.invoiceNumber}: ${intake.supplierName} -> ${intake.debtorName} (${intake.amountCspr} CSPR) ===`);
    const t = Date.now();
    const r = await processIntake(intake);
    console.log(`  provider/model: ${r.decision?.model}`);
    console.log(`  decision: ${r.status.toUpperCase()}  risk=${r.decision?.riskScore}  discount=${r.decision?.discountBps}bps  (${((Date.now() - t) / 1000).toFixed(0)}s)`);
    console.log(`  rationale: ${r.decision?.rationale}`);
    if (r.decision?.redFlags?.length) console.log(`  red flags: ${r.decision.redFlags.join(" | ")}`);
    if (r.id) console.log(`  on-chain invoice #${r.id}; attest tx: ${r.chain.attestHashes.at(-1)}`);
  }

  const after = await chain.stats();
  console.log(`\n== after ==  invoices ${after.invoiceCount}, attestations ${after.attestationCount}, liquid ${Number(BigInt(after.liquid) / 1_000_000_000n)} CSPR`);
  console.log("done — real Claude decisions anchored on Casper Testnet.");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
