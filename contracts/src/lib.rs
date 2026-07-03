//! # Faktura — the autonomous invoice-financing desk on Casper.
//!
//! `FakturaHub` is a single on-chain hub that combines:
//! - an **RWA registry** of tokenized invoices (receivables),
//! - a **DeFi liquidity pool** that funds invoices at an AI-priced discount and
//!   distributes the realized yield to liquidity providers via a share price,
//! - an **agent permission layer** (underwriter / collector agent keys),
//! - an **attestation log** that anchors every AI decision (hash of the full
//!   decision memo) on-chain, making autonomous underwriting auditable.
//!
//! Monetary values are denominated in motes (1 CSPR = 10^9 motes) and the pool
//! operates in native CSPR on Casper Testnet.

#![cfg_attr(target_arch = "wasm32", no_std)]
extern crate alloc;

use odra::casper_types::U512;
use odra::prelude::*;

/// Invoice lifecycle states.
pub mod state {
    /// Registered by the underwriter agent, awaiting funding.
    pub const LISTED: u8 = 0;
    /// Advance paid out to the supplier from the pool.
    pub const FUNDED: u8 = 1;
    /// Debtor repaid face value; yield realized by the pool.
    pub const SETTLED: u8 = 2;
    /// Flagged as defaulted by the collector agent after grace period.
    pub const DEFAULTED: u8 = 3;
}

const BPS_DENOMINATOR: u64 = 10_000;

/// A tokenized receivable registered by the underwriter agent.
#[odra::odra_type]
pub struct Invoice {
    /// Sequential identifier.
    pub id: u64,
    /// Account that receives the advance (the SMB selling the receivable).
    pub supplier: Address,
    /// Pseudonymous debtor identifier (e.g. `sha256(company registry id)`).
    pub debtor_tag: String,
    /// SHA-256 of the underlying invoice document.
    pub doc_hash: String,
    /// Face value of the invoice in motes.
    pub face_value: U512,
    /// Due timestamp (ms since epoch, Casper block-time domain).
    pub due_ts: u64,
    /// AI risk score, 0 (safest) - 100 (riskiest).
    pub risk_score: u8,
    /// AI-priced discount in basis points (advance = face * (1 - bps/10000)).
    pub discount_bps: u32,
    /// SHA-256 of the full AI underwriting memo (off-chain JSON).
    pub decision_hash: String,
    /// Lifecycle state, see [`state`].
    pub state: u8,
    /// Advance actually paid to the supplier (motes).
    pub advance: U512,
    /// Registration timestamp (ms).
    pub registered_ts: u64,
    /// Funding timestamp (ms), 0 if not funded.
    pub funded_ts: u64,
    /// Settlement / default timestamp (ms), 0 if open.
    pub closed_ts: u64,
}

/// An on-chain fingerprint of an autonomous agent decision.
#[odra::odra_type]
pub struct Attestation {
    /// Sequential identifier.
    pub id: u64,
    /// Agent account that submitted the attestation.
    pub actor: Address,
    /// Decision kind, e.g. `UNDERWRITE_APPROVE`, `DEFAULT_FLAG`.
    pub kind: String,
    /// Related invoice id (or 0 for standalone attestations).
    pub subject_id: u64,
    /// SHA-256 of the full decision payload stored off-chain.
    pub payload_hash: String,
    /// Model identifier that produced the decision.
    pub model: String,
    /// Block timestamp (ms).
    pub ts: u64,
}

/// Aggregated pool statistics for dashboards.
#[odra::odra_type]
pub struct PoolStats {
    /// Un-deployed CSPR sitting in the pool (motes).
    pub liquid: U512,
    /// Capital currently locked in funded invoices (motes).
    pub deployed: U512,
    /// Total LP shares outstanding.
    pub total_shares: U512,
    /// Cumulative advances paid out (motes).
    pub total_funded: U512,
    /// Cumulative face value collected on settlements (motes).
    pub total_settled: U512,
    /// Cumulative principal written off on defaults (motes).
    pub total_defaulted: U512,
    /// Number of invoices registered.
    pub invoice_count: u64,
    /// Number of attestations recorded.
    pub attestation_count: u64,
}

/// Errors raised by [`FakturaHub`].
#[odra::odra_error]
pub enum Error {
    /// Caller is not the underwriter agent.
    NotAgent = 1,
    /// Caller is not the collector agent.
    NotCollector = 2,
    /// Caller is not the admin.
    NotAdmin = 3,
    /// Invoice does not exist.
    InvoiceNotFound = 4,
    /// Operation not allowed in the invoice's current state.
    InvalidState = 5,
    /// Pool does not hold enough liquid CSPR.
    InsufficientLiquidity = 6,
    /// Caller owns fewer shares than requested.
    InsufficientShares = 7,
    /// Attached payment does not cover the invoice face value.
    PaymentTooLow = 8,
    /// Amount must be greater than zero.
    ZeroAmount = 9,
    /// Invoice is not past its due date + grace period yet.
    NotDue = 10,
    /// Discount must be below 100%.
    InvalidDiscount = 11,
    /// Due date must be in the future at registration time.
    InvalidDueDate = 12,
}

/// Emitted when an LP deposits CSPR into the pool.
#[odra::event]
pub struct Deposited {
    /// LP account.
    pub investor: Address,
    /// Amount in motes.
    pub amount: U512,
    /// Shares minted.
    pub shares: U512,
}

/// Emitted when an LP redeems shares.
#[odra::event]
pub struct Withdrawn {
    /// LP account.
    pub investor: Address,
    /// Amount in motes returned.
    pub amount: U512,
    /// Shares burned.
    pub shares: U512,
}

/// Emitted when the underwriter agent registers an invoice.
#[odra::event]
pub struct InvoiceRegistered {
    /// Invoice id.
    pub id: u64,
    /// Supplier account.
    pub supplier: Address,
    /// Face value in motes.
    pub face_value: U512,
    /// AI risk score.
    pub risk_score: u8,
    /// AI-priced discount (bps).
    pub discount_bps: u32,
    /// Hash of the AI decision memo.
    pub decision_hash: String,
}

/// Emitted when the pool funds an invoice.
#[odra::event]
pub struct InvoiceFunded {
    /// Invoice id.
    pub id: u64,
    /// Advance paid to the supplier (motes).
    pub advance: U512,
}

/// Emitted when a debtor settles an invoice.
#[odra::event]
pub struct InvoiceSettled {
    /// Invoice id.
    pub id: u64,
    /// Face value collected (motes).
    pub amount: U512,
    /// Yield realized by the pool (motes).
    pub pool_yield: U512,
}

/// Emitted when the collector agent flags a default.
#[odra::event]
pub struct InvoiceDefaulted {
    /// Invoice id.
    pub id: u64,
    /// Principal written off (motes).
    pub loss: U512,
}

/// Emitted for every agent attestation.
#[odra::event]
pub struct AgentAttested {
    /// Attestation id.
    pub id: u64,
    /// Agent account.
    pub actor: Address,
    /// Decision kind.
    pub kind: String,
    /// Related invoice id.
    pub subject_id: u64,
    /// Hash of the decision payload.
    pub payload_hash: String,
}

/// The Faktura on-chain hub. See crate docs for the big picture.
#[odra::module(
    errors = Error,
    events = [
        Deposited,
        Withdrawn,
        InvoiceRegistered,
        InvoiceFunded,
        InvoiceSettled,
        InvoiceDefaulted,
        AgentAttested
    ]
)]
pub struct FakturaHub {
    admin: Var<Address>,
    agent: Var<Address>,
    collector: Var<Address>,
    grace_ms: Var<u64>,
    invoice_count: Var<u64>,
    invoices: Mapping<u64, Invoice>,
    total_shares: Var<U512>,
    shares: Mapping<Address, U512>,
    liquid: Var<U512>,
    deployed: Var<U512>,
    total_funded: Var<U512>,
    total_settled: Var<U512>,
    total_defaulted: Var<U512>,
    attestation_count: Var<u64>,
    attestations: Mapping<u64, Attestation>,
}

#[odra::module]
impl FakturaHub {
    /// Initializes the hub. The deployer becomes admin; `agent` acts as both
    /// underwriter and collector until [`FakturaHub::set_agents`] is called.
    pub fn init(&mut self, agent: Address, grace_ms: u64) {
        let caller = self.env().caller();
        self.admin.set(caller);
        self.agent.set(agent);
        self.collector.set(agent);
        self.grace_ms.set(grace_ms);
        self.invoice_count.set(0);
        self.attestation_count.set(0);
        self.total_shares.set(U512::zero());
        self.liquid.set(U512::zero());
        self.deployed.set(U512::zero());
        self.total_funded.set(U512::zero());
        self.total_settled.set(U512::zero());
        self.total_defaulted.set(U512::zero());
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// Rotates the underwriter and collector agent keys. Admin only.
    pub fn set_agents(&mut self, agent: Address, collector: Address) {
        self.require_admin();
        self.agent.set(agent);
        self.collector.set(collector);
    }

    // ------------------------------------------------------------------
    // Liquidity pool (LP side)
    // ------------------------------------------------------------------

    /// Deposits attached CSPR into the pool and mints LP shares pro-rata.
    #[odra(payable)]
    pub fn deposit(&mut self) {
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        let caller = self.env().caller();
        let pool_value = self.pool_value();
        let total_shares = self.total_shares.get_or_default();

        // First deposit prices 1 share = 1 mote; afterwards shares are minted
        // at the current share price so late LPs don't dilute earlier yield.
        let minted = if total_shares.is_zero() || pool_value.is_zero() {
            amount
        } else {
            amount * total_shares / pool_value
        };

        self.shares
            .set(&caller, self.shares.get_or_default(&caller) + minted);
        self.total_shares.set(total_shares + minted);
        self.liquid.set(self.liquid.get_or_default() + amount);

        self.env().emit_event(Deposited {
            investor: caller,
            amount,
            shares: minted,
        });
    }

    /// Burns `share_amount` LP shares and returns the proportional slice of
    /// the pool's *liquid* capital (deployed capital cannot be withdrawn).
    pub fn withdraw(&mut self, share_amount: U512) {
        if share_amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        let caller = self.env().caller();
        let owned = self.shares.get_or_default(&caller);
        if owned < share_amount {
            self.env().revert(Error::InsufficientShares);
        }
        let total_shares = self.total_shares.get_or_default();
        let amount = share_amount * self.pool_value() / total_shares;
        let liquid = self.liquid.get_or_default();
        if amount > liquid {
            self.env().revert(Error::InsufficientLiquidity);
        }

        self.shares.set(&caller, owned - share_amount);
        self.total_shares.set(total_shares - share_amount);
        self.liquid.set(liquid - amount);
        self.env().transfer_tokens(&caller, &amount);

        self.env().emit_event(Withdrawn {
            investor: caller,
            amount,
            shares: share_amount,
        });
    }

    // ------------------------------------------------------------------
    // Invoice lifecycle (agent side)
    // ------------------------------------------------------------------

    /// Registers an AI-underwritten invoice. Underwriter agent only.
    #[allow(clippy::too_many_arguments)]
    pub fn register_invoice(
        &mut self,
        supplier: Address,
        debtor_tag: String,
        doc_hash: String,
        face_value: U512,
        due_ts: u64,
        risk_score: u8,
        discount_bps: u32,
        decision_hash: String,
    ) -> u64 {
        self.require_agent();
        if face_value.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if discount_bps as u64 >= BPS_DENOMINATOR {
            self.env().revert(Error::InvalidDiscount);
        }
        let now = self.env().get_block_time();
        if due_ts <= now {
            self.env().revert(Error::InvalidDueDate);
        }

        let id = self.invoice_count.get_or_default() + 1;
        let advance =
            face_value * U512::from(BPS_DENOMINATOR - discount_bps as u64) / U512::from(BPS_DENOMINATOR);

        let invoice = Invoice {
            id,
            supplier,
            debtor_tag,
            doc_hash,
            face_value,
            due_ts,
            risk_score,
            discount_bps,
            decision_hash: decision_hash.clone(),
            state: state::LISTED,
            advance,
            registered_ts: now,
            funded_ts: 0,
            closed_ts: 0,
        };
        self.invoices.set(&id, invoice);
        self.invoice_count.set(id);

        self.env().emit_event(InvoiceRegistered {
            id,
            supplier,
            face_value,
            risk_score,
            discount_bps,
            decision_hash,
        });
        id
    }

    /// Pays the advance out of the pool to the supplier. Underwriter agent only.
    pub fn fund_invoice(&mut self, id: u64) {
        self.require_agent();
        let mut invoice = self.load_invoice(id);
        if invoice.state != state::LISTED {
            self.env().revert(Error::InvalidState);
        }
        let liquid = self.liquid.get_or_default();
        if invoice.advance > liquid {
            self.env().revert(Error::InsufficientLiquidity);
        }

        self.liquid.set(liquid - invoice.advance);
        self.deployed
            .set(self.deployed.get_or_default() + invoice.advance);
        self.total_funded
            .set(self.total_funded.get_or_default() + invoice.advance);
        self.env()
            .transfer_tokens(&invoice.supplier, &invoice.advance);

        invoice.state = state::FUNDED;
        invoice.funded_ts = self.env().get_block_time();
        let advance = invoice.advance;
        self.invoices.set(&id, invoice);

        self.env().emit_event(InvoiceFunded { id, advance });
    }

    /// Settles an invoice by paying its face value. Callable by anyone
    /// (normally the debtor); excess payment is kept as pool yield.
    #[odra(payable)]
    pub fn settle_invoice(&mut self, id: u64) {
        let paid = self.env().attached_value();
        let mut invoice = self.load_invoice(id);
        if invoice.state != state::FUNDED {
            self.env().revert(Error::InvalidState);
        }
        if paid < invoice.face_value {
            self.env().revert(Error::PaymentTooLow);
        }

        self.deployed
            .set(self.deployed.get_or_default() - invoice.advance);
        self.liquid.set(self.liquid.get_or_default() + paid);
        self.total_settled
            .set(self.total_settled.get_or_default() + paid);

        invoice.state = state::SETTLED;
        invoice.closed_ts = self.env().get_block_time();
        let pool_yield = paid - invoice.advance;
        self.invoices.set(&id, invoice);

        self.env().emit_event(InvoiceSettled {
            id,
            amount: paid,
            pool_yield,
        });
    }

    /// Writes off a funded invoice past due + grace. Collector agent only.
    pub fn mark_default(&mut self, id: u64) {
        self.require_collector();
        let mut invoice = self.load_invoice(id);
        if invoice.state != state::FUNDED {
            self.env().revert(Error::InvalidState);
        }
        let now = self.env().get_block_time();
        if now <= invoice.due_ts + self.grace_ms.get_or_default() {
            self.env().revert(Error::NotDue);
        }

        self.deployed
            .set(self.deployed.get_or_default() - invoice.advance);
        self.total_defaulted
            .set(self.total_defaulted.get_or_default() + invoice.advance);

        invoice.state = state::DEFAULTED;
        invoice.closed_ts = now;
        let loss = invoice.advance;
        self.invoices.set(&id, invoice);

        self.env().emit_event(InvoiceDefaulted { id, loss });
    }

    /// Anchors the hash of an agent decision memo on-chain. Agent keys only.
    pub fn attest(
        &mut self,
        kind: String,
        subject_id: u64,
        payload_hash: String,
        model: String,
    ) -> u64 {
        let caller = self.env().caller();
        if caller != self.agent.get().unwrap_or(caller)
            && caller != self.collector.get().unwrap_or(caller)
        {
            self.env().revert(Error::NotAgent);
        }

        let id = self.attestation_count.get_or_default() + 1;
        let attestation = Attestation {
            id,
            actor: caller,
            kind: kind.clone(),
            subject_id,
            payload_hash: payload_hash.clone(),
            model,
            ts: self.env().get_block_time(),
        };
        self.attestations.set(&id, attestation);
        self.attestation_count.set(id);

        self.env().emit_event(AgentAttested {
            id,
            actor: caller,
            kind,
            subject_id,
            payload_hash,
        });
        id
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// Returns an invoice by id.
    pub fn get_invoice(&self, id: u64) -> Option<Invoice> {
        self.invoices.get(&id)
    }

    /// Returns up to `count` invoices starting at id `from` (1-based).
    pub fn list_invoices(&self, from: u64, count: u64) -> Vec<Invoice> {
        let last = self.invoice_count.get_or_default();
        let mut out = Vec::new();
        let mut id = from;
        while id <= last && (out.len() as u64) < count {
            if let Some(invoice) = self.invoices.get(&id) {
                out.push(invoice);
            }
            id += 1;
        }
        out
    }

    /// Returns an attestation by id.
    pub fn get_attestation(&self, id: u64) -> Option<Attestation> {
        self.attestations.get(&id)
    }

    /// Returns aggregated pool statistics.
    pub fn stats(&self) -> PoolStats {
        PoolStats {
            liquid: self.liquid.get_or_default(),
            deployed: self.deployed.get_or_default(),
            total_shares: self.total_shares.get_or_default(),
            total_funded: self.total_funded.get_or_default(),
            total_settled: self.total_settled.get_or_default(),
            total_defaulted: self.total_defaulted.get_or_default(),
            invoice_count: self.invoice_count.get_or_default(),
            attestation_count: self.attestation_count.get_or_default(),
        }
    }

    /// Returns the LP share balance of `owner`.
    pub fn shares_of(&self, owner: Address) -> U512 {
        self.shares.get_or_default(&owner)
    }

    /// Pool value = liquid + deployed capital (motes).
    pub fn pool_value(&self) -> U512 {
        self.liquid.get_or_default() + self.deployed.get_or_default()
    }

    /// Returns (admin, agent, collector) accounts.
    pub fn roles(&self) -> (Option<Address>, Option<Address>, Option<Address>) {
        (self.admin.get(), self.agent.get(), self.collector.get())
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    fn load_invoice(&self, id: u64) -> Invoice {
        match self.invoices.get(&id) {
            Some(invoice) => invoice,
            None => self.env().revert(Error::InvoiceNotFound),
        }
    }

    fn require_agent(&self) {
        if Some(self.env().caller()) != self.agent.get() {
            self.env().revert(Error::NotAgent);
        }
    }

    fn require_collector(&self) {
        if Some(self.env().caller()) != self.collector.get() {
            self.env().revert(Error::NotCollector);
        }
    }

    fn require_admin(&self) {
        if Some(self.env().caller()) != self.admin.get() {
            self.env().revert(Error::NotAdmin);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostRef};

    const CSPR: u64 = 1_000_000_000; // motes
    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    struct Fixture {
        hub: FakturaHubHostRef,
        env: odra::host::HostEnv,
        admin: Address,
        agent: Address,
        investor: Address,
        supplier: Address,
        debtor: Address,
    }

    fn setup() -> Fixture {
        let env = odra_test::env();
        let admin = env.get_account(0);
        let agent = env.get_account(1);
        let investor = env.get_account(2);
        let supplier = env.get_account(3);
        let debtor = env.get_account(4);

        env.set_caller(admin);
        let hub = FakturaHub::deploy(
            &env,
            FakturaHubInitArgs {
                agent,
                grace_ms: DAY_MS,
            },
        );
        Fixture {
            hub,
            env,
            admin,
            agent,
            investor,
            supplier,
            debtor,
        }
    }

    fn register_default_invoice(f: &mut Fixture) -> u64 {
        f.env.set_caller(f.agent);
        f.hub.register_invoice(
            f.supplier,
            String::from("debtor:acme-gmbh"),
            String::from("doc:sha256:abcd"),
            U512::from(100 * CSPR),
            f.env.block_time() + 30 * DAY_MS,
            35,
            300, // 3% discount => advance 97 CSPR
            String::from("memo:sha256:beef"),
        )
    }

    #[test]
    fn full_lifecycle_settlement_yields_lps() {
        let mut f = setup();

        // Investor seeds the pool with 200 CSPR.
        f.env.set_caller(f.investor);
        f.hub.with_tokens(U512::from(200 * CSPR)).deposit();
        assert_eq!(f.hub.stats().liquid, U512::from(200 * CSPR));
        assert_eq!(f.hub.shares_of(f.investor), U512::from(200 * CSPR));

        // Agent registers + funds a 100 CSPR invoice at 3% discount.
        let id = register_default_invoice(&mut f);
        f.env.set_caller(f.agent);
        let supplier_before = f.env.balance_of(&f.supplier);
        f.hub.fund_invoice(id);
        let advance = U512::from(97 * CSPR);
        assert_eq!(f.env.balance_of(&f.supplier), supplier_before + advance);

        let stats = f.hub.stats();
        assert_eq!(stats.liquid, U512::from(103 * CSPR));
        assert_eq!(stats.deployed, advance);
        assert_eq!(f.hub.get_invoice(id).unwrap().state, state::FUNDED);

        // Debtor settles at face value; pool realizes 3 CSPR yield.
        f.env.set_caller(f.debtor);
        f.hub
            .with_tokens(U512::from(100 * CSPR))
            .settle_invoice(id);
        let stats = f.hub.stats();
        assert_eq!(stats.liquid, U512::from(203 * CSPR));
        assert_eq!(stats.deployed, U512::zero());
        assert_eq!(f.hub.get_invoice(id).unwrap().state, state::SETTLED);

        // Investor exits with principal + yield.
        f.env.set_caller(f.investor);
        let balance_before = f.env.balance_of(&f.investor);
        f.hub.withdraw(f.hub.shares_of(f.investor));
        assert_eq!(
            f.env.balance_of(&f.investor),
            balance_before + U512::from(203 * CSPR)
        );
        assert_eq!(f.hub.stats().total_shares, U512::zero());
    }

    #[test]
    fn default_flow_realizes_loss() {
        let mut f = setup();
        f.env.set_caller(f.investor);
        f.hub.with_tokens(U512::from(200 * CSPR)).deposit();

        let id = register_default_invoice(&mut f);
        f.env.set_caller(f.agent);
        f.hub.fund_invoice(id);

        // Too early to default.
        assert_eq!(
            f.hub.try_mark_default(id).unwrap_err(),
            Error::NotDue.into()
        );

        // Past due + grace, the collector can write it off.
        f.env.advance_block_time(31 * DAY_MS + DAY_MS + 1);
        f.hub.mark_default(id);
        let stats = f.hub.stats();
        assert_eq!(stats.deployed, U512::zero());
        assert_eq!(stats.total_defaulted, U512::from(97 * CSPR));
        assert_eq!(f.hub.get_invoice(id).unwrap().state, state::DEFAULTED);

        // Pool value dropped; investor's shares are worth less now.
        assert_eq!(f.hub.pool_value(), U512::from(103 * CSPR));
    }

    #[test]
    fn share_price_appreciates_for_late_lps() {
        let mut f = setup();
        // Investor 1 deposits 100 CSPR.
        f.env.set_caller(f.investor);
        f.hub.with_tokens(U512::from(100 * CSPR)).deposit();

        // 100 CSPR invoice at 5% discount funded and settled -> +5 CSPR yield.
        f.env.set_caller(f.agent);
        let id = f.hub.register_invoice(
            f.supplier,
            String::from("debtor:x"),
            String::from("doc:y"),
            U512::from(100 * CSPR),
            f.env.block_time() + DAY_MS,
            50,
            500,
            String::from("memo:z"),
        );
        f.hub.fund_invoice(id);
        f.env.set_caller(f.debtor);
        f.hub
            .with_tokens(U512::from(100 * CSPR))
            .settle_invoice(id);

        // Pool is now 105 CSPR backed by 100 shares. A new 105 CSPR deposit
        // must mint exactly 100 shares.
        let admin_deposit = U512::from(105 * CSPR);
        f.env.set_caller(f.admin);
        f.hub.with_tokens(admin_deposit).deposit();
        assert_eq!(f.hub.shares_of(f.admin), U512::from(100 * CSPR));
    }

    #[test]
    fn access_control_is_enforced() {
        let mut f = setup();
        f.env.set_caller(f.investor);

        assert_eq!(
            f.hub
                .try_register_invoice(
                    f.supplier,
                    String::from("d"),
                    String::from("h"),
                    U512::from(CSPR),
                    f.env.block_time() + DAY_MS,
                    10,
                    100,
                    String::from("m"),
                )
                .unwrap_err(),
            Error::NotAgent.into()
        );
        assert_eq!(
            f.hub.try_fund_invoice(1).unwrap_err(),
            Error::NotAgent.into()
        );
        assert_eq!(
            f.hub.try_mark_default(1).unwrap_err(),
            Error::NotCollector.into()
        );
        assert_eq!(
            f.hub
                .try_attest(
                    String::from("K"),
                    0,
                    String::from("h"),
                    String::from("model")
                )
                .unwrap_err(),
            Error::NotAgent.into()
        );
        assert_eq!(
            f.hub.try_set_agents(f.investor, f.investor).unwrap_err(),
            Error::NotAdmin.into()
        );
    }

    #[test]
    fn funding_requires_liquidity_and_valid_state() {
        let mut f = setup();
        let id = register_default_invoice(&mut f);

        // Empty pool cannot fund.
        f.env.set_caller(f.agent);
        assert_eq!(
            f.hub.try_fund_invoice(id).unwrap_err(),
            Error::InsufficientLiquidity.into()
        );

        // Fund properly, then double-fund must fail.
        f.env.set_caller(f.investor);
        f.hub.with_tokens(U512::from(100 * CSPR)).deposit();
        f.env.set_caller(f.agent);
        f.hub.fund_invoice(id);
        assert_eq!(
            f.hub.try_fund_invoice(id).unwrap_err(),
            Error::InvalidState.into()
        );

        // Settling with less than face value must fail.
        f.env.set_caller(f.debtor);
        assert_eq!(
            f.hub
                .with_tokens(U512::from(CSPR))
                .try_settle_invoice(id)
                .unwrap_err(),
            Error::PaymentTooLow.into()
        );
    }

    #[test]
    fn attestations_are_recorded() {
        let mut f = setup();
        f.env.set_caller(f.agent);
        let id = f.hub.attest(
            String::from("UNDERWRITE_REJECT"),
            0,
            String::from("sha256:1234"),
            String::from("claude-sonnet-4-5"),
        );
        assert_eq!(id, 1);
        let attestation = f.hub.get_attestation(1).unwrap();
        assert_eq!(attestation.kind, String::from("UNDERWRITE_REJECT"));
        assert_eq!(attestation.actor, f.agent);
        assert_eq!(f.hub.stats().attestation_count, 1);
    }

    #[test]
    fn withdraw_limited_to_liquid_capital() {
        let mut f = setup();
        f.env.set_caller(f.investor);
        f.hub.with_tokens(U512::from(100 * CSPR)).deposit();

        let id = register_default_invoice(&mut f);
        f.env.set_caller(f.agent);
        f.hub.fund_invoice(id);

        // 97 CSPR deployed, 3 liquid: full withdrawal must fail.
        f.env.set_caller(f.investor);
        assert_eq!(
            f.hub
                .try_withdraw(f.hub.shares_of(f.investor))
                .unwrap_err(),
            Error::InsufficientLiquidity.into()
        );

        // Withdrawing a small slice works.
        f.hub.withdraw(U512::from(2 * CSPR));
    }
}
