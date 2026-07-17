import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  API_BASE,
  isSimulatedHash,
  judge,
  motesToCspr,
  stateName,
  type FeedEvent,
  type InvoiceRecord,
  type JudgeHealth,
  type JudgePreset,
  type JudgeSession,
  type JudgeStep,
  type Meta,
  type PoolResponse,
  type RiskReport,
} from "./api";

/**
 * The only way a hash is ever rendered: real deploys link to the explorer,
 * simulated showcase writes are labeled as such and never linked.
 */
function TxLink({ hash, explorer, prefix }: { hash?: string; explorer: string; prefix?: string }) {
  if (!hash) return <span className="muted">—</span>;
  if (isSimulatedHash(hash))
    return <span className="sim-tag">simulated write — no explorer tx</span>;
  return (
    <a target="_blank" rel="noreferrer" href={`${explorer}/deploy/${hash}`}>
      {prefix}
      {hash.slice(0, 10)}… ↗
    </a>
  );
}

const ACTOR_ICON: Record<string, string> = {
  underwriter: "AI",
  collector: "⏱",
  oracle: "402",
  system: "⚙",
};

const riskColor = (r: number) => (r <= 30 ? "#0f8a5f" : r <= 55 ? "#c98a1b" : "#d92d2d");

function fmtCspr(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function timeAgo(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${s.toFixed(0)}s ago`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

export default function App() {
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [selected, setSelected] = useState<InvoiceRecord | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [depositAmt, setDepositAmt] = useState("100");
  const [judgeOpen, setJudgeOpen] = useState(false);
  const [runnerOpen, setRunnerOpen] = useState(false);
  const [jhealth, setJhealth] = useState<JudgeHealth | null>(null);
  const [judgeProbed, setJudgeProbed] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  // Detect the live judge backend (:4034 behind /api/judge). Its presence flips
  // the hero to the real-testnet path; absence gracefully keeps the showcase.
  const probeJudge = () =>
    judge
      .health()
      .then((h) => setJhealth(h))
      .catch(() => setJhealth(null))
      .finally(() => setJudgeProbed(true));

  const refresh = async () => {
    try {
      const [p, inv] = await Promise.all([api.pool(), api.invoices()]);
      setPool(p);
      setInvoices(inv);
    } catch {
      /* backend still booting */
    }
  };

  useEffect(() => {
    refresh();
    api
      .meta()
      .then(setMeta)
      .catch(() => {});
    probeJudge();
    const jiv = setInterval(probeJudge, 30_000);
    const iv = setInterval(refresh, 12_000);
    const es = new EventSource(`${API_BASE}/activity`);
    es.onmessage = (m) => {
      const data = JSON.parse(m.data);
      if (data.history) setEvents(data.history.reverse());
      else {
        setEvents((prev) => [data, ...prev].slice(0, 120));
        if (data.kind === "onchain" || data.kind === "decision") refresh();
      }
    };
    return () => {
      es.close();
      clearInterval(iv);
      clearInterval(jiv);
    };
  }, []);

  const liveJudge = !!jhealth; // the dedicated live-testnet backend answered

  const stats = pool?.stats;
  const tvl = stats ? motesToCspr(stats.liquid) + motesToCspr(stats.deployed) : 0;
  const sharePrice =
    stats && BigInt(stats.totalShares) > 0n
      ? Number(
          ((BigInt(stats.liquid) + BigInt(stats.deployed)) * 10_000n) / BigInt(stats.totalShares),
        ) / 10_000
      : 1;
  const yieldRealized = stats
    ? motesToCspr(stats.totalSettled) -
      motesToCspr(stats.totalFunded) +
      motesToCspr(stats.totalDefaulted) * 0
    : 0;

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4200);
  };

  const contractShort = pool?.contract
    ? `${pool.contract.slice(0, 16)}…${pool.contract.slice(-6)}`
    : "not deployed";

  return (
    <div className="shell">
      <header className="header">
        <div>
          <div className="wordmark">
            FAKTU<em>RA</em>
          </div>
          <div className="tagline">The autonomous invoice-financing desk on Casper</div>
        </div>
        <div className="spacer" />
        <span className="chip">
          <span className="dot" /> casper-test
        </span>
        {meta && (
          <span className="chip" title="Underwriting model provider (from /api/meta)">
            AI · {meta.llmProvider === "mock" ? "deterministic scorer" : "live inference"}
          </span>
        )}
        {meta && (
          <span className="chip" title="Machine-payable risk oracle price">
            x402 · {(Number(meta.x402Price) / 1e9).toFixed(1)} CSPR
          </span>
        )}
        {meta?.mcp && (
          <button
            className="chip chip-btn"
            title="Open the MCP agent interface — 5 tools, quick-start commands, live previews"
            onClick={() => setMcpOpen(true)}
          >
            MCP · 5 tools ▾
          </button>
        )}
        {pool?.contract && (
          <a
            className="chip"
            target="_blank"
            rel="noreferrer"
            href={`${pool.explorer}/contract/${pool.contract.replace("hash-", "")}`}
          >
            ⛓ {contractShort}
          </a>
        )}
        <a
          className="chip"
          href="https://github.com/a252937166/faktura-casper"
          target="_blank"
          rel="noreferrer"
        >
          ⭐ GitHub
        </a>
      </header>

      {meta && (
        <div className={`mode-banner ${meta.mode}`}>
          <span className="mode-tag">{meta.mode === "showcase" ? "SHOWCASE" : "LIVE TESTNET"}</span>
          <span className="mode-text">
            {meta.mode === "showcase" ? (
              <>
                On-chain <b>reads</b> come from a captured snapshot of the real testnet contract
                (verifiable on cspr.live) and the AI underwriter runs <b>live</b> — but{" "}
                <b>writes are simulated</b> in server memory, not signed transactions. Run the stack
                locally (README) for real Casper transactions.
              </>
            ) : (
              <>
                Every action on this page is a <b>real Casper Testnet transaction</b> signed by the
                agent keys — follow the tx links in the activity feed.
              </>
            )}
            {meta.policy && (
              <span className="policy-note">
                {" "}
                On-chain hard caps: risk ≤ {meta.policy.maxRiskScore} · discount{" "}
                {(meta.policy.minDiscountBps / 100).toFixed(1)}–
                {(meta.policy.maxDiscountBps / 100).toFixed(0)}% · invoice ≤{" "}
                {(meta.policy.maxSingleInvoiceBps / 100).toFixed(0)}% of pool · debtor ≤{" "}
                {(meta.policy.maxDebtorExposureBps / 100).toFixed(0)}%.
                {meta.prefilter && (
                  <>
                    {" "}
                    Agent prefilter (stricter, saves gas): risk ≤ {meta.prefilter.maxRiskScore}. The
                    contract is the final authority.
                  </>
                )}
              </span>
            )}
          </span>
        </div>
      )}

      {pool && <ProofStrip pool={pool} invoices={invoices} meta={meta} />}

      <section className="hero">
        <div>
          <span className="hero-badge">
            <i /> Autonomous underwriting desk — Casper testnet
          </span>
          <h1>
            Invoices in.
            <br />
            Capital out. <span className="accent">No humans.</span>
          </h1>
          <p className="hero-sub">
            Faktura is an autonomous invoice-financing desk on Casper: an AI agent underwrites each
            receivable, a native-CSPR pool funds it, and every decision is hash-anchored on-chain
            {meta?.mode === "live-testnet"
              ? " — fully auditable."
              : " in live mode — this showcase seeds real proof and simulates new writes."}
          </p>
          <p className="hero-note">
            {meta?.mode === "live-testnet"
              ? "LLM proposes → policy disposes → registered, funded & attested on-chain."
              : "LLM proposes → policy disposes → seeded on-chain proof, new writes simulated."}
          </p>
          <div className="hero-cta">
            {liveJudge ? (
              <button className="btn-primary" onClick={() => setRunnerOpen(true)}>
                ▶ RUN REAL TESTNET WORKFLOW
              </button>
            ) : (
              <button className="btn-primary" onClick={() => setJudgeOpen(true)}>
                ▶ RUN JUDGE DEMO
              </button>
            )}
            <a
              className="btn-outline"
              href="https://youtu.be/47ZNPZlRXVA"
              target="_blank"
              rel="noreferrer"
            >
              WATCH 3-MIN DEMO ↗
            </a>
            <a
              className="btn-outline"
              target="_blank"
              rel="noreferrer"
              href={
                pool?.contract
                  ? `${pool.explorer}/contract/${pool.contract.replace("hash-", "")}`
                  : "https://testnet.cspr.live"
              }
            >
              OPEN EVIDENCE PACK ↗
            </a>
          </div>
          {liveJudge ? (
            <div className="hero-live">
              <span className={`live-dot ${jhealth?.paused ? "amber" : "green"}`} />
              {jhealth?.paused
                ? "Live judge mode is paused (topping up testnet keys) — explore the safe showcase below."
                : "Live Testnet Judge Mode is online — every step you run signs a real Casper Testnet transaction."}{" "}
              <button className="linklike" onClick={() => setJudgeOpen(true)}>
                Prefer the 30-second story?
              </button>
            </div>
          ) : (
            judgeProbed && (
              <div className="hero-live">
                <span className="live-dot muted" /> Safe Showcase — no gas, writes simulated from a
                real testnet snapshot. Run the stack in live mode to sign every step.
              </div>
            )
          )}
          <div className="hero-metrics">
            <div className="hm-red">
              <b>{fmtCspr(tvl)} CSPR</b>
              <span>pool TVL</span>
            </div>
            <div>
              <b>{sharePrice.toFixed(4)}</b>
              <span>LP share price</span>
            </div>
            <div>
              <b>{stats?.attestationCount ?? 0}</b>
              <span>
                {meta?.mode === "live-testnet"
                  ? "AI decisions on-chain"
                  : "AI decisions / seeded anchors"}
              </span>
            </div>
          </div>
        </div>
        <div className="doc-wrap" aria-hidden>
          <div className="doc">
            <header>
              INVOICE <span>№ 2026-0347</span>
            </header>
            <div className="doc-row">
              <span>Supplier</span>
              <b>Nordwind Logistics</b>
            </div>
            <div className="doc-row">
              <span>Debtor</span>
              <b>Aurora Retail AG</b>
            </div>
            <div className="doc-row">
              <span>Tenor</span>
              <b>30 days</b>
            </div>
            <div className="doc-row">
              <span>Risk score</span>
              <b className="r-red">28 / 100</b>
            </div>
            <div className="doc-row">
              <span>Discount</span>
              <b>2.00%</b>
            </div>
            <div className="doc-row">
              <span>Decision hash</span>
              <b>sha256:9d93…a8e1</b>
            </div>
            <div className="doc-total">
              <span>ADVANCE</span>
              <b>58.8 CSPR</b>
            </div>
          </div>
          <div className="stamp s1">APPROVED</div>
          <div className="stamp s2">FUNDED</div>
        </div>
      </section>

      <section className="stats">
        <div className="stat">
          <div className="label">Pool TVL</div>
          <div className="value">{fmtCspr(tvl)} CSPR</div>
          <div className="sub">
            liquid {fmtCspr(motesToCspr(stats?.liquid))} · deployed{" "}
            {fmtCspr(motesToCspr(stats?.deployed))}
          </div>
        </div>
        <div className="stat">
          <div className="label">LP Share Price</div>
          <div className={`value ${sharePrice > 1 ? "good" : ""}`}>{sharePrice.toFixed(4)}</div>
          <div className="sub">1.0000 at genesis — yield accrues here</div>
        </div>
        <div className="stat">
          <div className="label">Advances Funded</div>
          <div className="value accent">{fmtCspr(motesToCspr(stats?.totalFunded))} CSPR</div>
          <div className="sub">{stats?.invoiceCount ?? 0} invoices registered</div>
        </div>
        <div className="stat">
          <div className="label">Collected</div>
          <div className="value">{fmtCspr(motesToCspr(stats?.totalSettled))} CSPR</div>
          <div className="sub">face value settled by debtors</div>
        </div>
        <div className="stat">
          <div className="label">Defaults</div>
          <div className={`value ${motesToCspr(stats?.totalDefaulted) > 0 ? "bad" : ""}`}>
            {fmtCspr(motesToCspr(stats?.totalDefaulted))} CSPR
          </div>
          <div className="sub">written off autonomously</div>
        </div>
        <div className="stat">
          <div className="label">AI Attestations</div>
          <div className="value">{stats?.attestationCount ?? 0}</div>
          <div className="sub">
            {meta?.mode === "live-testnet"
              ? "decision hashes anchored on-chain"
              : "seeded anchors + simulated new decisions"}
          </div>
        </div>
      </section>

      <div className="grid">
        <div style={{ display: "grid", gap: 16 }}>
          <div className="panel">
            <div className="head">
              Receivables pipeline
              <span className="hint">
                {meta?.mode === "live-testnet"
                  ? "every state transition is a Casper Testnet transaction"
                  : "seeded from real Casper Testnet · new writes simulated"}
              </span>
              <span className="right hint">{invoices.length} intakes</span>
            </div>
            {invoices.length === 0 ? (
              <div className="empty">
                No invoices yet — submit one below and watch the underwriter work.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Supplier → Debtor</th>
                    <th className="num">Face</th>
                    <th className="num">Advance</th>
                    <th>Risk</th>
                    <th>Due</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((r) => {
                    const chainState = pool?.onchain.find((o) => o.id === r.id);
                    // policy_blocked outranks the raw chain state (Listed): the
                    // register succeeded but the contract refused the funding.
                    const status =
                      r.status === "policy_blocked"
                        ? "policy_blocked"
                        : chainState && r.id
                          ? stateName(chainState.state)
                          : r.status;
                    return (
                      <tr key={r.intakeId} className="row" onClick={() => setSelected(r)}>
                        <td className="mono">{r.intake.invoiceNumber}</td>
                        <td>
                          {r.intake.supplierName} <span className="muted">→</span>{" "}
                          {r.intake.debtorName}
                        </td>
                        <td className="num mono">{fmtCspr(r.intake.amountCspr)}</td>
                        <td className="num mono">
                          {r.decision?.approve
                            ? fmtCspr(
                                (r.intake.amountCspr * (10_000 - r.decision.discountBps)) / 10_000,
                              )
                            : "—"}
                        </td>
                        <td>
                          {r.decision ? (
                            <span className="risk">
                              <span className="bar">
                                <i
                                  style={{
                                    width: `${r.decision.riskScore}%`,
                                    background: riskColor(r.decision.riskScore),
                                  }}
                                />
                              </span>
                              <span className="mono">{r.decision.riskScore}</span>
                            </span>
                          ) : (
                            <span className="muted mono">…</span>
                          )}
                        </td>
                        <td className="mono muted">
                          {new Date(r.intake.dueTs).toISOString().slice(0, 10)}
                        </td>
                        <td>
                          <span className={`badge ${status}`}>{status.toUpperCase()}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="pool-actions">
              <span className="muted" style={{ fontSize: 12 }}>
                LP demo actions:
              </span>
              <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
              <button
                className="btn ghost sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.deposit(Number(depositAmt));
                    notify(
                      meta?.mode === "live-testnet"
                        ? `Deposited ${depositAmt} CSPR into the pool`
                        : `SHOWCASE: simulated ${depositAmt} CSPR deposit in memory`,
                    );
                    refresh();
                  } catch (e) {
                    notify(`Deposit failed: ${(e as Error).message}`);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Deposit CSPR
              </button>
              <span className="muted" style={{ fontSize: 11.5, fontFamily: "var(--mono)" }}>
                {meta?.mode === "live-testnet"
                  ? `share price ${sharePrice.toFixed(4)} · funded from real testnet balance`
                  : `share price ${sharePrice.toFixed(4)} · showcase deposit simulated in memory`}
              </span>
            </div>
          </div>

          <div id="sell">
            <SubmitPanel
              supplierDefault={meta?.supplier ?? null}
              liveMode={meta?.mode === "live-testnet"}
              onOpenGuided={() => setRunnerOpen(true)}
              onSubmitted={(r) => {
                notify(
                  r.status === "rejected"
                    ? `Underwriter REJECTED ${r.intake.invoiceNumber}`
                    : r.status === "policy_blocked"
                      ? `Casper policy BLOCKED funding of ${r.intake.invoiceNumber} — open it to see the firewall`
                      : `Underwriter approved & funded ${r.intake.invoiceNumber}`,
                );
                refresh();
              }}
            />
          </div>
        </div>

        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <AgentRoles />
          <div className="panel">
            <div className="head">
              Agent activity
              <span className="hint">live</span>
              <span className="right">
                <span className="dot" />
              </span>
            </div>
            <div className="feed" ref={feedRef}>
              {events.length === 0 && <div className="empty">Agents idle…</div>}
              {events.map((e, i) => (
                <div className="feed-item" key={`${e.ts}-${i}`}>
                  <div className="avatar">{ACTOR_ICON[e.actor] ?? "•"}</div>
                  <div className="body">
                    <div className="msg">{e.message}</div>
                    <div className="meta">
                      <span>{e.actor}</span>
                      <span>{timeAgo(e.ts)}</span>
                      {e.deployHash && (
                        <TxLink
                          hash={e.deployHash}
                          explorer={pool?.explorer ?? "https://testnet.cspr.live"}
                          prefix="tx "
                        />
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {selected && (
        <Drawer
          record={selected}
          pool={pool}
          meta={meta}
          busy={busy}
          notify={notify}
          onClose={() => setSelected(null)}
          onSettle={async (id) => {
            setBusy(true);
            try {
              await api.settle(id);
              notify(`Settlement submitted for invoice #${id}`);
              refresh();
            } catch (e) {
              notify(`Settle failed: ${(e as Error).message}`);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {judgeOpen && (
        <JudgeDemo
          meta={meta}
          onClose={() => {
            setJudgeOpen(false);
            refresh();
          }}
        />
      )}
      {runnerOpen && (
        <JudgeGuided
          health={jhealth}
          onHealth={setJhealth}
          onClose={() => {
            setRunnerOpen(false);
            refresh();
          }}
        />
      )}
      {mcpOpen && <McpDrawer meta={meta} notify={notify} onClose={() => setMcpOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/**
 * One-glance on-chain evidence: contract + the latest lifecycle transactions.
 * Only REAL deploys qualify — simulated showcase writes are filtered out, and
 * the strip is titled SEEDED (not LIVE) when the host runs in showcase mode.
 */
function ProofStrip({
  pool,
  invoices,
  meta,
}: {
  pool: PoolResponse;
  invoices: InvoiceRecord[];
  meta: Meta | null;
}) {
  const showcase = meta?.mode !== "live-testnet";
  const latest = (pick: (r: InvoiceRecord) => string | undefined) => {
    for (const r of invoices) {
      const h = pick(r);
      if (h && !isSimulatedHash(h)) return h;
    }
    return undefined;
  };
  const items: { label: string; hash?: string; text?: string }[] = [
    { label: "Contract package", text: `${pool.contract.slice(5, 13)}…${pool.contract.slice(-6)}` },
    { label: "Latest register tx", hash: latest((r) => r.chain.registerHash) },
    { label: "Latest fund tx", hash: latest((r) => r.chain.fundHash) },
    { label: "Latest attestation", hash: latest((r) => r.chain.attestHashes.at(-1)) },
    {
      label: "Latest decision hash",
      // Only anchored (real-register) records qualify; empty state renders "—".
      text: (() => {
        const h = invoices.find(
          (r) => r.decision && r.chain.registerHash && !isSimulatedHash(r.chain.registerHash),
        )?.decision?.decisionHash;
        return h ? `${h.slice(0, 21)}…` : undefined;
      })(),
    },
  ];
  return (
    <div className="proof-strip">
      <span
        className="ps-title"
        title={
          showcase
            ? "Real transactions captured from the testnet contract into the showcase seed — new writes here are simulated and never shown as proof."
            : undefined
        }
      >
        {showcase ? "SEEDED CASPER PROOF" : "LIVE CASPER PROOF"}
      </span>
      {items.map((it) => (
        <span className="ps-item" key={it.label}>
          <span className="ps-label">{it.label}</span>
          {it.hash ? (
            <a target="_blank" rel="noreferrer" href={`${pool.explorer}/deploy/${it.hash}`}>
              {it.hash.slice(0, 10)}… ↗
            </a>
          ) : it.label === "Contract package" ? (
            <a
              target="_blank"
              rel="noreferrer"
              href={`${pool.explorer}/contract-package/${pool.contract.replace("hash-", "")}`}
            >
              {it.text} ↗
            </a>
          ) : (
            <span className="mono">{it.text ?? "—"}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function SubmitPanel({
  supplierDefault,
  liveMode,
  onOpenGuided,
  onSubmitted,
}: {
  supplierDefault: string | null;
  liveMode: boolean;
  onOpenGuided: () => void;
  onSubmitted: (r: InvoiceRecord) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    supplierName: "Nordwind Logistics GmbH",
    supplierAddress: "",
    debtorName: "Aurora Retail AG",
    amountCspr: "45",
    dueDays: "30",
    invoiceNumber: `INV-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 900) + 100)}`,
    description: "March freight services, 14 pallet shipments Hamburg → Vienna",
    history: "6 prior invoices, all paid within terms",
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const num = () => String(Math.floor(Math.random() * 900) + 100);
  const presets: Record<string, Partial<typeof form> & { hint: string }> = {
    "Safe invoice": {
      hint: "clean counterparty → APPROVED",
      supplierName: "Nordwind Logistics GmbH",
      debtorName: "Aurora Retail AG",
      amountCspr: "45",
      dueDays: "30",
      description: "Freight services, 14 pallet shipments Hamburg → Vienna",
      history: "6 prior invoices, all paid within terms",
    },
    "AI rejection": {
      hint: "shell debtor + dispute → REJECTED by the model",
      supplierName: "QuickCash Trading",
      debtorName: "Unknown Shell Ltd",
      amountCspr: "40",
      dueDays: "90",
      description: "Consulting, lump sum, no deliverables specified",
      history: "new counterparty, one prior invoice disputed and overdue",
    },
    "Policy-cap rejection": {
      // 80 CSPR ≈ the DORAHACKS evidence case: the AI approves it, the
      // liquidity sanity check passes, and fund_invoice reverts on the
      // contract's 50%-of-pool single-invoice cap (User error: 15).
      hint: "AI approves — the contract cap blocks funding",
      supplierName: "Titan Freight OÜ",
      debtorName: "Vega Manufacturing GmbH",
      amountCspr: "80",
      dueDays: "30",
      description: "Bulk haulage, oversized single shipment against a shallow pool",
      history: "4 prior invoices, all paid within terms",
    },
    "Default after funding": {
      hint: "funds, then debtor never pays → written off",
      supplierName: "Helios Solar Kft",
      debtorName: "Metro Utilities Zrt",
      amountCspr: "50",
      dueDays: "1",
      description: "Panel maintenance, Q1 service contract",
      history: "3 prior invoices paid on time",
    },
  };
  const applyPreset = (name: string) => {
    const p = presets[name];
    setForm((f) => ({ ...f, ...p, invoiceNumber: `INV-${new Date().getFullYear()}-${num()}` }));
  };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.submit({
        supplierName: form.supplierName,
        supplierAddress: form.supplierAddress.trim() || undefined,
        debtorName: form.debtorName,
        amountCspr: Number(form.amountCspr),
        dueTs: Date.now() + Number(form.dueDays) * 86_400_000,
        invoiceNumber: form.invoiceNumber,
        description: form.description,
        history: form.history,
      });
      onSubmitted(r);
      set(
        "invoiceNumber",
        `INV-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 900) + 100)}`,
      );
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="head">
        Sell a receivable
        <span className="hint">intake goes straight to the autonomous underwriter</span>
      </div>
      <div className="presets">
        <span className="presets-label">Presets:</span>
        {Object.keys(presets).map((name) => (
          <button
            key={name}
            className="preset"
            title={presets[name].hint}
            onClick={() => applyPreset(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="form">
        <div className="field">
          <label>Supplier (you)</label>
          <input value={form.supplierName} onChange={(e) => set("supplierName", e.target.value)} />
        </div>
        <div className="field">
          <label>Debtor (owes the invoice)</label>
          <input value={form.debtorName} onChange={(e) => set("debtorName", e.target.value)} />
        </div>
        <div className="field">
          <label>Face value (CSPR)</label>
          <input value={form.amountCspr} onChange={(e) => set("amountCspr", e.target.value)} />
        </div>
        <div className="field">
          <label>Due in (days)</label>
          <input value={form.dueDays} onChange={(e) => set("dueDays", e.target.value)} />
        </div>
        <div className="field">
          <label>Invoice number</label>
          <input
            value={form.invoiceNumber}
            onChange={(e) => set("invoiceNumber", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Payment history</label>
          <input value={form.history} onChange={(e) => set("history", e.target.value)} />
        </div>
        <div className="field full">
          <label>Description</label>
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </div>
        <div className="field full">
          <label>Supplier Casper address — receives the advance (optional)</label>
          <input
            value={form.supplierAddress}
            placeholder={
              supplierDefault
                ? `defaults to demo supplier ${supplierDefault.replace("entity-account-", "account-hash-").slice(0, 30)}…`
                : "account-hash-… (defaults to the demo supplier account)"
            }
            onChange={(e) => set("supplierAddress", e.target.value)}
          />
        </div>
        <div
          className="full"
          style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
        >
          {liveMode ? (
            <>
              <button className="btn" onClick={onOpenGuided}>
                ▶ Run it live, step by step →
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                On the live desk each step is a separate Casper transaction — the guided walkthrough
                runs them one click at a time, no long waits.
              </span>
            </>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={submit}>
                {busy ? (
                  <span className="btn-working">
                    <span className="btn-orb">AI</span> Underwriting…
                  </span>
                ) : (
                  "Submit to underwriter"
                )}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                LLM proposes → on-chain policy disposes → writes simulated in showcase (a few
                seconds)
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Drawer({
  record,
  pool,
  meta,
  busy,
  notify,
  onClose,
  onSettle,
}: {
  record: InvoiceRecord;
  pool: PoolResponse | null;
  meta: Meta | null;
  busy: boolean;
  notify: (m: string) => void;
  onClose: () => void;
  onSettle: (id: number) => void;
}) {
  const chainState = pool?.onchain.find((o) => o.id === record.id);
  const status =
    record.status === "policy_blocked"
      ? "policy_blocked"
      : chainState && record.id
        ? stateName(chainState.state)
        : record.status;
  const d = record.decision;
  const explorer = pool?.explorer ?? "https://testnet.cspr.live";
  const showcase = meta?.mode !== "live-testnet";

  const txs = useMemo(
    () =>
      [
        ["Register", record.chain.registerHash],
        ["Fund (advance transfer)", record.chain.fundHash],
        ["Settle", record.chain.settleHash],
        ["Default write-off", record.chain.defaultHash],
        ...record.chain.attestHashes.map((h, i) => [`Attestation #${i + 1}`, h] as const),
      ].filter(([, h]) => h),
    [record],
  );

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <h2>
          {record.intake.invoiceNumber}{" "}
          <span className={`badge ${status}`}>{status.toUpperCase()}</span>
        </h2>
        <div className="muted" style={{ fontSize: 13 }}>
          {record.intake.supplierName} → {record.intake.debtorName} ·{" "}
          {fmtCspr(record.intake.amountCspr)} CSPR · due{" "}
          {new Date(record.intake.dueTs).toLocaleString()}
        </div>

        {d && (
          <div className="section">
            <h3>AI underwriting decision</h3>
            <div className="gauge">
              <div className="ring">
                <svg width="74" height="74" viewBox="0 0 74 74">
                  <circle cx="37" cy="37" r="31" fill="none" stroke="#e7dfcd" strokeWidth="7" />
                  <circle
                    cx="37"
                    cy="37"
                    r="31"
                    fill="none"
                    stroke={riskColor(d.riskScore)}
                    strokeWidth="7"
                    strokeLinecap="round"
                    strokeDasharray={`${(d.riskScore / 100) * 195} 195`}
                  />
                </svg>
                <div className="val" style={{ color: riskColor(d.riskScore) }}>
                  {d.riskScore}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>
                  {d.approve ? "APPROVED" : "REJECTED"} · discount{" "}
                  {(d.discountBps / 100).toFixed(2)}%
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  model {d.model} · {new Date(d.decidedTs).toLocaleTimeString()}
                </div>
                <div className="note" style={{ marginTop: 4 }}>
                  memo hash {d.decisionHash.slice(0, 26)}…{" "}
                  {record.chain.attestHashes.some((h) => h && !isSimulatedHash(h)) ||
                  (record.chain.registerHash && !isSimulatedHash(record.chain.registerHash))
                    ? "anchored on-chain"
                    : "(anchoring simulated in showcase)"}
                </div>
              </div>
            </div>
            <div className="memo" style={{ marginTop: 12 }}>
              {d.rationale}
            </div>
            {d.redFlags.length > 0 && (
              <div className="flags" style={{ marginTop: 10 }}>
                {d.redFlags.map((f) => (
                  <span className="flag" key={f}>
                    ⚑ {f}
                  </span>
                ))}
              </div>
            )}
            {d.policyNotes.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {d.policyNotes.map((n) => (
                  <div className="note" key={n}>
                    ▸ policy: {n}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {d && meta?.policy && (
          <PolicyFirewall
            record={record}
            d={d}
            policy={meta.policy}
            pool={pool}
            showcase={showcase}
          />
        )}

        <div className="section">
          <h3>Terms</h3>
          <div className="kv">
            <span className="k">Face value</span>
            <span className="mono">{fmtCspr(record.intake.amountCspr)} CSPR</span>
            <span className="k">Advance</span>
            <span className="mono">
              {d?.approve
                ? `${fmtCspr((record.intake.amountCspr * (10_000 - d.discountBps)) / 10_000)} CSPR`
                : "—"}
            </span>
            <span className="k">Pool fee</span>
            <span className="mono">{d ? `${(d.discountBps / 100).toFixed(2)}%` : "—"}</span>
            {record.intake.supplierAddress && (
              <>
                <span className="k">Advance paid to</span>
                <span className="mono" style={{ wordBreak: "break-all" }}>
                  {record.intake.supplierAddress.replace("entity-account-", "account-hash-")}{" "}
                  (supplier)
                </span>
              </>
            )}
            <span className="k">Debtor tag</span>
            <span className="mono">{record.intake.debtorTag}</span>
            <span className="k">Document hash</span>
            <span className="mono" style={{ wordBreak: "break-all" }}>
              {record.intake.docHash}
            </span>
          </div>
        </div>

        <div className="section">
          <h3>On-chain trail</h3>
          <div className="fw-sub">
            {txs.every(([, h]) => isSimulatedHash(String(h)))
              ? txs.length > 0
                ? "All rows below are simulated showcase writes — nothing was signed."
                : ""
              : "Real deploys link to the explorer; simulated showcase writes are labeled."}
          </div>
          {txs.length === 0 && !record.chain.fundError && (
            <div className="muted">No transactions yet.</div>
          )}
          {txs.map(([label, hash]) => (
            <div className="txlink" key={String(hash)}>
              <span>{label}</span>
              <TxLink hash={String(hash)} explorer={explorer} />
            </div>
          ))}
          {record.chain.fundError && (
            <div className="txlink">
              <span>Fund (advance transfer)</span>
              <span className="fw-verdict fail" style={{ padding: "3px 8px" }}>
                blocked — {record.chain.fundError}
              </span>
            </div>
          )}
          {record.chain.attestPending && (
            <div className="note" style={{ marginTop: 8 }}>
              Funded on-chain; attestation retry required.
            </div>
          )}
        </div>

        {d?.approve && record.id > 0 && (
          <X402Panel
            invoiceId={record.id}
            showcase={showcase}
            priceMotes={meta?.x402Price}
            notify={notify}
          />
        )}

        {status === "FUNDED" && (
          <div className="section">
            <button className="btn" disabled={busy} onClick={() => onSettle(record.id)}>
              {busy
                ? "Settling…"
                : showcase
                  ? `Simulate debtor settlement (${fmtCspr(record.intake.amountCspr)} CSPR)`
                  : `Submit debtor settlement on Casper Testnet (${fmtCspr(record.intake.amountCspr)} CSPR)`}
            </button>
            <div className="note" style={{ marginTop: 6 }}>
              {showcase
                ? "SHOWCASE: updates server memory only — no signed transaction."
                : "LIVE TESTNET: signs with the debtor demo key and submits a real deploy of face value to the contract."}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** Visual "Casper Policy Firewall": the model proposes, the contract checks. */
function PolicyFirewall({
  record,
  d,
  policy,
  pool,
  showcase,
}: {
  record: InvoiceRecord;
  d: NonNullable<InvoiceRecord["decision"]>;
  policy: NonNullable<Meta["policy"]>;
  pool: PoolResponse | null;
  showcase: boolean;
}) {
  const tvl = pool ? motesToCspr(pool.stats.liquid) + motesToCspr(pool.stats.deployed) : 0;
  const advance = (record.intake.amountCspr * (10_000 - d.discountBps)) / 10_000;
  const singleCapCspr = (tvl * policy.maxSingleInvoiceBps) / 10_000;
  const capExceeded =
    !!record.chain.fundError || d.policyNotes.some((n) => /cap|exposure|liquidity/i.test(n));
  const checks = [
    {
      label: "Risk score",
      value: `${d.riskScore} / ${policy.maxRiskScore}`,
      pass: d.riskScore <= policy.maxRiskScore,
    },
    {
      label: "Discount band",
      value: `${(d.discountBps / 100).toFixed(2)}% in ${(policy.minDiscountBps / 100).toFixed(1)}–${(policy.maxDiscountBps / 100).toFixed(0)}%`,
      pass: d.discountBps >= policy.minDiscountBps && d.discountBps <= policy.maxDiscountBps,
    },
    {
      label: "Single-invoice cap",
      value: `advance ${advance.toFixed(1)} ≤ ${singleCapCspr.toFixed(1)} CSPR (${policy.maxSingleInvoiceBps / 100}% of pool)`,
      pass: !capExceeded && advance <= singleCapCspr + 0.001,
    },
  ];
  const allow = d.approve && checks.every((c) => c.pass);
  // Attribute the block to the layer that actually said no: the AI itself,
  // the agent prefilter (never sent on-chain), or the Casper contract. A
  // model-approved record that still fails a check was stopped by the chain
  // (covers older records that predate the explicit fundError field).
  const source: "allowed" | "chain" | "prefilter" | "ai" = allow
    ? "allowed"
    : record.status === "policy_blocked" || record.chain.fundError || d.approve
      ? "chain"
      : d.model === "policy-gate" || d.policyNotes.some((n) => /prefilter|liquidity check/i.test(n))
        ? "prefilter"
        : "ai";
  return (
    <div className="section firewall">
      <h3>Casper Policy Firewall</h3>
      <div className="fw-sub">
        {showcase
          ? "SHOWCASE: the same contract policy is replayed in memory — nothing is signed."
          : "LIVE: enforced by the contract at register / fund — not by the agent."}
      </div>
      {checks.map((c) => (
        <div className="fw-row" key={c.label}>
          <span className="fw-label">{c.label}</span>
          <span className="fw-value mono">{c.value}</span>
          <span className={`fw-verdict ${c.pass ? "pass" : "fail"}`}>
            {c.pass ? "PASS" : "FAIL"}
          </span>
        </div>
      ))}
      <div className={`fw-result ${source === "allowed" ? "allow" : "block"}`}>
        {source === "allowed" ? (
          showcase ? (
            <>✓ Result: policy allowed funding — simulated in showcase</>
          ) : (
            <>✓ Result: capital movement allowed on-chain</>
          )
        ) : source === "chain" ? (
          <>
            ✕ Result: funding blocked by Casper policy
            {record.chain.fundError && <> — {record.chain.fundError}</>}
          </>
        ) : source === "prefilter" ? (
          <>✕ Result: blocked by the agent prefilter — never sent on-chain</>
        ) : (
          <>✕ Result: rejected by the AI underwriter — never sent on-chain</>
        )}
      </div>
      {record.chain.fundError && (
        <div className="fund-error">
          fund_invoice → {record.chain.fundError}. The AI approved this invoice and it registered
          on-chain — the contract refused to move the capital.
        </div>
      )}
    </div>
  );
}

/** In-drawer x402 flow: 402 challenge → pay → verified paid report. */
function X402Panel({
  invoiceId,
  showcase,
  priceMotes,
  notify,
}: {
  invoiceId: number;
  showcase: boolean;
  priceMotes?: string;
  notify: (m: string) => void;
}) {
  const [step, setStep] = useState(0); // 0 idle, 1 challenged, 2 paid, 3 report
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState("");
  const [payTo, setPayTo] = useState("");
  const [proof, setProof] = useState("");
  const [report, setReport] = useState<RiskReport | null>(null);
  const price = priceMotes ? (Number(priceMotes) / 1e9).toFixed(2) : "2.50";

  const challenge = async () => {
    setBusy(true);
    try {
      const c = await api.riskChallenge(invoiceId);
      const offer = c.body.accepts?.[0];
      if (c.status === 402 && offer) {
        setNonce(offer.extra.transferIdNonce);
        setPayTo(offer.payTo);
        setStep(1);
      } else {
        notify(`x402: unexpected ${c.status}`);
      }
    } finally {
      setBusy(false);
    }
  };
  const pay = async () => {
    setBusy(true);
    try {
      const r = await api.x402Pay(nonce, priceMotes ?? "2500000000");
      setProof(r.proof);
      setStep(2);
      const rep = await api.riskWithProof(invoiceId, r.proof, nonce);
      if (rep.status === 200) {
        setReport(rep.body);
        setStep(3);
        notify(`x402 report released${r.simulated ? " (simulated payment)" : ""}`);
      } else {
        notify(`x402 verify failed (${rep.status})`);
      }
    } catch (e) {
      notify(`x402 failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section x402">
      <h3>Machine-payable risk report · x402</h3>
      <div className="x402-meta">
        <span>Price {price} CSPR</span>
        <span>HTTP 402</span>
        <span>native-CSPR settlement</span>
      </div>
      <div className="x402-steps">
        <div className={`x402-step ${step >= 1 ? "done" : step === 0 ? "active" : ""}`}>
          <b>1</b> GET /api/risk/{invoiceId} → 402 Payment Required
          {step >= 1 && (
            <div className="mono sm">
              payTo {payTo.slice(0, 18)}… · price {price} CSPR · nonce {nonce}
            </div>
          )}
        </div>
        <div className={`x402-step ${step >= 2 ? "done" : step === 1 ? "active" : ""}`}>
          <b>2</b> {showcase ? "Buyer pays (simulated in showcase)" : "Buyer pays native CSPR"}
          {step >= 2 && (
            <div className="mono sm">
              {proof.startsWith("showcase") ? (
                proof
              ) : (
                <TxLink hash={proof} explorer="https://testnet.cspr.live" prefix="deploy " />
              )}
            </div>
          )}
        </div>
        <div className={`x402-step ${step >= 3 ? "done" : step === 2 ? "active" : ""}`}>
          <b>3</b> Retry with proof → verified AI risk report
        </div>
      </div>
      {report && (
        <div className="x402-report">
          risk {report.riskScore} · discount {(report.discountBps / 100).toFixed(2)}% · anchored
          hash <span className="mono">{report.decisionHash.slice(0, 22)}…</span>
        </div>
      )}
      {step === 0 && (
        <button className="btn ghost sm" disabled={busy} onClick={challenge}>
          {busy ? "…" : "Buy risk report via x402"}
        </button>
      )}
      {step === 1 && (
        <button className="btn ghost sm" disabled={busy} onClick={pay}>
          {busy ? "settling…" : `Pay ${price} CSPR & fetch report`}
        </button>
      )}
    </div>
  );
}

/** Judge Demo: a guided, self-driving walkthrough of the whole lifecycle. */
const JUDGE_STEPS: {
  actor: string;
  title: string;
  detail: string;
  /** Honest variant shown when the host runs in showcase mode. */
  showcaseDetail?: string;
}[] = [
  {
    actor: "investor",
    title: "LP deposits CSPR",
    detail:
      "Liquidity is added to the native-CSPR pool; LP shares mint at the current share price.",
  },
  {
    actor: "supplier",
    title: "Supplier submits an invoice",
    detail: "A receivable enters intake and goes straight to the autonomous underwriter.",
  },
  {
    actor: "underwriter",
    title: "AI underwriter scores risk",
    detail: "Deterministic pre-checks, then an LLM returns a risk score, a price and a rationale.",
  },
  {
    actor: "underwriter",
    title: "Casper policy checks the limits",
    detail:
      "The contract enforces risk ceiling, discount band and concentration caps — the agent cannot exceed them.",
  },
  {
    actor: "underwriter",
    title: "Contract registers the invoice",
    detail: "register_invoice writes the receivable on-chain with the decision hash.",
    showcaseDetail:
      "register_invoice semantics replayed in memory here — the seeded records link to the real testnet registrations.",
  },
  {
    actor: "underwriter",
    title: "Pool funds the supplier",
    detail:
      "fund_invoice streams the advance from the pool to the supplier account (never the debtor).",
    showcaseDetail:
      "In this showcase the advance moves in memory only; the seeded FUNDED invoices carry the real fund_invoice deploys.",
  },
  {
    actor: "underwriter",
    title: "AI decision is attested on-chain",
    detail:
      "The SHA-256 of the full decision memo is anchored — autonomous underwriting you can audit.",
    showcaseDetail:
      "Anchoring is simulated for new showcase writes; the seeded attestations are real, explorer-linkable deploys.",
  },
  {
    actor: "oracle",
    title: "Buyer purchases the risk report via x402",
    detail: "Another agent pays over HTTP 402 with native CSPR and gets the verified report.",
  },
  {
    actor: "debtor",
    title: "Debtor settles / collector writes off",
    detail:
      "On payment the pool realizes yield; past due + grace, the collector key defaults it and the loss hits the share price.",
    showcaseDetail:
      "Settlement and write-off are simulated here; the seeded SETTLED and DEFAULTED invoices link to the real transactions.",
  },
];

function JudgeDemo({ meta, onClose }: { meta: Meta | null; onClose: () => void }) {
  const [i, setI] = useState(0);
  const step = JUDGE_STEPS[i];
  const last = i === JUDGE_STEPS.length - 1;
  const live = meta?.mode === "live-testnet";
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="judge">
        <div className="judge-head">
          <div>
            <div className="judge-kicker">JUDGE DEMO · the 30-second story</div>
            <h2>
              How Faktura moves capital, safely{" "}
              <span className={`badge ${live ? "FUNDED" : "LISTED"}`}>
                {live ? "LIVE TESTNET" : "SHOWCASE"}
              </span>
            </h2>
          </div>
          <button className="judge-x" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="judge-body">
          <ol className="judge-list">
            {JUDGE_STEPS.map((s, n) => (
              <li
                key={n}
                className={n === i ? "active" : n < i ? "done" : ""}
                onClick={() => setI(n)}
              >
                <span className="jn">{n < i ? "✓" : n + 1}</span>
                <span className="jt">{s.title}</span>
                <span className="ja">{s.actor}</span>
              </li>
            ))}
          </ol>
          <div className="judge-detail">
            <div className="jd-actor">
              {ACTOR_ICON[step.actor] ?? "•"} {step.actor}
            </div>
            <h3>{step.title}</h3>
            <p>{!live && step.showcaseDetail ? step.showcaseDetail : step.detail}</p>
            {i === 3 && meta?.policy && (
              <div className="jd-policy">
                On-chain hard caps — risk ≤ {meta.policy.maxRiskScore} · discount{" "}
                {(meta.policy.minDiscountBps / 100).toFixed(1)}–
                {(meta.policy.maxDiscountBps / 100).toFixed(0)}% · invoice ≤{" "}
                {meta.policy.maxSingleInvoiceBps / 100}% of pool · debtor ≤{" "}
                {meta.policy.maxDebtorExposureBps / 100}%.
              </div>
            )}
            {i === 7 && (
              <div className="jd-policy">
                Price {meta ? (Number(meta.x402Price) / 1e9).toFixed(2) : "2.50"} CSPR · settled
                with a native transfer carrying a one-time nonce · the report carries the
                on-chain-anchored decision hash. The same surface is exposed as MCP tools.
              </div>
            )}
            <div className="jd-nav">
              <button className="btn ghost sm" disabled={i === 0} onClick={() => setI(i - 1)}>
                ← Back
              </button>
              {last ? (
                <button className="btn sm" onClick={onClose}>
                  {live ? "Explore the live desk →" : "Explore the showcase desk →"}
                </button>
              ) : (
                <button className="btn sm" onClick={() => setI(i + 1)}>
                  Next →
                </button>
              )}
            </div>
            <div className="jd-hint">
              {live
                ? "Every step below is a real Casper Testnet transaction — follow the tx links in the pipeline and activity feed."
                : "In this showcase the steps replay in memory (nothing is signed). The seeded records link to the real Casper Testnet transactions; run the stack locally in live mode to sign every step for real."}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---- Live Testnet Judge Mode: interactive runner ---------------------------

// ---- Live Testnet Judge Mode: guided, step-by-step full-page experience -----

const STEP_ICON: Record<JudgeStep["status"], string> = {
  locked: "○",
  ready: "▶",
  running: "…",
  done: "✓",
  reverted: "✓",
  failed: "✕",
};

function JudgeHealthBar({ health }: { health: JudgeHealth | null }) {
  if (!health) return null;
  return (
    <div className="lj-health">
      <span className={`live-dot ${health.rpcOk ? "green" : "amber"}`} /> RPC
      <span className={`live-dot ${health.contractOk ? "green" : "amber"}`} /> contract
      <span className="lj-hsep">·</span>
      {Object.keys(health.balances).map((k) => {
        const bal = health.balances[k];
        const low = health.low.includes(k);
        return (
          <span key={k} className="lj-bal" title={`${k} key balance`}>
            <span className={`live-dot ${bal == null || low ? "amber" : "green"}`} />
            {k} {bal == null ? "—" : bal.toFixed(0)}
          </span>
        );
      })}
    </div>
  );
}

/** One row in the guided stepper. The current (ready) step carries the action button. */
/** Counts up mm:ss from a client-side start time (chain-step finality feedback). */
function ElapsedTimer({ startTs }: { startTs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const s = Math.max(0, Math.floor((now - startTs) / 1000));
  return (
    <span className="lj-timer">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

function GuidedStep({
  step,
  index,
  isCurrent,
  onRun,
  running,
  runStartTs,
}: {
  step: JudgeStep;
  index: number;
  isCurrent: boolean;
  onRun: () => void;
  running: boolean;
  runStartTs: number;
}) {
  const done = step.status === "done" || step.status === "reverted";
  const isAi = step.kind === "compute";
  return (
    <div
      className={`lj-step ${step.status} ${isCurrent ? "current" : ""} ${running ? "busy" : ""}`}
    >
      <div className="lj-step-rail">
        <span
          className={`lj-node ${step.status} ${running ? "busy" : ""} ${running && isAi ? "ai" : ""}`}
        >
          {running ? (isAi ? "AI" : "") : STEP_ICON[step.status]}
        </span>
      </div>
      <div className="lj-step-body">
        <div className="lj-step-head">
          <span className="lj-step-n">STEP {index + 1}</span>
          <span className={`lj-step-actor ${isAi ? "ai" : ""}`}>
            {ACTOR_ICON[step.actor] ?? "•"} {step.actor}
          </span>
          {step.kind === "chain" ? (
            <span className="lj-badge-chain">on-chain tx</span>
          ) : (
            <span className="lj-badge-instant">AI · instant · no gas</span>
          )}
        </div>
        <h3 className="lj-step-title">{step.title}</h3>

        {(step.status === "locked" || (step.status === "ready" && !running)) && (
          <p className="lj-step-what">{step.what}</p>
        )}

        {/* Running feedback — a prominent AI indicator for the model step,
            a live finality timer for on-chain steps. */}
        {running && isAi && (
          <div className="lj-ai-working">
            <span className="lj-ai-orb">AI</span>
            <div className="lj-ai-text">
              The autonomous underwriter is scoring &amp; pricing the invoice…
              <span className="lj-ai-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
        {running && !isAi && (
          <div className="lj-signing">
            <div className="lj-signing-top">
              <span className="lj-spinner" /> Signing on Casper Testnet…
              <ElapsedTimer startTs={runStartTs} />
            </div>
            <div className="lj-wait-bar">
              <span className="lj-wait-fill" />
            </div>
            <span className="lj-run-hint">
              One real transaction · finality usually 30–120 s · keep this open
            </span>
          </div>
        )}

        {step.result && !running && (
          <div className={`lj-step-result ${step.status}`}>
            {step.status === "reverted" ? "⛔ " : done ? "✓ " : ""}
            {step.result}
          </div>
        )}
        {step.txHash && !running && (
          <a className="lj-step-tx" target="_blank" rel="noreferrer" href={step.explorerUrl}>
            {step.txHash.slice(0, 16)}… — verify on CSPR.live ↗
          </a>
        )}

        {isCurrent && step.status === "ready" && !running && (
          <div className="lj-step-run">
            <button className="lj-run-btn" onClick={onRun}>
              ▶ {step.action}
            </button>
            <span className="lj-run-hint">
              {step.kind === "chain"
                ? "Signs one real transaction · ~30–120 s for finality"
                : "Runs the AI model · a couple of seconds, no gas"}
            </span>
          </div>
        )}

        {(done || (isCurrent && !running)) && (step.who || step.why) && (
          <details className="lj-step-more">
            <summary>Who signs · why it matters</summary>
            {step.who && (
              <div>
                <b>Who</b> {step.who}
              </div>
            )}
            {step.why && (
              <div>
                <b>Why</b> {step.why}
              </div>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

function JudgeGuided({
  health,
  onHealth,
  onClose,
}: {
  health: JudgeHealth | null;
  onHealth: (h: JudgeHealth | null) => void;
  onClose: () => void;
}) {
  const [presets, setPresets] = useState<JudgePreset[]>([]);
  const [session, setSession] = useState<JudgeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runStartTs, setRunStartTs] = useState(0);

  useEffect(() => {
    judge
      .presets()
      .then(setPresets)
      .catch(() => {});
    // Resume an in-progress walkthrough after a refresh instead of stranding it.
    judge
      .health()
      .then((h) => {
        onHealth(h);
        if (h.activeSession && h.activeSession.status === "active") setSession(h.activeSession);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async (preset: string) => {
    setErr(null);
    setBusy(true);
    try {
      setSession(await judge.createSession(preset));
    } catch (e) {
      setErr((e as Error).message);
      judge
        .health()
        .then(onHealth)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const runNext = async () => {
    if (!session) return;
    setErr(null);
    setRunStartTs(Date.now());
    setBusy(true);
    try {
      const updated = await judge.nextStep(session.id);
      setSession(updated);
      if (updated.status !== "active")
        judge
          .health()
          .then(onHealth)
          .catch(() => {});
    } catch (e) {
      setErr((e as Error).message);
      // refresh session state (the step may have been marked failed server-side)
      judge
        .getSession(session.id)
        .then(setSession)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setSession(null);
    setErr(null);
    judge
      .health()
      .then(onHealth)
      .catch(() => {});
  };

  const paused = health?.paused;
  const doneCount = session
    ? session.steps.filter((s) => s.status === "done" || s.status === "reverted").length
    : 0;

  return (
    <div className="lj-page">
      <header className="lj-top">
        <div className="lj-brand">
          FAKTU<em>RA</em> <span className="lj-live">● LIVE TESTNET JUDGE MODE</span>
        </div>
        <button className="lj-close" onClick={onClose}>
          ✕ close
        </button>
      </header>

      <JudgeHealthBar health={health} />

      {paused && (
        <div className="lj-paused">
          Live judge mode is temporarily paused — a testnet key needs a top-up or the node is
          unreachable. The safe showcase remains fully available.
        </div>
      )}

      {!session && (
        <div className="lj-intro">
          <h1>Run the real workflow, one step at a time.</h1>
          <p>
            Pick a walkthrough. You'll trigger each step yourself — every on-chain step signs a{" "}
            <b>real Casper Testnet transaction</b> and shows its explorer link the moment it
            confirms, then the next step unlocks. No long waits between clicks.
          </p>
          <div className="lj-presets">
            {presets.map((p) => (
              <button
                key={p.id}
                className={`lj-preset ${p.id === "policy-block" ? "ace" : ""}`}
                disabled={paused || busy}
                onClick={() => start(p.id)}
              >
                <div className="lj-preset-title">{p.title}</div>
                <div className="lj-preset-sub">{p.subtitle}</div>
                <div className="lj-preset-meta">
                  {p.steps.length} steps · {p.steps.filter((s) => s.kind === "chain").length}{" "}
                  transactions
                  {p.id === "policy-block" && <span className="lj-ace-tag">the ace</span>}
                </div>
              </button>
            ))}
          </div>
          {err && <div className="lj-err">{err}</div>}
        </div>
      )}

      {session && (
        <div className="lj-run">
          <button className="lj-back" onClick={reset} disabled={busy}>
            ← Walkthroughs
          </button>
          <div className="lj-run-top">
            <div>
              <div className="lj-run-kicker">
                {session.id} · {session.subtitle}
              </div>
              <h1>{session.title}</h1>
            </div>
            <div className="lj-progress">
              <div className="lj-progress-count">
                {doneCount}
                <span>/{session.steps.length}</span>
              </div>
              <div className="lj-progress-label">
                {session.status === "active"
                  ? "steps done"
                  : session.status === "done"
                    ? "complete"
                    : "stopped"}
              </div>
            </div>
          </div>

          {session.note && <div className="lj-note">{session.note}</div>}

          <div className="lj-steps">
            {session.steps.map((s, i) => (
              <GuidedStep
                key={s.key}
                step={s}
                index={i}
                isCurrent={i === session.cursor && session.status === "active"}
                onRun={runNext}
                running={busy && i === session.cursor}
                runStartTs={runStartTs}
              />
            ))}
          </div>

          {err && <div className="lj-err">{err}</div>}

          {session.status === "done" && (
            <div className="lj-finish">
              <div className="lj-finish-head">
                ✓ Walkthrough complete — every step above is a real Casper Testnet transaction you
                can open on CSPR.live.
              </div>
              {session.poolAfter && (
                <div className="lj-finish-pool">
                  Pool now: liquid <b>{session.poolAfter.liquid}</b> · deployed{" "}
                  <b>{session.poolAfter.deployed}</b> · settled{" "}
                  <b>{session.poolAfter.totalSettled}</b> CSPR ·{" "}
                  <b>{session.poolAfter.invoiceCount}</b> invoices
                </div>
              )}
              <button className="lj-run-btn ghost" onClick={reset}>
                Run another walkthrough →
              </button>
            </div>
          )}
          {session.status === "failed" && (
            <div className="lj-finish">
              <div className="lj-finish-head fail">
                This run stopped early. You can start a fresh walkthrough.
              </div>
              <button className="lj-run-btn ghost" onClick={reset}>
                ← Back to walkthroughs
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Least-privilege agent / account map. */
function AgentRoles() {
  const rows = [
    ["Underwriter agent", "AI", "register · fund · attest", "#d92d2d"],
    ["Collector agent", "⏱", "mark_default only", "#c98a1b"],
    ["Supplier", "→", "receives the advance", "#0f8a5f"],
    ["Investor (LP)", "$", "deposit / withdraw", "#2456b8"],
    ["Debtor", "✓", "settles face value", "#17130d"],
    ["x402 buyer", "402", "buys the risk report", "#7a4dd0"],
  ] as const;
  return (
    <div className="panel roles">
      <div className="head">
        Agent / account map
        <span className="hint">least-privilege keys, enforced on-chain</span>
      </div>
      <div className="roles-grid">
        {rows.map(([name, icon, role, color]) => (
          <div className="role" key={name}>
            <span className="role-icon" style={{ background: color }}>
              {icon}
            </span>
            <span className="role-name">{name}</span>
            <span className="role-can">{role}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The MCP agent interface, productized: the 5 tools, quick-start commands,
 * and LIVE previews that call the same REST endpoints the MCP server wraps —
 * the JSON shown is exactly what an MCP-connected agent receives.
 */
const MCP_TOOLS = [
  {
    name: "pool_stats",
    what: "TVL, LP share price, funded/settled/defaulted totals, attestation count",
    ask: '"What\'s the state of the Faktura pool?"',
  },
  {
    name: "list_funded_invoices",
    what: "every invoice the pool is currently financing, with risk and due date",
    ask: '"Which invoices are we exposed to right now?"',
  },
  {
    name: "submit_invoice",
    what: "drives the real underwriting pipeline: AI scoring → on-chain policy → register/fund/attest",
    ask: '"Sell this €40k receivable from Aurora Retail, due in 30 days."',
  },
  {
    name: "get_risk_report",
    what: "buys the verified report via x402 (returns the 402 challenge, then the paid report)",
    ask: '"Buy the risk report for invoice #4."',
  },
  {
    name: "verify_decision_hash",
    what: "audits the AI: compares the off-chain memo hash with the on-chain anchor",
    ask: '"Prove the AI decision on invoice #4 wasn\'t rewritten."',
  },
];

function McpDrawer({
  meta,
  notify,
  onClose,
}: {
  meta: Meta | null;
  notify: (m: string) => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<{ tool: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Every command below is verified end-to-end from a fresh clone.
  const setupCmd =
    "git clone https://github.com/a252937166/faktura-casper && cd faktura-casper/agents && npm install";
  const quick = `FAKTURA_API=${window.location.origin} npm run mcp`;
  const claudeCmd = `claude mcp add faktura -e FAKTURA_API=${window.location.origin} -- npx tsx src/mcp.ts`;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify("Command copied");
    } catch {
      notify("Copy failed — select the text manually");
    }
  };

  // Real previews: same REST calls the MCP server wraps (read-only).
  const previewPool = async () => {
    setBusy(true);
    try {
      const p = await api.pool();
      const s = p.stats;
      const cspr = (m: string) => Number(BigInt(m) / 1_000_000n) / 1000;
      // Field-for-field identical to the pool_stats tool in agents/src/mcp.ts.
      const body = {
        contract: p.contract,
        explorer: `${p.explorer}/contract-package/${p.contract.replace("hash-", "")}`,
        tvlCspr: cspr(s.liquid) + cspr(s.deployed),
        liquidCspr: cspr(s.liquid),
        deployedCspr: cspr(s.deployed),
        lpSharePrice:
          BigInt(s.totalShares) > 0n
            ? Number(((BigInt(s.liquid) + BigInt(s.deployed)) * 10_000n) / BigInt(s.totalShares)) /
              10_000
            : 1,
        totalFundedCspr: cspr(s.totalFunded),
        totalSettledCspr: cspr(s.totalSettled),
        totalDefaultedCspr: cspr(s.totalDefaulted),
        invoiceCount: s.invoiceCount,
        aiAttestationsOnChain: s.attestationCount,
      };
      setPreview({ tool: "pool_stats", body: JSON.stringify(body, null, 2) });
    } finally {
      setBusy(false);
    }
  };
  const previewVerify = async () => {
    setBusy(true);
    try {
      const [inv, p] = await Promise.all([api.invoices(), api.pool()]);
      const withDecision = inv.filter((r) => r.decision && r.id > 0);
      const onchainById = new Map(p.onchain.map((o: { id: number }) => [o.id, o]));
      const target = withDecision.find((r) => onchainById.has(r.id));
      if (!target) {
        setPreview({ tool: "verify_decision_hash", body: '{ "error": "no verifiable invoice" }' });
        return;
      }
      const onchain = onchainById.get(target.id) as unknown as { decisionHash: string };
      const match = target.decision!.decisionHash === onchain.decisionHash;
      setPreview({
        tool: `verify_decision_hash (#${target.id})`,
        body: JSON.stringify(
          {
            invoiceId: target.id,
            offchainMemoHash: target.decision!.decisionHash,
            onchainAnchoredHash: onchain.decisionHash,
            match,
            verdict: match
              ? "MATCH — the memo the AI produced is exactly what was anchored on-chain"
              : "MISMATCH",
            registerTx:
              target.chain.registerHash && !isSimulatedHash(target.chain.registerHash)
                ? `${p.explorer}/deploy/${target.chain.registerHash}`
                : undefined,
          },
          null,
          2,
        ),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer mcp-drawer">
        <h2>
          MCP Agent Interface{" "}
          <span className={`badge ${meta?.mode === "live-testnet" ? "FUNDED" : "LISTED"}`}>
            {meta?.mode === "live-testnet" ? "LIVE TESTNET" : "SHOWCASE"}
          </span>
        </h2>
        <div className="muted" style={{ fontSize: 13 }}>
          Faktura exposes the whole credit desk as 5 MCP tools over stdio — any MCP-capable agent
          can inspect the pool, submit invoices, buy x402 risk reports, and verify AI decisions
          against Casper.
        </div>

        <div className="section">
          <h3>Quick start</h3>
          <div className="mcp-step">1 · one-time setup</div>
          <div className="mcp-cmd">
            <code>{setupCmd}</code>
            <button className="btn ghost sm" onClick={() => copy(setupCmd)}>
              Copy
            </button>
          </div>
          <div className="mcp-step">2 · speak MCP to this host (from agents/)</div>
          <div className="mcp-cmd">
            <code>{quick}</code>
            <button className="btn ghost sm" onClick={() => copy(quick)}>
              Copy
            </button>
          </div>
          <div className="mcp-step">3 · or register it with Claude Code (from agents/)</div>
          <div className="mcp-cmd">
            <code>{claudeCmd}</code>
            <button className="btn ghost sm" onClick={() => copy(claudeCmd)}>
              Copy
            </button>
          </div>
          <div className="note" style={{ marginTop: 6 }}>
            POSIX shell (macOS / Linux / WSL) · defined in{" "}
            <span className="mono">agents/src/mcp.ts</span> · works against this host or a local
            live-mode stack.
          </div>
        </div>

        <div className="section">
          <h3>The 5 tools</h3>
          {MCP_TOOLS.map((t, i) => (
            <div className="mcp-tool" key={t.name}>
              <div className="mcp-tool-head">
                <b className="mono">
                  {i + 1}. {t.name}
                </b>
              </div>
              <div className="mcp-tool-what">{t.what}</div>
              <div className="mcp-tool-ask">agent prompt: {t.ask}</div>
            </div>
          ))}
        </div>

        <div className="section">
          <h3>Tool output preview (read-only)</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn ghost sm" disabled={busy} onClick={previewPool}>
              ▸ pool_stats
            </button>
            <button className="btn ghost sm" disabled={busy} onClick={previewVerify}>
              ▸ verify_decision_hash
            </button>
          </div>
          {preview && (
            <div className="mcp-preview">
              <div className="mcp-preview-head">
                {preview.tool} → the same fields the MCP tool returns:
              </div>
              <pre>{preview.body}</pre>
            </div>
          )}
          {!preview && (
            <div className="note" style={{ marginTop: 8 }}>
              These previews call the same REST endpoints the MCP server wraps
              {meta?.mode !== "live-testnet" ? " (seeded showcase data)" : ""}.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
