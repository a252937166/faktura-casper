import { spawn } from "node:child_process";
import { config } from "./config.js";

/** Structured output of the underwriting model. */
export interface UnderwritingOpinion {
  approve: boolean;
  risk_score: number;
  discount_bps: number;
  rationale: string;
  red_flags: string[];
  confidence: number;
}

export interface LlmResult {
  opinion: UnderwritingOpinion;
  provider: string;
  model: string;
}

const SYSTEM = `You are the autonomous underwriting agent of Faktura, an invoice-financing protocol on the Casper blockchain.
You receive one invoice intake as JSON. Decide whether the protocol's liquidity pool should purchase this receivable, and price it.

Scoring rubric:
- risk_score: 0 (safest) to 100 (riskiest). Consider debtor quality, invoice size vs. typical SMB flows, tenor (days until due), description plausibility, supplier history, round-number anomalies, duplicate indicators.
- discount_bps: the fee the pool charges, in basis points of face value (advance = face * (1 - discount_bps/10000)). Price risk: safe short invoices ~100-300 bps; risky or long-tenor ones 500-2000 bps.
- approve=false if risk_score would exceed 65, if the invoice looks fraudulent/duplicated, or if data is inconsistent (e.g. due date in the past, absurd amounts).
- red_flags: short bullet strings, empty array if none.
- rationale: 2-4 sentences, factual, audit-grade: this text is hashed and anchored on-chain.

Respond with ONLY a JSON object: {"approve": bool, "risk_score": int, "discount_bps": int, "rationale": str, "red_flags": [str], "confidence": float 0-1}.`;

function extractJson(text: string): UnderwritingOpinion {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM returned no JSON: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(match[0]);
  return {
    approve: Boolean(parsed.approve),
    risk_score: Math.max(0, Math.min(100, Math.round(Number(parsed.risk_score)))),
    discount_bps: Math.round(Number(parsed.discount_bps)),
    rationale: String(parsed.rationale ?? ""),
    red_flags: Array.isArray(parsed.red_flags) ? parsed.red_flags.map(String) : [],
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
  };
}

async function viaAnthropic(intake: unknown): Promise<LlmResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: config.llmModel,
    max_tokens: 1000,
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(intake, null, 2) }],
  });
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
  return { opinion: extractJson(text), provider: "anthropic", model: config.llmModel };
}

/** Uses the local `claude` CLI in headless mode — no API key needed. */
async function viaClaudeCli(intake: unknown): Promise<LlmResult> {
  const prompt = `${SYSTEM}\n\nInvoice intake:\n${JSON.stringify(intake, null, 2)}`;
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt], { env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude CLI timed out"));
    }, 120_000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) =>
      code === 0
        ? (clearTimeout(timer), resolve(out))
        : (clearTimeout(timer), reject(new Error(`claude CLI failed: ${err.slice(0, 300)}`))),
    );
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  return { opinion: extractJson(text), provider: "claude-cli", model: "claude-cli" };
}

/**
 * Deterministic fallback so the full flow runs with zero external services
 * (used in CI and by judges without API keys). Transparent heuristic, not ML.
 */
function viaMock(intake: {
  amountCspr: number;
  dueTs: number;
  debtorName: string;
  history?: string;
}): LlmResult {
  const days = Math.max(0, (intake.dueTs - Date.now()) / 86_400_000);
  let risk = 20;
  const flags: string[] = [];
  if (days > 60) (risk += 15), flags.push("long tenor");
  if (intake.amountCspr > 1000) (risk += 15), flags.push("large ticket");
  if (/unknown|shell|ltd\.?$/i.test(intake.debtorName)) (risk += 20), flags.push("thin debtor profile");
  if (/late|overdue|dispute/i.test(intake.history ?? "")) (risk += 25), flags.push("adverse payment history");
  const approve = risk <= 65;
  const discount = Math.min(2000, 100 + risk * 12 + days * 3);
  return {
    opinion: {
      approve,
      risk_score: Math.min(100, risk),
      discount_bps: Math.round(discount),
      rationale: `Deterministic heuristic scoring: tenor ${days.toFixed(0)}d, ticket ${intake.amountCspr} CSPR, flags: ${flags.join(", ") || "none"}.`,
      red_flags: flags,
      confidence: 0.55,
    },
    provider: "mock",
    model: "faktura-heuristic-v1",
  };
}

async function cliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--version"]);
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function underwrite(intake: {
  supplierName: string;
  debtorName: string;
  amountCspr: number;
  dueTs: number;
  invoiceNumber: string;
  description: string;
  history?: string;
}): Promise<LlmResult> {
  const provider = config.llmProvider;
  const enriched = {
    ...intake,
    dueDateIso: new Date(intake.dueTs).toISOString(),
    nowIso: new Date().toISOString(),
    daysUntilDue: Math.round((intake.dueTs - Date.now()) / 86_400_000),
  };

  if (provider === "anthropic") return viaAnthropic(enriched);
  if (provider === "claude-cli") return viaClaudeCli(enriched);
  if (provider === "mock") return viaMock(intake);

  // auto
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await viaAnthropic(enriched);
    } catch (e) {
      console.warn("anthropic failed, falling back:", (e as Error).message);
    }
  }
  if (await cliAvailable()) {
    try {
      return await viaClaudeCli(enriched);
    } catch (e) {
      console.warn("claude-cli failed, falling back to mock:", (e as Error).message);
    }
  }
  return viaMock(intake);
}
