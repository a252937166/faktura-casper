# Faktura — one-command entry points for judges and operators.
#
#   make test            run everything CI runs (contract tests, typecheck, web build)
#   make build           build the wasm, the livenet ops binary and the web UI
#   make deploy          deploy FakturaHub to Casper Testnet (needs funded agent key)
#   make configure       set-agents + set-policy on the deployed contract
#   make fund-collector  send 150 CSPR gas from the agent key to the collector key
#   make e2e             full live-testnet lifecycle (~4-6 min: waits out testnet
#                        finality per deploy + the default window)
#   make e2e-fast        happy path + AI rejection only (~2-3 min)
#   make seed            capture live state into agents/data/seed.json (showcase snapshot)
#   make serve           run the agent service + web UI locally
#   make mcp             run the MCP server (stdio) against a running service
#   make x402-demo       buyer agent pays the x402 oracle and fetches a risk report
#   make x402-facilitator-demo  same purchase, but verification is delegated to a
#                        reference x402 facilitator (X402_MODE=official-facilitator)
#
# Chain-touching targets read the standard env:
#   FAKTURA_CONTRACT=hash-...   (after make deploy prints it)
#   DEEPSEEK_API_KEY / ANTHROPIC_API_KEY (optional; falls back to a deterministic scorer)

CONTRACTS = cd contracts
AGENTS    = cd agents
WEB       = cd web
LIVENET   = ./target/debug/livenet

# Odra livenet env (agent key by default; personas are handled inside the agents).
define LIVENET_ENV
ODRA_CASPER_LIVENET_SECRET_KEY_PATH=$$PWD/../keys/agent/secret_key.pem \
ODRA_CASPER_LIVENET_NODE_ADDRESS=$${CASPER_NODE_ADDRESS:-https://node.testnet.casper.network} \
ODRA_CASPER_LIVENET_CHAIN_NAME=$${CASPER_CHAIN_NAME:-casper-test} \
ODRA_CASPER_LIVENET_EVENTS_URL=$${CASPER_EVENTS_URL:-https://node.testnet.casper.network/events}
endef

.PHONY: test build deploy configure fund-collector e2e e2e-fast seed serve mcp x402-demo x402-facilitator-demo keys

test:
	$(CONTRACTS) && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
	$(AGENTS) && npm install --no-audit --no-fund && npm run typecheck
	$(WEB) && npm install --no-audit --no-fund && npm run build

build:
	$(CONTRACTS) && cargo odra build -c FakturaHub && cargo build --features livenet --bin livenet
	$(WEB) && npm install --no-audit --no-fund && npm run build

# Generates the five demo persona keypairs (testnet only — fund via the faucet).
keys:
	for p in agent collector supplier investor debtor; do \
	  mkdir -p keys/$$p; \
	  [ -f keys/$$p/secret_key.pem ] || openssl genpkey -algorithm ed25519 -out keys/$$p/secret_key.pem; \
	  hex=$$(openssl pkey -in keys/$$p/secret_key.pem -pubout -outform DER | tail -c 32 | xxd -p -c 64); \
	  echo "01$$hex" > keys/$$p/public_key_hex; \
	  echo "$$p: 01$$hex"; \
	done

deploy:
	$(CONTRACTS) && $(LIVENET_ENV) AGENT=$$($(LIVENET_ENV) $(LIVENET) caller | sed 's/.*"caller":"\([^"]*\)".*/\1/') && \
	  $(LIVENET_ENV) FAKTURA_DEPLOY_GAS_CSPR=600 $(LIVENET) deploy $$AGENT 30000

configure:
	@test -n "$(FAKTURA_CONTRACT)" || (echo "set FAKTURA_CONTRACT=hash-..." && exit 2)
	$(CONTRACTS) && \
	  AGENT=$$($(LIVENET_ENV) $(LIVENET) caller | sed 's/.*"caller":"\([^"]*\)".*/\1/') && \
	  COLLECTOR=$$($(LIVENET_ENV) ODRA_CASPER_LIVENET_SECRET_KEY_PATH=$$PWD/../keys/collector/secret_key.pem $(LIVENET) caller | sed 's/.*"caller":"\([^"]*\)".*/\1/') && \
	  $(LIVENET_ENV) $(LIVENET) set-agents $(FAKTURA_CONTRACT) $$AGENT $$COLLECTOR && \
	  $(LIVENET_ENV) $(LIVENET) set-policy $(FAKTURA_CONTRACT) 70 50 3000 5000 6000 && \
	  $(LIVENET_ENV) $(LIVENET) policy $(FAKTURA_CONTRACT)

fund-collector:
	$(AGENTS) && npx tsx scripts/transfer.ts agent collector 150

e2e:
	@test -n "$(FAKTURA_CONTRACT)" || (echo "set FAKTURA_CONTRACT=hash-..." && exit 2)
	$(AGENTS) && npm run e2e

e2e-fast:
	@test -n "$(FAKTURA_CONTRACT)" || (echo "set FAKTURA_CONTRACT=hash-..." && exit 2)
	$(AGENTS) && FAKTURA_E2E_FAST=1 npm run e2e

seed:
	@test -n "$(FAKTURA_CONTRACT)" || (echo "set FAKTURA_CONTRACT=hash-..." && exit 2)
	$(AGENTS) && npx tsx scripts/make-seed.ts

serve:
	$(AGENTS) && npm run dev

mcp:
	$(AGENTS) && npm run mcp

x402-demo:
	$(AGENTS) && npm run x402-demo

x402-facilitator-demo:
	@test -n "$(FAKTURA_CONTRACT)" || (echo "set FAKTURA_CONTRACT=hash-..." && exit 2)
	$(AGENTS) && npx tsx scripts/facilitator-demo.ts
