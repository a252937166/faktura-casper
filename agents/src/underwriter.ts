import crypto from "node:crypto";
import { chain } from "./chain.js";
import { config } from "./config.js";
import { feed } from "./feed.js";
import { underwrite as llmUnderwrite } from "./llm.js";
import { db, upsertInvoice, type InvoiceRecord } from "./store.js";

const CSPR = 1_000_000_000n;

export interface IntakeInput {
  supplierName: string;
  /** Casper public key or account hash that receives the advance. Defaults to the demo supplier. */
  supplierAddress?: string;
  debtorName: string;
  amountCspr: number;
  dueTs: number;
  invoiceNumber: string;
  description: string;
  history?: string;
  /** Raw document text or base64; hashed for the on-chain doc_hash. */
  document?: string;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * The autonomous underwriting pipeline:
 * intake -> deterministic pre-checks -> LLM risk opinion -> policy guardrails
 * -> on-chain register + fund -> on-chain attestation of the decision memo.
 *
 * The LLM proposes; the deterministic policy layer disposes. Every decision
 * (approve or reject) is hashed and anchored on-chain for auditability.
 */
export async function processIntake(input: IntakeInput): Promise<InvoiceRecord> {
  const intakeId = crypto.randomUUID();
  const docHash = sha256(input.document ?? JSON.stringify(input));
  const record: InvoiceRecord = {
    id: 0,
    intakeId,
    status: "underwriting",
    intake: {
      supplierName: input.supplierName,
      supplierAddress: input.supplierAddress,
      debtorName: input.debtorName,
      debtorTag: `debtor:${sha256(input.debtorName.toLowerCase()).slice(0, 16)}`,
      amountCspr: input.amountCspr,
      dueTs: input.dueTs,
      invoiceNumber: input.invoiceNumber,
      description: input.description,
      history: input.history,
      docHash: `sha256:${docHash}`,
      receivedTs: Date.now(),
    },
    chain: { attestHashes: [] },
  };
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "intake",
    message: `Intake ${input.invoiceNumber}: ${input.supplierName} → ${input.debtorName}, ${input.amountCspr} CSPR due ${new Date(input.dueTs).toISOString().slice(0, 10)}`,
    data: { intakeId },
  });

  const policyNotes: string[] = [];
  const p = config.policy;

  // ---- Deterministic pre-checks (hard gates) -----------------------------
  const hardFail = (reason: string) => {
    policyNotes.push(`HARD-REJECT: ${reason}`);
    return finalizeReject(record, {
      riskScore: 100,
      discountBps: 0,
      rationale: `Rejected by deterministic policy before model review: ${reason}`,
      redFlags: [reason],
      model: "policy-gate",
      policyNotes,
    });
  };

  if (!(input.amountCspr >= p.minFaceCspr)) return hardFail(`face value below ${p.minFaceCspr} CSPR`);
  if (!(input.amountCspr <= p.maxFaceCspr)) return hardFail(`face value above ${p.maxFaceCspr} CSPR`);
  const dueIn = input.dueTs - Date.now();
  if (dueIn < p.minDueInMs) return hardFail("due date not sufficiently in the future");
  if (dueIn > p.maxDueInMs) return hardFail("tenor exceeds policy maximum");
  const duplicate = db.invoices.find(
    (x) => x.intake.docHash === record.intake.docHash && x.intakeId !== intakeId && x.status !== "rejected",
  );
  if (duplicate) return hardFail(`duplicate document (matches intake ${duplicate.intake.invoiceNumber})`);

  // ---- LLM opinion --------------------------------------------------------
  feed.publish({
    actor: "underwriter",
    kind: "llm",
    message: `Scoring ${input.invoiceNumber} with ${config.llmProvider === "auto" ? "auto-selected model" : config.llmProvider}...`,
  });
  const { opinion, provider, model } = await llmUnderwrite({
    supplierName: input.supplierName,
    debtorName: input.debtorName,
    amountCspr: input.amountCspr,
    dueTs: input.dueTs,
    invoiceNumber: input.invoiceNumber,
    description: input.description,
    history: input.history,
  });

  // ---- Policy guardrails on top of the model ------------------------------
  let { approve, risk_score, discount_bps } = opinion;
  discount_bps = Math.max(p.minDiscountBps, Math.min(p.maxDiscountBps, discount_bps));
  if (discount_bps !== opinion.discount_bps)
    policyNotes.push(`discount clamped ${opinion.discount_bps} → ${discount_bps} bps`);
  if (risk_score > p.maxRiskScore && approve) {
    approve = false;
    policyNotes.push(`model approved but risk ${risk_score} > policy max ${p.maxRiskScore}`);
  }

  // Exposure cap vs. current pool liquidity.
  if (approve) {
    const stats = await chain.stats();
    const liquid = BigInt(stats.liquid);
    const advance =
      (BigInt(Math.round(input.amountCspr * 1e9)) * BigInt(10_000 - discount_bps)) / 10_000n;
    if (liquid === 0n || advance * 10_000n > liquid * BigInt(p.maxPoolShareBps)) {
      approve = false;
      policyNotes.push(
        `exposure cap: advance ${advance / CSPR} CSPR vs liquid ${liquid / CSPR} CSPR (max ${p.maxPoolShareBps} bps of pool)`,
      );
    }
  }

  const memo = {
    intakeId,
    invoiceNumber: input.invoiceNumber,
    decidedAt: new Date().toISOString(),
    provider,
    model,
    opinion,
    applied: { approve, risk_score, discount_bps },
    policyNotes,
  };
  const decisionHash = `sha256:${sha256(JSON.stringify(memo))}`;

  if (!approve) {
    return finalizeReject(record, {
      riskScore: risk_score,
      discountBps: discount_bps,
      rationale: opinion.rationale,
      redFlags: opinion.red_flags,
      model: `${provider}:${model}`,
      policyNotes,
      decisionHash,
    });
  }

  // ---- On-chain: register + fund + attest ---------------------------------
  record.decision = {
    approve: true,
    riskScore: risk_score,
    discountBps: discount_bps,
    rationale: opinion.rationale,
    redFlags: opinion.red_flags,
    policyNotes,
    model: `${provider}:${model}`,
    decisionHash,
    decidedTs: Date.now(),
  };
  record.status = "approved";
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "decision",
    message: `APPROVED ${input.invoiceNumber}: risk ${risk_score}/100, discount ${(discount_bps / 100).toFixed(2)}% — registering on-chain`,
    data: { decisionHash, redFlags: opinion.red_flags },
  });

  const faceMotes = (BigInt(Math.round(input.amountCspr * 1e9))).toString();
  const supplier = input.supplierAddress ?? (await chain.caller("debtor"));

  const reg = await chain.register({
    supplier,
    debtorTag: record.intake.debtorTag,
    docHash: record.intake.docHash,
    faceMotes,
    dueTs: input.dueTs,
    risk: risk_score,
    discountBps: discount_bps,
    decisionHash,
  });
  record.id = reg.result.invoiceId;
  record.chain.registerHash = reg.deployHashes.at(-1);
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "onchain",
    message: `Invoice #${record.id} registered on Casper Testnet`,
    invoiceId: record.id,
    deployHash: record.chain.registerHash,
  });

  const funded = await chain.fund(record.id);
  record.chain.fundHash = funded.deployHashes.at(-1);
  record.status = "funded";
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "onchain",
    message: `Invoice #${record.id} FUNDED — advance streamed to supplier from the pool`,
    invoiceId: record.id,
    deployHash: record.chain.fundHash,
  });

  const att = await chain.attest("UNDERWRITE_APPROVE", record.id, decisionHash, model);
  record.chain.attestHashes.push(att.deployHashes.at(-1) ?? "");
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "attest",
    message: `Decision memo hash anchored on-chain (attestation #${att.result.attestationId})`,
    invoiceId: record.id,
    deployHash: record.chain.attestHashes.at(-1),
  });

  return record;
}

async function finalizeReject(
  record: InvoiceRecord,
  d: {
    riskScore: number;
    discountBps: number;
    rationale: string;
    redFlags: string[];
    model: string;
    policyNotes: string[];
    decisionHash?: string;
  },
): Promise<InvoiceRecord> {
  const decisionHash =
    d.decisionHash ??
    `sha256:${sha256(JSON.stringify({ intakeId: record.intakeId, ...d }))}`;
  record.decision = {
    approve: false,
    riskScore: d.riskScore,
    discountBps: d.discountBps,
    rationale: d.rationale,
    redFlags: d.redFlags,
    policyNotes: d.policyNotes,
    model: d.model,
    decisionHash,
    decidedTs: Date.now(),
  };
  record.status = "rejected";
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "decision",
    message: `REJECTED ${record.intake.invoiceNumber}: ${d.redFlags.join("; ") || d.rationale.slice(0, 120)}`,
    data: { decisionHash },
  });

  // Anchor rejections too — the audit trail must include what the agent refused.
  try {
    const att = await chain.attest("UNDERWRITE_REJECT", 0, decisionHash, d.model);
    record.chain.attestHashes.push(att.deployHashes.at(-1) ?? "");
    upsertInvoice(record);
    feed.publish({
      actor: "underwriter",
      kind: "attest",
      message: `Rejection memo anchored on-chain (attestation #${att.result.attestationId})`,
      deployHash: record.chain.attestHashes.at(-1),
    });
  } catch (e) {
    feed.publish({
      actor: "system",
      kind: "warn",
      message: `Rejection attestation failed: ${(e as Error).message.slice(0, 200)}`,
    });
  }
  return record;
}
