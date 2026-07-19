# Live Testnet Judge Mode — Design (v0.2, as implemented)

> Rationale: the finals judge asked for a *real, clickable* Casper Testnet
> workflow, not a hosted showcase whose writes are simulated in memory. Live
> Judge Mode is that surface: a guided, step-by-step walkthrough where every
> click signs exactly one real Testnet transaction — additive, budgeted, and
> isolated from the always-on public showcase.

## 1. Topology (two independent backends, one nginx)

```
                          nginx (faktura.axiqo.xyz, :443)
                          ├─ location /            → static web/dist (SPA)
                          ├─ location /api/        → :4030  SHOWCASE backend  (no keys, writes simulated)
                          └─ location /api/judge/  → :4034  LIVE JUDGE backend (holds keys, signs)
```

- **:4030 showcase** — `FAKTURA_SHOWCASE=1`: reads from a captured real-testnet
  snapshot, live AI, simulated writes. Untouched; the always-available fallback.
- **:4034 live judge** — `FAKTURA_JUDGE=1`: holds the 5 persona keys + the
  livenet binary. Exposes **only** `/api/judge/*`; the free-form demo write
  routes (`POST /api/invoices`, `/api/demo/*`) return `403 walkthroughOnly` on
  this backend, so the guided walkthrough is the *only* public signing surface.

Rollout is blue/green: the new backend must pass `/api/judge/health` before
nginx routes to it.

## 2. Guided session model (one transaction per click)

| Method | Path                          | Purpose |
|--------|-------------------------------|---------|
| GET    | `/api/judge/health`           | balances, pool, per-preset `canRun`, budgets, active session (owner only) |
| GET    | `/api/judge/presets`          | the 5 preset descriptors with step lists |
| POST   | `/api/judge/session`          | `{preset, supplierAddress?}` → `{id, displayId, token, steps…}` (signs nothing) |
| POST   | `/api/judge/session/:id/next` | header `X-Judge-Token` — runs the next step: **exactly one transaction** |
| GET    | `/api/judge/session/:id`      | session state (resume); owner requests refresh `lastActivityTs` |
| GET    | `/api/judge/recent`           | last 5 completed walkthroughs — public receipts (no tokens/IPs) |
| GET    | `/api/judge/recent/:displayId` | one run as a canonical `faktura.credit-receipt.v1` (memo + receiptHash; verify offline with `npm run verify-receipt`) |
| GET    | `/api/judge/balance/:pubkey`  | testnet balance of any public key (wallet chip) |

Presets:

1. **`happy`** — the main story (5 steps): AI underwrite → `register_invoice` →
   `fund_invoice` → `attest` → `settle_invoice`. Face is fixed at **2 CSPR**
   so visitor payouts stay ≈1.9 CSPR. (The x402 sale is its own preset —
   settlement never depends on someone buying a report.)
2. **`policy-block`** — the ace (3 steps): the AI approves an oversized invoice,
   registration succeeds, and `fund_invoice` **reverts with `User error: 15`
   (SingleInvoiceCapExceeded)**.
3. **`x402`** — 3 steps: pick any on-chain invoice with a decision memo
   (funded, settled or defaulted — reports price the UNDERWRITING, zero new
   exposure), buy its report over HTTP 402 with a real native-CSPR transfer,
   then the consumer agent verifies the hash THREE ways (report · local memo ·
   on-chain anchor), applies its own acceptance policy (risk ≤ 35) and the
   attestation relay anchors `CREDIT_REPORT_ACCEPTED` — the buyer acts on what
   it bought.
4. **`default`** — 2 steps: the collector finds a funded invoice past due +
   grace and signs `mark_default` — the loss half of the credit lifecycle,
   absorbed by LPs through the share price. Overdue positions are exempt from
   the auto-settle cleanup, and the cleanup worker AUTO-SEEDS a tiny 60s-due
   invoice whenever the inventory runs dry (rate-limited, gas-budgeted), so
   this preset is always playable; `canRun` reports "ripening — ready in ~Ns"
   while the next one matures.
5. **`ai-reject`** — 2 steps: the other exit of Gate 1. A deliberately bad
   intake (shell-company debtor, disputed history, vague deliverables) is
   underwritten, the model REJECTS it, and the rejection memo hash is anchored
   with `attest UNDERWRITE_REJECT` (subject id 0 — nothing was ever registered
   or funded). Every preset has an EXPECTED verdict; an off-script LLM verdict
   gets one silent same-input retry and then fails the step retryable — a
   walkthrough can never end as a false "done".

Sessions: unguessable UUID id + human `JUDGE-YYYYMMDD-XXXXXXXX` display id + a
32-byte bearer token required on every mutation. The active session (with its
token) is revealed only to its creator — matched by an HttpOnly `fj_cid`
cookie set at creation (IP is a fallback for cookie-less curls and otherwise
used for rate-limits only); everyone else sees a `deskBusy` flag. A same-owner
restart supersedes the old run — but NOT while a transaction is still
settling (409: resume instead), so an in-flight payout can never be orphaned. Failed steps stay **retryable**; refresh-resume is offered, never forced.

### Policy-block feasibility — why the math lives server-side

The contract checks, in order:

```
advance > liquid                                   → InsufficientLiquidity (6)
advance > (liquid + deployed) × maxSingleInvoiceBps → SingleInvoiceCapExceeded (15)
```

so a clean error-15 revert requires `singleCap < advance ≤ liquid − margin`.
`policyBlockPlan()` computes this from live pool stats; the preset clamps the
LLM's discount into [0.5%, 4%] so the whole possible advance band clears the
cap and stays under liquidity. The SAME function powers `/health.canRun` and
the underwrite step, so the UI can never promise a revert the pool shape can't
deliver — and `POST /session` re-checks `canRun` **server-side** (deep links
and curls hit the same wall). The fund step then *asserts* the revert is
exactly error 15: any other outcome fails the step loudly and voids the run.

### Wallet payouts (read-only, budgeted)

Connecting Casper Wallet passes a **public key only** (01…/02…, normalized to
`account-hash-…` via the SDK before `register_invoice`); the site never
requests a signature. Payouts are **reserved** at session creation
(`reservePayout`) and committed after the fund confirms — concurrent sessions
cannot overshoot the budget, and a run that dies pre-fund releases its
reservation. The ledger write is atomic (temp + rename) and the reserve path
**fails closed**: if it cannot persist, no payout session starts.

## 3. Anti-abuse budgets (persisted in `agents/data/judge-limits.json`)

| Budget | Default | Env |
|---|---|---|
| Wallet payout per wallet / per IP | 1 per 24 h | — |
| Global payout CSPR per 24 h | 10 | `JUDGE_DAILY_PAYOUT_CSPR` |
| Walkthroughs per IP per hour | 4 | `JUDGE_RUNS_PER_IP_HOUR` |
| Walkthroughs per 24 h (all) | 24 | `JUDGE_RUNS_PER_DAY` |
| Per-preset per 24 h | 12 / 10 / 15 / 8 / 8 | `JUDGE_HAPPY_PER_DAY` / `JUDGE_POLICY_PER_DAY` / `JUDGE_X402_PER_DAY` / `JUDGE_DEFAULT_PER_DAY` / `JUDGE_AI_REJECT_PER_DAY` |
| Signed steps (gas) per 24 h | 60 | `JUDGE_DEPLOYS_PER_DAY` |

Plus: one active session globally (a same-owner restart supersedes unless a
transaction is in flight; a *different* visitor can take the desk only after
5 min of inactivity), a 4 s double-submit debounce (the UI auto-retries with
`retryAfterMs`), a CORS allow-list, `trust proxy` IP handling, and
`JUDGE_SMOKE_SECRET` (header `X-Judge-Smoke`) for our own pre-freeze self-tests
— it bypasses rate limits, never the signing or recording.

## 4. Reliability: sessions, timeouts, reconciliation, cleanup

- **Inactivity, not wall-clock**: sessions expire after **40 min without
  activity** (`lastActivityTs` bumps on create/step start/step end/resume) — a
  judge reading explorer pages between steps never loses the run.
- **Retry = reconcile first.** A livenet timeout may still land on-chain, so
  the timeout error carries any submitted tx hash, and re-running a failed
  step first checks the chain: `register` scans the ids minted since the
  session started for its docHash; `fund`/`settle` read the invoice state (and
  treat `InvalidState` as "read the truth, then recover"); the x402 step
  stores its transfer proof + nonce and re-verifies the SAME payment instead
  of paying twice. Recovery never double-commits the payout.
- **Cleanup worker.** Every funded invoice is tracked as an open position
  (persisted). If a walkthrough goes idle ≥20 min after funding, the worker
  auto-settles it with the debtor key (serialized with live steps, budgeted),
  marks the session done with a note, and the pool is whole for the next
  visitor. Positions survive restarts.
- **Health gating is per-preset.** `canRun` checks only the personas a preset
  actually signs with (happy: agent+debtor · policy-block: agent · x402:
  agent+debtor · default: collector) plus pool feasibility, overdue inventory
  and budgets; the global `paused` flag is
  reserved for "the node/contract is unreachable". A low collector balance
  can never switch the policy firewall off.

## 5. What we do NOT change

- The showcase backend, its seed, and all existing `/api/*` routes.
- The Rust contract (deployed + exercised on Testnet; see DORAHACKS.md).
- The honest labeling of simulated showcase writes.

## 6. Deliverables checklist

- [x] `agents/src/judge.ts` — guided session router + step executors + cleanup worker
- [x] `agents/src/judge-limits.ts` — persisted budgets/reservations/positions/receipts
- [x] `web/src/App.tsx` — story-first homepage + guided runner + receipts
- [x] Linux glibc-2.17 livenet binary built + shipped to the server
- [x] server: keys (600), `faktura-live` systemd unit on :4034, nginx route
- [x] balances funded via faucet; health green; canRun feasibility verified
- [x] self-tests: happy (+wallet 01/02), policy-block (exact error 15), x402
- [x] releases `v0.2.0` → `v0.2.4-final` (current); evidence pack in DORAHACKS.md

## Canonical serialization spec (faktura.decision.v1)

Cross-language verifiers re-hash the memo DOCUMENT, so the byte layout is a
contract:

- Encoding: UTF-8 JSON with **no whitespace** (`JSON.stringify` defaults).
- Field order is FIXED (insertion order, exactly as `buildDecisionMemo`
  emits): `schema, intakeId, invoiceNumber, decidedAt, provider, model,
  opinion, applied, policyNotes`; inside `opinion`: `approve, risk_score,
  discount_bps, rationale, red_flags[, confidence]` (confidence omitted when
  absent, never null); inside `applied`: `approve, risk_score, discount_bps`.
- Hash: lowercase hex SHA-256 of those bytes, prefixed `sha256:`.
- `JSON.parse` in any mainstream runtime preserves this key order, so
  "parse the shipped memo → stringify → SHA-256" reproduces the anchored
  hash without any canonicalization library. A verifier in another language
  must construct the object in the order above (or preserve parse order)
  before serializing. The same rules apply to `faktura.consumer-verdict.v1`
  and the receipt body of `faktura.credit-receipt.v1` (hash covers the body
  without the trailing `receiptHash` field).
