# Faktura — the autonomous RWA credit desk on Casper

> Real-world invoices, underwritten by an **AI agent**, bounded by an
> **on-chain risk policy**, financed by a **native-CSPR liquidity pool**, and
> sold to other machines as an **x402 pay-per-call risk oracle** — an
> autonomous credit desk for the Casper machine economy.

**Casper Agentic Buildathon 2026** submission · Casper Innovation Track ·
Deployed & running on **Casper Testnet**.

| | |
|---|---|
| Contract package | [`fb209bb1…b49d7e`](https://testnet.cspr.live/contract-package/fb209bb1d3a1d5e675841f7d184ab7fa96d65adc099f6fd0105f29115fb49d7e) |
| Odra address | `hash-fb209bb1d3a1d5e675841f7d184ab7fa96d65adc099f6fd0105f29115fb49d7e` |
| Deploy tx | [`b59b3292…`](https://testnet.cspr.live/transaction/b59b32927dc57f614a56de4012990f4303542ac12f821c21e0408ade3fe90d5d) |
| Network | Casper **Testnet** (`casper-test`) · built with **Odra 2.8** |
| Evidence pack | [`DORAHACKS.md`](DORAHACKS.md) — every lifecycle step as an explorer-linkable transaction |

---

## The problem

Small businesses sell on 30–90 day terms and wait months to get paid. Invoice
factoring bridges the gap, but it is slow, opaque, and gated by human
underwriters — and the ~$3T of trade receivables behind it sit off-chain,
illiquid. Put an autonomous AI agent in the underwriter's seat and two questions
immediately follow: **can you trust what the agent decided, and why?** If an AI
drains a liquidity pool, "the model said so" is not an answer.

Faktura's thesis: **autonomous underwriting is only fundable if it is auditable
— and only safe if the chain itself enforces the limits.**

## What makes it agentic — and safe

Three agent roles run with no human in the loop, each with its **own key** and
**least-privilege permissions on-chain**:

- **Underwriter agent** (`agent` key) — runs deterministic pre-checks → asks an
  LLM for a risk score and price → registers, funds and attests. The advance is
  paid from the pool **to the supplier's account** (never the debtor's).
- **Collector agent** (`collector` key) — reconciles settlements and
  autonomously writes off invoices past due + grace. It is the *only* key the
  contract accepts for `mark_default`, and it cannot register or fund.
- **x402 risk oracle** — sells each underwriting as a verified risk report over
  **HTTP 402** with native-CSPR settlement, machine-to-machine
  ([docs/x402.md](docs/x402.md)).

Two load-bearing ideas:

1. **The LLM proposes; the on-chain policy disposes.** The contract stores a
   `Policy` — max risk score, discount band, single-invoice cap and per-debtor
   exposure cap (both as basis points of pool value) — and enforces it inside
   `register_invoice` / `fund_invoice`. A buggy prompt, a hallucinating model,
   or even a **compromised agent key** cannot exceed those bounds; the deploy
   reverts with a typed error. Exposure is tracked per debtor and released on
   settle/default.
   *Two layers, one source of truth:* the TypeScript agent applies a stricter
   prefilter for **risk score and discount** (at boot it reads `get_policy()`
   and takes the tighter of the two), plus a gas-saving **liquidity sanity
   check**. Concentration limits are deliberately left to the Casper contract
   at `fund_invoice` — that on-chain revert is intentionally demonstrable
   (the "Policy-cap rejection" preset in the UI, and the reverted deploy in
   the evidence pack). The contract is the final authority; the UI banner
   shows both layers.
2. **The on-chain attestation log.** `attest(...)` records
   `{actor, kind, subjectId, payloadHash, model, ts}` for **every** autonomous
   decision — approvals *and* rejections. The SHA-256 of the full decision memo
   is anchored at decision time, so anyone can prove after the fact exactly
   what the agent decided. That turns "an AI moved money" into an auditable,
   fundable credit process.

## The DeFi + RWA core (`FakturaHub`, Odra/Rust)

- **RWA registry** — receivables with a `Listed → Funded → (Settled |
  Defaulted)` lifecycle.
- **Native-CSPR liquidity pool** — `deposit()` mints LP shares at the current
  share price; yield and losses accrue to the **share price**
  (`poolValue / totalShares`). `withdraw()` is limited to liquid capital.
- **On-chain risk policy** — admin-set, contract-enforced (see above), readable
  by anyone via `get_policy` / `debtor_exposure_of`.
- **Agent permission layer** — separate underwriter / collector keys, rotatable
  by the admin; every mutating entrypoint is access-controlled with typed
  errors.
- **Auditable attestations** — the append-only AI-decision log.

One deployed contract does all of it: [`contracts/src/lib.rs`](contracts/src/lib.rs).
**12 Odra tests** cover the pool math, the policy caps (including the
compromised-key scenario) and the permission layer; CI runs them plus
`fmt`/`clippy`/typecheck/web build on every push.

## Architecture

```
   Supplier ── invoice ──▶ ┌───────────────────────────┐
                           │   Underwriter agent        │  pre-checks → LLM
   ┌──────────┐  REST/SSE  │  (Node.js + Odra livenet)  │  → on-chain policy
   │  Web UI   │◀──────────│  register · fund · attest  │
   │ (React)   │           └───────────┬───────────────┘
   └──────────┘                        │ Odra livenet CLI (Rust)
   ┌──────────┐  default/settle        ▼
   │Collector │───────────▶┌─────────────────────────────────────────┐
   │  agent   │            │        FakturaHub  (Odra / Rust)          │
   └──────────┘            │  RWA registry · native-CSPR pool ·        │
   ┌──────────┐  HTTP 402  │  on-chain risk policy · agent permissions │
   │x402 buyer│───────────▶│  · AI-attestation log                     │
   └──────────┘ pay-per-call         Casper Testnet
   ┌──────────┐  MCP/stdio
   │ any agent│───────────▶ 5 tools: pool_stats · submit_invoice ·
   └──────────┘             get_risk_report · verify_decision_hash ·
                            list_funded_invoices
```

See [`docs/architecture.md`](docs/architecture.md) for the sequence diagram and
the on-chain data model.

## Plug your agent in (MCP)

Faktura is itself a service *for* agents: an MCP server exposes the desk to any
MCP-capable assistant.

```bash
# quickest check — speaks MCP over stdio against the hosted showcase:
cd agents && FAKTURA_API=https://faktura.axiqo.xyz npm run mcp

# register it with Claude Code:
claude mcp add faktura -- npx tsx agents/src/mcp.ts     # or: make mcp
```

Tools: `pool_stats`, `list_funded_invoices`, `submit_invoice` (drives the real
underwriting pipeline), `get_risk_report` (x402: returns the 402 payment
challenge, then the paid report), `verify_decision_hash` (audits that the
off-chain memo matches the on-chain anchor).

## Live demo vs. local run — read this first

Two ways to see Faktura, honestly labeled (the UI shows the active mode in a
banner):

- **Hosted showcase** — <https://faktura.axiqo.xyz> runs in **showcase mode**:
  on-chain *reads* come from a captured snapshot of the real testnet contract
  (verifiable on cspr.live) and the AI underwriter runs *live*, but *writes*
  are simulated in server memory so visitors don't burn testnet gas or wait
  30–120 s per block. No transaction shown there is claimed to be on-chain.
- **Local live mode** — run the stack yourself (below) with funded testnet
  keys and **every state transition is a real Casper Testnet transaction**;
  `make e2e` prints an explorer-linkable evidence table
  (the one in [DORAHACKS.md](DORAHACKS.md) came from exactly that).

## Run it

```bash
# prerequisites: Rust (rustup; the pinned nightly in contracts/rust-toolchain
# installs automatically), cargo-odra, Node 20+, openssl
make build            # wasm + livenet ops binary + web UI
make test             # everything CI runs
make keys             # generate the 5 demo persona keypairs (testnet only)
#   fund the agent + investor keys: https://testnet.cspr.live/tools/faucet

make deploy           # deploys FakturaHub, prints the contract address
export FAKTURA_CONTRACT=hash-...
make configure        # set-agents (underwriter/collector) + set-policy
make fund-collector   # 150 CSPR gas so the collector can sign write-offs

make e2e              # full lifecycle on live testnet + tx evidence table
make e2e-fast         # happy path + AI rejection only (~2-3 min)
make serve            # agent service + web UI on :4020
make x402-demo        # buyer agent pays the oracle, fetches a risk report
make x402-facilitator-demo  # same purchase via a reference x402 facilitator
```

`make e2e` deposits into the pool, then underwrites three invoices — one
approved + funded + settled, one risk-rejected, one funded then **written off
by the collector key** after grace — all as real Casper Testnet transactions.
It takes **~4–6 minutes**: each deploy waits for testnet finality, and the
default path deliberately waits out the due date + grace window before the
collector signs the write-off. `make e2e-fast` skips the default path.

`make x402-facilitator-demo` runs the same machine-payable purchase with
`X402_MODE=official-facilitator`: a bundled **reference facilitator**
(implementing the standard `POST /verify` API, really checking the settlement
deploy over RPC) authorizes the release instead of the in-process verifier —
so the facilitator wire path is demonstrated, not just stubbed
([docs/x402.md](docs/x402.md)).

No LLM key? The underwriter falls back to a deterministic, transparent scorer
so the whole flow still runs (`LLM_PROVIDER=mock`); any OpenAI- or
Anthropic-compatible key plugs in via env.

## Judging-criteria notes

- **Working smart contracts on Testnet** — deployed and exercised on
  `casper-test`; every lifecycle step in [DORAHACKS.md](DORAHACKS.md) links to
  a real deploy.
- **Use of AI / agentic systems** — the agents run the entire credit process;
  the attestation log + on-chain policy make each autonomous decision provable
  *and* bounded.
- **Real-world applicability (DeFi & RWA)** — invoice factoring is a live $3T
  market; the pool, yield model, and RWA lifecycle are the actual mechanism.
- **Long-term plan** — permissioned institutional pools, real supplier-ERP
  document ingestion with proof-of-authenticity, and the x402/MCP surfaces as
  the distribution channel: other agents underwrite *with* Faktura instead of
  rebuilding it.

## License

MIT.
