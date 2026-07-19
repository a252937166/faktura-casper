import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
 * set X402_MODE=official-facilitator (+ X402_FACILITATOR_URL) to delegate
 * verification to a standard x402 facilitator's /verify API instead
 * (docs/x402.md covers both modes).
 */

interface PendingCharge {
  nonce: string;
  createdTs: number;
  /** What this charge was issued FOR — bound at 402 time, enforced at settle. */
  resource?: string;
  invoiceId?: number;
  amountMotes?: string;
  payTo?: string;
}

/**
 * Charges and the replay set are PERSISTED (atomic tmp+rename, best-effort):
 * a visitor who paid a real CSPR transfer must never lose their unlock to a
 * backend restart between the 402 and the retry. Disk trouble degrades to
 * in-memory behavior — it must never block payment verification itself.
 */
const STATE_FILE = () => path.join(config.dataDir, "x402-state.json");
const SETTLED_RETENTION_MS = 7 * 24 * 3600_000;

const pending = new Map<string, PendingCharge>(); // nonce -> charge
const settledDeploys = new Map<string, number>(); // deployHash -> settledTs (replay protection)

function loadX402State() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) as {
      pending?: PendingCharge[];
      settled?: Record<string, number>;
    };
    for (const c of raw.pending ?? [])
      if (Date.now() - c.createdTs <= config.x402.ttlMs) pending.set(c.nonce, c);
    for (const [h, ts] of Object.entries(raw.settled ?? {}))
      if (Date.now() - ts <= SETTLED_RETENTION_MS) settledDeploys.set(h, ts);
  } catch {
    /* first boot or unreadable file — start clean */
  }
}
loadX402State();

function saveX402State() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    const tmp = `${STATE_FILE()}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        pending: [...pending.values()].filter((c) => Date.now() - c.createdTs <= config.x402.ttlMs),
        settled: Object.fromEntries(
          [...settledDeploys].filter(([, ts]) => Date.now() - ts <= SETTLED_RETENTION_MS),
        ),
      }),
    );
    fs.renameSync(tmp, STATE_FILE());
  } catch {
    /* best-effort — see note above */
  }
}

/** Read-only probes (debugging + tests): did the persisted state load? */
export const x402HasPendingNonce = (nonce: string) => pending.has(nonce);
export const x402DeploySettled = (deployHash: string) => settledDeploys.has(deployHash);

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
          settlement:
            config.x402.mode === "official-facilitator" ? "facilitator" : "native-transfer",
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
async function verifyPayment(
  deployHash: string,
  nonce: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (settledDeploys.has(deployHash)) return { ok: false, reason: "deploy already used" };
  try {
    const info = await rpc("info_get_deploy", { deploy_hash: deployHash });
    const deploy = info?.deploy;
    const results = info?.execution_info?.execution_result ?? info?.execution_results;
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

    // Casper 1.x reports {"Success": ...}; Casper 2.0 (Condor) reports
    // execution_result.Version2 with error_message === null on success.
    const v2 = (results as { Version2?: { error_message: string | null } } | undefined)?.Version2;
    const success = v2
      ? v2.error_message == null
      : JSON.stringify(results ?? "").includes("Success");
    if (!success) return { ok: false, reason: "deploy not (yet) successful" };

    settledDeploys.set(deployHash, Date.now());
    saveX402State();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * Delegates verification to an external x402 facilitator (`POST /verify`,
 * standard x402 facilitator API). Used when X402_MODE=official-facilitator.
 */
async function verifyViaFacilitator(
  proof: string,
  nonce: string,
  resource: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!config.x402.facilitatorUrl)
    return { ok: false, reason: "X402_FACILITATOR_URL not configured" };
  try {
    const res = await fetch(`${config.x402.facilitatorUrl.replace(/\/$/, "")}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentHeader: proof,
        paymentRequirements: {
          scheme: "exact",
          network: `casper:${config.chainName}`,
          maxAmountRequired: config.x402.priceMotes,
          payTo: config.x402.payTo,
          resource,
          extra: { transferIdNonce: nonce },
        },
      }),
    });
    const body = (await res.json()) as { isValid?: boolean; invalidReason?: string };
    return body.isValid
      ? { ok: true }
      : { ok: false, reason: body.invalidReason ?? `facilitator returned ${res.status}` };
  } catch (e) {
    return { ok: false, reason: `facilitator unreachable: ${(e as Error).message}` };
  }
}

/** Express middleware that gates a route behind an x402 charge. */
export function x402Gate() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const proof = req.header("PAYMENT-SIGNATURE");
    const nonceHeader = req.header("PAYMENT-NONCE");

    if (!proof || !nonceHeader) {
      // Keep the nonce under 2^48: it rides the Casper transfer id (u64) and
      // comes back through JSON, where larger values lose precision.
      const nonce = String(crypto.randomInt(1, 2 ** 48));
      const invoiceMatch = /\/api\/risk\/(\d+)/.exec(req.originalUrl);
      pending.set(nonce, {
        nonce,
        createdTs: Date.now(),
        resource: req.originalUrl,
        invoiceId: invoiceMatch ? Number(invoiceMatch[1]) : undefined,
        amountMotes: config.x402.priceMotes,
        payTo: config.x402.payTo,
      });
      // GC old charges
      for (const [k, v] of pending)
        if (Date.now() - v.createdTs > config.x402.ttlMs) pending.delete(k);
      saveX402State();
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
    // The charge is BOUND to what it was issued for — a nonce bought for one
    // report cannot unlock a different resource.
    if (charge.resource && charge.resource !== req.originalUrl) {
      res.status(402).json({
        x402Version: 1,
        error: `nonce was issued for ${charge.resource}, not ${req.originalUrl}`,
      });
      return;
    }
    // Showcase mode only: accept the clearly-labeled simulated proof issued by
    // /api/demo/x402-pay so public visitors can walk the flow without keys.
    if (config.showcase && proof.trim() === `showcase-simulated:${nonceHeader}`) {
      pending.delete(nonceHeader);
      saveX402State();
      feed.publish({
        actor: "oracle",
        kind: "x402",
        message: `SIMULATED payment accepted (showcase) — releasing risk report for nonce ${nonceHeader}`,
      });
      next();
      return;
    }
    const verdict =
      config.x402.mode === "official-facilitator"
        ? await verifyViaFacilitator(proof.trim(), nonceHeader, req.originalUrl)
        : await verifyPayment(proof.trim(), nonceHeader);
    if (!verdict.ok) {
      feed.publish({
        actor: "oracle",
        kind: "x402",
        message: `Payment rejected for nonce ${nonceHeader}: ${verdict.reason}`,
      });
      res
        .status(402)
        .json({ x402Version: 1, error: `payment verification failed: ${verdict.reason}` });
      return;
    }
    pending.delete(nonceHeader);
    saveX402State();
    feed.publish({
      actor: "oracle",
      kind: "x402",
      message: `Payment verified (deploy ${proof.slice(0, 10)}…) — releasing risk report`,
      deployHash: proof.trim(),
    });
    next();
  };
}
