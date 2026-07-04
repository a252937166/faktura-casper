import path from "node:path";
import express from "express";
import cors from "cors";
import { config, ROOT } from "./config.js";
import { feed } from "./feed.js";
import { db } from "./store.js";
import { chain } from "./chain.js";
import { processIntake, type IntakeInput } from "./underwriter.js";
import { startCollector } from "./collector.js";
import { x402Gate } from "./x402.js";
import { getSeed } from "./chain-showcase.js";
import type { FeedEvent } from "./feed.js";
import type { InvoiceRecord } from "./store.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---- Intake / underwriting ------------------------------------------------

app.post("/api/invoices", async (req, res) => {
  try {
    const b = req.body as Partial<IntakeInput>;
    for (const k of ["supplierName", "debtorName", "amountCspr", "dueTs", "invoiceNumber"] as const) {
      if (b[k] === undefined) {
        res.status(400).json({ error: `missing field ${k}` });
        return;
      }
    }
    const record = await processIntake({
      supplierName: String(b.supplierName),
      supplierAddress: b.supplierAddress ? String(b.supplierAddress) : undefined,
      debtorName: String(b.debtorName),
      amountCspr: Number(b.amountCspr),
      dueTs: Number(b.dueTs),
      invoiceNumber: String(b.invoiceNumber),
      description: String(b.description ?? ""),
      history: b.history ? String(b.history) : undefined,
      document: b.document ? String(b.document) : undefined,
    });
    res.json(record);
  } catch (e) {
    feed.publish({ actor: "system", kind: "error", message: (e as Error).message.slice(0, 300) });
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/invoices", (_req, res) => {
  res.json([...db.invoices].sort((a, b) => b.intake.receivedTs - a.intake.receivedTs));
});

// ---- Pool / chain state -----------------------------------------------------

let statsCache: { ts: number; data: unknown } = { ts: 0, data: null };
app.get("/api/pool", async (_req, res) => {
  try {
    if (Date.now() - statsCache.ts > 10_000) {
      const [stats, onchain] = await Promise.all([chain.stats(), chain.invoices(1, 200)]);
      statsCache = { ts: Date.now(), data: { stats, onchain, contract: config.contract, explorer: config.explorerBase } };
    }
    res.json(statsCache.data);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Demo actions: in production these are wallet transactions from real users;
// in the hackathon demo they run against funded testnet demo keys.
app.post("/api/demo/deposit", async (req, res) => {
  try {
    const cspr = Number(req.body?.amountCspr ?? 0);
    if (!(cspr > 0)) {
      res.status(400).json({ error: "amountCspr > 0 required" });
      return;
    }
    feed.publish({ actor: "system", kind: "demo", message: `LP depositing ${cspr} CSPR into the pool...` });
    const r = await chain.deposit(BigInt(Math.round(cspr * 1e9)).toString());
    statsCache.ts = 0;
    feed.publish({
      actor: "system",
      kind: "onchain",
      message: `LP deposit confirmed on-chain`,
      deployHash: r.deployHashes.at(-1),
    });
    res.json({ ok: true, deployHash: r.deployHashes.at(-1) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/demo/settle/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const inv = await chain.invoice(id);
    if (!inv) {
      res.status(404).json({ error: "invoice not found" });
      return;
    }
    feed.publish({
      actor: "system",
      kind: "demo",
      message: `Debtor initiating settlement of invoice #${id} (${Number(BigInt(inv.faceValue) / 1000000n) / 1000} CSPR)...`,
    });
    const r = await chain.settle(id, inv.faceValue);
    statsCache.ts = 0;
    feed.publish({
      actor: "system",
      kind: "onchain",
      message: `Invoice #${id} settlement transaction confirmed`,
      invoiceId: id,
      deployHash: r.deployHashes.at(-1),
    });
    res.json({ ok: true, deployHash: r.deployHashes.at(-1) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---- x402 machine-payable risk oracle --------------------------------------

app.get("/api/risk/:id", x402Gate(), async (req, res) => {
  const id = Number(req.params.id);
  const record = db.invoices.find((x) => x.id === id);
  const inv = await chain.invoice(id).catch(() => null);
  if (!record?.decision || !inv) {
    res.status(404).json({ error: "no risk report for this invoice" });
    return;
  }
  res.json({
    invoiceId: id,
    issuedAt: new Date().toISOString(),
    issuer: "faktura-risk-oracle-v1",
    riskScore: record.decision.riskScore,
    discountBps: record.decision.discountBps,
    redFlags: record.decision.redFlags,
    rationale: record.decision.rationale,
    decisionHash: record.decision.decisionHash,
    onchain: {
      state: inv.state,
      faceValue: inv.faceValue,
      dueTs: inv.dueTs,
      contract: config.contract,
      verify: `${config.explorerBase}/contract/${config.contract.replace("hash-", "")}`,
    },
  });
});

// ---- Activity feed (SSE) ----------------------------------------------------

app.get("/api/activity", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ history: feed.history.slice(-100) })}\n\n`);
  const onEvent = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  feed.on("event", onEvent);
  req.on("close", () => feed.off("event", onEvent));
});

let metaCache: Record<string, unknown> | null = null;
app.get("/api/meta", async (_req, res) => {
  if (!metaCache) {
    let policy: unknown = null;
    let supplier: string | null = null;
    try {
      policy = await chain.policy();
    } catch {
      /* pre-policy contract or node hiccup — banner degrades gracefully */
    }
    try {
      supplier = await chain.caller("supplier");
    } catch {
      /* key missing on this host */
    }
    metaCache = {
      mode: config.showcase ? "showcase" : "live-testnet",
      contract: config.contract,
      chain: config.chainName,
      node: config.nodeAddress,
      explorer: config.explorerBase,
      x402Price: config.x402.priceMotes,
      llmProvider: config.llmProvider,
      policy,
      supplier,
    };
  }
  res.json(metaCache);
});

// ---- Static web app ---------------------------------------------------------

const webDist = path.join(ROOT, "web", "dist");
app.use(express.static(webDist));
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) res.status(404).send("web UI not built yet — run: cd web && npm run build");
  });
});

// ---- Boot -------------------------------------------------------------------

/** Preload the public showcase with a real captured snapshot (invoices + feed). */
function seedShowcase() {
  try {
    const seed = getSeed();
    if (Array.isArray(seed.records)) {
      db.invoices.length = 0;
      db.invoices.push(...(seed.records as InvoiceRecord[]));
    }
    if (Array.isArray(seed.feed)) {
      feed.history = seed.feed as FeedEvent[];
    }
    console.log(
      `showcase seed loaded: ${db.invoices.length} invoices, ${feed.history.length} activity events`,
    );
  } catch (e) {
    console.warn("showcase seed load failed:", (e as Error).message);
  }
}

async function main() {
  if (config.showcase) {
    seedShowcase();
  } else {
    if (!config.contract) {
      console.warn("FAKTURA_CONTRACT not set — chain features disabled until deploy.");
    }
    if (!config.x402.payTo) {
      // Prefer the agent PUBLIC KEY (buyers can transfer to it directly);
      // fall back to the account hash from the livenet binary.
      try {
        const fs = await import("node:fs");
        config.x402.payTo = fs
          .readFileSync(path.join(ROOT, "keys/agent/public_key_hex"), "utf8")
          .trim();
      } catch {
        try {
          config.x402.payTo = await chain.caller("agent");
        } catch {
          /* key not present on this host */
        }
      }
    }
  }
  app.listen(config.port, process.env.HOST ?? "0.0.0.0", () => {
    feed.publish({
      actor: "system",
      kind: "boot",
      message: config.showcase
        ? `Faktura showcase on :${config.port} — live autonomous AI underwriter, on-chain reads from real testnet snapshot`
        : `Faktura agent service on :${config.port} — contract ${config.contract || "(unset)"}`,
    });
    // The autonomous collector only runs against the real chain, never the showcase snapshot.
    if (config.contract && !config.showcase) startCollector();
  });
}

main();
