import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { FeedEvent } from "./feed.js";

/** Off-chain record accompanying an on-chain invoice. */
export interface InvoiceRecord {
  /** On-chain id (0 until registered). */
  id: number;
  /** Local intake id. */
  intakeId: string;
  status:
    | "pending"
    | "underwriting"
    | "approved"
    | "rejected"
    | "policy_blocked"
    | "funded"
    | "settled"
    | "defaulted"
    | "error";
  intake: {
    supplierName: string;
    supplierAddress?: string;
    debtorName: string;
    debtorTag: string;
    amountCspr: number;
    dueTs: number;
    invoiceNumber: string;
    description: string;
    history?: string;
    docHash: string;
    receivedTs: number;
  };
  /** The canonical decision memo (faktura.decision.v1) — the exact document
   * whose SHA-256 is anchored on-chain. Verifiers re-hash THIS. */
  memo?: import("./decision-memo.js").CanonicalDecisionMemo;
  decision?: {
    approve: boolean;
    riskScore: number;
    discountBps: number;
    rationale: string;
    redFlags: string[];
    policyNotes: string[];
    model: string;
    decisionHash: string;
    decidedTs: number;
  };
  chain: {
    registerHash?: string;
    fundHash?: string;
    settleHash?: string;
    defaultHash?: string;
    attestHashes: string[];
    advanceMotes?: string;
    /** Typed contract error when the chain refused to fund (e.g. User error: 15). */
    fundError?: string;
    /** Funding succeeded but the attestation deploy needs a retry. */
    attestPending?: boolean;
  };
}

interface Db {
  invoices: InvoiceRecord[];
  activity: FeedEvent[];
  meta: { contract?: string; deployHash?: string };
}

const file = () => path.join(config.dataDir, "db.json");

function load(): Db {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Db;
  } catch {
    return { invoices: [], activity: [], meta: {} };
  }
}

export const db: Db = load();

export function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(db, null, 2));
}

export function upsertInvoice(record: InvoiceRecord) {
  const i = db.invoices.findIndex((x) => x.intakeId === record.intakeId);
  if (i >= 0) db.invoices[i] = record;
  else db.invoices.push(record);
  save();
}

export function findByChainId(id: number) {
  return db.invoices.find((x) => x.id === id);
}
