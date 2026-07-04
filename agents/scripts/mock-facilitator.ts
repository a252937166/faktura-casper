/**
 * Reference x402 facilitator for Casper — implements the standard
 * `POST /verify` API and REALLY verifies the settlement deploy over RPC
 * (executed, right payee, amount, transfer-id nonce). Used to exercise
 * X402_MODE=official-facilitator end-to-end without external infrastructure.
 *
 *   npm run facilitator          # listens on :4402
 */
import express from "express";
import { config } from "../src/config.js";

const PORT = Number(process.env.FACILITATOR_PORT ?? 4402);

async function rpc(method: string, params: unknown) {
  const res = await fetch(`${config.nodeAddress}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: any; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const app = express();
app.use(express.json());

app.post("/verify", async (req, res) => {
  try {
    const { paymentHeader, paymentRequirements } = req.body ?? {};
    const deployHash = String(paymentHeader ?? "").trim();
    const reqs = paymentRequirements ?? {};
    const nonce = String(reqs.extra?.transferIdNonce ?? "");
    const payTo = String(reqs.payTo ?? "").toLowerCase();
    const minAmount = BigInt(reqs.maxAmountRequired ?? "0");

    const info = await rpc("info_get_deploy", { deploy_hash: deployHash });
    const session = info?.deploy?.session?.Transfer?.args as [string, any][] | undefined;
    if (!session) {
      res.json({ isValid: false, invalidReason: "not a native transfer" });
      return;
    }
    const arg = (n: string) => session.find(([k]) => k === n)?.[1]?.parsed as string | undefined;
    const results = info?.execution_info?.execution_result ?? info?.execution_results;
    const v2 = (results as { Version2?: { error_message: string | null } } | undefined)?.Version2;
    const success = v2
      ? v2.error_message == null
      : JSON.stringify(results ?? "").includes("Success");

    let reason: string | null = null;
    if (!success) reason = "deploy not (yet) successful";
    else if (BigInt(arg("amount") ?? "0") < minAmount) reason = "amount below price";
    else if (!(arg("target") ?? "").toLowerCase().includes(payTo.replace(/^01|^02/, "")))
      reason = "wrong payee";
    else if (String(arg("id") ?? "") !== nonce) reason = "nonce mismatch";

    console.log(`[facilitator] verify ${deployHash.slice(0, 10)}… → ${reason ?? "VALID"}`);
    res.json(reason ? { isValid: false, invalidReason: reason } : { isValid: true });
  } catch (e) {
    res.json({ isValid: false, invalidReason: (e as Error).message.slice(0, 200) });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[facilitator] reference x402 facilitator on :${PORT} — POST /verify`);
});
