/**
 * Demo x402 client: a third-party agent buying a verified risk report from
 * the Faktura oracle, machine-to-machine, with on-chain settlement.
 *
 *   npx tsx src/x402-client.ts <invoiceId>
 *
 * Flow: GET -> 402 + PaymentRequirements -> native CSPR transfer with the
 * nonce as transfer id (signed by the buyer key) -> retry with
 * PAYMENT-SIGNATURE: <deployHash> -> 200 risk report.
 */
import { spawn } from "node:child_process";
import { config } from "./config.js";

const invoiceId = process.argv[2] ?? "1";
const base = process.env.FAKTURA_API ?? `http://localhost:${config.port}`;
const buyerKey = process.env.BUYER_KEY_PATH ?? config.keys.debtor;

function casperClient(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("casper-client", args);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || out))));
  });
}

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
  const out = await casperClient([
    "transfer",
    "--node-address",
    config.nodeAddress,
    "--chain-name",
    config.chainName,
    "--secret-key",
    buyerKey,
    "--amount",
    offer.maxAmountRequired,
    "--target-account",
    offer.payTo,
    "--transfer-id",
    nonce,
    "--payment-amount",
    "100000000",
  ]);
  const deployHash = out.match(/"deploy_hash":\s*"([0-9a-f]{64})"/)?.[1]
    ?? out.match(/\b[0-9a-f]{64}\b/)?.[0];
  if (!deployHash) throw new Error(`no deploy hash in casper-client output:\n${out}`);
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
