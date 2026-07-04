/**
 * One-command demo of X402_MODE=official-facilitator (live testnet only):
 * starts the reference facilitator, starts the Faktura service pointed at it,
 * then runs the buyer agent — the report is released only after the
 * facilitator's /verify approves the real settlement deploy.
 *
 *   FAKTURA_CONTRACT=hash-... npx tsx scripts/facilitator-demo.ts [invoiceId]
 */
import { spawn } from "node:child_process";

const invoiceId = process.argv[2] ?? "4";
const PORT = "4028";
const FPORT = "4402";
const kids: ReturnType<typeof spawn>[] = [];

function run(label: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn("npx", ["tsx", ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  kids.push(child);
  return child;
}

const cleanup = () => kids.forEach((k) => k.kill("SIGKILL"));
process.on("exit", cleanup);

async function waitFor(url: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function main() {
  run("facilitator", ["scripts/mock-facilitator.ts"], { FACILITATOR_PORT: FPORT });
  run("server", ["src/server.ts"], {
    PORT,
    X402_MODE: "official-facilitator",
    X402_FACILITATOR_URL: `http://127.0.0.1:${FPORT}`,
  });
  await waitFor(`http://127.0.0.1:${PORT}/api/meta`);
  console.log(
    `\n== buyer agent purchasing report for invoice #${invoiceId} (facilitator mode) ==\n`,
  );

  const buyer = run("buyer", ["src/x402-client.ts", invoiceId], {
    FAKTURA_API: `http://127.0.0.1:${PORT}`,
  });
  const code: number = await new Promise((res) => buyer.on("close", res));
  cleanup();
  process.exit(code ?? 1);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
