/**
 * Demo x402 client: a third-party agent buying a verified risk report from
 * the Faktura oracle, machine-to-machine, with on-chain settlement.
 *
 *   npx tsx src/x402-client.ts <invoiceId>
 *
 * Flow: GET -> 402 + PaymentRequirements -> native CSPR transfer with the
 * nonce as transfer id (signed by the buyer key, in-process via
 * casper-js-sdk — no casper-client CLI needed) -> retry with
 * PAYMENT-SIGNATURE: <deployHash> -> 200 risk report.
 */
import { config } from "./config.js";
import { nativeTransfer } from "./native-transfer.js";

const invoiceId = process.argv[2] ?? "1";
const base = process.env.FAKTURA_API ?? `http://localhost:${config.port}`;
const buyerKey = process.env.BUYER_KEY_PATH ?? config.keys.debtor;

async function main() {
  console.log(`[buyer-agent] requesting risk report for invoice #${invoiceId} ...`);
  const first = await fetch(`${base}/api/risk/${invoiceId}`);
  if (first.status !== 402) {
    console.log(`[buyer-agent] unexpected status ${first.status}:`, await first.text());
    return;
  }
  const req402 = (await first.json()) as any;
  const offer = req402.accepts[0];
  const nonce: string = offer.extra.transferIdNonce;
  console.log(
    `[buyer-agent] 402 Payment Required: ${Number(offer.maxAmountRequired) / 1e9} CSPR to ${offer.payTo} (nonce ${nonce})`,
  );

  console.log(`[buyer-agent] settling on-chain via native transfer ...`);
  const deployHash = await nativeTransfer({
    fromKeyPath: buyerKey,
    to: offer.payTo,
    motes: offer.maxAmountRequired,
    id: nonce,
  });
  console.log(`[buyer-agent] payment deploy: ${deployHash} — waiting for execution ...`);

  // Poll until executed (up to ~2 min).
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const retry = await fetch(`${base}/api/risk/${invoiceId}`, {
      headers: { "PAYMENT-SIGNATURE": deployHash, "PAYMENT-NONCE": nonce },
    });
    if (retry.status === 200) {
      console.log(`[buyer-agent] ✅ paid content received:`);
      console.log(JSON.stringify(await retry.json(), null, 2));
      return;
    }
    const body = await retry.json().catch(() => ({}));
    console.log(`[buyer-agent] not settled yet (${retry.status}): ${(body as any).error ?? ""}`);
  }
  throw new Error("payment did not settle in time");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
