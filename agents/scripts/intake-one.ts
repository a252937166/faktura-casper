/**
 * Runs a single invoice through the live underwriting pipeline (register +
 * fund + attest on testnet). Used to leave a FUNDED invoice in the showcase
 * seed and to drive live demos.
 *
 *   FAKTURA_CONTRACT=hash-... npx tsx scripts/intake-one.ts
 */
import { processIntake } from "../src/underwriter.js";
import { feed } from "../src/feed.js";

feed.on("event", () => {});

const r = await processIntake({
  supplierName: process.env.INTAKE_SUPPLIER ?? "Baltic Components OÜ",
  debtorName: process.env.INTAKE_DEBTOR ?? "Vega Manufacturing GmbH",
  amountCspr: Number(process.env.INTAKE_AMOUNT ?? 80),
  dueTs: Date.now() + Number(process.env.INTAKE_DUE_DAYS ?? 45) * 86_400_000,
  invoiceNumber: process.env.INTAKE_NUMBER ?? "INV-2026-504",
  description: process.env.INTAKE_DESC ?? "Precision-machined housings, batch 7 of 12, net 45",
  history: process.env.INTAKE_HISTORY ?? "4 prior invoices, all paid on time",
});

console.log(
  JSON.stringify(
    {
      status: r.status,
      id: r.id,
      risk: r.decision?.riskScore,
      discountBps: r.decision?.discountBps,
      supplier: r.intake.supplierAddress,
      txs: r.chain,
    },
    null,
    2,
  ),
);
process.exit(0);
