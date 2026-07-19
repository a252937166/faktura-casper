/**
 * Audit-7 hardening tests: the abandon decision, funding-error classification
 * (infrastructure must never masquerade as a policy verdict), and x402 charge
 * persistence across a restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FAKTURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "faktura-test7-"));
process.env.FAKTURA_SHOWCASE = "1";

const { abandonOutcome } = await import("../src/judge.js");
const { classifyFundError } = await import("../src/underwriter.js");
const { config } = await import("../src/config.js");

// ---- abandon decision -------------------------------------------------------

const sess = (over: Record<string, unknown> = {}) => ({
  status: "active",
  steps: [{ status: "done" }, { status: "ready" }],
  ctx: {},
  ...over,
});

test("abandon: a running step means SETTLING — refuse", () => {
  assert.equal(
    abandonOutcome(sess({ steps: [{ status: "done" }, { status: "running" }] }) as never),
    "settling",
  );
});

test("abandon: pre-fund session releases cleanly", () => {
  assert.equal(abandonOutcome(sess() as never), "release");
});

test("abandon: funded session hands off to cleanup", () => {
  assert.equal(
    abandonOutcome(sess({ ctx: { record: { chain: { fundHash: "ab".repeat(32) } } } }) as never),
    "cleanup",
  );
  assert.equal(abandonOutcome(sess({ ctx: { payoutCommitted: true } }) as never), "cleanup");
});

test("abandon: ended sessions are idempotent no-ops", () => {
  assert.equal(abandonOutcome(sess({ status: "done" }) as never), "already-ended");
});

// ---- funding error classification ------------------------------------------

test("classifyFundError: typed policy errors 13–16 are POLICY", () => {
  assert.equal(classifyFundError("User error: 15 (SingleInvoiceCapExceeded)"), "policy");
  assert.equal(classifyFundError("User error: 13 (RiskAbovePolicy)"), "policy");
  assert.equal(classifyFundError("User error: 16 (DebtorExposureCapExceeded)"), "policy");
});

test("classifyFundError: timeouts, RPC failures and other errors are INFRA", () => {
  assert.equal(classifyFundError("connection timed out after 180s"), "infra");
  assert.equal(classifyFundError("User error: 6 (InsufficientLiquidity)"), "infra");
  assert.equal(classifyFundError("livenet fund failed (101): thread panicked"), "infra");
});

// ---- x402 charge persistence ------------------------------------------------

test("x402 state: a paid nonce and the replay set survive a restart (loader honors the file)", async () => {
  // Write the state file BEFORE the x402 module is first imported in this
  // process — its module-init loader must pick both entries up, exactly like
  // a backend restart between the 402 and the buyer's retry.
  const stateFile = path.join(config.dataDir, "x402-state.json");
  const nonce = "784551123";
  const staleNonce = "111222333";
  const deploy = "cd".repeat(32);
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      pending: [
        {
          nonce,
          createdTs: Date.now(),
          resource: "/api/risk/30",
          invoiceId: 30,
          amountMotes: "2500000000",
          payTo: "0202bc",
        },
        { nonce: staleNonce, createdTs: Date.now() - 365 * 24 * 3600_000 }, // long expired
      ],
      settled: { [deploy]: Date.now() },
    }),
  );
  const x402 = await import("../src/x402.js");
  assert.equal(x402.x402HasPendingNonce(nonce), true, "paid nonce must survive the restart");
  assert.equal(x402.x402HasPendingNonce(staleNonce), false, "expired charges are pruned on load");
  assert.equal(x402.x402DeploySettled(deploy), true, "replay protection must survive the restart");
});
