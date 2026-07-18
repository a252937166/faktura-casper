# Faktura — judge evidence pack

Everything below is verifiable on [testnet.cspr.live](https://testnet.cspr.live) right now. This
file exists so a judge can check every claim in the README in under five
minutes, without running anything.

## ▶ Run it live yourself — Live Testnet Judge Mode

You don't have to take the transactions below on faith. On
[faktura.axiqo.xyz](https://faktura.axiqo.xyz), click **▶ Use the real AI
desk** and pick a guided walkthrough. You trigger each step yourself: the
AI decision is instant (and shows its rationale + red flags), and every
on-chain step signs exactly **one real Casper Testnet transaction** (~30–120 s
to finality, with a live timer), then shows its CSPR.live link and unlocks the
next step — short, bounded waits instead of one long run, and every screen
tells you what just happened, why it matters, and what comes next. One main
story, three challenges:

- **Full lifecycle** (main story) — AI underwrite → `register_invoice` →
  `fund_invoice` → `attest` → `settle_invoice` (5 steps, 4 transactions,
  ~3–6 min). Supplier gets paid; debtor settles; the pool earns yield.
- **Policy firewall** (fastest proof) — the AI *approves* an invoice sized
  above the on-chain single-invoice cap, and the **contract reverts funding**
  with `User error 15 (SingleInvoiceCapExceeded)` — and the revert **you**
  trigger links itself on CSPR.live. A valid agent key with a model approval
  still cannot exceed the on-chain policy.
- **x402 consumer loop** (agent economy) — a consumer agent pays over HTTP 402
  with native CSPR, verifies the report hash **three ways** (report · local
  memo · on-chain anchor), applies its own acceptance policy, and anchors
  `CREDIT_REPORT_ACCEPTED` — produce → sell → verify → act.
- **Default workout** (credit loss) — the COLLECTOR key writes off an overdue
  funded invoice; LPs absorb the loss through the share price. The desk keeps
  this inventory stocked automatically.

**Connect your Casper Wallet and the desk pays the advance to YOUR testnet
address** — read-only (public key only, never a signature), verified with both
ed25519 (`01…`) and secp256k1 (`02…`) keys. Walkthroughs are preset-only and
small-capped, signed by pre-funded testnet-only demo keys; payouts are reserved
against a persisted daily budget, every signed step draws on a daily gas
budget, abandoned funded runs are auto-settled by a cleanup worker, and the
page shows a live health check with per-preset runnability — a judge never
hits a dead button. Design notes:
[docs/judge-mode-design.md](docs/judge-mode-design.md).

The transactions in this file were produced by exactly these code paths.

### Pre-freeze smoke matrix — the guided walkthrough, verified end to end (2026-07-18)

Every preset was driven through the PUBLIC guided API against the production
desk, the way a judge would click it. Freshly generated visitor wallets (not
our demo personas) received the payouts:

| Run | Steps | Key transactions |
|---|---|---|
| **Policy firewall** `JUDGE-20260718-EA56` — asserted the revert is EXACTLY `User error: 15` | 3/3 ✓ | register [`55fc0afc…`](https://testnet.cspr.live/deploy/55fc0afcb960acc60949d8afb9a3e5cef0406593848f98e0bd334c18209399fc) → fund **REVERTED (err 15, SingleInvoiceCapExceeded)** |
| **Full lifecycle + ed25519 visitor wallet** `JUDGE-20260718-B9FE` (`0155d6cc…`) — balance 0 → **1.96 CSPR** | 6/6 ✓ | register #20 [`6c0bc0eb…`](https://testnet.cspr.live/deploy/6c0bc0ebda991e9de45817f717f9985e676618cd19493b580763de2a10edaadc) · fund→wallet [`a1640661…`](https://testnet.cspr.live/deploy/a164066156dee02d7444e3895031dc5861377fe14ea1167ef6197810ff6c3d6b) · attest [`f503aba9…`](https://testnet.cspr.live/deploy/f503aba9608d6988fe3a7c4a2d8d985edbd00a92c2a7180812bd107708ef4f9b) · x402 [`ab9b4a65…`](https://testnet.cspr.live/deploy/ab9b4a650ea385a286f34f4a8485da45099da4190752a62fe337891ae783c09d) · settle [`6a75a808…`](https://testnet.cspr.live/deploy/6a75a808c694697ea027fc9b295aa7803b9d9c751693a42c2697dfa08f33ed50) |
| **Full lifecycle + secp256k1 visitor wallet** `JUDGE-20260718-8F86` (`02021271…`) — balance 0 → **1.97 CSPR** | 6/6 ✓ | register #21 [`f93cf16b…`](https://testnet.cspr.live/deploy/f93cf16bdf2ab32afd9dee0dc988c433f2d675d93d58144ccc35e597331b187b) · fund→wallet [`4a1d85f9…`](https://testnet.cspr.live/deploy/4a1d85f9b178958b4016d314d3ba1a4319b19438807371abb5e56d8ad8612ad5) · attest [`df88384f…`](https://testnet.cspr.live/deploy/df88384f2bb1257175b2464e0f97a672421f48192759f22ad349adcb39df465d) · x402 [`7f4ec8ac…`](https://testnet.cspr.live/deploy/7f4ec8ac1a2cc7c94c39f904afeea595e46aca58fa10a90d2ae8656662119228) · settle [`a7814fe2…`](https://testnet.cspr.live/deploy/a7814fe22fea16c552ad9e0051169bd7c335bb93223e982474dc1afb6718edf3) |
| **Standalone x402 purchase** `JUDGE-20260718-477D` (reuses a funded invoice — zero new exposure) | 2/2 ✓ | payment [`bb7f1a71…`](https://testnet.cspr.live/deploy/bb7f1a7137f16fd11c44ceee3736bcf565e05ae91b6b8a43a3c9b8c256b90a26) → verified report |

Both wallet runs prove the public-key → account-hash normalization on both
Casper key schemes. The budgets did their job during the matrix: payouts
3.93 / 10 CSPR daily cap, signed steps 13 / 60 daily gas budget — all persisted
(see [docs/judge-mode-design.md](docs/judge-mode-design.md)). The latest
completed run is always visible on the homepage ("LATEST LIVE RUN")
and at `/api/judge/recent`.

The same evening, three more guided runs verified the credit-lifecycle
completions — **the revert you trigger now links itself**, the x402 buyer
**acts** on what it bought, and the collector processes a real loss:

| Run | Steps | Key transactions |
|---|---|---|
| **Policy firewall** `JUDGE-20260718-CDD9` — the revert step carries the JUST-TRIGGERED failed tx | 3/3 ✓ | register [`0631679f…`](https://testnet.cspr.live/deploy/0631679f8010532102609619c9ffa3ab5c4f6412379b4054c135572bd04b8b4a) → fund **REVERTED, err 15, linked live** [`269a3e22…`](https://testnet.cspr.live/transaction/269a3e223b8ee3c003488dd59636fd19f22744fc655571310858bfac6baf1166) |
| **x402 + consumer verdict** `JUDGE-20260718-B066` — buyer pays, verifies the memo hash, ACCEPTs (risk 20 ≤ 35) and anchors `CREDIT_REPORT_ACCEPTED` | 3/3 ✓ | payment [`bbba64e6…`](https://testnet.cspr.live/deploy/bbba64e663e89fcbe847e81905b5273a5e1814ae6cf9cc92477aef4ccdd4b9e9) · verdict attest [`075ff462…`](https://testnet.cspr.live/deploy/075ff462106fd0864b017e6e6ba224eec0f5a6f788376a3be885e96e98c8542e) |
| **Default workout** `JUDGE-20260718-2A6D` — an overdue funded invoice written off by the COLLECTOR key; LPs absorb the loss | 2/2 ✓ | mark_default [`c9d24e8c…`](https://testnet.cspr.live/deploy/c9d24e8cadd054c2ab9fcfae582cb144816996fb828cfea60289a4291412deb6) |
| **x402 three-way verification** `JUDGE-20260718-0475` — report hash checked against the local memo AND the anchor read from the contract, then ACCEPT anchored | 3/3 ✓ | payment [`3eaa758a…`](https://testnet.cspr.live/deploy/3eaa758a6d852fc546b2e72b78387b8fd54213f37cf7d3d572899f17003eab68) · verdict [`87551752…`](https://testnet.cspr.live/deploy/8755175223c71409478fdaeacdc4f70b96aa6548875a101ae03b901a00ceca4d) |

## The deployment

| | |
|---|---|
| Contract package | [`fb209bb1d3a1d5e675841f7d184ab7fa96d65adc099f6fd0105f29115fb49d7e`](https://testnet.cspr.live/contract-package/fb209bb1d3a1d5e675841f7d184ab7fa96d65adc099f6fd0105f29115fb49d7e) |
| Odra address (env `FAKTURA_CONTRACT`) | `hash-fb209bb1d3a1d5e675841f7d184ab7fa96d65adc099f6fd0105f29115fb49d7e` |
| Network | `casper-test` |
| Framework | Odra 2.8 (Rust), single contract `FakturaHub` |
| Live showcase | [faktura.axiqo.xyz](https://faktura.axiqo.xyz) (UI banner explains showcase vs live mode) |

### The five agent accounts (separation of duties)

| Persona | Account | On-chain rights |
|---|---|---|
| Underwriter (`agent`) | `account-hash-025a06c0319478189fcb95c2f62503b0b257af59a346a295d4eb112d867384bf` | `register_invoice` / `fund_invoice` / `attest`; **cannot** `mark_default` |
| Collector | `account-hash-3af70494b86de5df33fec197705b766b3ff8fa4647bcb972ecbc5106d853f5b7` | `mark_default` + `attest` only |
| Supplier | `account-hash-c8981d32a123d050479a5290bd5780836775ba26f24c13969b6bad02d1336efc` | receives every advance |
| Investor (LP) | `account-hash-2e814f0cdf1d016e0c0a8fb10e4df3f530a506ab785166d051912a040179a192` | `deposit` / `withdraw` |
| Debtor | `account-hash-6b6db703cd59f19e1ff2f813dd3f2d12799ac0a06e781eeae1988d1b45334fb4` | pays `settle_invoice` |

## Transaction evidence — one full autonomous lifecycle

Setup:

| Step | Signer | Transaction |
|---|---|---|
| Deploy `FakturaHub` | admin | [`b59b3292…`](https://testnet.cspr.live/transaction/b59b32927dc57f614a56de4012990f4303542ac12f821c21e0408ade3fe90d5d) |
| `set_agents` (underwriter + collector keys) | admin | [`ff5441dc…`](https://testnet.cspr.live/transaction/ff5441dc67b55905ea541b5cb6d510b02b50d57af79d5aa7dc499f26edf52557) |
| `set_policy` (risk ≤ 70 · discount 0.5–30% · invoice ≤ 50% pool · debtor ≤ 60%) | admin | [`8b2201b3…`](https://testnet.cspr.live/transaction/8b2201b38dd9540854eec1bb28ffc3a27aa913e66e6dfee20b1354570f53e53d) |
| Gas transfer to the collector key | agent | [`d9bd6bcf…`](https://testnet.cspr.live/deploy/d9bd6bcf72b087d3e12f7fe202fce781892819d6a6a2fece199c3b5ae86bdb44) |

Lifecycle, produced by `make e2e` (three intakes: clean / fraudulent / short-dated):

| Step | Signer | Transaction |
|---|---|---|
| LP deposit 200 CSPR → mints shares | investor | [`e44f8979…`](https://testnet.cspr.live/deploy/e44f8979a3ef7d3e432159a175e177645848c41ecc7c1588f0d02bcf5fdbbafd) |
| `register_invoice` #1 (AI risk 20/100, discount 2.00%) | agent | [`5a86ef94…`](https://testnet.cspr.live/deploy/5a86ef94b7bdfcd54cc57d97a2468e42bd1e83ebce30a36eeebc34fe8d5d11cd) |
| `fund_invoice` #1 — 98 CSPR advance **to the supplier account** | agent | [`96602a8c…`](https://testnet.cspr.live/deploy/96602a8c227476fdfafd81f640ed295375beaaab86c8f5c9621664d5bedd9338) |
| `attest` UNDERWRITE_APPROVE #1 (decision-memo SHA-256 anchored) | agent | [`8099c8ea…`](https://testnet.cspr.live/deploy/8099c8ea425dead0dfdcdbdc85e3e2eb74500e3fd3f3415b50cd6612a254d381) |
| `attest` UNDERWRITE_REJECT (shell-company intake, risk 90/100 — **rejections are anchored too**) | agent | [`dee005ad…`](https://testnet.cspr.live/deploy/dee005adb59f8336b985e1480853a460eb6f5a224cd0ed0972222b31ef3b2305) |
| `register_invoice` #2 (short-dated, AI risk 10/100) | agent | [`c0fb8fe8…`](https://testnet.cspr.live/deploy/c0fb8fe866608bd2a58ed3c72248e872a7c3a40201d43e212008d0bc49f4ab13) |
| `fund_invoice` #2 — 49.5 CSPR advance to the supplier | agent | [`66029619…`](https://testnet.cspr.live/deploy/6602961945250dd30443f3e7e90b7c2bc7991f759c3362c0988de55aecc3ccf5) |
| `settle_invoice` #1 — debtor pays 100 CSPR face value; pool realizes yield | debtor | [`6ff7d0a4…`](https://testnet.cspr.live/deploy/6ff7d0a4b7bbe6a5757ce3251871788aec7ac42bf554830e5c557f0af95850dd) |
| `mark_default` #2 — past due + grace, written off autonomously **by the collector key** | collector | [`f6b3b746…`](https://testnet.cspr.live/deploy/f6b3b7469ed26e08f7f560b4b93cf3d3f792d03029396f23a84e388d7f4d6930) |

### The on-chain policy firing for real (not a unit test)

After the run above the pool held ~152.5 CSPR, so the policy's single-invoice
cap (50% of pool value) was ~76 CSPR. The underwriter then approved an 80 CSPR
invoice (advance 78.4) — and the **contract refused to fund it**:

| Step | Signer | Transaction |
|---|---|---|
| `register_invoice` #3 (AI risk 20/100 — registration is within policy) | agent | [`4e68fbc7…`](https://testnet.cspr.live/deploy/4e68fbc73a9fa5646bfe3a84f8307f88f39f0cdc1ca2df7bcb381774b48dbd08) |
| `fund_invoice` #3 → **REVERTED with `User error: 15` (SingleInvoiceCapExceeded)** | agent | [`830ebd77…`](https://testnet.cspr.live/transaction/830ebd775835ffdeba1122b99695a0bf589de442f80d1c31c1d43c4e7039aaea) |

The agent held a valid key and a model-approved decision, and the chain still
said no. That failed deploy is the whole thesis in one transaction: the LLM
proposes, the on-chain policy disposes. (Invoice #3 remains `Listed` until the
pool is deep enough.)

A right-sized invoice then went straight through (currently `Funded` — this is
the live position the showcase shows):

| Step | Signer | Transaction |
|---|---|---|
| `register_invoice` #4 (AI risk 12/100, discount 1.50%) | agent | [`6a4a814e…`](https://testnet.cspr.live/deploy/6a4a814e40664d9220767dbef7c5d7ead46d9abffd678b600ea344bf9de5334c) |
| `fund_invoice` #4 — 39.4 CSPR advance to the supplier | agent | [`59c8ee92…`](https://testnet.cspr.live/deploy/59c8ee927cd13790983d6d4348f52fb43fb2bf3a9c3c2185ab35ddd0d1073fcf) |
| `attest` UNDERWRITE_APPROVE #4 | agent | [`04e625c0…`](https://testnet.cspr.live/deploy/04e625c0915a4a4eb6742e20be36f28fd37715eb07cc68ec462fbc8846a97a10) |

And a machine bought invoice #4's risk report over **x402** (`npm run x402-demo`):
2.5 CSPR native transfer carrying the one-time nonce as the transfer id — the
oracle verified it over RPC and released the report, whose `decisionHash`
matches attestation #7 above.

| Step | Signer | Transaction |
|---|---|---|
| x402 settlement for `GET /api/risk/4` (nonce as transfer id) | buyer agent | [`adf150c7…`](https://testnet.cspr.live/deploy/adf150c7a0e07976da430b85f58e48a930095dd3bfe31837a021061c34688c7c) |

Pool accounting after the run (read `stats` on the contract, or the UI):
deposits 200 → funded 147.5 → settled +100 → default −49.5 ⇒ the LP share
price moved with real yield and a real loss. Nothing here is mocked.

## How to verify the load-bearing claims

1. **"The contract enforces the risk policy, not the TypeScript"** — read
   `register_invoice` / `fund_invoice` in
   [`contracts/src/lib.rs`](contracts/src/lib.rs): risk ceiling, discount band,
   single-invoice cap, per-debtor exposure cap, typed errors 13–16. Query it
   live: `./contracts/target/debug/livenet policy <contract>`. Odra tests cover
   the caps including a compromised-agent-key scenario (`cargo test`).
2. **"Every AI decision is anchored on-chain"** — open any `attest` deploy
   above; the payload hash is the SHA-256 of the decision memo the UI shows.
   The MCP tool `verify_decision_hash` (or the invoice drawer) does the
   comparison for you.
3. **"Separation of duties is on-chain"** — try `mark_default` with the agent
   key: the contract rejects it (`NotCollector`). The write-off deploy above is
   signed by the collector account.
4. **"The advance goes to the supplier"** — open either `fund_invoice` deploy;
   the transfer target is the supplier account listed in the personas table.
5. **x402 machine-payable oracle** — `make x402-demo` (or read
   [docs/x402.md](docs/x402.md)): 402 challenge → native-CSPR settlement with
   nonce as transfer id → paid report carrying the on-chain `decisionHash`.
   `make x402-facilitator-demo` runs the same purchase with
   `X402_MODE=official-facilitator` against a bundled reference facilitator
   (its `POST /verify` really checks the deploy over RPC). The hosted UI also
   walks the three-step flow inside every funded invoice (simulated payment in
   showcase, clearly labeled; a real transfer in live mode).

## Judging criteria mapping

- **Working smart contracts on Casper Testnet** — the tables above; plus 12
  passing Odra tests and CI (fmt, clippy, tests, typecheck, web build).
- **Use of AI / agentic systems** — an LLM underwrites every intake
  (deterministic fallback keeps the flow reproducible without keys); the
  underwriter, collector and x402 oracle run with no human in the loop, each
  under its own key with least-privilege on-chain permissions.
- **Real-world applicability (DeFi & RWA)** — invoice factoring (~$3T
  receivables market) with a native-CSPR pool, share-price yield accounting and
  a full RWA lifecycle exercised on-chain.
- **Innovation** — "LLM proposes, on-chain policy disposes": the risk policy is
  contract state, so a compromised or hallucinating agent cannot exceed it; the
  attestation log makes every autonomous decision (including refusals)
  post-hoc provable; the desk is consumable by other machines via x402 + MCP.

## Run it yourself

```bash
make build && make keys      # then fund agent+investor at the faucet
make deploy                  # prints FAKTURA_CONTRACT
make configure fund-collector
make e2e                     # re-produces a table like the one above
```
