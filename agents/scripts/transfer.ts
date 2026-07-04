/**
 * Native CSPR transfer between demo personas — used to fund agent accounts
 * with gas (e.g. the collector) from the main agent account.
 *
 *   npx tsx scripts/transfer.ts <from-persona> <to-persona|01hexpubkey> <cspr>
 *   npx tsx scripts/transfer.ts agent collector 150
 */
import { config, type Persona } from "../src/config.js";
import { nativeTransfer, queryBalance, toPublicKey } from "../src/native-transfer.js";

async function main() {
  const [fromName, toName, csprStr] = process.argv.slice(2);
  if (!fromName || !toName || !csprStr) {
    console.error("usage: tsx scripts/transfer.ts <from-persona> <to-persona|01hex> <cspr>");
    process.exit(2);
  }
  const toHex = toPublicKey(toName).toHex();
  const motes = (BigInt(Math.round(Number(csprStr) * 1000)) * 1_000_000n).toString();

  const before = await queryBalance(toHex).catch(() => 0n);
  console.log(`-> ${toHex}`);
  console.log(`target balance before: ${Number(before / 1_000_000n) / 1000} CSPR`);

  const hash = await nativeTransfer({
    fromKeyPath: config.keys[fromName as Persona],
    to: toName,
    motes,
    id: Date.now() % 1_000_000,
  });
  console.log(`transfer deploy: ${hash}`);
  console.log(`explorer: ${config.explorerBase}/deploy/${hash}`);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 12_000));
    const now = await queryBalance(toHex).catch(() => before);
    if (now > before) {
      console.log(`✅ confirmed — target balance now ${Number(now / 1_000_000n) / 1000} CSPR`);
      return;
    }
    process.stdout.write(".");
  }
  throw new Error("transfer not observed within 6 min — check the explorer link above");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
