/**
 * Audit-6 hardening tests: a consumer must REJECT when the memo is missing,
 * malformed or unbound; ownership never falls back to a shared IP once a
 * session is cookie-bound; deterministic hard rejects mint the same canonical
 * memo as every other decision; and the strict verified-invoice predicate is
 * what the x402 surface actually uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the ledger BEFORE the config module is imported anywhere.
process.env.FAKTURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "faktura-test6-"));
process.env.FAKTURA_SHOWCASE = "1"; // keyless simulated chain for the reject path

const { buildDecisionMemo, hashDecisionMemo, isCanonicalDecisionMemo } = await import(
  "../src/decision-memo.js"
);
const { consumerChecks, verifiedMemoRecord, ownerMatch } = await import("../src/judge.js");
const { processIntake } = await import("../src/underwriter.js");

const memoOf = () =>
  buildDecisionMemo({
    intakeId: "t6-1",
    invoiceNumber: "INV-T6-1",
    decidedAt: "2026-07-19T00:00:00.000Z",
    provider: "desk",
    model: "autonomous-ai-underwriter",
    opinion: {
      approve: true,
      risk_score: 20,
      discount_bps: 200,
      rationale: "clean counterparty",
      red_flags: [],
    },
    applied: { approve: true, risk_score: 20, discount_bps: 200 },
    policyNotes: [],
  });

const repOf = (memo: ReturnType<typeof memoOf>) => ({
  invoiceId: 9,
  riskScore: 20,
  discountBps: 200,
  decisionHash: hashDecisionMemo(memo),
  memo,
});

const truthFor = (rep: { decisionHash: string; riskScore: number; discountBps: number }) => ({
  decisionHash: rep.decisionHash,
  riskScore: rep.riskScore,
  discountBps: rep.discountBps,
});

// ---- consumer: no memo, no deal --------------------------------------------

test("consumer: report WITHOUT a memo → REJECT even when every hash string agrees", () => {
  const memo = memoOf();
  const rep = { ...repOf(memo), memo: undefined };
  const c = consumerChecks(rep, truthFor(rep), truthFor(rep));
  assert.equal(c.recomputed, false);
  assert.equal(c.accepted, false);
});

test("consumer: memo that is not a canonical document → REJECT", () => {
  const memo = memoOf();
  const rep = { ...repOf(memo), memo: { schema: "totally-not-a-memo", blob: 42 } };
  const c = consumerChecks(rep, truthFor(rep), truthFor(rep));
  assert.equal(c.recomputed, false);
  assert.equal(c.accepted, false);
});

test("consumer: memo document that does not re-hash to the claimed hash → REJECT", () => {
  const memo = memoOf();
  const rep = {
    ...repOf(memo),
    memo: { ...memo, opinion: { ...memo.opinion, rationale: "trust me" } },
  };
  const c = consumerChecks(rep, truthFor(rep), truthFor(rep));
  assert.equal(c.recomputed, false);
  assert.equal(c.accepted, false);
});

// ---- consumer: report fields must be bound to the memo document ------------

test("consumer: memo says risk 50 while report/local/chain all say 5 → REJECT (memo binding)", () => {
  const memo = buildDecisionMemo({
    intakeId: "t6-2",
    invoiceNumber: "INV-T6-2",
    decidedAt: "2026-07-19T00:00:00.000Z",
    provider: "desk",
    model: "autonomous-ai-underwriter",
    opinion: { approve: true, risk_score: 50, discount_bps: 200, rationale: "r", red_flags: [] },
    applied: { approve: true, risk_score: 50, discount_bps: 200 },
    policyNotes: [],
  });
  // A registration that wrote risk=5 into the contract while hashing a memo
  // that says 50: every HASH check passes, only the memo binding catches it.
  const rep = { invoiceId: 9, riskScore: 5, discountBps: 200, decisionHash: hashDecisionMemo(memo), memo };
  const c = consumerChecks(rep, truthFor(rep), truthFor(rep));
  assert.equal(c.recomputed, true);
  assert.equal(c.memoRisk, false);
  assert.equal(c.accepted, false);
});

test("consumer: memo discount differs from the report → REJECT (memo binding)", () => {
  const memo = memoOf(); // discount 200 in the memo
  const rep = { invoiceId: 9, riskScore: 20, discountBps: 150, decisionHash: hashDecisionMemo(memo), memo };
  const c = consumerChecks(rep, truthFor(rep), truthFor(rep));
  assert.equal(c.recomputed, true);
  assert.equal(c.memoDiscount, false);
  assert.equal(c.accepted, false);
});

test("consumer: fully consistent report with memo → ACCEPT (regression guard)", () => {
  const memo = memoOf();
  const rep = repOf(memo);
  const c = consumerChecks(rep, truthFor(rep), truthFor(rep));
  assert.equal(c.accepted, true);
});

// ---- canonical-memo type gate ----------------------------------------------

test("isCanonicalDecisionMemo: accepts a built memo, rejects junk shapes", () => {
  assert.equal(isCanonicalDecisionMemo(memoOf()), true);
  assert.equal(isCanonicalDecisionMemo(null), false);
  assert.equal(isCanonicalDecisionMemo("sha256:abc"), false);
  assert.equal(isCanonicalDecisionMemo({ schema: "faktura.decision.v1" }), false);
  const broken = { ...memoOf(), opinion: { ...memoOf().opinion, red_flags: "none" } };
  assert.equal(isCanonicalDecisionMemo(broken), false);
});

// ---- strict verified-invoice predicate -------------------------------------

test("verifiedMemoRecord: memo-backed record passes; decision-only record fails", () => {
  const memo = memoOf();
  const good = { memo, decision: { decisionHash: hashDecisionMemo(memo) } };
  assert.equal(verifiedMemoRecord(good), true);
  assert.equal(verifiedMemoRecord(good, hashDecisionMemo(memo)), true);
  assert.equal(verifiedMemoRecord(good, "sha256:different"), false);
  assert.equal(verifiedMemoRecord({ decision: { decisionHash: "sha256:x" } }), false);
  const stale = { memo, decision: { decisionHash: "sha256:stale" } };
  assert.equal(verifiedMemoRecord(stale), false);
});

// ---- session ownership: cookie-bound means cookie-only ----------------------

test("ownerMatch: a cookie-bound session is NOT owned by a cookie-less request from the same IP", () => {
  assert.equal(ownerMatch("cid-1", "10.0.0.9", "", "10.0.0.9"), false);
  assert.equal(ownerMatch("cid-1", "10.0.0.9", "cid-2", "10.0.0.9"), false);
  assert.equal(ownerMatch("cid-1", "10.0.0.9", "cid-1", "203.0.113.7"), true);
  // Legacy sessions without a cid keep the old IP rule.
  assert.equal(ownerMatch(undefined, "10.0.0.9", "", "10.0.0.9"), true);
  assert.equal(ownerMatch(undefined, "10.0.0.9", "", "203.0.113.7"), false);
});

// ---- deterministic hard reject mints a canonical memo ----------------------

test("deterministic reject: below-minimum face → canonical memo, provider deterministic-policy, hash matches", async () => {
  const record = await processIntake({
    supplierName: "Tiny Co",
    debtorName: "Debtor GmbH",
    amountCspr: 0.5, // below minFaceCspr=5 → hard reject before any LLM call
    dueTs: Date.now() + 30 * 86_400_000,
    invoiceNumber: "INV-T6-HARD",
    description: "too small to finance",
  });
  assert.equal(record.status, "rejected");
  assert.ok(record.memo, "hard reject must write record.memo");
  assert.equal(isCanonicalDecisionMemo(record.memo), true);
  const memo = record.memo!;
  assert.equal(memo.provider, "deterministic-policy");
  assert.equal(memo.applied.approve, false);
  assert.equal(hashDecisionMemo(memo), record.decision!.decisionHash);
});
