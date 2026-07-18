/**
 * Minimal native-CSPR transfer + balance helpers over casper-js-sdk.
 * Used by ops scripts (scripts/transfer.ts) and the x402 buyer demo
 * (src/x402-client.ts) so nothing here needs the casper-client CLI.
 */
import fs from "node:fs";
import path from "node:path";
// casper-js-sdk v2 ships CJS — under ESM only the default export is reliable.
import casper from "casper-js-sdk";
import { ROOT, config } from "./config.js";

const { CLPublicKey, CasperClient, DeployUtil, Keys } = casper;

export const rpcUrl = () => `${config.nodeAddress.replace(/\/$/, "")}/rpc`;

/** Resolves "01<hex>" / "02<hex>" or a persona name (keys/<name>/public_key_hex). */
export function toPublicKey(target: string) {
  if (/^0[12][0-9a-f]{64,66}$/i.test(target)) return CLPublicKey.fromHex(target);
  const p = path.join(ROOT, "keys", target, "public_key_hex");
  return CLPublicKey.fromHex(fs.readFileSync(p, "utf8").trim());
}

export function personaPublicKeyHex(name: string): string {
  return fs.readFileSync(path.join(ROOT, "keys", name, "public_key_hex"), "utf8").trim();
}

/**
 * Public key hex (01 ed25519 / 02 secp256k1) → "account-hash-…". The livenet
 * CLI's Address parser accepts account-hash for both schemes, while a raw 02
 * public key is rejected — so visitor wallets are normalized here.
 */
export function pubKeyToAccountHashStr(hex: string): string {
  return CLPublicKey.fromHex(hex).toAccountHashStr();
}

/** Signs + submits a native transfer; returns the deploy hash. */
export async function nativeTransfer(opts: {
  fromKeyPath: string;
  /** "01…" public key hex or persona name. */
  to: string;
  motes: string;
  /** Casper transfer id — the x402 nonce rides here. */
  id: string | number;
}): Promise<string> {
  const from = Keys.Ed25519.loadKeyPairFromPrivateFile(opts.fromKeyPath);
  const deploy = DeployUtil.makeDeploy(
    new DeployUtil.DeployParams(from.publicKey, config.chainName),
    DeployUtil.ExecutableDeployItem.newTransfer(opts.motes, toPublicKey(opts.to), null, opts.id),
    DeployUtil.standardPayment(100_000_000), // 0.1 CSPR
  );
  return new CasperClient(rpcUrl()).putDeploy(DeployUtil.signDeploy(deploy, from));
}

/** Main-purse balance in motes via the Casper 2.0 `query_balance` RPC. */
export async function queryBalance(pubKeyHex: string): Promise<bigint> {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query_balance",
      params: { purse_identifier: { main_purse_under_public_key: pubKeyHex } },
    }),
  });
  const body = (await res.json()) as { result?: { balance: string }; error?: { message: string } };
  if (!body.result) throw new Error(`query_balance: ${body.error?.message ?? "no result"}`);
  return BigInt(body.result.balance);
}
