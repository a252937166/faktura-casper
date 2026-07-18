/**
 * Offline verifier for a downloaded judge receipt (faktura.credit-receipt.v1).
 *
 *   npm run verify-receipt -- JUDGE-20260718-XXXXXXXX.json
 *
 * Checks, without talking to any server:
 *   1. receiptHash — SHA-256 of the receipt body (everything except the
 *      trailing receiptHash field) matches the embedded hash.
 *   2. decision memo — the FULL canonical memo document re-hashes to the
 *      decisionHash that was anchored on-chain (rationale + red flags included:
 *      edit one character anywhere and this breaks).
 *   3. consumer verdict memo — same re-hash for the buyer's own verdict.
 * The final step a human does by eye: open the attest deploy on CSPR.live and
 * compare the anchored payload hash to the decisionHash printed here.
 */
import fs from "node:fs";
import crypto from "node:crypto";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run verify-receipt -- <receipt.json>");
  process.exit(2);
}

const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
if (doc.schema !== "faktura.credit-receipt.v1") {
  console.error(`not a faktura.credit-receipt.v1 document (schema=${String(doc.schema)})`);
  process.exit(2);
}

let failed = false;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "  MATCH " : "MISMATCH"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

// 1. receiptHash covers the whole body minus the trailing receiptHash field.
const { receiptHash, ...body } = doc;
const recomputedReceipt = `sha256:${sha256(JSON.stringify(body))}`;
check("receiptHash", recomputedReceipt === receiptHash, `${recomputedReceipt}`);

// 2. Decision memo re-hash — the exact bytes anchored on-chain.
if (doc.memo && doc.decisionHash) {
  const recomputedMemo = `sha256:${sha256(JSON.stringify(doc.memo))}`;
  check("decision memo → decisionHash", recomputedMemo === doc.decisionHash, recomputedMemo);
} else {
  console.log("     —     no decision memo embedded (older run or report-only preset)");
}

// 3. Consumer verdict memo re-hash (x402 walkthroughs).
const cv = doc.consumerVerdict as { memo?: unknown; hash?: string } | null | undefined;
if (cv?.memo && cv.hash) {
  const recomputedVerdict = `sha256:${sha256(JSON.stringify(cv.memo))}`;
  check("consumer verdict memo → hash", recomputedVerdict === cv.hash, recomputedVerdict);
}

const steps = (doc.steps as Array<{ txHash?: string; explorerUrl?: string }> | undefined) ?? [];
const anchored = steps.filter((s) => s.txHash);
console.log(
  `\n${anchored.length} on-chain transaction(s) in this receipt — compare decisionHash above with the anchored payload on CSPR.live:`,
);
for (const s of anchored) console.log(`  ${s.explorerUrl ?? s.txHash}`);

console.log(failed ? "\nRESULT: MISMATCH — do not trust this receipt" : "\nRESULT: VERIFIED");
process.exit(failed ? 1 : 0);
