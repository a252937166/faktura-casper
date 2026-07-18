import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  API_BASE,
  isSimulatedHash,
  judge,
  motesToCspr,
  rememberJudgeToken,
  stateName,
  type ApiError,
  type ChainStats,
  type DecisionCard,
  type FeedEvent,
  type InvoiceRecord,
  type JudgeHealth,
  type JudgePreset,
  type JudgeSession,
  type JudgeStep,
  type Meta,
  type PoolResponse,
  type RecentRun,
  type RiskReport,
} from "./api";
import {
  clickAccount,
  connectWallet,
  disconnectWallet,
  initWallet,
  registerClickBridge,
  shortKey,
  type WalletState,
} from "./wallet";
import { ClickUI, CsprClickThemes, ThemeModeType, useClickRef } from "@make-software/csprclick-ui";
import { ThemeProvider as ClickThemeProvider } from "styled-components";
import { EVIDENCE } from "./evidence";

/**
 * Bridges CSPR.click into the wallet module: account events feed the shared
 * WalletState, and connect/disconnect route through the SDK while it's alive.
 * ClickUI must be MOUNTED for the sign-in dialog to exist (it hosts the
 * modal), but we don't want its top bar — so it renders off-screen while the
 * modal portals to <body>. Unmount deregisters; the extension fallback stays.
 */
function ClickBridge() {
  const clickRef = useClickRef();
  useEffect(() => {
    if (!clickRef) return;
    const onIn = (evt: { account?: { public_key?: string } }) =>
      clickAccount(evt?.account?.public_key ?? null);
    const onOut = () => clickAccount(null);
    clickRef.on("csprclick:signed_in", onIn);
    clickRef.on("csprclick:switched_account", onIn);
    clickRef.on("csprclick:signed_out", onOut);
    clickRef.on("csprclick:disconnected", onOut);
    // An unregistered appId 401s and the SDK never injects its iframe. Only
    // hand connect/disconnect over once the SDK PROVES alive (iframe present
    // or the loaded event fires) — otherwise the extension fallback keeps
    // the connect button working instead of dying silently.
    let registered = false;
    const register = () => {
      if (registered) return;
      registered = true;
      registerClickBridge({
        signIn: () => clickRef.signIn(),
        signOut: () => clickRef.signOut(),
      });
      clickRef
        .getActiveAccountAsync?.()
        .then((a) => a?.public_key && clickAccount(a.public_key))
        .catch(() => {});
    };
    if (document.querySelector("iframe[src*='cspr.click']")) register();
    else clickRef.on("csprclick:loaded", register);
    return () => {
      if (registered) registerClickBridge(null);
      clickRef.off("csprclick:loaded", register);
      clickRef.off("csprclick:signed_in", onIn);
      clickRef.off("csprclick:switched_account", onIn);
      clickRef.off("csprclick:signed_out", onOut);
      clickRef.off("csprclick:disconnected", onOut);
    };
  }, [clickRef]);
  return (
    <div className="csprclick-host" aria-hidden>
      <ClickThemeProvider theme={CsprClickThemes.light}>
        <ClickUI themeMode={ThemeModeType.light} rootAppElement="#root" />
      </ClickThemeProvider>
    </div>
  );
}

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

/**
 * The OFFICIAL Casper Network wordmark (red RGB variant from casper.network),
 * served from /public so the brand reads exactly as Casper draws it — the
 * homepage highlights the chain, not our imitation of it.
 */
function CasperWordmark({ height = 18 }: { height?: number }) {
  return (
    <img
      className="casper-wordmark"
      src="/casper-wordmark-red.png"
      alt="Casper"
      style={{ height }}
    />
  );
}

/**
 * The header wallet chip, grown up: clicking it opens a small wallet menu
 * (copy address, refresh balance, explorer account view, faucet, disconnect)
 * instead of instantly disconnecting — the read-only promise stays: the site
 * only ever holds the PUBLIC key.
 */
function WalletChip({
  wallet,
  bal,
  onBal,
}: {
  wallet: WalletState;
  bal: number | null;
  onBal: (b: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!wallet.connected || !wallet.publicKey) {
    return (
      <button
        className="wallet-btn"
        title={
          wallet.available
            ? "Connect your Casper Wallet — the desk can pay advances to YOUR address"
            : "Get the Casper Wallet extension"
        }
        onClick={() => void connectWallet()}
      >
        ⛓ {wallet.available ? "CONNECT WALLET" : "GET CASPER WALLET"}
      </button>
    );
  }

  const pk = wallet.publicKey;
  const refresh = async () => {
    setRefreshing(true);
    try {
      onBal((await judge.balance(pk)).cspr);
    } catch {
      /* keep the last reading — the chip is informational */
    } finally {
      setRefreshing(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pk);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the key is visible to select manually */
    }
  };

  return (
    <div className="wallet-wrap" ref={boxRef}>
      <button
        className="wallet-btn on"
        title="Connected Casper Wallet — open the wallet menu"
        onClick={() => setOpen(!open)}
      >
        <span className="wallet-dot" />
        {shortKey(pk)}
        {bal != null && <span className="wallet-bal">{bal.toFixed(0)} CSPR</span>}
        <span className="wallet-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="wallet-menu">
          <div className="wm-head">
            <span className="wallet-dot" /> CONNECTED · CASPER WALLET
          </div>
          <div className="wm-row">
            <span className="wm-key mono" title={pk}>
              {pk.slice(0, 12)}…{pk.slice(-8)}
            </span>
            <button className="wm-mini" onClick={() => void copy()}>
              {copied ? "COPIED ✓" : "COPY"}
            </button>
          </div>
          <div className="wm-row">
            <span className="wm-lbl">Balance</span>
            <b className="mono">{bal != null ? `${bal.toFixed(2)} CSPR` : "—"}</b>
            <button className="wm-mini" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? "…" : "↻ REFRESH"}
            </button>
          </div>
          <div className="wm-note">
            Read from Casper <b>Testnet</b>. If your extension shows a different number, switch its
            network to Testnet. Connection is read-only — this site never asks for a signature.
          </div>
          <a
            className="wm-link"
            target="_blank"
            rel="noreferrer"
            href={`https://testnet.cspr.live/account/${pk}`}
          >
            ↗ Account &amp; transactions on CSPR.live
          </a>
          <a
            className="wm-link"
            target="_blank"
            rel="noreferrer"
            href="https://testnet.cspr.live/tools/faucet"
          >
            ↗ Get testnet CSPR (faucet)
          </a>
          <button
            className="wm-link danger"
            onClick={() => {
              setOpen(false);
              void disconnectWallet();
            }}
          >
            ⏏ Disconnect wallet
          </button>
        </div>
      )}
    </div>
  );
}

const riskColor = (r: number) => (r <= 30 ? "#0f8a5f" : r <= 55 ? "#c98a1b" : "#d92d2d");

/**
 * The hero invoice is a STATE MACHINE, not a prop: it loops the two real
 * endings (funded / blocked-by-contract) with numbers that mirror the live
 * walkthrough — a 2 CSPR happy-path face and an above-the-cap policy-block
 * face — so the story on the right is the same story a judge can trigger.
 */
const HERO_RUNS = [
  {
    variant: "funded" as const,
    supplier: "Nordwind Logistics",
    face: "2 CSPR",
    advance: "1.96 CSPR",
    risk: "28 / 100",
    phases: ["WAITING", "AI REVIEWING", "AI APPROVED", "POLICY CHECK", "FUNDED", "SETTLED"],
  },
  {
    variant: "blocked" as const,
    supplier: "Baltic Freight Union",
    face: "84 CSPR",
    advance: "82.3 CSPR",
    risk: "31 / 100",
    phases: ["WAITING", "AI REVIEWING", "AI APPROVED", "POLICY CHECK", "BLOCKED"],
  },
];

function HeroInvoice() {
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const r = HERO_RUNS[run];
    const last = phase >= r.phases.length - 1;
    const t = setTimeout(
      () => {
        if (last) {
          setRun((run + 1) % HERO_RUNS.length);
          setPhase(0);
        } else setPhase(phase + 1);
      },
      last ? 3400 : 1500,
    );
    return () => clearTimeout(t);
  }, [run, phase]);
  const r = HERO_RUNS[run];
  const label = r.phases[phase];
  const scored = phase >= 2;
  const approved = phase >= 2;
  const funded = r.variant === "funded" && phase >= 4;
  const settled = r.variant === "funded" && phase >= 5;
  const blocked = r.variant === "blocked" && phase >= 4;
  return (
    <div className="doc-wrap" aria-hidden>
      <div className={`doc ${blocked ? "doc-blocked" : ""}`}>
        <header>
          INVOICE <span>№ 2026-0{347 + run}</span>
        </header>
        <div className="doc-row">
          <span>Supplier</span>
          <b>{r.supplier}</b>
        </div>
        <div className="doc-row">
          <span>Debtor</span>
          <b>Aurora Retail AG</b>
        </div>
        <div className="doc-row">
          <span>Risk score</span>
          <b className="r-red">{scored ? r.risk : "…"}</b>
        </div>
        <div className="doc-row">
          <span>Discount</span>
          <b>{scored ? "2.00%" : "…"}</b>
        </div>
        <div className="doc-row">
          <span>Single-invoice cap</span>
          <b className={blocked ? "doc-bad" : ""}>
            {r.variant === "blocked" ? (phase >= 3 ? "EXCEEDED" : "checking…") : "within limits"}
          </b>
        </div>
        <div className="doc-total">
          <span>ADVANCE</span>
          <b>{scored ? r.advance : "…"}</b>
        </div>
        <div className={`doc-status ${blocked ? "bad" : settled || funded ? "good" : ""}`}>
          <i className="doc-status-dot" />
          {label === "BLOCKED" ? "BLOCKED — User error: 15" : label}
        </div>
      </div>
      {approved && <div className="stamp s1">AI APPROVED</div>}
      {(funded || settled) && <div className="stamp s2">{settled ? "SETTLED" : "FUNDED"}</div>}
      {blocked && <div className="stamp s2 blocked">BLOCKED BY CONTRACT</div>}
      <div className="doc-caption">
        Illustrative loop — the guided walkthrough runs both endings with real transactions.
      </div>
    </div>
  );
}

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
  const [runnerPreset, setRunnerPreset] = useState<string | null>(null);
  const openRunner = (preset?: string) => {
    setRunnerPreset(preset ?? null);
    setRunnerOpen(true);
  };
  const [jhealth, setJhealth] = useState<JudgeHealth | null>(null);
  const [judgeProbed, setJudgeProbed] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  /** Full desk is collapsed by default — the homepage is a story, not a dashboard. */
  const [deskOpen, setDeskOpen] = useState(false);
  const [recent, setRecent] = useState<RecentRun[]>([]);
  const fetchRecent = () =>
    judge
      .recent()
      .then((r) => setRecent(r.runs))
      .catch(() => {});
  const [wallet, setWallet] = useState<WalletState>({
    available: false,
    connected: false,
    publicKey: null,
    error: null,
  });
  const [walletBal, setWalletBal] = useState<number | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => initWallet(setWallet), []);
  useEffect(() => {
    if (!wallet.publicKey) {
      setWalletBal(null);
      return;
    }
    judge
      .balance(wallet.publicKey)
      .then((b) => setWalletBal(b.cspr))
      .catch(() => setWalletBal(null));
  }, [wallet.publicKey, runnerOpen]);

  // Detect the live judge backend (:4034 behind /api/judge). Its presence flips
  // the hero to the real-testnet path; absence gracefully keeps the showcase.
  const probeJudge = () =>
    judge
      .health()
      .then((h) => {
        setJhealth(h);
        fetchRecent();
      })
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
        <a
          href="/"
          className="site-logo-link"
          title="Faktura — autonomous invoice financing on Casper"
        >
          <img
            className="site-logo"
            src="/faktura-logo.png"
            alt="Faktura — autonomous invoice financing protocol on chain"
          />
        </a>
        <div className="spacer" />
        <WalletChip wallet={wallet} bal={walletBal} onBal={setWalletBal} />
        {meta?.mcp && (
          <button
            className="chip chip-btn"
            title="Open the MCP agent interface — 5 tools, quick-start commands, live previews"
            onClick={() => setMcpOpen(true)}
          >
            MCP · 5 tools ▾
          </button>
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
        <div className={`desk-status ${liveJudge ? "live" : meta.mode}`}>
          <div className="desk-status-main">
            {liveJudge ? (
              <>
                <span className="ds-pill live">
                  <i /> LIVE DESK ONLINE
                </span>
                <span className="ds-text">
                  Trigger <b>real, agent-signed Casper transactions</b> in the{" "}
                  <button className="linklike" onClick={() => openRunner()}>
                    guided walkthrough
                  </button>
                  {" — "}this page below is the safe showcase (simulated writes, real proof).
                </span>
              </>
            ) : meta.mode === "showcase" ? (
              <>
                <span className="ds-pill showcase">SHOWCASE</span>
                <span className="ds-text">
                  Reads come from a captured snapshot of the <b>real testnet contract</b>; the AI
                  underwriter runs live; writes are simulated — nothing here pretends to be signed.
                </span>
              </>
            ) : (
              <>
                <span className="ds-pill live">
                  <i /> LIVE TESTNET
                </span>
                <span className="ds-text">
                  Every action on this page is a <b>real Casper transaction</b> signed by the agent
                  keys.
                </span>
              </>
            )}
          </div>
          <div className="ds-tools">
            {pool && (
              <details className="ds-more">
                <summary>Casper proof</summary>
                <div className="ds-more-body">
                  <ProofStrip pool={pool} invoices={invoices} meta={meta} />
                </div>
              </details>
            )}
            {meta.policy && (
              <details className="ds-more">
                <summary>Rules of the desk</summary>
                <div className="ds-more-body">
                  On-chain hard caps — risk ≤ {meta.policy.maxRiskScore} · discount{" "}
                  {(meta.policy.minDiscountBps / 100).toFixed(1)}–
                  {(meta.policy.maxDiscountBps / 100).toFixed(0)}% · single invoice ≤{" "}
                  {(meta.policy.maxSingleInvoiceBps / 100).toFixed(0)}% of pool · per debtor ≤{" "}
                  {(meta.policy.maxDebtorExposureBps / 100).toFixed(0)}%.
                  {meta.prefilter && (
                    <>
                      {" "}
                      The agent pre-filters stricter (risk ≤ {meta.prefilter.maxRiskScore}) to save
                      gas; <b>the contract is the final authority</b>.
                    </>
                  )}
                </div>
              </details>
            )}
          </div>
        </div>
      )}

      <section className="hero">
        <div>
          <h1>
            AI underwrites.
            <br />
            Casper decides. <span className="accent">Suppliers get paid.</span>
          </h1>
          <p className="hero-sub">
            Faktura turns unpaid invoices into working capital. An autonomous AI agent evaluates the
            receivable, a <span className="casper-word">Casper</span> contract enforces the risk
            limits, and a native-CSPR pool pays the supplier. Every decision stays verifiable.
          </p>
          <p className="hero-tagline">
            An AI can approve the invoice. <b>Only Casper can move the money.</b>
          </p>
          <div className="hero-cta">
            {liveJudge ? (
              <>
                <button className="btn-primary" onClick={() => openRunner("happy")}>
                  ▶ Use the real AI desk
                </button>
                <button className="btn-outline" onClick={() => openRunner("policy-block")}>
                  ⛔ Watch the AI get blocked
                </button>
              </>
            ) : (
              <button className="btn-primary" onClick={() => setJudgeOpen(true)}>
                ▶ RUN JUDGE DEMO
              </button>
            )}
          </div>
          {liveJudge && (
            <p className="hero-cost">
              6 guided steps · 5 real on-chain transactions · about 4–8 minutes
            </p>
          )}
          <p className="hero-links">
            <a target="_blank" rel="noreferrer" href={EVIDENCE.evidencePackUrl}>
              View contract &amp; transaction evidence →
            </a>
            <a href={EVIDENCE.videoUrl} target="_blank" rel="noreferrer">
              Watch the 3-min demo ↗
            </a>
          </p>
          {liveJudge ? (
            <div className="hero-live">
              <span className={`live-dot ${jhealth?.paused ? "amber" : "green"}`} />
              {jhealth?.paused
                ? "Live workflow paused — the Casper node is unreachable right now; the desk preview below still works."
                : "Guided workflow: real on-chain transactions. Desk preview below: safe showcase data."}
            </div>
          ) : (
            judgeProbed && (
              <div className="hero-live">
                <span className="live-dot muted" /> Safe Showcase — no gas, writes simulated from a
                real testnet snapshot. Run the stack in live mode to sign every step.
              </div>
            )
          )}
          <a
            className="hero-builton"
            href="https://www.casper.network/"
            target="_blank"
            rel="noreferrer"
            title="Casper Network — the chain that enforces this desk's risk policy"
          >
            <span>BUILT ON</span>
            <CasperWordmark height={34} />
          </a>
          {/* Trust facts, not business metrics — TVL & share price live on the desk below. */}
          <div className="hero-metrics">
            <div className="hm-red">
              <b>5</b>
              <span>real on-chain txs per full run</span>
            </div>
            <div>
              <b>On-chain</b>
              <span>risk limits the AI cannot cross</span>
            </div>
            <div>
              <b>Read-only</b>
              <span>wallet connect — never a signature</span>
            </div>
          </div>
        </div>
        <HeroInvoice />
      </section>

      {/* ---- One invoice, two endings — the whole product in one story ---- */}
      <section className="story">
        <h2 className="section-title">One invoice. Two possible endings.</h2>
        <p className="story-lede">
          Nordwind shipped the freight; Aurora pays in 30 days. Nordwind needs the cash <i>now</i>,
          so the desk's AI reads the invoice, prices the risk and approves it. Then{" "}
          <span className="casper-word">Casper</span> decides what an approval is worth:
        </p>
        <div className="story-acts endings">
          <div className="story-act">
            <div className="story-stamp green">ENDING A · FUNDED</div>
            <h3>The policy checks pass</h3>
            <p>
              Risk ceiling, discount band, concentration caps — all within limits. The pool streams
              the advance to the supplier in one transaction, the AI memo is hash-anchored, and the
              debtor settles at maturity. The credit loop closes.
            </p>
          </div>
          <div className="story-act blocked">
            <div className="story-stamp red">ENDING B · BLOCKED</div>
            <h3>The AI approved it. Casper still said no.</h3>
            <p>
              The same valid agent key submits an invoice above the single-invoice cap — and the
              contract reverts the funding with{" "}
              <span className="mono-sm">User error: 15 (SingleInvoiceCapExceeded)</span>.
              Autonomous, but never unbounded.
            </p>
            <div className="story-links">
              <a target="_blank" rel="noreferrer" href={EVIDENCE.policyRevertTxUrl}>
                Open a real reverted transaction ↗
              </a>
              {liveJudge && (
                <button className="linklike" onClick={() => openRunner("policy-block")}>
                  Reproduce it live →
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ---- Latest real run — a receipt, not a metric ---- */}
      {liveJudge && recent.length > 0 && (
        <LatestRunReceipt runs={recent} onOpen={() => openRunner()} />
      )}

      {/* ---- Capabilities, each backed by something real ---- */}
      <section className="caps">
        <h2 className="section-title">What makes it different</h2>
        <div className="caps-grid">
          <div className="cap">
            <h3>⛔ AI proposes, contract disposes</h3>
            <p>
              The on-chain policy is the final authority: an AI-approved invoice above the
              concentration cap gets <b>rejected by the contract itself</b> — watch a real revert (
              <span className="mono-sm">User error: 15</span>) in the walkthrough.
            </p>
          </div>
          <div className="cap">
            <h3>💸 Get paid to your own wallet</h3>
            <p>
              Connect Casper Wallet and the desk pays the invoice advance to <b>your address</b> on
              the real chain. Read-only — we ask for a public key, never a signature.
            </p>
          </div>
          <div className="cap">
            <h3>🤝 Machine-payable risk data (x402)</h3>
            <p>
              Another agent buys the verified risk report over <b>HTTP 402</b>, settling with a
              native CSPR transfer — the agent economy, working end to end.
            </p>
          </div>
          <div className="cap">
            <h3>🔑 Five keys, least privilege</h3>
            <p>
              Underwriter, collector, supplier, LP and debtor each hold their own key. The
              underwriter cannot write off defaults; the collector can do <i>only</i> that.
            </p>
          </div>
        </div>
      </section>

      {/* ---- Run it yourself ---- */}
      {liveJudge && (
        <section className="runit">
          <div className="runit-card">
            <div>
              <h2>Don't take our word for it. Trigger it yourself. Verify every transaction.</h2>
              <p>
                Four guided walkthroughs — the full lifecycle, the policy firewall, an x402 purchase
                where the buyer acts on the report, and a default workout. One click per step, one
                real agent-signed Casper transaction per click, explorer links as they confirm. Your
                wallet never signs anything.
              </p>
            </div>
            <button className="btn-primary big" onClick={() => openRunner()}>
              ▶ USE THE REAL AI DESK
            </button>
          </div>
        </section>
      )}

      {/* ---- The live desk (book & controls) ---- */}
      <section className="desk-head" id="desk">
        <h2 className="section-title">The desk — live book &amp; controls</h2>
        <p className="desk-head-sub">
          {meta?.mode === "showcase"
            ? "Reads come from a captured snapshot of the real testnet contract; new writes here are simulated (the guided walkthrough is the live surface)."
            : "Everything below reads and writes the live testnet contract."}
        </p>
        <button className="desk-toggle" onClick={() => setDeskOpen(!deskOpen)}>
          {deskOpen ? "▴ Collapse the full desk" : "▾ Open the full live desk"}
        </button>
      </section>

      {!deskOpen && (
        <DeskSummary
          stats={stats}
          tvl={tvl}
          sharePrice={sharePrice}
          invoices={invoices}
          events={events}
          onOpen={() => setDeskOpen(true)}
        />
      )}

      {deskOpen && (
        <>
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
              <div className="label">Pool value / share</div>
              <div className={`value ${sharePrice > 1 ? "good" : ""}`}>{sharePrice.toFixed(4)}</div>
              <div className="sub">1.0000 at genesis — yield accrues here</div>
            </div>
            <div className="stat">
              <div className="label">Lifetime advances</div>
              <div className="value accent">{fmtCspr(motesToCspr(stats?.totalFunded))} CSPR</div>
              <div className="sub">{stats?.invoiceCount ?? 0} invoices registered</div>
            </div>
            <div className="stat">
              <div className="label">Lifetime collected</div>
              <div className="value">{fmtCspr(motesToCspr(stats?.totalSettled))} CSPR</div>
              <div className="sub">face value settled by debtors</div>
            </div>
            <div className="stat">
              <div className="label">Lifetime defaults</div>
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
                      ? "every state transition is a real Casper transaction"
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
                                    (r.intake.amountCspr * (10_000 - r.decision.discountBps)) /
                                      10_000,
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
                  wallet={wallet}
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
                  <span className="hint">
                    {meta?.mode === "showcase" ? "live AI · showcase writes simulated" : "live"}
                  </span>
                  <span className="right">
                    <span className="dot" />
                  </span>
                </div>
                <div className="feed" ref={feedRef}>
                  {events.length === 0 && <div className="empty">Agents idle…</div>}
                  {events.map((e, i) => {
                    // The freshest "the model is scoring…" line gets the working
                    // treatment — pulsing AI avatar + shimmer — so you can SEE the
                    // agent thinking, not just read about it.
                    const aiWorking = e.kind === "llm" && i === 0;
                    return (
                      <div
                        className={`feed-item ${e.actor === "underwriter" ? "is-ai" : ""} ${aiWorking ? "ai-working" : ""}`}
                        key={`${e.ts}-${i}`}
                      >
                        <div className={`avatar ${e.actor === "underwriter" ? "ai" : ""}`}>
                          {ACTOR_ICON[e.actor] ?? "•"}
                        </div>
                        <div className="body">
                          <div className="msg">
                            {e.message}
                            {aiWorking && (
                              <span className="lj-ai-dots">
                                <i />
                                <i />
                                <i />
                              </span>
                            )}
                          </div>
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
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

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
          wallet={wallet}
          initialPreset={runnerPreset}
          onOpenMcp={() => setMcpOpen(true)}
          onClose={() => {
            setRunnerOpen(false);
            refresh();
            fetchRecent();
          }}
        />
      )}
      <ClickBridge />
      {mcpOpen && <McpDrawer meta={meta} notify={notify} onClose={() => setMcpOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/**
 * Collapsed desk: three current numbers, the three freshest invoices and feed
 * lines — enough to prove the book is alive without turning the homepage into
 * a dashboard. The full desk is one click away.
 */
function DeskSummary({
  stats,
  tvl,
  sharePrice,
  invoices,
  events,
  onOpen,
}: {
  stats: ChainStats | undefined;
  tvl: number;
  sharePrice: number;
  invoices: InvoiceRecord[];
  events: FeedEvent[];
  onOpen: () => void;
}) {
  return (
    <section className="desk-summary">
      <div className="stats compact">
        <div className="stat">
          <div className="label">Pool TVL</div>
          <div className="value">{fmtCspr(tvl)} CSPR</div>
          <div className="sub">
            liquid {fmtCspr(motesToCspr(stats?.liquid))} · deployed{" "}
            {fmtCspr(motesToCspr(stats?.deployed))}
          </div>
        </div>
        <div className="stat">
          <div className="label">Pool value / share</div>
          <div className={`value ${sharePrice > 1 ? "good" : ""}`}>{sharePrice.toFixed(4)}</div>
          <div className="sub">1.0000 at genesis — yield accrues here</div>
        </div>
        <div className="stat">
          <div className="label">Lifetime advances</div>
          <div className="value accent">{fmtCspr(motesToCspr(stats?.totalFunded))} CSPR</div>
          <div className="sub">{stats?.invoiceCount ?? 0} invoices registered</div>
        </div>
      </div>
      <div className="desk-summary-cols">
        <div className="panel">
          <div className="head">
            Latest invoices <span className="right hint">{invoices.length} total</span>
          </div>
          {invoices.slice(0, 3).map((r) => (
            <div className="dsum-row" key={r.intakeId}>
              <span className="mono">{r.intake.invoiceNumber}</span>
              <span className="dsum-names">
                {r.intake.supplierName} <span className="muted">→</span> {r.intake.debtorName}
              </span>
              <span className="mono num">{fmtCspr(r.intake.amountCspr)} CSPR</span>
              <span className={`badge ${r.status}`}>{r.status.toUpperCase()}</span>
            </div>
          ))}
          {invoices.length === 0 && <div className="empty">No invoices yet.</div>}
        </div>
        <div className="panel">
          <div className="head">
            Agent activity <span className="right hint">latest 3</span>
          </div>
          {events.slice(0, 3).map((e, i) => (
            <div className="dsum-row feedish" key={`${e.ts}-${i}`}>
              <span className="dsum-actor">{e.actor}</span>
              <span className="dsum-msg">{e.message}</span>
              <span className="muted">{timeAgo(e.ts)}</span>
            </div>
          ))}
          {events.length === 0 && <div className="empty">Agents idle…</div>}
        </div>
      </div>
      <button className="desk-toggle big" onClick={onOpen}>
        ▾ Open the full live desk — full book, LP actions, custom intake, agent roles &amp; feed
      </button>
    </section>
  );
}

/**
 * The receipt of the LAST completed real walkthrough — persisted server-side.
 * More convincing than any static metric: it names the run, lists every step
 * and links every transaction.
 */
function LatestRunReceipt({ runs, onOpen }: { runs: RecentRun[]; onOpen: () => void }) {
  const run = runs[0];
  if (!run) return null;
  const txs = run.steps.filter((s) => s.txHash);
  return (
    <section className="latest-run">
      <div className="latest-run-card">
        <div className="latest-run-head">
          <span className="latest-run-kicker">LATEST LIVE RUN</span>
          <span className="latest-run-id mono">{run.displayId}</span>
          <span className="latest-run-when">{timeAgo(run.endedTs)}</span>
        </div>
        <div className="latest-run-steps">
          {run.steps.map((s) => (
            <div className="latest-run-step" key={s.key}>
              <span className={`lr-mark ${s.status}`}>
                {s.status === "reverted" ? "⛔" : s.status === "done" ? "✓" : "•"}
              </span>
              <span className="lr-title">{s.title}</span>
              {s.txHash && (
                <a className="lr-tx mono" target="_blank" rel="noreferrer" href={s.explorerUrl}>
                  {s.txHash.slice(0, 8)}… ↗
                </a>
              )}
            </div>
          ))}
        </div>
        <div className="latest-run-foot">
          {run.wallet && (
            <span className="lr-wallet">◈ advance paid to visitor wallet {run.wallet}</span>
          )}
          <span className="lr-count">
            {txs.length} real transaction{txs.length === 1 ? "" : "s"} on CSPR.live
          </span>
          <button className="linklike" onClick={onOpen}>
            Run the next one yourself →
          </button>
        </div>
      </div>
    </section>
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

/**
 * The AI-at-work takeover shown while the underwriter scores an intake — a
 * visible, narrated "the model is thinking" moment instead of a dead button.
 */
const AI_THINKING_LINES = [
  "Reading the invoice…",
  "Weighing the debtor's payment history…",
  "Scanning for fraud patterns…",
  "Pricing the risk…",
  "Writing the decision memo…",
];

function AiThinking({ compact }: { compact?: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setI((n) => (n + 1) % AI_THINKING_LINES.length), 1400);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className={`ai-takeover ${compact ? "compact" : ""}`}>
      <span className="lj-ai-orb">AI</span>
      <div className="ai-takeover-body">
        <div className="ai-takeover-line" key={i}>
          {AI_THINKING_LINES[i]}
        </div>
        <div className="ai-scan">
          <span />
        </div>
      </div>
    </div>
  );
}

function SubmitPanel({
  supplierDefault,
  liveMode,
  wallet,
  onOpenGuided,
  onSubmitted,
}: {
  supplierDefault: string | null;
  liveMode: boolean;
  wallet: WalletState;
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

  // A connected wallet becomes the supplier automatically — the advance is
  // yours unless you type a different address.
  useEffect(() => {
    if (wallet.publicKey) {
      setForm((f) =>
        f.supplierAddress && f.supplierAddress !== wallet.publicKey
          ? f
          : { ...f, supplierAddress: wallet.publicKey! },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.publicKey]);
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
          <label>
            Supplier Casper address — receives the advance
            {wallet.connected && wallet.publicKey && form.supplierAddress === wallet.publicKey ? (
              <span className="field-wallet on"> · ◈ your connected wallet</span>
            ) : !wallet.connected ? (
              <button className="field-wallet linklike" onClick={() => void connectWallet()}>
                · connect your wallet to receive it yourself
              </button>
            ) : null}
          </label>
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
          ) : busy ? (
            <AiThinking />
          ) : (
            <>
              <button className="btn" onClick={submit}>
                Submit to underwriter
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
                  : `Submit debtor settlement on Casper (${fmtCspr(record.intake.amountCspr)} CSPR)`}
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
                ? "Every step below is a real Casper transaction — follow the tx links in the pipeline and activity feed."
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
      {health.budget && (
        <>
          <span className="lj-hsep">·</span>
          <span
            className="lj-bal"
            title="Anti-abuse budgets: daily wallet-payout CSPR and signed transactions"
          >
            budget {health.budget.spentCspr}/{health.budget.capCspr} CSPR
            {health.budget.deployCap != null &&
              ` · ${health.budget.deploysToday ?? 0}/${health.budget.deployCap} tx`}
          </span>
        </>
      )}
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

/**
 * Every walkthrough step maps to a real MCP capability. The verb matters:
 * "drive" tools EXECUTE the step from an agent; "verify"/"observe" tools audit
 * or read its effect — the hook never claims more than the tool actually does.
 */
const STEP_MCP: Record<string, { tool: string; verb: string; prompt: string }> = {
  underwrite: {
    tool: "submit_invoice",
    verb: "Your agent can drive this pipeline",
    prompt: "Submit this invoice to Faktura and tell me the AI's risk score, price and red flags.",
  },
  register: {
    tool: "submit_invoice",
    verb: "Your agent can drive this pipeline",
    prompt:
      "Submit an invoice to Faktura — the tool drives register + fund on-chain and returns the tx hashes.",
  },
  fund: {
    tool: "pool_stats",
    verb: "Your agent can verify the pool effect",
    prompt: "How much liquid capital does the Faktura pool have left after that funding?",
  },
  attest: {
    tool: "verify_decision_hash",
    verb: "Your agent can audit this anchor",
    prompt: "Verify the latest Faktura invoice's decision hash against its on-chain attestation.",
  },
  pick: {
    tool: "list_funded_invoices",
    verb: "Your agent can read the book",
    prompt: "Which invoices is the Faktura pool currently exposed to?",
  },
  x402: {
    tool: "get_risk_report",
    verb: "Your agent can buy this report",
    prompt: "Buy the x402 risk report for that funded invoice and summarise the red flags.",
  },
  settle: {
    tool: "pool_stats",
    verb: "Your agent can verify the pool effect",
    prompt: "Did the pool realise yield after that settlement? Compare TVL before and after.",
  },
  consumer: {
    tool: "verify_decision_hash",
    verb: "Your agent can audit the memo it bought",
    prompt: "Verify the purchased risk report's decision hash against the on-chain anchor.",
  },
  "pick-expired": {
    tool: "list_funded_invoices",
    verb: "Your agent can read the book",
    prompt: "Which funded Faktura invoices are past their due date?",
  },
  default: {
    tool: "pool_stats",
    verb: "Your agent can verify the loss",
    prompt: "Compare Faktura's totalDefaulted and share price before and after that write-off.",
  },
};

/**
 * Collapsed by default: the walkthrough serves judges first, developers second.
 * One quiet line advertises the capability; expanding reveals the prompt.
 */
function AgentHook({ stepKey, onOpenMcp }: { stepKey: string; onOpenMcp: () => void }) {
  const m = STEP_MCP[stepKey];
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!m) return null;
  if (!open) {
    return (
      <button className="lj-agenthook-fold" onClick={() => setOpen(true)}>
        ▸ Related MCP capability · <b>{m.tool}</b>
      </button>
    );
  }
  return (
    <div className="lj-agenthook">
      <div className="lj-agenthook-head">
        <button className="lj-agenthook-fold open" onClick={() => setOpen(false)}>
          ▾ Related MCP capability
        </button>
        <span className="lj-agenthook-badge">🤖 {m.verb}</span>
        <span className="lj-agenthook-tool">
          MCP tool: <b>{m.tool}</b>
        </span>
      </div>
      <div className="lj-agenthook-row">
        <code className="lj-agenthook-prompt">"{m.prompt}"</code>
        <button
          className="lj-agenthook-copy"
          onClick={() => {
            navigator.clipboard?.writeText(m.prompt).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? "COPIED ✓" : "COPY"}
        </button>
        <button className="lj-agenthook-open" onClick={onOpenMcp}>
          MCP interface →
        </button>
      </div>
    </div>
  );
}

/**
 * The AI's judgment made legible: verdict, price, the WHY and the red flags —
 * so the walkthrough shows an auditable credit opinion, not a black-box score.
 */
function AiDecisionCard({ d }: { d: DecisionCard }) {
  return (
    <div className={`lj-ai-decision ${d.verdict === "APPROVE" ? "ok" : "no"}`}>
      <div className="lj-aid-head">
        <span className="lj-aid-kicker">AI DECISION</span>
        <span className={`lj-aid-verdict ${d.verdict === "APPROVE" ? "ok" : "no"}`}>
          {d.verdict}
        </span>
        <span className="lj-aid-fact">
          risk <b>{d.riskScore}/100</b>
        </span>
        {d.discountBps > 0 && (
          <span className="lj-aid-fact">
            price <b>{(d.discountBps / 100).toFixed(2)}%</b>
          </span>
        )}
      </div>
      {d.rationale && (
        <p className="lj-aid-why">
          <span className="lj-aid-lbl">Why</span>
          {d.rationale}
        </p>
      )}
      <div className="lj-aid-flags">
        <span className="lj-aid-lbl">Red flags</span>
        {d.redFlags.length ? d.redFlags.join(" · ") : "none"}
      </div>
      <div className="lj-aid-hash mono" title={d.decisionHash}>
        {d.model} · {d.decisionHash.slice(0, 24)}…
      </div>
    </div>
  );
}

function GuidedStep({
  step,
  index,
  total,
  isCurrent,
  onRun,
  running,
  runStartTs,
  nextTitle,
  walletLock,
  onReconnect,
  onAbandon,
  onOpenMcp,
}: {
  step: JudgeStep;
  index: number;
  total: number;
  isCurrent: boolean;
  onRun: () => void;
  running: boolean;
  runStartTs: number;
  nextTitle?: string;
  /** Set when this session pays a wallet that is no longer connected. */
  walletLock?: string | null;
  onReconnect: () => void;
  onAbandon: () => void;
  onOpenMcp: () => void;
}) {
  const done = step.status === "done" || step.status === "reverted";
  const isAi = step.kind === "compute";

  // Completed and not-yet-reached steps render as compact rows so the CURRENT
  // step stays the single focus — you always know exactly where you are.
  if (!isCurrent) {
    return (
      <div className={`lj-row ${step.status}`}>
        <span className={`lj-node ${step.status}`}>{STEP_ICON[step.status]}</span>
        <div className="lj-row-main">
          <div className="lj-row-title">
            <span className="lj-row-n">{index + 1}</span>
            {step.title}
          </div>
          {done && step.result && <div className="lj-row-result">{step.result}</div>}
          {done && step.decision && <AiDecisionCard d={step.decision} />}
        </div>
        {done && step.txHash && (
          <a className="lj-row-tx" target="_blank" rel="noreferrer" href={step.explorerUrl}>
            {step.txHash.slice(0, 10)}… ↗
          </a>
        )}
      </div>
    );
  }

  // The current step — the expanded story card. What's happening, why it
  // matters, and what comes next are all visible, never hidden behind a toggle.
  return (
    <div className={`lj-step current ${running ? "busy" : ""} ${isAi ? "ai" : "chain"}`}>
      <div className="lj-step-rail">
        <span className={`lj-node current ${running ? "busy" : ""} ${running && isAi ? "ai" : ""}`}>
          {running ? (isAi ? "AI" : "") : String(index + 1)}
        </span>
      </div>
      <div className="lj-step-body">
        <div className="lj-step-head">
          <span className="lj-step-n">
            STEP {index + 1} <span className="lj-step-of">of {total}</span>
          </span>
          <span className={`lj-step-actor ${isAi ? "ai" : ""}`}>
            {ACTOR_ICON[step.actor] ?? "•"} {step.actor}
          </span>
          {isAi ? (
            <span className="lj-badge-instant">AI decision · instant · no gas</span>
          ) : (
            <span className="lj-badge-chain">signs 1 Casper transaction</span>
          )}
        </div>
        <h3 className="lj-step-title">{step.title}</h3>

        {/* The narrative — always visible on the active step */}
        {!running && (
          <div className="lj-story">
            <p className="lj-story-now">
              <span className="lj-story-lbl">What happens</span>
              {step.what}
            </p>
            {step.why && (
              <p className="lj-story-why">
                <span className="lj-story-lbl">Why it matters</span>
                {step.why}
              </p>
            )}
          </div>
        )}

        {/* Running feedback */}
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
              <span className="lj-spinner" /> Signing on Casper…
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

        {isCurrent && step.status === "failed" && !running && (
          <div className="lj-failbox">
            <div className="lj-failbox-title">
              ⚠ This step hit a testnet hiccup — nothing was lost.
            </div>
            {step.result && <div className="lj-failbox-err">{step.result}</div>}
            <div className="lj-relock-actions">
              <button className="lj-run-btn" onClick={onRun}>
                ↻ Retry this step
              </button>
              <button className="lj-back" onClick={onAbandon}>
                Abandon walkthrough
              </button>
            </div>
          </div>
        )}
        {step.status === "ready" && !running && walletLock && (
          <div className="lj-relock">
            <div className="lj-relock-text">
              ⚠ This walkthrough pays <b>your wallet {shortKey(walletLock)}</b>, which is no longer
              connected. Reconnect it to continue — or abandon and start a new run.
            </div>
            <div className="lj-relock-actions">
              <button className="lj-wallet-btn" onClick={onReconnect}>
                ⛓ Reconnect wallet
              </button>
              <button className="lj-back" onClick={onAbandon}>
                Abandon walkthrough
              </button>
            </div>
          </div>
        )}
        {step.status === "ready" && !running && !walletLock && (
          <div className="lj-step-run">
            <button className={`lj-run-btn ${isAi ? "ai" : ""}`} onClick={onRun}>
              {isAi ? "✦" : "▶"} {step.action}
            </button>
            {step.who && <span className="lj-run-signer">Signed by: {step.who}</span>}
          </div>
        )}

        <AgentHook stepKey={step.key} onOpenMcp={onOpenMcp} />

        {/* What's next — so the user always knows where the story is going */}
        {nextTitle && !running && (
          <div className="lj-next">
            <span className="lj-next-lbl">Up next</span> {nextTitle}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where DeFi meets the credit outcome: the pool BEFORE vs AFTER the run, with
 * the realized yield or loss and the LP share-value move — so "the pool earns
 * / absorbs" is a number, not a sentence.
 */
function PoolEconomics({
  before,
  after,
}: {
  before?: Record<string, number>;
  after: Record<string, number>;
}) {
  const share = (p?: Record<string, number>) =>
    p && p.totalShares ? (p.liquid + p.deployed) / p.totalShares : null;
  const sb = share(before);
  const sa = share(after);
  const value = (p?: Record<string, number>) => (p ? p.liquid + p.deployed : null);
  const vb = value(before);
  const va = value(after);
  const delta = vb != null && va != null ? va - vb : null;
  const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
  return (
    <div className="lj-finish-pool">
      <div className="lj-pe-kicker">POOL ECONOMICS</div>
      <div className="lj-pe-grid">
        <span className="lj-pe-lbl"></span>
        <span className="lj-pe-col">liquid</span>
        <span className="lj-pe-col">deployed</span>
        <span className="lj-pe-col">share value</span>
        {before && (
          <>
            <span className="lj-pe-lbl">before</span>
            <span className="mono">{fmt(before.liquid)}</span>
            <span className="mono">{fmt(before.deployed)}</span>
            <span className="mono">{sb ? sb.toFixed(4) : "—"}</span>
          </>
        )}
        <span className="lj-pe-lbl">after</span>
        <span className="mono">{fmt(after.liquid)}</span>
        <span className="mono">{fmt(after.deployed)}</span>
        <span className="mono">{sa ? sa.toFixed(4) : "—"}</span>
      </div>
      {delta != null && Math.abs(delta) > 0.0005 && (
        <div className={`lj-pe-delta ${delta > 0 ? "gain" : "loss"}`}>
          {delta > 0 ? "yield realized" : "credit loss absorbed by LPs"}{" "}
          <b>
            {delta > 0 ? "+" : ""}
            {fmt(delta)} CSPR
          </b>
          {sb != null && sa != null && sb !== sa && (
            <span className="lj-pe-share">
              {" "}
              · share value {sb.toFixed(4)} → {sa.toFixed(4)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function JudgeGuided({
  health,
  onHealth,
  wallet,
  initialPreset,
  onOpenMcp,
  onClose,
}: {
  health: JudgeHealth | null;
  onHealth: (h: JudgeHealth | null) => void;
  wallet: WalletState;
  /** Preset the caller wants started immediately (hero CTA deep-link). */
  initialPreset?: string | null;
  onOpenMcp: () => void;
  onClose: () => void;
}) {
  const [presets, setPresets] = useState<JudgePreset[]>([]);
  const [session, setSession] = useState<JudgeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runStartTs, setRunStartTs] = useState(0);
  /** Preset chosen while no wallet was connected — held at the wallet gate. */
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  /** An active server-side walkthrough offered for resume (never auto-entered). */
  const [resumable, setResumable] = useState<JudgeSession | null>(null);
  const explorer = health?.explorer ?? "https://testnet.cspr.live";

  useEffect(() => {
    judge
      .presets()
      .then(setPresets)
      .catch(() => {});
    // An in-progress walkthrough is OFFERED for resume on the intro — never
    // silently jumped into (a visitor who picked nothing must land on the picker).
    judge
      .health()
      .then((h) => {
        onHealth(h);
        if (h.activeSession && h.activeSession.status === "active") {
          rememberJudgeToken(h.activeSession.id, h.activeSession.token);
          setResumable(h.activeSession);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doStart = async (preset: string, supplierAddress?: string, attempt = 0) => {
    setErr(null);
    setBusy(true);
    setPendingPreset(null);
    try {
      // With a wallet connected, the desk pays the advance to THEIR address.
      setSession(await judge.createSession(preset, supplierAddress));
      setBusy(false);
    } catch (e) {
      // The server debounces rapid session creation (double-click / deep-link
      // followed by a manual click). That is a WAIT, not a failure — keep the
      // button in its busy state and retry automatically when the window opens.
      const retryAfterMs = Number((e as ApiError).body?.retryAfterMs ?? 0);
      if (retryAfterMs > 0 && attempt < 3) {
        setTimeout(() => void doStart(preset, supplierAddress, attempt + 1), retryAfterMs + 400);
        return; // busy stays true — the UI shows "starting…"
      }
      setErr((e as Error).message);
      setBusy(false);
      judge
        .health()
        .then(onHealth)
        .catch(() => {});
    }
  };

  /**
   * Soft wallet gate — ONLY for the happy path (the one preset that pays out).
   * Policy-block reverts by design and x402 reuses an existing invoice, so a
   * wallet adds nothing there; asking would be friction without meaning.
   */
  const start = (preset: string) => {
    if (preset !== "happy") {
      void doStart(preset);
      return;
    }
    if (wallet.connected && wallet.publicKey) void doStart(preset, wallet.publicKey);
    else setPendingPreset(preset);
  };

  // Hero deep-link: start the requested preset once presets are in and nothing
  // is already running or offered for resume.
  const initialConsumed = useRef(false);
  useEffect(() => {
    if (
      initialPreset &&
      !initialConsumed.current &&
      presets.length &&
      !session &&
      !resumable &&
      !busy
    ) {
      initialConsumed.current = true;
      start(initialPreset);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPreset, presets, resumable]);

  // Wallet connected while waiting at the gate — continue automatically.
  useEffect(() => {
    if (pendingPreset && wallet.connected && wallet.publicKey && !busy) {
      void doStart(pendingPreset, wallet.publicKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.connected, wallet.publicKey]);

  // A walkthrough that pays the visitor's wallet is BOUND to that wallet:
  // disconnecting (or switching accounts) locks further steps until reconnect.
  const walletMismatch =
    !!session?.wallet && (!wallet.connected || wallet.publicKey !== session.wallet);

  const runNext = async () => {
    if (!session || walletMismatch) return;
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
          FAKTU<em>RA</em> <span className="lj-live">● LIVE JUDGE MODE</span>
        </div>
        <button className="lj-close" onClick={onClose}>
          ✕ close
        </button>
      </header>

      <JudgeHealthBar health={health} />

      {paused && (
        <div className="lj-paused">
          Live judge mode is temporarily paused — the Casper node is unreachable right now. The safe
          showcase remains fully available.
        </div>
      )}

      {!session && (
        <div className="lj-intro">
          <p className="lj-intro-kicker">You are the credit desk.</p>
          <h1>Move real capital on Casper — one step, one signature at a time.</h1>
          <p className="lj-intro-lede">
            Choose a story below. You trigger each step yourself: the AI underwriter thinks out
            loud, then every on-chain move signs a <b>real Casper transaction</b> you can open on
            the explorer the instant it confirms. Each screen tells you what just happened, why it
            matters, and what comes next.
          </p>

          {resumable && resumable.status === "active" && (
            <div className="lj-resume">
              <div className="lj-resume-text">
                <b>You have a walkthrough in progress:</b> {resumable.title} (
                {
                  resumable.steps.filter((st) => st.status === "done" || st.status === "reverted")
                    .length
                }
                /{resumable.steps.length} steps done)
              </div>
              <div className="lj-resume-actions">
                <button
                  className="lj-wallet-btn"
                  onClick={() => {
                    setSession(resumable);
                    setResumable(null);
                  }}
                >
                  Resume →
                </button>
                <button className="lj-back" onClick={() => setResumable(null)}>
                  Start fresh instead
                </button>
              </div>
            </div>
          )}

          {/* Wallet story — make it YOUR money. Only ever asks for a public key. */}
          {wallet.connected && wallet.publicKey ? (
            <div className="lj-wallet on">
              <span className="lj-wallet-badge">◈</span>
              <div>
                <b>Wallet connected — you are the supplier.</b> In the Full lifecycle run the desk
                pays the invoice advance straight to{" "}
                <span className="lj-wallet-key">{shortKey(wallet.publicKey)}</span> — watch your own
                balance move on a real chain.
              </div>
            </div>
          ) : (
            <div className="lj-wallet">
              <span className="lj-wallet-badge">⛓</span>
              <div>
                <b>Optional: connect your Casper wallet and get paid yourself.</b> The desk will
                send the invoice advance to <i>your</i> address instead of the demo supplier —
                read-only, we only ask for your public key, never a signature.
              </div>
              <button className="lj-wallet-btn" onClick={() => void connectWallet()}>
                {wallet.available ? "Connect wallet" : "Get Casper Wallet ↗"}
              </button>
            </div>
          )}
          {wallet.error && <div className="lj-err">{wallet.error}</div>}

          {pendingPreset ? (
            /* Soft wallet gate — connect is the recommended path, the demo
               supplier is always available so nobody is ever locked out. */
            <div className="lj-gate">
              <div className="lj-gate-kicker">
                {presets.find((p) => p.id === pendingPreset)?.title ?? "Walkthrough"} · one choice
                before we run
              </div>
              <h2>Who should receive the invoice advance?</h2>
              <div className="lj-gate-options">
                <button className="lj-gate-opt primary" onClick={() => void connectWallet()}>
                  <span className="lj-gate-opt-title">
                    ⛓ {wallet.available ? "Connect Casper Wallet" : "Get Casper Wallet ↗"}
                  </span>
                  <span className="lj-gate-opt-sub">
                    Recommended — the desk pays the advance to <b>your own address</b> and you watch
                    your balance move on a real chain. Read-only: public key only, never a
                    signature.
                  </span>
                </button>
                <button
                  className="lj-gate-opt"
                  disabled={busy}
                  onClick={() => void doStart(pendingPreset)}
                >
                  <span className="lj-gate-opt-title">Continue with the demo supplier</span>
                  <span className="lj-gate-opt-sub">
                    No extension needed — the advance goes to the desk's demo supplier account
                    instead. Every transaction is just as real.
                  </span>
                </button>
              </div>
              <button className="lj-back" onClick={() => setPendingPreset(null)}>
                ← Pick a different walkthrough
              </button>
            </div>
          ) : (
            <>
              {busy && (
                <div className="lj-starting">
                  <span className="lj-spinner" /> Starting your walkthrough…
                </div>
              )}
              <div className="lj-presets">
                {presets.map((p, idx) => (
                  <button
                    key={p.id}
                    className={`lj-preset ${p.id === "policy-block" ? "ace" : ""}`}
                    disabled={
                      paused ||
                      busy ||
                      health?.canRun?.[p.id === "policy-block" ? "policyBlock" : p.id]?.ok === false
                    }
                    title={
                      health?.canRun?.[p.id === "policy-block" ? "policyBlock" : p.id]?.reason ??
                      undefined
                    }
                    onClick={() => start(p.id)}
                  >
                    <div className="lj-preset-title">{p.title}</div>
                    <div className="lj-preset-sub">
                      {health?.canRun?.[p.id === "policy-block" ? "policyBlock" : p.id]?.ok ===
                      false
                        ? health?.canRun?.[p.id === "policy-block" ? "policyBlock" : p.id]?.reason
                        : p.subtitle}
                    </div>
                    <div className="lj-preset-meta">
                      {p.steps.length} steps · {p.steps.filter((s) => s.kind === "chain").length}{" "}
                      real transactions
                      {p.id === "policy-block" && (
                        <span className="lj-ace-tag">the one to watch</span>
                      )}
                    </div>
                    <span className="lj-preset-go">Begin →</span>
                  </button>
                ))}
              </div>
            </>
          )}
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
                {session.displayId ?? session.id.slice(0, 8)} · {session.subtitle}
              </div>
              <div className={`lj-payout ${session.wallet ? "own" : ""}`}>
                {session.preset === "policy-block"
                  ? "no advance will move — the contract is about to reject this one"
                  : session.preset === "x402"
                    ? "no new advance — reuses an already-funded invoice"
                    : session.preset === "default"
                      ? "no payout — an overdue advance gets written off; LPs absorb the loss"
                      : session.wallet
                        ? `◈ advance pays YOUR wallet ${shortKey(session.wallet)}`
                        : "advance pays the demo supplier"}
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
                total={session.steps.length}
                isCurrent={i === session.cursor && session.status === "active"}
                onRun={runNext}
                running={busy && i === session.cursor}
                runStartTs={runStartTs}
                nextTitle={session.steps[i + 1]?.title}
                walletLock={walletMismatch ? session.wallet : null}
                onReconnect={() => void connectWallet()}
                onAbandon={reset}
                onOpenMcp={onOpenMcp}
              />
            ))}
          </div>

          {err && <div className="lj-err">{err}</div>}

          {session.status === "done" && (
            <div className="lj-finish">
              <div className="lj-finish-head">
                ✓ Walkthrough complete — every on-chain step above is a real Casper transaction you
                can open on CSPR.live.
              </div>
              {session.wallet && session.preset === "happy" && (
                <div className="lj-finish-wallet">
                  💸 The advance was paid to <b>your wallet</b> ({shortKey(session.wallet)}) —{" "}
                  <a
                    target="_blank"
                    rel="noreferrer"
                    href={`${explorer}/account/${session.wallet}`}
                  >
                    see it on your account ↗
                  </a>
                </div>
              )}
              {session.poolAfter && (
                <PoolEconomics before={session.poolBefore} after={session.poolAfter} />
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
    ["x402 buyer", "402", "buys the risk report · demo signs with the debtor key", "#7a4dd0"],
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
    what: "runs the underwriting pipeline (live AI + policy checks). Hosted here: writes are simulated; a local live-mode stack signs the real register/fund/attest deploys",
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
      <div className="drawer-backdrop mcp-top-bd" onClick={onClose} />
      <div className="drawer mcp-drawer mcp-top">
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
            <span className="mono">agents/src/mcp.ts</span>. <b>Hosted MCP</b> (this host): live AI
            + read-only chain data, writes simulated — the guided walkthrough stays the only public
            signing surface. <b>Local live mode</b> with your own funded testnet keys signs real
            deploys.
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
