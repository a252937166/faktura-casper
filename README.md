# Faktura — the autonomous invoice-financing desk on Casper

> Real-world invoices, underwritten by an **AI agent** whose every decision is
> **hash-anchored on-chain**, financed by a **native-CSPR DeFi liquidity pool**,
> and sold as a **machine-payable (x402) risk oracle** — Agentic AI × DeFi × RWA
> on Casper.

**Casper Agentic Buildathon 2026** submission · Casper Innovation Track ·
Deployed & running on **Casper Testnet**.

| | |
|---|---|
| Contract package | [`a10c7ba4…44730d`](https://testnet.cspr.live/contract-package/a10c7ba41e599a31f25a0bed75a698f06b07f1bc5e84aa5ceb4c144b7e44730d) |
| Odra address | `hash-a10c7ba41e599a31f25a0bed75a698f06b07f1bc5e84aa5ceb4c144b7e44730d` |
| Deploy tx | [`0d27e86f…`](https://testnet.cspr.live/transaction/0d27e86f613f5bbba0f296d48d04d08069b770ea2315e397735963d97e3632a0) |
| Network | Casper **Testnet** (`casper-test`) · built with **Odra 2.8** |

---

## The problem

Small businesses sell on 30–90 day terms and wait months to get paid. Invoice
factoring bridges the gap, but it is slow, opaque, and gated by human
underwriters — and the ~$3T of trade receivables behind it sit off-chain,
illiquid. Put an autonomous AI agent in the underwriter's seat and two questions
immediately follow: **can you trust what the agent decided, and why?** If an AI
drains a liquidity pool, "the model said so" is not an answer.

Faktura's thesis: **autonomous underwriting is only fundable if it is auditable.**

## What makes it agentic — and safe

Three agent roles run with no human in the loop:

- **Underwriter agent** — on each invoice it runs deterministic pre-checks →
  asks an LLM (Claude) for a risk score and price → applies hard policy
  guardrails (risk ceiling, discount clamp, pool-exposure cap) → registers the
  invoice, funds the advance from the pool, and **writes the SHA-256 of its full
  decision memo on-chain**. The LLM *proposes*; deterministic Rust *disposes*.
- **Collector agent** — reconciles settlements observed on-chain and
  **autonomously writes off** invoices past due + grace.
- **x402 risk oracle** — every underwriting produces a verified risk report,
  sold to other agents over **HTTP 402** with native-CSPR settlement
  (machine-to-machine, pay-per-call).

The load-bearing idea is the **on-chain attestation log**: `attest(...)` records
`{actor, kind, subjectId, payloadHash, model, ts}` for **every** autonomous
decision — approvals *and* rejections. You can prove after the fact exactly what
the agent decided and which model produced it. That is what turns "an AI moved
money" into "an auditable, fundable credit process."

## The DeFi + RWA core (`FakturaHub`, Odra/Rust)

- **RWA registry** — tokenized receivables with a `Listed → Funded → (Settled |
  Defaulted)` lifecycle.
- **Native-CSPR liquidity pool** — `deposit()` mints LP shares at the current
  share price; yield and losses accrue to the **share price**
  (`poolValue / totalShares`), so LPs who entered earlier capture the spread.
  `withdraw()` is limited to liquid (un-deployed) capital.
- **Agent permission layer** — separate underwriter / collector keys, rotatable
  by an admin; every mutating entrypoint is access-controlled with typed errors.
- **Auditable attestations** — the append-only AI-decision log described above.

A single deployed contract does all of it; see
[`contracts/src/lib.rs`](contracts/src/lib.rs). **12 Odra tests pass** and a
**live-testnet end-to-end run** exercises the whole lifecycle
([`agents/src/e2e.ts`](agents/src/e2e.ts)).

## Architecture

```
   Supplier ── invoice ──▶ ┌───────────────────────────┐
                           │   Underwriter agent        │  pre-checks → LLM
   ┌──────────┐  REST/SSE  │  (Node.js + Odra livenet)  │  → policy → on-chain
   │  Web UI   │◀──────────│  register · fund · attest  │
   │ (React)   │           └───────────┬───────────────┘
   └──────────┘                        │ Odra livenet CLI (Rust)
   ┌──────────┐  default/settle        ▼
   │Collector │───────────▶┌─────────────────────────────────────────┐
   │  agent   │            │        FakturaHub  (Odra / Rust)          │
   └──────────┘            │  RWA registry · native-CSPR pool ·        │
   ┌──────────┐  HTTP 402  │  agent permissions · AI-attestation log   │
   │x402 buyer│───────────▶│                                           │
   └──────────┘ pay-per-call         Casper Testnet
```

See [`docs/architecture.md`](docs/architecture.md) for the sequence diagram and
the on-chain data model.

## What was built for this hackathon

Everything here is new work for the Casper Agentic Buildathon:

- `contracts/` — `FakturaHub` in Odra/Rust: the RWA registry, the native-CSPR
  pool with an LP share-price yield model, the agent permission layer, and the
  on-chain AI-attestation log. Plus a small **livenet ops CLI**
  (`contracts/bin/livenet.rs`) the agents drive to transact.
- `agents/` — the autonomous underwriter + collector + x402 oracle (TypeScript;
  pluggable LLM: Anthropic API / local `claude` CLI / deterministic fallback).
- `web/` — a live operations dashboard (React + Vite).

## Run it

```bash
# prerequisites: Rust (nightly per rust-toolchain), cargo-odra, casper-client,
# Node 20+, and a funded Casper testnet key (https://testnet.cspr.live/tools/faucet)
cd contracts && cargo test          # 12 passing (Odra VM)
cargo odra build -c FakturaHub      # -> wasm/FakturaHub.wasm
cargo build --features livenet --bin livenet

# deploy (prints the contract address)
export ODRA_CASPER_LIVENET_SECRET_KEY_PATH=keys/agent/secret_key.pem
export ODRA_CASPER_LIVENET_NODE_ADDRESS=https://node.testnet.casper.network
export ODRA_CASPER_LIVENET_CHAIN_NAME=casper-test
./contracts/target/debug/livenet deploy <agent-account-hash> 30000

# agents + web, then drive the full lifecycle on live testnet
cd agents && npm install && FAKTURA_CONTRACT=hash-... npm run e2e
```

`npm run e2e` deposits into the pool, then underwrites three invoices — one
approved + funded + settled, one risk-rejected, one funded then defaulted — all
as real Casper Testnet transactions.

## Judging-criteria notes

- **Working smart contracts on Testnet** — deployed and exercised on
  `casper-test`; every state transition is a real on-chain deploy.
- **Use of AI / agentic systems** — the agents run the entire credit process;
  the on-chain attestation log makes each autonomous decision provable.
- **Real-world applicability (DeFi & RWA)** — invoice factoring is a live $3T
  market; the pool, yield model, and RWA lifecycle are the actual mechanism.
- **Long-term plan** — permissioned institutional pools, real supplier-ERP
  document ingestion with proof-of-authenticity, and a cross-framework agent
  marketplace for the x402 risk oracle.

## License

MIT.
