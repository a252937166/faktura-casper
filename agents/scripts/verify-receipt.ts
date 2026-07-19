/**
 * Verifier for a downloaded judge receipt (faktura.credit-receipt.v1).
 *
 *   npm run verify-receipt -- JUDGE-20260718-XXXXXXXX.json            # offline
 *   npm run verify-receipt -- JUDGE-….json --online                   # + chain
 *   npm run verify-receipt -- JUDGE-….json --online --node <rpc> --api <base>
 *
 * OFFLINE checks (no network): the receipt body re-hashes to its embedded
 * receiptHash, the canonical decision memo re-hashes to the decisionHash,
 * and the consumer verdict memo re-hashes to its hash. This proves INTERNAL
 * INTEGRITY only — a forger could rewrite the file and recompute every hash,
 * which is why the verdict says so instead of overclaiming.
 *
 * ONLINE adds authenticity: every transaction hash in the receipt is looked
 * up DIRECTLY against a Casper node RPC (trustless — not our API) and must
 * be finalized with the outcome the receipt claims (success, or the expected
 * revert for policy-block steps). The invoice's anchored decision hash is
 * cross-checked via the desk's public /api/pool (labeled as such — final
 * word is always the explorer links printed below).
 */
import fs from "node:fs";
import crypto from "node:crypto";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const online = argv.includes("--online");
const argAfter = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const NODE_RPC = argAfter("--node") ?? "https://node.testnet.casper.network/rpc";
const API_BASE = (argAfter("--api") ?? "https://faktura.axiqo.xyz").replace(/\/$/, "");

if (!file) {
  console.error(
    "usage: npm run verify-receipt -- <receipt.json> [--online] [--node rpc] [--api base]",
  );
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

// ---- 1. internal integrity -------------------------------------------------

const { receiptHash, ...body } = doc;
const recomputedReceipt = `sha256:${sha256(JSON.stringify(body))}`;
check("receiptHash", recomputedReceipt === receiptHash, `${recomputedReceipt}`);

if (doc.memo && doc.decisionHash) {
  const recomputedMemo = `sha256:${sha256(JSON.stringify(doc.memo))}`;
  check("decision memo → decisionHash", recomputedMemo === doc.decisionHash, recomputedMemo);
} else {
  console.log("     —     no decision memo embedded (older run or report-only preset)");
}

const cv = doc.consumerVerdict as { memo?: unknown; hash?: string } | null | undefined;
if (cv?.memo && cv.hash) {
  const recomputedVerdict = `sha256:${sha256(JSON.stringify(cv.memo))}`;
  check("consumer verdict memo → hash", recomputedVerdict === cv.hash, recomputedVerdict);
}

type Step = { key?: string; status?: string; txHash?: string; explorerUrl?: string };
const steps = ((doc.steps as Step[] | undefined) ?? []).filter((s) => s.txHash);

// ---- 2. chain authenticity (--online) --------------------------------------

async function rpcTransaction(
  hash: string,
): Promise<{ found: boolean; errorMessage: string | null }> {
  // Odra contract calls are TransactionV1; native transfers may be legacy
  // Deploys — try both wrappers before giving up.
  for (const wrap of [{ Version1: hash }, { Deploy: hash }]) {
    const r = await fetch(NODE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "info_get_transaction",
        params: { transaction_hash: wrap },
      }),
    });
    const j = (await r.json().catch(() => ({}))) as {
      result?: {
        execution_info?: { execution_result?: Record<string, { error_message?: string | null }> };
      };
      error?: unknown;
    };
    const execResult = j.result?.execution_info?.execution_result;
    if (execResult) {
      const versioned = execResult.Version2 ?? execResult.Version1 ?? {};
      return { found: true, errorMessage: versioned.error_message ?? null };
    }
  }
  return { found: false, errorMessage: null };
}

async function onlineChecks() {
  console.log(`\nquerying ${steps.length} transaction(s) directly against ${NODE_RPC} …`);
  let chainFailed = false;
  for (const s of steps) {
    const { found, errorMessage } = await rpcTransaction(s.txHash!);
    const wantRevert = s.status === "reverted";
    let ok: boolean;
    let note: string;
    if (!found) {
      ok = false;
      note = "NOT FOUND on chain";
    } else if (wantRevert) {
      // The policy-block story claims a SPECIFIC revert — assert exactly it.
      // "Some revert happened" would let a wrong failure impersonate the ace.
      const wantExact = doc.preset === "policy-block" && s.key === "fund" ? "User error: 15" : null;
      ok = wantExact ? !!errorMessage && errorMessage.includes(wantExact) : errorMessage != null;
      note = ok
        ? `finalized as expected revert (${errorMessage})`
        : wantExact && errorMessage != null
          ? `reverted with "${errorMessage}" but the receipt claims ${wantExact}`
          : "expected a revert but the tx succeeded";
    } else {
      ok = errorMessage == null;
      note = ok ? "finalized, success" : `execution failed: ${errorMessage}`;
    }
    console.log(
      `${ok ? "  CHAIN  " : "MISMATCH"}  ${s.key ?? "step"} ${s.txHash!.slice(0, 12)}… — ${note}`,
    );
    if (!ok) chainFailed = true;
  }

  // Anchored-hash cross-check via the desk's public API (labeled — the
  // explorer links remain the final authority a human can click).
  if (doc.invoiceId && doc.decisionHash) {
    try {
      const pool = (await (await fetch(`${API_BASE}/api/pool`)).json()) as {
        onchain?: Array<{ id: number; state: number; decisionHash: string }>;
      };
      const inv = pool.onchain?.find((x) => x.id === doc.invoiceId);
      if (inv) {
        const ok = inv.decisionHash === doc.decisionHash;
        console.log(
          `${ok ? "  CHAIN  " : "MISMATCH"}  invoice #${doc.invoiceId} anchored decisionHash ${ok ? "matches the receipt" : "DIFFERS from the receipt"} (via ${API_BASE}/api/pool — desk-served, cross-check on the explorer)`,
        );
        if (!ok) chainFailed = true;
      } else {
        console.log(`     —     invoice #${doc.invoiceId} not in the public book response`);
      }
    } catch {
      console.log("     —     desk API unreachable — anchored-hash cross-check skipped");
    }
  }
  return chainFailed;
}

// ---- verdict ----------------------------------------------------------------

const finish = (chainFailed: boolean | null) => {
  console.log(
    `\n${steps.length} on-chain transaction(s) referenced — the explorer is always the final authority:`,
  );
  for (const s of steps) console.log(`  ${s.explorerUrl ?? s.txHash}`);

  if (failed) {
    console.log("\nRESULT: MISMATCH — do not trust this receipt");
    process.exit(1);
  }
  console.log("\nRESULT: INTERNAL INTEGRITY VERIFIED (offline)");
  if (chainFailed === null) {
    console.log(
      "CHAIN AUTHENTICITY: manual check required — open the explorer links above, or re-run with --online",
    );
    process.exit(0);
  }
  if (chainFailed) {
    console.log("CHAIN AUTHENTICITY: FAILED — the chain does not back this receipt");
    process.exit(1);
  }
  console.log(
    `CHAIN AUTHENTICITY: ${steps.length} transaction(s) finalized on casper-test with the claimed outcomes`,
  );
  process.exit(0);
};

if (online) void onlineChecks().then(finish);
else finish(null);
