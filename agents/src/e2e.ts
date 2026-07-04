/**
 * End-to-end smoke against the LIVE Casper Testnet deployment:
 *   deposit -> 3 intakes (approve+fund+settle / reject / fund+default) -> stats.
 * Talks to the chain through the Odra livenet CLI (see contracts/bin/livenet.rs).
 * Prints a transaction evidence table at the end (explorer-verifiable).
 *
 *   FAKTURA_CONTRACT=hash-... npm run e2e
 *
 * The full run takes ~4-6 minutes (testnet finality per deploy, plus waiting
 * out the due date + grace before the collector's write-off). Set
 * FAKTURA_E2E_FAST=1 (make e2e-fast) to run only the happy path + rejection
 * (~2-3 minutes, no default-window wait).
 */
import { config } from "./config.js";
import { chain } from "./chain.js";
import { processIntake } from "./underwriter.js";
import { feed } from "./feed.js";
import { upsertInvoice } from "./store.js";

const CSPR = 1_000_000_000n; // motes
const motes = (cspr: number) => ((BigInt(Math.round(cspr * 1000)) * CSPR) / 1000n).toString();

feed.on("event", () => {});

const FAST = process.env.FAKTURA_E2E_FAST === "1";

const evidence: { step: string; tx: string }[] = [];
const track = (step: string, tx?: string) => {
  if (tx) evidence.push({ step, tx });
};

async function main() {
  console.log(`contract:  ${config.contract}`);
  console.log(`agent:     ${await chain.caller("agent")}   (underwriter: register/fund/attest)`);
  console.log(`collector: ${await chain.caller("collector")}   (workout desk: mark_default)`);
  console.log(`supplier:  ${await chain.caller("supplier")}   (receives advances)`);
  console.log(`investor:  ${await chain.caller("investor")}   (LP)`);
  console.log(`debtor:    ${await chain.caller("debtor")}   (pays settlements)`);

  const policy = await chain.policy();
  console.log(
    `\non-chain policy: risk<=${policy.maxRiskScore}, discount ${policy.minDiscountBps}-${policy.maxDiscountBps}bps, ` +
      `single<=${policy.maxSingleInvoiceBps}bps of pool, debtor<=${policy.maxDebtorExposureBps}bps`,
  );

  const before = await chain.stats();
  console.log("\n== stats before ==");
  console.log(
    `liquid ${Number(BigInt(before.liquid) / CSPR)} CSPR, invoices ${before.invoiceCount}`,
  );

  if (BigInt(before.liquid) < 150n * CSPR) {
    console.log("\nseeding pool with 200 CSPR from investor...");
    const dep = await chain.deposit(motes(200));
    track("LP deposit (investor)", dep.deployHashes.at(-1));
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
  console.log(
    `-> status=${r1.status} id=${r1.id} risk=${r1.decision?.riskScore} discount=${r1.decision?.discountBps}bps`,
  );
  console.log(`   advance recipient: ${r1.intake.supplierAddress}`);
  track("register_invoice #1 (agent)", r1.chain.registerHash);
  track("fund_invoice #1 → supplier (agent)", r1.chain.fundHash);
  track("attest UNDERWRITE_APPROVE #1 (agent)", r1.chain.attestHashes.at(-1));

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
  console.log(
    `-> status=${r2.status} risk=${r2.decision?.riskScore} flags=${r2.decision?.redFlags.join("|")}`,
  );
  track("attest UNDERWRITE_REJECT (agent)", r2.chain.attestHashes.at(-1));

  if (FAST) {
    console.log("\n(FAKTURA_E2E_FAST=1 — skipping the funded-then-default path)");
    if (r1.status === "funded") {
      console.log(`\n== settling invoice #${r1.id} (debtor pays 100 CSPR face value) ==`);
      const st = await chain.settle(r1.id, motes(100));
      track("settle_invoice (debtor)", st.deployHashes.at(-1));
      r1.chain.settleHash = st.deployHashes.at(-1);
      r1.status = "settled";
      upsertInvoice(r1);
      console.log("settled");
    }
    await printSummary();
    return;
  }

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
  track("register_invoice #3 (agent)", r3.chain.registerHash);
  track("fund_invoice #3 → supplier (agent)", r3.chain.fundHash);

  if (r1.status === "funded") {
    console.log(`\n== settling invoice #${r1.id} (debtor pays 100 CSPR face value) ==`);
    const st = await chain.settle(r1.id, motes(100));
    track("settle_invoice #1 (debtor)", st.deployHashes.at(-1));
    r1.chain.settleHash = st.deployHashes.at(-1);
    r1.status = "settled";
    upsertInvoice(r1);
    console.log(`settled`);
  }

  if (r3.status === "funded") {
    console.log(
      `\n== waiting out due + grace, then defaulting invoice #${r3.id} (collector key) ==`,
    );
    await new Promise((res) => setTimeout(res, (90 + 30 + 15) * 1000));
    const def = await chain.markDefault(r3.id);
    track("mark_default #3 (collector)", def.deployHashes.at(-1));
    r3.chain.defaultHash = def.deployHashes.at(-1);
    r3.status = "defaulted";
    upsertInvoice(r3);
    console.log(`invoice #${r3.id} written off on-chain`);
  }

  await printSummary();
}

async function printSummary() {
  const after = await chain.stats();
  console.log("\n== stats after ==");
  console.log(`liquid        ${Number(BigInt(after.liquid) / CSPR)} CSPR`);
  console.log(`deployed      ${Number(BigInt(after.deployed) / CSPR)} CSPR`);
  console.log(`totalFunded   ${Number(BigInt(after.totalFunded) / CSPR)} CSPR`);
  console.log(`totalSettled  ${Number(BigInt(after.totalSettled) / CSPR)} CSPR`);
  console.log(`invoices ${after.invoiceCount}, attestations ${after.attestationCount}`);

  console.log("\n== transaction evidence (paste into DORAHACKS.md) ==");
  for (const e of evidence) {
    console.log(
      `| ${e.step} | [\`${e.tx.slice(0, 10)}…\`](${config.explorerBase}/deploy/${e.tx}) |`,
    );
  }
  console.log(`\n✅ e2e complete — verify on ${config.explorerBase}/`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
