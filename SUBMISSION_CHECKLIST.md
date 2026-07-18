# Faktura — the 8 links a judge needs

| # | What | Link |
|---|---|---|
| 1 | **Live Testnet Judge Mode — guided real Casper Testnet transactions (walkthroughs sign one tx per click); the safe showcase remains the fallback view** (honest mode banner; simulated writes are labeled, never explorer-linked) | [faktura.axiqo.xyz](https://faktura.axiqo.xyz) |
| 2 | **Demo video** (3 min) | [youtu.be/47ZNPZlRXVA](https://youtu.be/47ZNPZlRXVA) |
| 3 | **Contract package** on Casper Testnet | [testnet.cspr.live/contract-package/fb209bb1d3a1d5e675841f…](https://testnet.cspr.live/contract-package/fb209bb1d3a1d5e675841f7d184ab7fa96d65adc099f6fd0105f29115fb49d7e) |
| 4 | **Evidence pack** — every judging claim as a testnet tx | [DORAHACKS.md](DORAHACKS.md) |
| 5 | **Policy-reverted funding** — the AI approved, the contract said no (`User error: 15`, SingleInvoiceCapExceeded) | [testnet.cspr.live/transaction/830ebd775835ffdeba1122b9969…](https://testnet.cspr.live/transaction/830ebd775835ffdeba1122b99695a0bf589de442f80d1c31c1d43c4e7039aaea) |
| 6 | **x402 settlement** — buyer agent paid 2.5 CSPR, got the verified report | [testnet.cspr.live/deploy/adf150c7a0e07976da430b85f58e48a9…](https://testnet.cspr.live/deploy/adf150c7a0e07976da430b85f58e48a930095dd3bfe31837a021061c34688c7c) |
| 7 | **MCP in one command** (after the clone below) | `cd agents && npm install && FAKTURA_API=https://faktura.axiqo.xyz npm run mcp` |
| 8 | **GitHub release** (CI green: fmt, clippy, 12 contract tests, typecheck, format, web build) | [github.com/a252937166/faktura-casper/releases/tag/v0.2.1-…](https://github.com/a252937166/faktura-casper/releases/tag/v0.2.1-final-live-testnet) |

Two minutes of hands-on, if you have them:

```bash
git clone https://github.com/a252937166/faktura-casper && cd faktura-casper
make test              # everything CI runs
make x402-facilitator-demo   # x402 purchase via the reference facilitator (needs funded keys)
```

And on the live showcase: press **▶ Run a real Testnet story**, then submit the
**Policy-cap rejection** preset — the AI approves it, and the contract's
single-invoice cap blocks the funding in front of you.
