/**
 * End-to-end smoke against the LIVE Casper Testnet deployment:
 *   deposit -> 3 intakes (approve+fund+settle / reject / fund+default) -> stats.
 * Talks to the chain through the Odra livenet CLI (see contracts/bin/livenet.rs).
 *
 *   FAKTURA_CONTRACT=contract-package-... npx tsx src/e2e.ts
 */
import { config } from "./config.js";
import { chain } from "./chain.js";
import { processIntake } from "./underwriter.js";
import { feed } from "./feed.js";

const CSPR = 1_000_000_000n; // motes
const motes = (cspr: number) => (BigInt(Math.round(cspr * 1000)) * CSPR / 1000n).toString();

feed.on("event", () => {});

async function main() {
  console.log(`contract: ${config.contract}`);
  console.log(`agent:    ${await chain.caller("agent")}`);
  console.log(`investor: ${await chain.caller("investor")}`);
  console.log(`debtor:   ${await chain.caller("debtor")}`);

  const before = await chain.stats();
  console.log("\n== stats before ==");
  console.log(`liquid ${Number(BigInt(before.liquid) / CSPR)} CSPR, invoices ${before.invoiceCount}`);

  if (BigInt(before.liquid) < 150n * CSPR) {
    console.log("\nseeding pool with 200 CSPR from investor...");
    await chain.deposit(motes(200));
  }

  const day = 86_400_000;

  console.log("\n== intake 1: clean invoice (expect APPROVE + fund + settle) ==");
  const r1 = await processIntake({
    supplierName: "Nordwind Logistics GmbH",
    debtorName: "Aurora Retail AG",
    amountCspr: 100,
    dueTs: Date.now() + 30 * day,
    invoiceNumber: "INV-2026-501",
    description: "Freight services, 14 pallet shipments Hamburg to Vienna",
    history: "6 prior invoices, all paid within terms",
  });
  console.log(`-> status=${r1.status} id=${r1.id} risk=${r1.decision?.riskScore} discount=${r1.decision?.discountBps}bps`);

  console.log("\n== intake 2: sketchy invoice (expect REJECT) ==");
  const r2 = await processIntake({
    supplierName: "QuickCash Trading",
    debtorName: "Unknown Shell Ltd",
    amountCspr: 40,
    dueTs: Date.now() + 90 * day,
    invoiceNumber: "INV-2026-502",
    description: "Consulting, lump sum, no deliverables specified",
    history: "new counterparty, one prior invoice disputed and overdue",
  });
  console.log(`-> status=${r2.status} risk=${r2.decision?.riskScore} flags=${r2.decision?.redFlags.join("|")}`);

  console.log("\n== intake 3: short-dated invoice (expect APPROVE + fund, then DEFAULT) ==");
  const r3 = await processIntake({
    supplierName: "Helios Solar Kft",
    debtorName: "Metro Utilities Zrt",
    amountCspr: 50,
    dueTs: Date.now() + 90_000, // 90s -> exercises the collector's default path live
    invoiceNumber: "INV-2026-503",
    description: "Panel maintenance, Q1 service contract",
    history: "3 prior invoices paid on time",
  });
  console.log(`-> status=${r3.status} id=${r3.id} risk=${r3.decision?.riskScore}`);

  if (r1.status === "funded") {
    console.log(`\n== settling invoice #${r1.id} (debtor pays 100 CSPR face value) ==`);
    await chain.settle(r1.id, motes(100));
    console.log(`settled`);
  }

  if (r3.status === "funded") {
    console.log(`\n== waiting out due + grace, then defaulting invoice #${r3.id} ==`);
    await new Promise((res) => setTimeout(res, (90 + 30 + 15) * 1000));
    await chain.markDefault(r3.id);
    console.log(`invoice #${r3.id} written off on-chain`);
  }

  const after = await chain.stats();
  console.log("\n== stats after ==");
  console.log(`liquid        ${Number(BigInt(after.liquid) / CSPR)} CSPR`);
  console.log(`deployed      ${Number(BigInt(after.deployed) / CSPR)} CSPR`);
  console.log(`totalFunded   ${Number(BigInt(after.totalFunded) / CSPR)} CSPR`);
  console.log(`totalSettled  ${Number(BigInt(after.totalSettled) / CSPR)} CSPR`);
  console.log(`invoices ${after.invoiceCount}, attestations ${after.attestationCount}`);
  console.log(`\n✅ e2e complete — verify on https://testnet.cspr.live/`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
