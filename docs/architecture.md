# Faktura (Casper) — architecture

## Lifecycle sequence

```mermaid
sequenceDiagram
    autonumber
    participant S as Supplier
    participant U as Underwriter agent
    participant L as LLM (Claude)
    participant H as FakturaHub (Casper Testnet)
    participant D as Debtor
    participant C as Collector agent

    S->>U: submit invoice (intake)
    U->>U: deterministic pre-checks (amount, tenor, duplicate)
    U->>L: score risk + price discount
    L-->>U: {approve, riskScore, discountBps, rationale}
    U->>U: policy guardrails (risk ceiling, clamp, exposure cap)
    U->>H: register_invoice(supplier, face, due, risk, discount, memoHash)
    U->>H: fund_invoice(id)
    H->>S: transfer CSPR advance from the pool
    U->>H: attest(UNDERWRITE_APPROVE, memoHash, model)
    Note over H: decision hash anchored on-chain (audit trail)

    D->>H: settle_invoice(id) + CSPR (face value)
    Note over H: surplus over advance = pool yield -> LP share price

    C->>H: (poll) list_invoices
    alt overdue past due + grace
        C->>H: mark_default(id)
        Note over H: advance written off; loss hits LP share price
        C->>H: attest(DEFAULT_FLAG, ...)
    end
```

## On-chain data model (`FakturaHub`, Odra/Rust)

- **Roles**: `admin`, `agent` (underwriter), `collector`. Rotatable by admin.
- **Invoice**: `{id, supplier, debtor_tag, doc_hash, face_value (motes), due_ts,
  risk_score, discount_bps, decision_hash, state, advance, timestamps}`.
  State machine: `Listed → Funded → (Settled | Defaulted)`.
- **Liquidity pool** (native CSPR): `deposit()` mints LP shares at the current
  share price; `withdraw()` burns them against **liquid** capital only. Yield and
  losses accrue to **share price** = `pool_value / total_shares`, so earlier LPs
  capture the spread.
- **Attestations**: append-only log of `{actor, kind, subject_id, payload_hash,
  model, ts}` — the hash-anchored record of every AI decision (approve *and*
  reject).

## Why the attestation log is the point

An autonomous agent that moves pooled capital is only fundable if its decisions
are **provable after the fact**. `attest(...)` writes the SHA-256 of the full
decision memo (LLM opinion + applied policy + model id) on-chain for every
underwriting outcome. Anyone can later verify *what* was decided and *which
model* decided it — turning "the AI approved it" into an auditable credit
process. This is Faktura's core contribution on top of a standard invoice-pool.

## Trust & safety model

- The **LLM proposes; deterministic Rust + policy code disposes.** Risk ceiling,
  discount clamp, and pool-exposure cap are enforced off-chain in policy and
  on-chain in `register_invoice` / `fund_invoice`.
- Access control on every mutating entrypoint; a typed custom error per revert.
- `withdraw()` cannot touch deployed capital, so LP redemptions can't strand
  funded invoices.
- Every autonomous decision is attested — the system is auditable, not opaque.

## Components

| Path | Role |
|---|---|
| `contracts/src/lib.rs` | `FakturaHub` — registry + native-CSPR pool + attestations |
| `contracts/bin/livenet.rs` | Odra livenet ops CLI the agents shell out to |
| `agents/src/underwriter.ts` | intake → LLM → policy → register/fund/attest |
| `agents/src/collector.ts` | settlement reconciliation + autonomous default |
| `agents/src/x402.ts` | HTTP-402 machine-payable risk oracle (native CSPR) |
| `agents/src/chain.ts` | driver over the livenet CLI, per-persona tx queues |
| `agents/src/llm.ts` | pluggable underwriting model (Anthropic / CLI / fallback) |
| `web/` | React operations dashboard (live SSE feed) |

## Casper specifics

- Built with **Odra 2.8** (Rust), compiled to Wasm and deployed to
  `casper-test`. The agents transact through the Odra **livenet** host via a
  thin Rust CLI, so transaction construction, signing and finality-waiting stay
  inside audited Odra code.
- Addresses: the CLI normalizes Casper 2.0 (Condor) formatted strings
  (`entity-account-…`, `contract-package-…`) to the classic forms Odra's
  `Address::from_str` accepts (`account-hash-…`, `hash-…`).
- Deploy gas for the hub is ~600 CSPR; entrypoint calls are set per-action.
```
