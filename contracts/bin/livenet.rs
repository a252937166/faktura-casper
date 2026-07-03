//! Livenet operations CLI for the Faktura agents.
//!
//! Every agent-side on-chain action goes through this small binary so that
//! transaction construction, signing and waiting stay inside the well-tested
//! Odra livenet host. The Node.js agent service shells out to it and parses
//! the `RESULT { ... }` line printed on success.
//!
//! Configuration comes from the standard Odra livenet env vars:
//! - `ODRA_CASPER_LIVENET_SECRET_KEY_PATH` (persona key: agent / investor / debtor)
//! - `ODRA_CASPER_LIVENET_NODE_ADDRESS`
//! - `ODRA_CASPER_LIVENET_CHAIN_NAME` (casper-test)
//! - `ODRA_CASPER_LIVENET_EVENTS_URL`

use faktura::{FakturaHub, FakturaHubHostRef, FakturaHubInitArgs, Invoice, PoolStats};
use odra::casper_types::U512;
use odra::host::{Deployer, HostEnv, HostRef, HostRefLoader};
use odra::prelude::*;
use std::str::FromStr;

const CSPR: u64 = 1_000_000_000;

fn gas(cspr: u64) -> u64 {
    cspr * CSPR
}

/// Normalizes Casper 2.0 (Condor) formatted addresses to the classic form that
/// Odra's `Address::from_str` accepts: `entity-account-X` -> `account-hash-X`,
/// `contract-package-X` / `entity-contract-X` -> `hash-X`.
fn normalize_address(s: &str) -> String {
    if let Some(rest) = s.strip_prefix("entity-account-") {
        format!("account-hash-{rest}")
    } else if let Some(rest) = s.strip_prefix("contract-package-") {
        format!("hash-{rest}")
    } else if let Some(rest) = s.strip_prefix("entity-contract-") {
        format!("hash-{rest}")
    } else {
        s.to_string()
    }
}

fn load(env: &HostEnv, addr: &str) -> FakturaHubHostRef {
    let address = Address::from_str(&normalize_address(addr)).expect("invalid contract address");
    FakturaHub::load(env, address)
}

fn parse_address(s: &str) -> Address {
    Address::from_str(&normalize_address(s)).expect("invalid address")
}

fn invoice_json(i: &Invoice) -> String {
    format!(
        r#"{{"id":{},"supplier":"{}","debtorTag":{},"docHash":{},"faceValue":"{}","dueTs":{},"riskScore":{},"discountBps":{},"decisionHash":{},"state":{},"advance":"{}","registeredTs":{},"fundedTs":{},"closedTs":{}}}"#,
        i.id,
        i.supplier.to_formatted_string(),
        serde_json::to_string(&i.debtor_tag).unwrap(),
        serde_json::to_string(&i.doc_hash).unwrap(),
        i.face_value,
        i.due_ts,
        i.risk_score,
        i.discount_bps,
        serde_json::to_string(&i.decision_hash).unwrap(),
        i.state,
        i.advance,
        i.registered_ts,
        i.funded_ts,
        i.closed_ts
    )
}

fn stats_json(s: &PoolStats) -> String {
    format!(
        r#"{{"liquid":"{}","deployed":"{}","totalShares":"{}","totalFunded":"{}","totalSettled":"{}","totalDefaulted":"{}","invoiceCount":{},"attestationCount":{}}}"#,
        s.liquid,
        s.deployed,
        s.total_shares,
        s.total_funded,
        s.total_settled,
        s.total_defaulted,
        s.invoice_count,
        s.attestation_count
    )
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("help");
    let env = odra_casper_livenet_env::env();

    match cmd {
        // deploy <agent_address> <grace_ms>
        "deploy" => {
            let agent = parse_address(&args[2]);
            let grace_ms: u64 = args[3].parse().expect("grace_ms");
            env.set_gas(gas(u64::from_str(
                &std::env::var("FAKTURA_DEPLOY_GAS_CSPR").unwrap_or_else(|_| "400".into()),
            )
            .unwrap()));
            let hub = FakturaHub::deploy(&env, FakturaHubInitArgs { agent, grace_ms });
            println!(
                r#"RESULT {{"contract":"{}"}}"#,
                hub.address().to_formatted_string()
            );
        }
        // register <contract> <supplier> <debtor_tag> <doc_hash> <face_motes> <due_ts> <risk> <discount_bps> <decision_hash>
        "register" => {
            let mut hub = load(&env, &args[2]);
            env.set_gas(gas(15));
            let id = hub.register_invoice(
                parse_address(&args[3]),
                args[4].clone(),
                args[5].clone(),
                U512::from_dec_str(&args[6]).expect("face_motes"),
                args[7].parse().expect("due_ts"),
                args[8].parse().expect("risk"),
                args[9].parse().expect("discount_bps"),
                args[10].clone(),
            );
            println!(r#"RESULT {{"invoiceId":{id}}}"#);
        }
        // fund <contract> <id>
        "fund" => {
            let mut hub = load(&env, &args[2]);
            env.set_gas(gas(15));
            let id: u64 = args[3].parse().expect("id");
            hub.fund_invoice(id);
            println!(r#"RESULT {{"funded":{id}}}"#);
        }
        // settle <contract> <id> <amount_motes>   (payable, run with debtor key)
        "settle" => {
            let mut hub = load(&env, &args[2]);
            env.set_gas(gas(15));
            let id: u64 = args[3].parse().expect("id");
            let amount = U512::from_dec_str(&args[4]).expect("amount");
            hub.with_tokens(amount).settle_invoice(id);
            println!(r#"RESULT {{"settled":{id}}}"#);
        }
        // default <contract> <id>   (collector key)
        "default" => {
            let mut hub = load(&env, &args[2]);
            env.set_gas(gas(15));
            let id: u64 = args[3].parse().expect("id");
            hub.mark_default(id);
            println!(r#"RESULT {{"defaulted":{id}}}"#);
        }
        // deposit <contract> <amount_motes>   (investor key)
        "deposit" => {
            let mut hub = load(&env, &args[2]);
            env.set_gas(gas(15));
            let amount = U512::from_dec_str(&args[3]).expect("amount");
            hub.with_tokens(amount).deposit();
            println!(r#"RESULT {{"deposited":"{amount}"}}"#);
        }
        // withdraw <contract> <shares>
        "withdraw" => {
            let mut hub = load(&env, &args[2]);
            env.set_gas(gas(15));
            let shares = U512::from_dec_str(&args[3]).expect("shares");
            hub.withdraw(shares);
            println!(r#"RESULT {{"withdrawn":"{shares}"}}"#);
        }
        // attest <contract> <kind> <subject_id> <payload_hash> <model>
        "attest" => {
            let mut hub = load(&env, &args[2]);
            env.set_gas(gas(10));
            let id = hub.attest(
                args[3].clone(),
                args[4].parse().expect("subject_id"),
                args[5].clone(),
                args[6].clone(),
            );
            println!(r#"RESULT {{"attestationId":{id}}}"#);
        }
        // set-agents <contract> <agent> <collector>   (admin key)
        "set-agents" => {
            let mut hub = load(&env, &args[2]);
            env.set_gas(gas(5));
            hub.set_agents(parse_address(&args[3]), parse_address(&args[4]));
            println!(r#"RESULT {{"ok":true}}"#);
        }
        // invoice <contract> <id>   (free query)
        "invoice" => {
            let hub = load(&env, &args[2]);
            let id: u64 = args[3].parse().expect("id");
            match hub.get_invoice(id) {
                Some(inv) => println!("RESULT {}", invoice_json(&inv)),
                None => println!("RESULT null"),
            }
        }
        // invoices <contract> <from> <count>   (free query)
        "invoices" => {
            let hub = load(&env, &args[2]);
            let from: u64 = args[3].parse().expect("from");
            let count: u64 = args[4].parse().expect("count");
            let items: Vec<String> = hub
                .list_invoices(from, count)
                .iter()
                .map(invoice_json)
                .collect();
            println!("RESULT [{}]", items.join(","));
        }
        // stats <contract>   (free query)
        "stats" => {
            let hub = load(&env, &args[2]);
            println!("RESULT {}", stats_json(&hub.stats()));
        }
        // shares <contract> <address>   (free query)
        "shares" => {
            let hub = load(&env, &args[2]);
            let owner = parse_address(&args[3]);
            println!(r#"RESULT {{"shares":"{}"}}"#, hub.shares_of(owner));
        }
        // caller — prints the account address for the configured key
        "caller" => {
            println!(
                r#"RESULT {{"caller":"{}"}}"#,
                env.caller().to_formatted_string()
            );
        }
        _ => {
            eprintln!(
                "usage: livenet <deploy|register|fund|settle|default|deposit|withdraw|attest|set-agents|invoice|invoices|stats|shares|caller> ..."
            );
            std::process::exit(2);
        }
    }
}
