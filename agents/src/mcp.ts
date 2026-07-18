/**
 * Faktura MCP server — plugs the autonomous credit desk into any MCP-capable
 * agent (Claude Code/Desktop, etc.) as six tools over stdio. Tools talk to a
 * running Faktura service via its REST API.
 *
 * Two modes, stated per tool: against the HOSTED showcase, reads are live but
 * chain writes are simulated ('showcase:'-tagged hashes); against a LOCAL
 * stack in live mode (docs/casper-live.md) every write is a real Testnet deploy.
 *
 *   FAKTURA_API=https://faktura.axiqo.xyz npx tsx src/mcp.ts
 *   # or register it:  claude mcp add faktura -- npx tsx src/mcp.ts
 */
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const base = (process.env.FAKTURA_API ?? "http://localhost:4020").replace(/\/$/, "");

/** Re-hash a canonical memo document fetched over REST. JSON.parse preserves
 * key order, so stringifying the parsed object reproduces the hashed bytes. */
const memoHash = (memo: unknown) =>
  `sha256:${crypto.createHash("sha256").update(JSON.stringify(memo)).digest("hex")}`;

const text = (v: unknown) => ({
  content: [
    { type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) },
  ],
});

async function get(path: string): Promise<any> {
  const r = await fetch(`${base}${path}`);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const server = new McpServer({ name: "faktura", version: "0.2.4" });

server.tool(
  "pool_stats",
  "Live stats of the Faktura liquidity pool on Casper Testnet: TVL, LP share price, funded/settled/defaulted totals, invoice and attestation counts.",
  {},
  async () => {
    const { body } = await get("/api/pool");
    const s = body.stats ?? {};
    const cspr = (m: string) => Number(BigInt(m ?? "0") / 1_000_000n) / 1000;
    const tvl = cspr(s.liquid) + cspr(s.deployed);
    const sharePrice =
      s.totalShares && BigInt(s.totalShares) > 0n
        ? Number(((BigInt(s.liquid) + BigInt(s.deployed)) * 10_000n) / BigInt(s.totalShares)) /
          10_000
        : 1;
    return text({
      contract: body.contract,
      explorer: `${body.explorer}/contract-package/${String(body.contract ?? "").replace("hash-", "")}`,
      tvlCspr: tvl,
      liquidCspr: cspr(s.liquid),
      deployedCspr: cspr(s.deployed),
      lpSharePrice: sharePrice,
      totalFundedCspr: cspr(s.totalFunded),
      totalSettledCspr: cspr(s.totalSettled),
      totalDefaultedCspr: cspr(s.totalDefaulted),
      invoiceCount: s.invoiceCount,
      aiAttestationsOnChain: s.attestationCount,
    });
  },
);

server.tool(
  "list_funded_invoices",
  "Invoices currently financed by the pool (on-chain state FUNDED), with face value, advance, risk score and due date. See also list_verified_invoices — ANY invoice with an anchored decision memo can be priced via x402, not only live positions.",
  {},
  async () => {
    const { body } = await get("/api/pool");
    const funded = (body.onchain ?? [])
      .filter((i: any) => i.state === 1)
      .map((i: any) => ({
        id: i.id,
        faceCspr: Number(BigInt(i.faceValue) / 1_000_000n) / 1000,
        advanceCspr: Number(BigInt(i.advance) / 1_000_000n) / 1000,
        riskScore: i.riskScore,
        discountBps: i.discountBps,
        dueIso: new Date(i.dueTs).toISOString(),
        decisionHash: i.decisionHash,
      }));
    return text({ count: funded.length, funded });
  },
);

const STATE_NAMES = ["LISTED", "FUNDED", "SETTLED", "DEFAULTED"];

server.tool(
  "list_verified_invoices",
  "Every on-chain invoice whose canonical decision memo ACTUALLY verifies — the memo document re-hashes to the local decision hash AND matches the on-chain anchor (LISTED, FUNDED, SETTLED or DEFAULTED). This is the buyable universe for get_risk_report; invoices with a hash but no verifiable memo are excluded, not dressed up.",
  {},
  async () => {
    const [inv, pool] = await Promise.all([get("/api/invoices"), get("/api/pool")]);
    const locals = (inv.body as any[]) ?? [];
    const verified = ((pool.body.onchain as any[]) ?? [])
      .filter((i) =>
        locals.some(
          (r) =>
            r.id === i.id &&
            r.decision &&
            r.memo &&
            memoHash(r.memo) === r.decision.decisionHash &&
            r.decision.decisionHash === i.decisionHash,
        ),
      )
      .map((i) => ({
        id: i.id,
        state: STATE_NAMES[i.state] ?? `#${i.state}`,
        faceCspr: Number(BigInt(i.faceValue) / 1_000_000n) / 1000,
        riskScore: i.riskScore,
        discountBps: i.discountBps,
        dueIso: new Date(i.dueTs).toISOString(),
        decisionHash: i.decisionHash,
        memoVerified: true,
      }));
    return text({ count: verified.length, verified });
  },
);

server.tool(
  "submit_invoice",
  "Submit a receivable to the autonomous AI underwriter. It runs pre-checks + LLM risk scoring, and the on-chain policy decides; approved invoices are registered, funded to the supplier and attested on Casper. MODE MATTERS: against the hosted showcase the AI underwriting is live but chain writes are SIMULATED ('showcase:'-tagged hashes, no real deploys); run the stack locally in live mode (docs/casper-live.md) to sign real Testnet transactions.",
  {
    supplierName: z.string().describe("Legal name of the supplier selling the invoice"),
    debtorName: z.string().describe("Company that owes the invoice"),
    amountCspr: z.number().describe("Face value in CSPR (demo scale)"),
    dueInDays: z.number().describe("Days until the invoice is due"),
    invoiceNumber: z.string().describe("Invoice reference, e.g. INV-2026-042"),
    description: z.string().describe("What the invoice is for"),
    history: z.string().optional().describe("Payment history with this debtor"),
    supplierAddress: z
      .string()
      .optional()
      .describe(
        "Casper account (account-hash-…) that receives the advance; defaults to the demo supplier",
      ),
  },
  async (a) => {
    const r = await fetch(`${base}/api/invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supplierName: a.supplierName,
        debtorName: a.debtorName,
        amountCspr: a.amountCspr,
        dueTs: Date.now() + a.dueInDays * 86_400_000,
        invoiceNumber: a.invoiceNumber,
        description: a.description,
        history: a.history,
        supplierAddress: a.supplierAddress,
      }),
    });
    const rec = (await r.json()) as any;
    if (!r.ok) return text({ error: rec.error ?? r.statusText });
    return text({
      status: rec.status,
      invoiceId: rec.id,
      riskScore: rec.decision?.riskScore,
      discountBps: rec.decision?.discountBps,
      redFlags: rec.decision?.redFlags,
      rationale: rec.decision?.rationale,
      decisionHash: rec.decision?.decisionHash,
      advanceRecipient: rec.intake?.supplierAddress,
      chainTxs: rec.chain,
    });
  },
);

server.tool(
  "get_risk_report",
  "Negotiate the x402 machine-payable oracle for an invoice's verified AI risk report. This tool never spends money itself: without payment proof it returns the HTTP 402 PaymentRequirements (price, payTo, nonce); YOU pay from any wallet or agent with a native CSPR transfer carrying the nonce as transfer id, then call again with paymentDeployHash + nonce to unlock the report (which ships the full canonical decision memo — re-hash it yourself against the on-chain anchor).",
  {
    invoiceId: z.number().describe("On-chain invoice id"),
    paymentDeployHash: z.string().optional().describe("Deploy hash of your settlement transfer"),
    nonce: z
      .string()
      .optional()
      .describe("Nonce from the 402 PaymentRequirements you are settling"),
  },
  async (a) => {
    const headers: Record<string, string> = {};
    if (a.paymentDeployHash && a.nonce) {
      headers["PAYMENT-SIGNATURE"] = a.paymentDeployHash;
      headers["PAYMENT-NONCE"] = a.nonce;
    }
    const r = await fetch(`${base}/api/risk/${a.invoiceId}`, { headers });
    const body = await r.json().catch(() => ({}));
    return text({ httpStatus: r.status, ...(body as object) });
  },
);

server.tool(
  "verify_decision_hash",
  "Audit an AI underwriting decision the hard way: re-computes the SHA-256 of the FULL canonical memo document (rationale and red flags included), then compares that fresh hash against BOTH the locally stored decision hash and the anchor in the on-chain invoice record. Editing one character of the memo after the fact breaks this — comparing two stored strings would not catch it, so this tool never does that.",
  { invoiceId: z.number().describe("On-chain invoice id") },
  async (a) => {
    const [inv, pool] = await Promise.all([get("/api/invoices"), get("/api/pool")]);
    const record = (inv.body as any[]).find((x) => x.id === a.invoiceId);
    const onchain = (pool.body.onchain as any[])?.find((x) => x.id === a.invoiceId);
    if (!record?.decision || !onchain)
      return text({ error: `no local decision or on-chain record for invoice #${a.invoiceId}` });
    if (!record.memo) {
      return text({
        invoiceId: a.invoiceId,
        match: false,
        error:
          "canonical memo unavailable (legacy record predating faktura.decision.v1) — there is nothing to re-hash, so this decision cannot be verified. Underwrite a fresh invoice to see a full verification.",
        storedLocalHash: record.decision.decisionHash,
        onchainAnchoredHash: onchain.decisionHash,
      });
    }
    const recomputedMemoHash = memoHash(record.memo);
    const localMatch = recomputedMemoHash === record.decision.decisionHash;
    const onchainMatch = recomputedMemoHash === onchain.decisionHash;
    const match = localMatch && onchainMatch;
    return text({
      invoiceId: a.invoiceId,
      recomputedMemoHash,
      storedLocalHash: record.decision.decisionHash,
      onchainAnchoredHash: onchain.decisionHash,
      localMatch,
      onchainMatch,
      match,
      verdict: match
        ? "MATCH — the full memo document re-hashes to exactly what was anchored on-chain"
        : "MISMATCH — the memo document does NOT re-hash to the anchor; someone edited the story after the fact",
      // Simulated showcase writes are tagged 'showcase:' — never build an
      // explorer URL out of one.
      registerTx:
        record.chain?.registerHash && !String(record.chain.registerHash).startsWith("showcase")
          ? `${pool.body.explorer}/deploy/${record.chain.registerHash}`
          : undefined,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[faktura-mcp] ready — REST base ${base}`);
