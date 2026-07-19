import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finalTxHash,
  parseProgressLine,
  setLiveProgressSink,
  type ProgressTrack,
} from "../src/chain.js";

/** The regression behind this file: the first bare 64-hex in the CLI stream
 * is the contract PACKAGE hash from the "Calling …" line — the old parser
 * linked it as the transaction, giving every run the same explorer-dead URL.
 * The real tx hash must come ONLY from the signed transaction's debug dump,
 * announced once the watcher confirms submission. */

const PKG = "c8981d32a1f00000000000000000000000000000000000000000000000000000";
const TX = "6d0f7abc0123456789abcdef0123456789abcdef0123456789abcdef01234567";

function collect() {
  const events: { phase?: string; txHash?: string }[] = [];
  setLiveProgressSink((p) => events.push(p));
  return events;
}

test("package hash in the Calling line is NEVER announced as the tx", () => {
  const events = collect();
  const track: ProgressTrack = { hash: null, announced: false };
  parseProgressLine(`Calling "hash-${PKG}" with entrypoint "attest" through proxy.`, track);
  setLiveProgressSink(null);
  assert.equal(track.hash, null);
  assert.ok(events.every((e) => !e.txHash));
  assert.equal(events.at(-1)?.phase, "building & signing the transaction");
});

test("tx hash is remembered from the signed-transaction dump, announced by the watcher", () => {
  const events = collect();
  const track: ProgressTrack = { hash: null, announced: false };
  parseProgressLine(`  "hash": "${TX}",`, track);
  assert.equal(track.hash, TX);
  assert.ok(
    events.every((e) => !e.txHash),
    "not announced before submission",
  );
  parseProgressLine(
    `[DEBUG] [WATCHER] Starting to monitor for transaction: deploy-hash(6d0f7…4567)`,
    track,
  );
  setLiveProgressSink(null);
  const announced = events.filter((e) => e.txHash);
  assert.equal(announced.length, 1);
  assert.equal(announced[0].txHash, TX);
  assert.equal(announced[0].phase, "submitted — waiting for on-chain finality");
});

test("watcher announcement is idempotent", () => {
  const events = collect();
  const track: ProgressTrack = { hash: null, announced: false };
  parseProgressLine(`  "hash": "${TX}",`, track);
  parseProgressLine(`[DEBUG] [WATCHER] Starting to monitor for transaction: x`, track);
  parseProgressLine(`[DEBUG] [WATCHER] Starting to monitor for transaction: x`, track);
  setLiveProgressSink(null);
  assert.equal(events.filter((e) => e.txHash).length, 1);
});

test("watcher line without a tracked hash degrades to a phase note (info level)", () => {
  const events = collect();
  const track: ProgressTrack = { hash: null, announced: false };
  parseProgressLine(`[DEBUG] [WATCHER] Starting to monitor for transaction: x`, track);
  setLiveProgressSink(null);
  assert.ok(events.every((e) => !e.txHash));
  assert.equal(events.at(-1)?.phase, "submitted — waiting for on-chain finality");
});

test("other hex fields in the dump (body_hash, args) are ignored", () => {
  const events = collect();
  const track: ProgressTrack = { hash: null, announced: false };
  parseProgressLine(`    "body_hash": "${PKG}",`, track);
  parseProgressLine(`      "bytes": "${PKG}",`, track);
  setLiveProgressSink(null);
  assert.equal(track.hash, null);
  assert.equal(events.length, 0);
});

// ---- finalTxHash: the execution-report line beats every other hex ----------

const ROOT = "5d7b1b23197cda53dec593caf30836a5740afa2279b356fae74bf1bdc2b2e725";

test("final hash comes from the execution report, not the last hex (debug query noise)", () => {
  // The production regression: debug-level query dumps print state roots
  // AFTER the success line, so "last hex wins" picked a state root.
  const raw = [
    `Calling "hash-${PKG}" with entrypoint "attest" through proxy.`,
    `Deploy "${TX}" successfully executed.`,
    `[DEBUG] { "state_root_hash": "${ROOT}" }`,
  ].join("\n");
  assert.equal(finalTxHash(raw), TX);
});

test("V2 transaction report and V1 failure report both match", () => {
  assert.equal(finalTxHash(`Transaction "${TX}" successfully executed.`), TX);
  assert.equal(finalTxHash(`Deploy V1 "${TX}" failed with error: "User error: 15".`), TX);
  assert.equal(finalTxHash(`Transaction "${TX}" failed with error: something.`), TX);
});

test("no execution report → no hash (pre-submit failures carry none)", () => {
  assert.equal(finalTxHash(`[DEBUG] { "hash": "${ROOT}" }\nGasNotSet`), undefined);
});
