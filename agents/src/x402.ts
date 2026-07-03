import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { feed } from "./feed.js";

/**
 * x402 (HTTP 402 Payment Required) gate for the Faktura risk oracle.
 *
 * Follows the x402 PaymentRequirements shape used by the official Casper
 * implementation (make-software/casper-x402, `exact` scheme on the
 * `casper:casper-test` CAIP-2 chain), in **facilitator-less native mode**:
 * instead of CEP-18 `transfer_with_authorization` via a facilitator, the
 * client settles with a plain native CSPR transfer carrying a nonce as the
 * transfer id, and replays the request with the deploy hash as proof. The
 * server verifies execution, recipient, amount and nonce over RPC.
 *
 * This keeps the wire format x402-compatible while staying self-contained;
 * swapping in the official facilitator is a config change (see README).
 */

interface PendingCharge {
  nonce: string;
  createdTs: number;
}

const pending = new Map<string, PendingCharge>(); // nonce -> charge
const settledDeploys = new Set<string>(); // replay protection

function paymentRequirements(req: Request, nonce: string) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: `casper:${config.chainName}`,
        maxAmountRequired: config.x402.priceMotes,
        asset: "native-CSPR",
        payTo: config.x402.payTo,
        resource: req.originalUrl,
        description: "Faktura verified risk report (machine-payable oracle)",
        mimeType: "application/json",
        maxTimeoutSeconds: Math.floor(config.x402.ttlMs / 1000),
        extra: {
          settlement: "native-transfer",
          transferIdNonce: nonce,
          proofHeader: "PAYMENT-SIGNATURE",
          proofFormat: "deploy-hash-hex",
        },
      },
    ],
    error: "Payment required: settle the charge and retry with PAYMENT-SIGNATURE header.",
  };
}

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

/** Verifies a native transfer deploy: executed, paid to us, right amount + nonce. */
async function verifyPayment(deployHash: string, nonce: string): Promise<{ ok: boolean; reason?: string }> {
  if (settledDeploys.has(deployHash)) return { ok: false, reason: "deploy already used" };
  try {
    const info = await rpc("info_get_deploy", { deploy_hash: deployHash });
    const deploy = info?.deploy;
    const results = info?.execution_results ?? info?.execution_info?.execution_result;
    const session = deploy?.session?.Transfer?.args as [string, any][] | undefined;
    if (!session) return { ok: false, reason: "not a native transfer" };

    const arg = (name: string) =>
      session.find(([n]) => n === name)?.[1]?.parsed as string | undefined;

    const amount = arg("amount");
    const target = (arg("target") ?? "").toLowerCase();
    const id = String(arg("id") ?? "");
    const payTo = config.x402.payTo.toLowerCase().replace(/^account-hash-/, "");

    if (!amount || BigInt(amount) < BigInt(config.x402.priceMotes))
      return { ok: false, reason: `amount ${amount} < required ${config.x402.priceMotes}` };
    if (!target.includes(payTo.replace(/^01|^02/, "")) && target !== payTo)
      return { ok: false, reason: "wrong payee" };
    if (id !== nonce) return { ok: false, reason: "nonce mismatch" };

    const success = JSON.stringify(results ?? "").includes("Success");
    if (!success) return { ok: false, reason: "deploy not (yet) successful" };

    settledDeploys.add(deployHash);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Express middleware that gates a route behind an x402 charge. */
export function x402Gate() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const proof = req.header("PAYMENT-SIGNATURE");
    const nonceHeader = req.header("PAYMENT-NONCE");

    if (!proof || !nonceHeader) {
      const nonce = crypto.randomBytes(8).readBigUInt64BE().toString();
      pending.set(nonce, { nonce, createdTs: Date.now() });
      // GC old charges
      for (const [k, v] of pending) if (Date.now() - v.createdTs > config.x402.ttlMs) pending.delete(k);
      feed.publish({
        actor: "oracle",
        kind: "x402",
        message: `402 issued for ${req.originalUrl} — ${Number(config.x402.priceMotes) / 1e9} CSPR (nonce ${nonce})`,
      });
      res.status(402).json(paymentRequirements(req, nonce));
      return;
    }

    const charge = pending.get(nonceHeader);
    if (!charge) {
      res.status(402).json({ x402Version: 1, error: "unknown or expired nonce" });
      return;
    }
    const verdict = await verifyPayment(proof.trim(), nonceHeader);
    if (!verdict.ok) {
      feed.publish({
        actor: "oracle",
        kind: "x402",
        message: `Payment rejected for nonce ${nonceHeader}: ${verdict.reason}`,
      });
      res.status(402).json({ x402Version: 1, error: `payment verification failed: ${verdict.reason}` });
      return;
    }
    pending.delete(nonceHeader);
    feed.publish({
      actor: "oracle",
      kind: "x402",
      message: `Payment verified (deploy ${proof.slice(0, 10)}…) — releasing risk report`,
      deployHash: proof.trim(),
    });
    next();
  };
}
