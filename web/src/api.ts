export interface FeedEvent {
  ts: number;
  actor: string;
  kind: string;
  message: string;
  invoiceId?: number;
  deployHash?: string;
  data?: Record<string, unknown>;
}

export interface Decision {
  approve: boolean;
  riskScore: number;
  discountBps: number;
  rationale: string;
  redFlags: string[];
  policyNotes: string[];
  model: string;
  decisionHash: string;
  decidedTs: number;
}

export interface InvoiceRecord {
  id: number;
  intakeId: string;
  status: string;
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
  decision?: Decision;
  chain: {
    registerHash?: string;
    fundHash?: string;
    settleHash?: string;
    defaultHash?: string;
    attestHashes: string[];
  };
}

export interface ChainStats {
  liquid: string;
  deployed: string;
  totalShares: string;
  totalFunded: string;
  totalSettled: string;
  totalDefaulted: string;
  invoiceCount: number;
  attestationCount: number;
}

export interface ChainPolicy {
  maxRiskScore: number;
  minDiscountBps: number;
  maxDiscountBps: number;
  maxSingleInvoiceBps: number;
  maxDebtorExposureBps: number;
}

export interface Meta {
  mode: "live-testnet" | "showcase";
  contract: string;
  chain: string;
  explorer: string;
  x402Price: string;
  x402Mode?: string;
  llmProvider: string;
  mcp?: boolean;
  policy: ChainPolicy | null;
  prefilter?: {
    maxRiskScore: number;
    minDiscountBps: number;
    maxDiscountBps: number;
    maxPoolShareBps: number;
  };
  supplier: string | null;
}

export interface X402Challenge {
  status: number;
  body: {
    accepts?: {
      maxAmountRequired: string;
      payTo: string;
      extra: { transferIdNonce: string };
    }[];
    error?: string;
    [k: string]: unknown;
  };
}

export interface RiskReport {
  invoiceId: number;
  issuer: string;
  riskScore: number;
  discountBps: number;
  redFlags: string[];
  rationale: string;
  decisionHash: string;
  onchain: { state: number; contract: string };
}

export interface PoolResponse {
  stats: ChainStats;
  onchain: {
    id: number;
    state: number;
    faceValue: string;
    advance: string;
    dueTs: number;
    riskScore: number;
    discountBps: number;
  }[];
  contract: string;
  explorer: string;
}

const j = <T>(r: Response): Promise<T> => {
  if (!r.ok) return r.json().then((b) => Promise.reject(new Error((b as any).error ?? r.statusText)));
  return r.json() as Promise<T>;
};

/** API base — matches Vite's base so the app works under /faktura/ or /. */
export const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

export const api = {
  pool: () => fetch(`${API_BASE}/pool`).then((r) => j<PoolResponse>(r)),
  invoices: () => fetch(`${API_BASE}/invoices`).then((r) => j<InvoiceRecord[]>(r)),
  meta: () => fetch(`${API_BASE}/meta`).then((r) => j<Meta>(r)),
  submit: (body: unknown) =>
    fetch(`${API_BASE}/invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<InvoiceRecord>(r)),
  deposit: (amountCspr: number) =>
    fetch(`${API_BASE}/demo/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCspr }),
    }).then((r) => j<{ ok: boolean }>(r)),
  settle: (id: number) =>
    fetch(`${API_BASE}/demo/settle/${id}`, { method: "POST" }).then((r) =>
      j<{ ok: boolean; deployHash?: string }>(r),
    ),
  riskChallenge: async (id: number): Promise<X402Challenge> => {
    const r = await fetch(`${API_BASE}/risk/${id}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  },
  x402Pay: (nonce: string, amount: string) =>
    fetch(`${API_BASE}/demo/x402-pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce, amount }),
    }).then((r) => j<{ simulated: boolean; proof: string }>(r)),
  riskWithProof: async (id: number, proof: string, nonce: string) => {
    const r = await fetch(`${API_BASE}/risk/${id}`, {
      headers: { "PAYMENT-SIGNATURE": proof, "PAYMENT-NONCE": nonce },
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as RiskReport };
  },
};

export const motesToCspr = (m: string | undefined) =>
  m ? Number(BigInt(m) / 1_000_000n) / 1000 : 0;

export const stateName = (s: number) =>
  ["LISTED", "FUNDED", "SETTLED", "DEFAULTED"][s] ?? `#${s}`;
