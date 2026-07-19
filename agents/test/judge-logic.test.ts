/**
 * State-machine tests for the pieces the smoke matrix cannot cover cheaply:
 * the policy-block feasibility window and the persisted budget ledger.
 * Run with `npm test` (tsx --test); CI runs it on every push.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the ledger BEFORE the config module is imported anywhere.
process.env.FAKTURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "faktura-test-"));
process.env.FAKTURA_SHOWCASE = "1"; // judge.ts imports chain.ts — keep it keyless

const { policyBlockPlan } = await import("../src/judge.js");
const limits = await import("../src/judge-limits.js");

const snap = (liquid: number, deployed: number) => ({
  liquid,
  deployed,
  totalFunded: 0,
  totalSettled: 0,
  totalDefaulted: 0,
  totalShares: 100,
  invoiceCount: 0,
});

// ---- policyBlockPlan: the error-15 window --------------------------------

test("policy-block plan: feasible pool → advance lands ABOVE cap and BELOW liquidity for the whole discount band", () => {
  const pool = snap(100, 50); // poolValue 150, cap 50% → singleCap 75
  const plan = policyBlockPlan(pool, 5000);
  assert.equal(plan.feasible, true);
  const face = plan.faceCspr!;
  const margin = Math.max(1, 0.03 * pool.liquid);
  // clamped preset discount band is [0.5%, 4%] → advance ∈ [0.96·face, 0.995·face]
  assert.ok(face * 0.96 > plan.singleCap, "min advance must clear the single-invoice cap");
  assert.ok(face * 0.995 <= pool.liquid - margin + 1e-9, "max advance must stay under liquidity");
});

test("policy-block plan: mostly-deployed pool cannot produce error 15 → infeasible with a reason", () => {
  const plan = policyBlockPlan(snap(30, 170), 5000); // singleCap 100 > liquid 30
  assert.equal(plan.feasible, false);
  assert.match(plan.reason ?? "", /cannot produce a clean SingleInvoiceCapExceeded/);
});

test("policy-block plan: empty pool is infeasible, not NaN", () => {
  const plan = policyBlockPlan(snap(0, 0), 5000);
  assert.equal(plan.feasible, false);
});

test("policy-block plan: health and underwrite agree (same function, same inputs, same answer)", () => {
  const pool = snap(102.6, 51.0); // the real pre-freeze pool shape
  const a = policyBlockPlan(pool, 5000);
  const b = policyBlockPlan(pool, 5000);
  assert.deepEqual(a, b);
});

// ---- payout ledger: reserve → commit / release ---------------------------

test("payout budget: reservation counts against the cap immediately", () => {
  const before = limits.spentLast24h();
  const r = limits.reservePayout("s1", "wallet-a", "ip-a", 2);
  assert.equal(r.ok, true);
  assert.equal(limits.spentLast24h(), before + 2);
});

test("payout budget: a retry by the same visitor REPLACES their hold (never dead-locks them)", () => {
  // Same wallet re-reserving from a new session: the old hold is replaced,
  // not stacked and not denied — total held budget stays 2, owner moves to s2.
  const spentBefore = limits.spentLast24h();
  assert.equal(limits.reservePayout("s2", "wallet-a", "ip-a", 2).ok, true);
  assert.equal(limits.spentLast24h(), spentBefore);
  // Rebind the hold back to s1 so the commit test below finds it there.
  assert.equal(limits.reservePayout("s1", "wallet-a", "ip-a", 2).ok, true);
  assert.equal(limits.spentLast24h(), spentBefore);
});

test("payout budget: commit converts the reservation into a payout exactly once", () => {
  const spentBefore = limits.spentLast24h();
  limits.commitPayout("s1", 1.96);
  // reservation (2) replaced by actual payout (1.96)
  assert.ok(Math.abs(limits.spentLast24h() - (spentBefore - 2 + 1.96)) < 1e-9);
  // the wallet stays burned for 24 h even after commit
  assert.equal(limits.reservePayout("s4", "wallet-a", "ip-b", 2).ok, false);
});

test("payout budget: release returns the reserved budget", () => {
  const ok = limits.reservePayout("s5", "wallet-b", "ip-b", 2);
  assert.equal(ok.ok, true);
  const during = limits.spentLast24h();
  limits.releaseReservation("s5");
  assert.ok(Math.abs(limits.spentLast24h() - (during - 2)) < 1e-9);
});

test("payout budget: the global daily cap is a hard ceiling", () => {
  // cap is 10; ~1.96 committed so far — a 9 CSPR reservation must bounce
  const r = limits.reservePayout("s6", "wallet-c", "ip-c", 9);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /budget/);
});

// ---- run + gas budgets ----------------------------------------------------

test("run budget: per-IP hourly limit blocks the 5th walkthrough", () => {
  for (let i = 0; i < 4; i++) {
    assert.equal(limits.canStartRun("ip-run", "happy").ok, true, `run ${i + 1} allowed`);
    limits.recordRun("ip-run", "happy");
  }
  const fifth = limits.canStartRun("ip-run", "happy");
  assert.equal(fifth.ok, false);
  assert.match(fifth.reason ?? "", /per hour/);
});

test("gas budget: the daily deploy cap closes the desk for signing", () => {
  for (let i = 0; i < limits.CAPS.deploysPerDay; i++) limits.recordDeploy("test");
  const gate = limits.canSignDeploy();
  assert.equal(gate.ok, false);
  assert.match(gate.reason ?? "", /budget/i);
});

// ---- positions: overdue inventory vs cleanup ------------------------------

test("positions: add → stale → resolve lifecycle", () => {
  limits.addPosition({
    sessionId: "sess-p",
    displayId: "JUDGE-TEST",
    invoiceId: 999,
    faceMotes: "2000000000",
    dueTs: Date.now() + 60_000,
    fundedTs: Date.now(),
  });
  assert.equal(limits.openPositionCount(), 1);
  assert.equal(limits.stalePositions(-1).length, 1); // strictly-older-than comparison
  assert.equal(limits.stalePositions(60_000).length, 0); // just touched — not stale yet
  limits.resolvePosition(999);
  assert.equal(limits.openPositionCount(), 0);
});

// ---- run budget: create and canRun must share the same math ----------------

test("run budget: an exhausted per-preset cap disables BOTH create and canRun", () => {
  // Fill policy-block to its daily cap from distinct IPs (so the per-IP
  // hourly limit stays out of the way — this test is about the GLOBAL caps).
  const cap = limits.CAPS.perPresetPerDay["policy-block"];
  for (let i = 0; i < cap; i++) limits.recordRun(`ip-pb-${i}`, "policy-block");
  const create = limits.canStartRun("ip-pb-fresh", "policy-block");
  const gate = limits.presetRunBudget("policy-block");
  assert.equal(create.ok, false);
  assert.equal(gate.ok, false);
  // The regression this pins: the picker said "runnable", create said 429.
  assert.equal(create.reason, gate.reason);
  assert.match(gate.reason ?? "", /within 24 h/);
  // Other stories keep their own budgets.
  assert.equal(limits.presetRunBudget("x402").ok, true);
});

// ---- session lifecycle: expiry fires, eviction never eats a live run -------

const { prunePlan } = await import("../src/judge.js");
const MIN = 60_000;
const sess = (id: string, status: string, idleMin: number, running = false) => ({
  id,
  status,
  running,
  lastActivityTs: Date.now() - idleMin * MIN,
});

test("prune: an idle active session expires after 40 min — unless a tx is mid-flight", () => {
  const plan = prunePlan(
    [sess("stale", "active", 41), sess("signing", "active", 41, true), sess("fresh", "active", 5)],
    Date.now(),
  );
  assert.deepEqual(plan.expire, ["stale"]);
  assert.deepEqual(plan.evict, []);
});

test("prune: overflow evicts oldest NON-active only; live sessions survive a full store", () => {
  const list = [
    sess("old-done", "done", 500),
    sess("old-active", "active", 10),
    ...Array.from({ length: 60 }, (_, i) => sess(`s${i}`, "active", 1)),
  ];
  const plan = prunePlan(list, Date.now());
  // 62 sessions, cap 60 → 2 slots over, but only ONE non-active candidate.
  assert.deepEqual(plan.evict, ["old-done"]);
  assert.deepEqual(plan.expire, []);
});

test("prune: a session expiring in this pass becomes evictable in the same pass", () => {
  const list = [
    sess("expired-now", "active", 90),
    ...Array.from({ length: 61 }, (_, i) => sess(`t${i}`, "active", 1)),
  ];
  const plan = prunePlan(list, Date.now());
  assert.deepEqual(plan.expire, ["expired-now"]);
  assert.deepEqual(plan.evict, ["expired-now"]);
});
