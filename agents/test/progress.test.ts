import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProgressLine, setLiveProgressSink, type ProgressTrack } from "../src/chain.js";

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
