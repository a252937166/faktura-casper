# Faktura — judge evidence pack

Everything below is verifiable on [testnet.cspr.live](https://testnet.cspr.live) right now. This
file exists so a judge can check every claim in the README in under five
minutes, without running anything.

## ▶ Run it live yourself — Live Testnet Judge Mode

You don't have to take the transactions below on faith. On
[faktura.axiqo.xyz](https://faktura.axiqo.xyz), click **Run Real Testnet
Workflow** and pick a guided walkthrough. You trigger each step yourself: the
AI decision is instant, and every on-chain step signs exactly **one real Casper
Testnet transaction** (~30–120 s to finality, with a live timer), then shows its
CSPR.live link and unlocks the next step — short, bounded waits instead of one
long run, and every screen tells you what just happened, why it matters, and
what comes next:

- **Full lifecycle** — AI underwrite → `register_invoice` → `fund_invoice`
  → `attest` → x402 report purchase → `settle_invoice` (6 steps, 5 transactions).
- **Policy firewall** (the one to watch) — the AI *approves* an invoice sized
  above the on-chain single-invoice cap, and the **contract reverts funding**
  with `User error 15 (SingleInvoiceCapExceeded)`. A valid agent key with a
  model approval still cannot exceed the on-chain policy.
- **x402** — a buyer agent pays over HTTP 402 with native CSPR for the verified
  risk report.

Walkthroughs are preset-only and small-capped, signed by pre-funded
testnet-only demo keys, so anyone can trigger real value safely. The page shows
a live health check (key balances, RPC/contract reachability) and pauses itself
to the safe showcase if a key needs a faucet top-up — a judge never hits a dead
button. Design notes: [docs/judge-mode-design.md](docs/judge-mode-design.md).

The transactions in this file were produced by exactly these code paths.

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
