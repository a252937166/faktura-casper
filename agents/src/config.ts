import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (faktura/). */
export const ROOT = path.resolve(here, "..", "..");

export const config = {
  port: Number(process.env.PORT ?? 4020),

  /**
   * Showcase mode: serve a public, read-only demo without the Rust livenet
   * binary or any secret keys. On-chain reads come from a captured seed
   * snapshot (real testnet state, verifiable on cspr.live); writes are
   * simulated in-memory. The AI underwriter still runs for real.
   */
  showcase: process.env.FAKTURA_SHOWCASE === "1",
  seedPath: process.env.FAKTURA_SEED ?? path.join(ROOT, "agents/data/seed.json"),

  /** Deployed FakturaHub contract address ("hash-..."). */
  contract: process.env.FAKTURA_CONTRACT ?? "",

  /** Casper network config (Odra livenet env). */
  nodeAddress:
    process.env.CASPER_NODE_ADDRESS ?? "https://node.testnet.casper.network",
  chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test",
  eventsUrl:
    process.env.CASPER_EVENTS_URL ??
    "https://node.testnet.casper.network/events",

  /** Persona secret keys (Ed25519 PEM files). */
  keys: {
    agent: process.env.AGENT_KEY_PATH ?? path.join(ROOT, "keys/agent/secret_key.pem"),
    investor:
      process.env.INVESTOR_KEY_PATH ?? path.join(ROOT, "keys/investor/secret_key.pem"),
    debtor: process.env.DEBTOR_KEY_PATH ?? path.join(ROOT, "keys/debtor/secret_key.pem"),
  },

  /** Path to the compiled livenet ops binary (see contracts/bin/livenet.rs). */
  livenetBin:
    process.env.FAKTURA_LIVENET_BIN ??
    path.join(ROOT, "contracts/target/debug/livenet"),

  /** Underwriting policy guardrails (deterministic, enforced in code). */
  policy: {
    minFaceCspr: 5,
    maxFaceCspr: 5000,
    minDueInMs: 60_000, // due date must be at least 1 min out
    maxDueInMs: 120 * 24 * 3600_000,
    minDiscountBps: 50,
    maxDiscountBps: 2500,
    maxRiskScore: 65, // policy: reject anything riskier
    maxPoolShareBps: 6000, // single invoice advance <= 60% of liquid pool
  },

  /** Collector loop. */
  collector: {
    intervalMs: Number(process.env.COLLECTOR_INTERVAL_MS ?? 30_000),
  },

  /** LLM provider: "anthropic" | "claude-cli" | "deepseek" | "mock" | "auto". */
  llmProvider: process.env.LLM_PROVIDER ?? "auto",
  llmModel: process.env.LLM_MODEL ?? "claude-sonnet-4-5",

  /** DeepSeek (OpenAI-compatible) — used when the host has no Claude Code CLI. */
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "",
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
  },

  /** x402 paid oracle pricing (motes). */
  x402: {
    priceMotes: process.env.X402_PRICE_MOTES ?? "2500000000", // 2.5 CSPR
    payTo: process.env.X402_PAY_TO ?? "", // agent account hash, set at boot
    ttlMs: 10 * 60_000,
  },

  explorerBase: "https://testnet.cspr.live",
  dataDir: process.env.FAKTURA_DATA_DIR ?? path.join(ROOT, "agents/data"),
};

export type Persona = keyof typeof config.keys;
