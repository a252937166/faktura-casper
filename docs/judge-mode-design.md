# Live Testnet Judge Mode — Design

> Rationale: the finals judge (Kara) asked for a *real, clickable* Casper Testnet
> workflow, not a hosted showcase whose writes are simulated in memory. This
> document specifies the additive "Live Testnet Judge Mode": judges open the
> site, click one button, and each step signs a real Testnet transaction with an
> explorer link — while the safe public showcase stays untouched and always up.


> **Implementation status — v0.2 (2026-07-18).** The shipped design evolved from
> the batch `/run` orchestrator described below into a **guided session model**:
> `POST /api/judge/session {preset, supplierAddress?}` → `{id, displayId, token}`,
> then `POST /api/judge/session/:id/next` (header `X-Judge-Token`) signs exactly
> **one transaction per click**; failed steps stay retryable. Additions since
> this document was first written: connect-your-wallet payouts (public key →
> `account-hash-…` via the JS SDK; happy-path only), persisted anti-abuse quotas
> (one payout per wallet & per IP per 24 h + a global daily CSPR cap in
> `agents/data/judge-limits.json`), unguessable session ids + bearer tokens,
> CORS allow-list, `trust proxy` IP handling, and per-preset `canRun` health.
> The free-form demo write routes are disabled on the live backend — the
> walkthrough is the only signing surface. Sections below are kept for the
> architectural rationale; where they conflict, the code and this note win.

## 1. Topology (two independent backends, one nginx)

```
                          nginx (faktura.axiqo.xyz, :443)
                          ├─ location /            → static web/dist (SPA)
                          ├─ location /api/        → :4030  SHOWCASE backend  (unchanged)
                          └─ location /api/judge/  → :4034  LIVE JUDGE backend (new)
```

- **:4030 showcase** — `FAKTURA_SHOWCASE=1`, no keys, in-memory writes. Left
  exactly as-is. This is the always-available fallback: if the live backend is
  down or paused, the site still fully works in showcase mode.
- **:4034 live judge** — `FAKTURA_SHOWCASE=0`, holds the 5 role keys + livenet
  binary, signs real Casper Testnet transactions. Exposes only `/api/judge/*`
  and `/api/judge/health`. Never serves the SPA (nginx does), never exposes the
  free-form `/api/invoices` intake (preset-only, anti-abuse).

Rollout is blue/green: bring :4034 up and health-check it *before* adding the
nginx `location`, so the public site is never wired to a broken backend.

## 2. Live judge backend — `agents/src/judge.ts` (mounted by server when enabled)

A self-contained express Router, enabled only when `FAKTURA_JUDGE=1` (so the
showcase process never accidentally exposes it). Endpoints:

| Method | Path                       | Purpose |
|--------|----------------------------|---------|
| GET    | `/api/judge/health`        | key balances, RPC/contract reachability, mode, paused flag, last run |
| GET    | `/api/judge/presets`       | the 3 preset descriptors (id, title, steps, est. duration) |
| POST   | `/api/judge/run`           | start a preset run `{preset}` → `{runId}` (429 if rate-limited/queued/paused) |
| GET    | `/api/judge/run/:runId`    | poll run state: per-step status + tx hashes + results |
| GET    | `/api/judge/runs`          | recent runs (for "View latest run") |

### Presets (controlled, preset-only — no free-form amounts from the client)

1. **`happy`** — full lifecycle, expect success end-to-end
   `ensureLiquidity → submit(clean invoice) → AI underwrite → register → fund →
   attest → x402 buyer purchase → settle → pool accounting delta`
2. **`policy-block`** — the ace: AI approves, the *contract* rejects
   `ensureLiquidity → submit(invoice sized > on-chain single-invoice cap) →
   AI underwrite APPROVES → register → fund **REVERTS** SingleInvoiceCapExceeded`
   The face value is computed **dynamically from live pool stats** so the advance
   always lands above the on-chain `maxSingleInvoiceBps` (clearing the TS
   liquidity prefilter, so the revert happens on-chain, not in code).
3. **`x402`** — machine-payable risk report purchase against the most recent
   funded invoice: `402 challenge → buyer signs native transfer → verify → report`

### Anti-abuse (public host signing real value)

- **preset-only**: the client picks a preset id, never an amount or address.
- **rate limit**: 1 run / 10 min / IP, plus a **global single-flight lock** —
  only one run executes at a time (real keys are serialized per-persona anyway).
- **small caps**: happy-path invoice 8–15 CSPR; ensureLiquidity tops up only when
  liquid < threshold, and only in small increments.
- **fixed accounts**: supplier/debtor/buyer are the demo personas; never client
  input.
- **run ids**: `JUDGE-YYYYMMDD-NNN` for traceability, shown in the UI.
- **auto-pause**: if any role key balance < floor or RPC/contract unreachable,
  `/run` returns 503 with `paused:true`; the UI shows "temporarily paused — top
  up testnet keys" instead of failing mid-run.

### Run/step model

```ts
type StepStatus = "pending" | "signing" | "submitted" | "confirmed" | "reverted" | "skipped" | "failed";
interface JudgeStep {
  key: string; actor: string; title: string;
  status: StepStatus;
  txHash?: string; explorerUrl?: string;
  result?: string;        // one-line human outcome
  what?: string; who?: string; why?: string;   // the 3-line tx annotation
  startedTs?: number; endedTs?: number;
}
interface JudgeRun {
  runId: string; preset: string; status: "running"|"done"|"failed";
  steps: JudgeStep[]; startedTs: number; endedTs?: number;
  poolBefore?: PoolSnap; poolAfter?: PoolSnap;
}
```

The orchestrator reuses the *tested* code paths:
- `processIntake()` already does submit→underwrite→register→fund→attest and sets
  `record.status` to `funded` or `policy_blocked` with `record.chain.fundError`.
  The orchestrator maps the record's chain hashes onto the step list.
- `chain.deposit/settle/markDefault` for liquidity/settlement.
- The existing x402 demo path (`/api/demo/x402-pay` + `/api/risk/:id`) for preset 3.

Because `processIntake` is one call, the orchestrator subscribes to the `feed`
events it emits (intake/llm/decision/onchain/attest/policy_block) and updates
step statuses live as they arrive, then reconciles from the returned record.

## 3. Frontend — evolve `JudgeDemo` from slideshow → live runner

Today `JudgeDemo` is a passive story walkthrough. It becomes an **interactive
runner**:

- **Hero CTA** changes to three buttons:
  `Run Real Testnet Workflow` (primary) · `Watch 3-min demo` · `Open Evidence Pack`.
  Showcase is demoted to a secondary "Safe Showcase — no gas" link.
- Clicking `Run Real Testnet Workflow` opens the judge panel with a **preset
  picker** (Happy path / Policy-block / x402) then a **stepper** that POSTs
  `/api/judge/run` and polls `/api/judge/run/:id`.
- Each step row shows exactly three things: **status pill**, **one-line result**,
  **CSPR.live link**. Expanding a row reveals What / Who / Why.
- Honest waiting UX: `signing → submitted → waiting finality → confirmed`, with a
  persistent note: *"Real Casper Testnet run. ~30–120 s per deploy; the full run
  takes ~6–12 min. Don't refresh."*
- **Health panel** at the top of the judge panel: green/amber dots for each key
  balance + RPC + contract; if paused, the Run button is disabled with the
  top-up message.
- If the live backend is unreachable (`/api/judge/health` fails), the panel says
  "Live judge mode is offline right now — explore the Safe Showcase below," so a
  judge is never left staring at a dead button.

Live vs showcase is detected by probing `/api/judge/health`; the rest of the
page (pool, invoices, feed) keeps reading the showcase `/api` as before, so the
existing UI is undisturbed.

## 4. What we do NOT change

- The showcase backend, its seed, and all existing `/api/*` routes.
- The Rust contract (already deployed + audited on Testnet).
- The honest TxLink / simulated-write labeling in the showcase.

## 5. Deliverables checklist

- [x] `agents/src/judge.ts` — router + orchestrator + health + rate-limit
- [x] `server.ts` — mount judge router when `FAKTURA_JUDGE=1`
- [x] `web/src/api.ts` — judge client (health/presets/run/poll)
- [x] `web/src/App.tsx` — hero CTAs + interactive JudgeRunner + health panel
- [x] Linux glibc-2.17 livenet binary built + shipped to server
- [x] server: keys uploaded (600), `faktura-live` systemd unit on :4034, nginx route
- [x] balances funded via faucet; health green
- [x] 3 self-test runs (happy / policy-block / x402) green, tx links verified
- [x] new video, BUIDL page tx table, release v0.2-final-live-testnet
