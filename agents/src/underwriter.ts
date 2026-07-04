import crypto from "node:crypto";
import { chain } from "./chain.js";
import { config } from "./config.js";
import { feed } from "./feed.js";
import { underwrite as llmUnderwrite } from "./llm.js";
import { db, upsertInvoice, type InvoiceRecord } from "./store.js";

const CSPR = 1_000_000_000n;

/**
 * The on-chain Policy is the source of truth; config.policy is a stricter UX
 * prefilter. At runtime we take the tighter of the two so the numbers shown
 * to users can never drift looser than the contract.
 */
let effectivePolicy: {
  maxRiskScore: number;
  minDiscountBps: number;
  maxDiscountBps: number;
} | null = null;

async function loadEffectivePolicy() {
  if (effectivePolicy) return effectivePolicy;
  const p = config.policy;
  try {
    const onchain = await chain.policy();
    effectivePolicy = {
      maxRiskScore: Math.min(p.maxRiskScore, onchain.maxRiskScore),
      minDiscountBps: Math.max(p.minDiscountBps, onchain.minDiscountBps),
      maxDiscountBps: Math.min(p.maxDiscountBps, onchain.maxDiscountBps),
    };
  } catch {
    effectivePolicy = {
      maxRiskScore: p.maxRiskScore,
      minDiscountBps: p.minDiscountBps,
      maxDiscountBps: p.maxDiscountBps,
    };
  }
  return effectivePolicy;
}

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

  if (!(input.amountCspr >= p.minFaceCspr))
    return hardFail(`face value below ${p.minFaceCspr} CSPR`);
  if (!(input.amountCspr <= p.maxFaceCspr))
    return hardFail(`face value above ${p.maxFaceCspr} CSPR`);
  const dueIn = input.dueTs - Date.now();
  if (dueIn < p.minDueInMs) return hardFail("due date not sufficiently in the future");
  if (dueIn > p.maxDueInMs) return hardFail("tenor exceeds policy maximum");
  const duplicate = db.invoices.find(
    (x) =>
      x.intake.docHash === record.intake.docHash &&
      x.intakeId !== intakeId &&
      x.status !== "rejected",
  );
  if (duplicate)
    return hardFail(`duplicate document (matches intake ${duplicate.intake.invoiceNumber})`);

  // ---- LLM opinion --------------------------------------------------------
  feed.publish({
    actor: "underwriter",
    kind: "llm",
    message: `Scoring ${input.invoiceNumber} with the autonomous AI underwriter...`,
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
  // (tightest of the TS prefilter and the on-chain policy — see loadEffectivePolicy)
  const eff = await loadEffectivePolicy();
  let { approve, risk_score, discount_bps } = opinion;
  discount_bps = Math.max(eff.minDiscountBps, Math.min(eff.maxDiscountBps, discount_bps));
  if (discount_bps !== opinion.discount_bps)
    policyNotes.push(`discount clamped ${opinion.discount_bps} → ${discount_bps} bps`);
  if (risk_score > eff.maxRiskScore && approve) {
    approve = false;
    policyNotes.push(
      `model approved but risk ${risk_score} > prefilter max ${eff.maxRiskScore} (on-chain hard cap applies at register)`,
    );
  }

  // Liquidity sanity check only: don't send an intake on-chain if the pool
  // plainly can't pay the advance. Concentration limits (single-invoice and
  // per-debtor caps) are deliberately LEFT to the contract, so the on-chain
  // policy revert is observable — that's the point of the system.
  if (approve) {
    const stats = await chain.stats();
    const liquid = BigInt(stats.liquid);
    const advance =
      (BigInt(Math.round(input.amountCspr * 1e9)) * BigInt(10_000 - discount_bps)) / 10_000n;
    if (advance > liquid) {
      approve = false;
      policyNotes.push(
        `liquidity check: advance ${advance / CSPR} CSPR exceeds liquid ${liquid / CSPR} CSPR`,
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
      model: "autonomous-ai-underwriter",
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
    model: "autonomous-ai-underwriter",
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

  const faceMotes = BigInt(Math.round(input.amountCspr * 1e9)).toString();
  // Advance recipient: caller-supplied address, else the demo SUPPLIER account.
  // Never the debtor — the debtor owes the money; the supplier sold the invoice.
  const supplier = input.supplierAddress ?? (await chain.caller("supplier"));
  record.intake.supplierAddress = supplier;
  upsertInvoice(record);

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

  // Funding is where the contract's concentration caps bite. A revert here is
  // a first-class outcome (the chain overruling the model), not an API error.
  try {
    const funded = await chain.fund(record.id);
    record.chain.fundHash = funded.deployHashes.at(-1);
    record.status = "funded";
    upsertInvoice(record);
    feed.publish({
      actor: "underwriter",
      kind: "onchain",
      message: `Invoice #${record.id} FUNDED — advance paid from the pool to supplier ${supplier.replace("entity-account-", "account-hash-").slice(0, 26)}…`,
      invoiceId: record.id,
      deployHash: record.chain.fundHash,
    });
  } catch (e) {
    record.status = "policy_blocked";
    record.chain.fundError = normalizeRevert((e as Error).message);
    upsertInvoice(record);
    feed.publish({
      actor: "underwriter",
      kind: "policy_block",
      message: `Casper policy blocked funding for invoice #${record.id}: ${record.chain.fundError}`,
      invoiceId: record.id,
    });
    return record;
  }

  // The advance is an irreversible on-chain fact by now — a failed attestation
  // must not fail the request; it is retried, not rolled back.
  try {
    const att = await chain.attest(
      "UNDERWRITE_APPROVE",
      record.id,
      decisionHash,
      "autonomous-ai-underwriter",
    );
    record.chain.attestHashes.push(att.deployHashes.at(-1) ?? "");
    upsertInvoice(record);
    feed.publish({
      actor: "underwriter",
      kind: "attest",
      message: `Decision memo hash anchored on-chain (attestation #${att.result.attestationId})`,
      invoiceId: record.id,
      deployHash: record.chain.attestHashes.at(-1),
    });
  } catch (e) {
    record.chain.attestPending = true;
    upsertInvoice(record);
    feed.publish({
      actor: "system",
      kind: "warn",
      message: `Invoice #${record.id} funded on-chain; attestation retry required (${(e as Error).message.slice(0, 120)})`,
      invoiceId: record.id,
    });
  }

  return record;
}

/** Extracts the typed contract error from a livenet revert message. */
function normalizeRevert(msg: string): string {
  const m = msg.match(/User error:\s*(\d+)/);
  const names: Record<string, string> = {
    "6": "InsufficientLiquidity",
    "13": "RiskAbovePolicy",
    "14": "DiscountOutOfPolicy",
    "15": "SingleInvoiceCapExceeded",
    "16": "DebtorExposureCapExceeded",
  };
  if (m) return `User error: ${m[1]} (${names[m[1]] ?? "see contracts/src/lib.rs"})`;
  return msg.slice(0, 160);
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
    d.decisionHash ?? `sha256:${sha256(JSON.stringify({ intakeId: record.intakeId, ...d }))}`;
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
