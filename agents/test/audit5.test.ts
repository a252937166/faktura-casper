/**
 * Audit-5 hardening tests: the canonical decision memo (the anchored hash must
 * cover the WHOLE opinion), the consumer's field-binding verification, the
 * payout-commit evidence rule, the 2-deploy seeder budget, and the receipt
 * hash contract. The session-supersede 409 lives in the express route and is
 * exercised by the production smoke, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the ledger BEFORE the config module is imported anywhere.
process.env.FAKTURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "faktura-test5-"));
process.env.FAKTURA_SHOWCASE = "1"; // judge.ts imports chain.ts — keep it keyless

const { buildDecisionMemo, hashDecisionMemo } = await import("../src/decision-memo.js");
const { consumerChecks } = await import("../src/judge.js");
const limits = await import("../src/judge-limits.js");

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ---- canonical memo: the hash covers EVERYTHING ---------------------------

const baseMemo = () =>
  buildDecisionMemo({
    intakeId: "t-1",
    invoiceNumber: "INV-T-1",
    decidedAt: "2026-07-18T00:00:00.000Z",
    provider: "desk",
    model: "autonomous-ai-underwriter",
    opinion: {
      approve: true,
      risk_score: 22,
      discount_bps: 250,
      rationale: "Established counterparty; short tenor.",
      red_flags: ["none material"],
    },
    applied: { approve: true, risk_score: 22, discount_bps: 250 },
    policyNotes: ["discount clamped 260 → 250 bps"],
  });

test("memo hash: identical inputs → identical hash (deterministic canonical form)", () => {
  assert.equal(hashDecisionMemo(baseMemo()), hashDecisionMemo(baseMemo()));
});

test("memo tamper: rewriting one character of the RATIONALE breaks the anchor match", () => {
  const memo = baseMemo();
  const anchored = hashDecisionMemo(memo);
  const tampered = { ...memo, opinion: { ...memo.opinion, rationale: "Established counterparty; short tenor?" } };
  assert.notEqual(hashDecisionMemo(tampered), anchored);
});

test("memo tamper: dropping a RED FLAG breaks the anchor match", () => {
  const memo = baseMemo();
  const anchored = hashDecisionMemo(memo);
  const tampered = { ...memo, opinion: { ...memo.opinion, red_flags: [] } };
  assert.notEqual(hashDecisionMemo(tampered), anchored);
});

test("memo tamper: editing the risk score breaks the anchor match", () => {
  const memo = baseMemo();
  const anchored = hashDecisionMemo(memo);
  const tampered = {
    ...memo,
    opinion: { ...memo.opinion, risk_score: 10 },
    applied: { ...memo.applied, risk_score: 10 },
  };
  assert.notEqual(hashDecisionMemo(tampered), anchored);
});

test("memo tamper: editing the discount breaks the anchor match", () => {
  const memo = baseMemo();
  const anchored = hashDecisionMemo(memo);
  const tampered = { ...memo, applied: { ...memo.applied, discount_bps: 100 } };
  assert.notEqual(hashDecisionMemo(tampered), anchored);
});

test("memo tamper: editing a policy note breaks the anchor match", () => {
  const memo = baseMemo();
  const anchored = hashDecisionMemo(memo);
  const tampered = { ...memo, policyNotes: [] };
  assert.notEqual(hashDecisionMemo(tampered), anchored);
});

// ---- consumer verification: re-hash + field binding -----------------------

const repFor = (memo: ReturnType<typeof baseMemo>) => ({
  invoiceId: 7,
  riskScore: memo.applied.risk_score,
  discountBps: memo.applied.discount_bps,
  decisionHash: hashDecisionMemo(memo),
  memo,
});

test("consumer: honest report + matching chain → every check passes, ACCEPT", () => {
  const memo = baseMemo();
  const rep = repFor(memo);
  const truth = { decisionHash: rep.decisionHash, riskScore: 22, discountBps: 250 };
  const c = consumerChecks(rep, truth, truth);
  assert.equal(c.recomputed, true);
  assert.ok(c.localHash && c.chainHash && c.localRisk && c.chainRisk);
  assert.equal(c.accepted, true);
});

test("consumer: oracle keeps the hash but LIES about the risk score → field binding fails, REJECT", () => {
  const memo = baseMemo();
  const rep = { ...repFor(memo), riskScore: 5 }; // "everything is fine, buy it"
  const truth = { decisionHash: rep.decisionHash, riskScore: 22, discountBps: 250 };
  const c = consumerChecks(rep, truth, truth);
  assert.equal(c.recomputed, true); // the hash itself still matches…
  assert.equal(c.chainRisk, false); // …but the number is not the anchored number
  assert.equal(c.accepted, false);
});

test("consumer: tampered memo document → re-hash mismatch, REJECT even with matching hash claims", () => {
  const memo = baseMemo();
  const rep = {
    ...repFor(memo),
    memo: { ...memo, opinion: { ...memo.opinion, rationale: "all good, trust me" } },
  };
  const truth = { decisionHash: rep.decisionHash, riskScore: 22, discountBps: 250 };
  const c = consumerChecks(rep, truth, truth);
  assert.equal(c.recomputed, false);
  assert.equal(c.accepted, false);
});

test("consumer: risk above its own policy (35) → REJECT with all hashes matching", () => {
  const memo = buildDecisionMemo({
    intakeId: "t-2",
    invoiceNumber: "INV-T-2",
    decidedAt: "2026-07-18T00:00:00.000Z",
    provider: "desk",
    model: "autonomous-ai-underwriter",
    opinion: { approve: true, risk_score: 60, discount_bps: 300, rationale: "risky", red_flags: [] },
    applied: { approve: true, risk_score: 60, discount_bps: 300 },
    policyNotes: [],
  });
  const rep = repFor(memo);
  const truth = { decisionHash: rep.decisionHash, riskScore: 60, discountBps: 300 };
  const c = consumerChecks(rep, truth, truth);
  assert.equal(c.recomputed, true);
  assert.equal(c.riskOk, false);
  assert.equal(c.accepted, false);
});

// ---- payout commit: never book a transfer to "unknown" --------------------

test("commitPayout: no reservation + no evidence → throws (fail loud, never 'unknown')", () => {
  assert.throws(
    () => limits.commitPayout("ghost-session", 1.9),
    /without reservation or session evidence/,
  );
});

test("commitPayout: reservation gone but session evidence supplied → books to the evidence wallet", () => {
  limits.commitPayout("ghost-session-2", 1.9, { wallet: "wallet-evi", ip: "ip-evi" });
  // The 24 h ledger now knows this wallet — a second payout is refused.
  assert.equal(limits.canPayout("wallet-evi", "ip-other", 2).ok, false);
  assert.equal(limits.canPayout("wallet-other", "ip-evi", 2).ok, false);
});

// ---- seeder budget: two deploys or none -----------------------------------

test("canSignDeploy(count): a seeder needing 2 deploys is refused when only 1 slot remains", () => {
  const cap = limits.CAPS.deploysPerDay;
  const used = limits.deploysLast24h();
  for (let i = used; i < cap - 1; i++) limits.recordDeploy("test:filler");
  assert.equal(limits.canSignDeploy().ok, true, "one slot left — a single deploy still fits");
  assert.equal(limits.canSignDeploy(2).ok, false, "…but a register+fund pair must be refused");
});

// ---- receipt hash contract -------------------------------------------------

test("receiptHash: parse + strip receiptHash reproduces the hashed bytes (verifier contract)", () => {
  // Mirror of the server's construction: hash the body, append receiptHash LAST.
  const body = {
    schema: "faktura.credit-receipt.v1",
    displayId: "JUDGE-20260718-DEADBEEF",
    preset: "happy",
    endedTs: 1_753_000_000_000,
    memo: baseMemo(),
    decisionHash: hashDecisionMemo(baseMemo()),
    steps: [{ key: "fund", status: "done", txHash: "ab".repeat(32) }],
  };
  const receiptHash = `sha256:${sha256(JSON.stringify(body))}`;
  const wire = JSON.stringify({ ...body, receiptHash });
  // The verifier side: parse, split off receiptHash, re-stringify, re-hash.
  const parsed = JSON.parse(wire) as Record<string, unknown>;
  const { receiptHash: claimed, ...rest } = parsed;
  assert.equal(`sha256:${sha256(JSON.stringify(rest))}`, claimed);
  // And the embedded memo still re-hashes to the embedded decisionHash.
  assert.equal(hashDecisionMemo(rest.memo as never), rest.decisionHash);
});
