/**
 * THE canonical AI-decision memo — one shape, one serialization, one hash,
 * shared by every underwriting path (the production pipeline AND the Live
 * Judge walkthrough).
 *
 * Why this exists: the on-chain anchor is only worth something if it covers
 * the WHOLE opinion. A hash over {risk, discount} proves those two numbers;
 * a hash over the full memo proves the rationale and red flags were never
 * rewritten after the fact. Auditable AI means the latter.
 *
 * Serialization contract: `JSON.stringify` over an object built with the
 * exact insertion order below (schema, intakeId, invoiceNumber, decidedAt,
 * provider, model, opinion, applied, policyNotes). The memo embeds its
 * decision timestamp, so hashes are COMPUTE-ONCE-AND-STORE: nothing in the
 * system ever re-derives a hash from raw inputs — verifiers re-hash the
 * stored memo document itself and compare with the on-chain anchor.
 * Cross-language verifiers: the full byte-layout spec lives in
 * docs/judge-mode-design.md § "Canonical serialization spec".
 */
import crypto from "node:crypto";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** The raw LLM opinion, exactly as the underwriter returns it (snake_case). */
export interface MemoOpinion {
  approve: boolean;
  risk_score: number;
  discount_bps: number;
  rationale: string;
  red_flags: string[];
  /** Optional — present when the model reports one. */
  confidence?: number;
}

export interface CanonicalDecisionMemo {
  schema: "faktura.decision.v1";
  intakeId: string;
  invoiceNumber: string;
  decidedAt: string;
  provider: string;
  model: string;
  /** The FULL model opinion — rationale and red flags included. */
  opinion: MemoOpinion;
  /** What the desk actually applied after policy clamps. */
  applied: { approve: boolean; risk_score: number; discount_bps: number };
  policyNotes: string[];
}

/** Build the memo with a guaranteed field order (see serialization contract). */
export function buildDecisionMemo(m: {
  intakeId: string;
  invoiceNumber: string;
  decidedAt?: string;
  provider: string;
  model: string;
  opinion: MemoOpinion;
  applied: { approve: boolean; risk_score: number; discount_bps: number };
  policyNotes: string[];
}): CanonicalDecisionMemo {
  return {
    schema: "faktura.decision.v1",
    intakeId: m.intakeId,
    invoiceNumber: m.invoiceNumber,
    decidedAt: m.decidedAt ?? new Date().toISOString(),
    provider: m.provider,
    model: m.model,
    opinion: {
      approve: m.opinion.approve,
      risk_score: m.opinion.risk_score,
      discount_bps: m.opinion.discount_bps,
      rationale: m.opinion.rationale,
      red_flags: m.opinion.red_flags,
      ...(m.opinion.confidence !== undefined ? { confidence: m.opinion.confidence } : {}),
    },
    applied: {
      approve: m.applied.approve,
      risk_score: m.applied.risk_score,
      discount_bps: m.applied.discount_bps,
    },
    policyNotes: m.policyNotes,
  };
}

export function hashDecisionMemo(memo: CanonicalDecisionMemo): string {
  return `sha256:${sha256(JSON.stringify(memo))}`;
}

/**
 * Structural gate for untrusted memo documents (an x402 report, a receipt).
 * A verifier must refuse to "verify" something that is not actually a
 * canonical memo — hashing an arbitrary blob and calling it a match would be
 * theater. Checks the schema literal and every field the hash contract needs.
 */
export function isCanonicalDecisionMemo(x: unknown): x is CanonicalDecisionMemo {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  const o = m.opinion as Record<string, unknown> | undefined;
  const a = m.applied as Record<string, unknown> | undefined;
  return (
    m.schema === "faktura.decision.v1" &&
    typeof m.intakeId === "string" &&
    typeof m.invoiceNumber === "string" &&
    typeof m.decidedAt === "string" &&
    typeof m.provider === "string" &&
    typeof m.model === "string" &&
    !!o &&
    typeof o.approve === "boolean" &&
    typeof o.risk_score === "number" &&
    typeof o.discount_bps === "number" &&
    typeof o.rationale === "string" &&
    Array.isArray(o.red_flags) &&
    !!a &&
    typeof a.approve === "boolean" &&
    typeof a.risk_score === "number" &&
    typeof a.discount_bps === "number" &&
    Array.isArray(m.policyNotes)
  );
}
