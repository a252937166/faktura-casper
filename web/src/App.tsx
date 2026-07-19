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
import { useModalA11y } from "./useModalA11y";

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
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
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    // Respect prefers-reduced-motion: hold one meaningful frame, no cycling.
    if (reducedMotion) {
      if (phase !== 5) setPhase(5);
      return;
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <div className="doc-row doc-row-optional">
          <span>Supplier</span>
          <b>{r.supplier}</b>
        </div>
        <div className="doc-row doc-row-optional">
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

/** Small-screen header menu — the MCP and GitHub chips collapse in here
 * instead of vanishing (audit: a menu button, not a disappearing act). */
function HeaderMoreMenu({ onOpenMcp, showMcp }: { onOpenMcp: () => void; showMcp: boolean }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  return (
    <div className="hdr-more" ref={boxRef}>
      <button
        className="chip chip-btn hdr-more-btn"
        aria-label="More"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="hdr-more-menu" role="menu">
          {showMcp && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenMcp();
              }}
            >
              🤖 MCP interface
            </button>
          )}
          <a
            role="menuitem"
            href="https://github.com/a252937166/faktura-casper"
            target="_blank"
            rel="noreferrer"
          >
            ⭐ GitHub
          </a>
        </div>
      )}
    </div>
  );
}

// ---- ONE live-desk state machine — hero, status strip, picker and runner all
// read the SAME six states, so the site never says "warming" in one corner
// and "node down" in another.
export type LiveState =
  "checking" | "ready" | "limited" | "warming" | "busy" | "paused" | "offline";

export function deriveLiveState(probed: boolean, h: JudgeHealth | null): LiveState {
  if (!probed) return "checking";
  if (!h) return "offline";
  if (h.paused) return (h.uptimeSec ?? 999) < 150 ? "warming" : "paused";
  if (h.deskBusy) return "busy";
  // The desk can be healthy while EVERY story is temporarily unrunnable
  // (daily signing budget spent, keys awaiting a top-up, pool shape) — saying
  // READY and then showing five disabled cards would be a contradiction.
  const runnable = Object.values(h.canRun ?? {}).filter((c) => c.ok).length;
  if (h.canRun && runnable === 0) return "limited";
  return "ready";
}

const LIVE_COPY: Record<
  LiveState,
  { dot: "green" | "amber" | "muted"; pill: string; sub: string }
> = {
  checking: {
    dot: "muted",
    pill: "CHECKING LIVE DESK…",
    sub: "Checking the live signing desk…",
  },
  ready: {
    dot: "green",
    pill: "LIVE AI DESK READY",
    sub: "Guided workflow: real on-chain transactions. Desk preview below: safe showcase data.",
  },
  warming: {
    dot: "amber",
    pill: "DESK RESTARTING",
    sub: "The live desk just restarted and is warming up — ready in under a minute.",
  },
  busy: {
    dot: "amber",
    pill: "DESK SIGNING",
    sub: "Another visitor's walkthrough is signing right now — the desk signs one story at a time. Watch the latest verified run, or try again in a minute or two.",
  },
  limited: {
    dot: "amber",
    pill: "DESK ONLINE · STORIES LIMITED",
    sub: "The desk is healthy but every story is temporarily unavailable — the daily signing budget is spent or the agent keys await a top-up. Browse the stories to see each reason.",
  },
  paused: {
    dot: "amber",
    pill: "LIVE SIGNING PAUSED",
    sub: "Live signing is temporarily paused — the Casper node is unreachable right now; the desk preview below still works.",
  },
  offline: {
    dot: "muted",
    pill: "SAFE SHOWCASE",
    sub: "Safe Showcase — no gas, writes simulated from a real testnet snapshot. Run the stack in live mode to sign every step.",
  },
};

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
    };
  }, []);

  const liveJudge = !!jhealth; // the dedicated live-testnet backend answered
  const liveState = deriveLiveState(judgeProbed, jhealth);
  const liveCopy = LIVE_COPY[liveState];

  // Probe cadence follows the state: while the desk is unresolved (restarting,
  // node blip, first load) re-check every 5 s so a visitor landing mid-restart
  // watches it come back within seconds; once settled, 30 s keeps it warm.
  const probeMs =
    liveState === "ready" || liveState === "limited" || liveState === "busy" ? 30_000 : 5_000;
  useEffect(() => {
    const iv = setInterval(probeJudge, probeMs);
    return () => clearInterval(iv);
  }, [probeMs]);

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

  const overlayOpen = mcpOpen || runnerOpen || judgeOpen || !!selected;

  return (
    <div className="shell">
      <div className="app-main" aria-hidden={overlayOpen || undefined}>
        <header className="header">
          <a
            href="/"
            className="site-logo-link"
            title="Faktura — autonomous invoice financing on Casper"
          >
            <img
              className="site-logo"
              src="/faktura-logo-compact.png"
              alt="Faktura — autonomous invoice financing protocol on chain"
            />
          </a>
          <div className="spacer" />
          <WalletChip wallet={wallet} bal={walletBal} onBal={setWalletBal} />
          {meta?.mcp && (
            <button
              className="chip chip-btn"
              title="Open the MCP agent interface — 6 tools, quick-start commands, live previews"
              onClick={() => setMcpOpen(true)}
            >
              MCP · 6 tools ▾
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
          <HeaderMoreMenu onOpenMcp={() => setMcpOpen(true)} showMcp={!!meta?.mcp} />
        </header>

        {meta && (
          <div className={`desk-status ${liveJudge ? "live" : meta.mode}`}>
            <div className="desk-status-main">
              {liveJudge ? (
                <>
                  <span className={`ds-pill live ${liveState !== "ready" ? "amber" : ""}`}>
                    <i /> {liveCopy.pill}
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
                    underwriter runs live; writes are simulated — nothing here pretends to be
                    signed.
                  </span>
                </>
              ) : (
                <>
                  <span className="ds-pill live">
                    <i /> LIVE TESTNET
                  </span>
                  <span className="ds-text">
                    Every action on this page is a <b>real Casper transaction</b> signed by the
                    agent keys.
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
                        The agent pre-filters stricter (risk ≤ {meta.prefilter.maxRiskScore}) to
                        save gas; <b>the contract is the final authority</b>.
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
              Faktura turns unpaid invoices into working capital. An autonomous AI agent evaluates
              the receivable, a <span className="casper-word">Casper</span> contract enforces the
              risk limits, and a shared liquidity pool advances the money up front — in CSPR,
              Casper's native token. Every decision stays verifiable.
            </p>
            <p className="hero-tagline">
              An AI can approve the invoice. <b>Only Casper can move the money.</b>
            </p>
            <div className="hero-cta">
              {liveState === "checking" ? (
                // Fixed-size placeholder — the CTA row must never flash a wrong
                // entry point and then jump when the health probe lands.
                <button className="btn-primary hero-cta-checking" disabled>
                  ● Checking live desk…
                </button>
              ) : liveState === "ready" ? (
                // ONE primary task — the five stories are chosen on the next
                // screen, not before understanding the product.
                <button className="btn-primary" onClick={() => openRunner()}>
                  ▶ Use the live AI desk · 3–6 min
                </button>
              ) : liveState === "busy" ? (
                <>
                  <button
                    className="btn-primary"
                    onClick={() =>
                      document
                        .querySelector(".latest-run")
                        ?.scrollIntoView({ behavior: "smooth", block: "center" })
                    }
                  >
                    ▶ View the latest verified run
                  </button>
                  <button className="btn-outline" onClick={() => openRunner()}>
                    Browse the five stories →
                  </button>
                  <button className="btn-outline sm-cta" onClick={() => probeJudge()}>
                    ↻ Retry when available
                  </button>
                </>
              ) : liveState === "limited" ? (
                <button className="btn-outline" onClick={() => openRunner()}>
                  Browse the five stories — reasons inside →
                </button>
              ) : liveState === "warming" || liveState === "paused" ? (
                <button className="btn-primary" disabled>
                  ▶ Use the live AI desk · 3–6 min
                </button>
              ) : (
                <button className="btn-primary" onClick={() => setJudgeOpen(true)}>
                  ▶ RUN JUDGE DEMO
                </button>
              )}
            </div>
            {jhealth?.canRun?.policyBlock?.ok === true && (
              <p className="hero-agent-link">
                <button className="linklike" onClick={() => openRunner("policy-block")}>
                  ⛔ Skip straight to the contract refusing an AI-approved invoice →
                </button>
              </p>
            )}
            <p className="hero-agent-link dev">
              <span className="muted">Developers:</span>{" "}
              <button className="linklike" onClick={() => setMcpOpen(true)}>
                🤖 MCP interface
              </button>{" "}
              ·{" "}
              <a
                className="linklike"
                href="https://github.com/a252937166/faktura-casper"
                target="_blank"
                rel="noreferrer"
              >
                ⭐ GitHub
              </a>
            </p>
            {liveState === "ready" && (
              <p className="hero-cost">
                Five stories to pick from — every on-chain step is a real Casper transaction. No
                wallet required; connect one only if you want the payout sent to you.
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
            {liveState !== "checking" && (
              <div className="hero-live" aria-live="polite">
                <span className={`live-dot ${liveCopy.dot}`} /> {liveCopy.sub}
              </div>
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
                <b>4</b>
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

        {/* ---- One invoice, two gates, two credit outcomes — the whole system ---- */}
        <section className="story">
          <h2 className="section-title">One invoice. Two gates. Two credit outcomes.</h2>
          <p className="story-lede">
            Nordwind shipped the freight; Aurora pays in 30 days. Nordwind needs the cash <i>now</i>
            . Before any money moves, the invoice passes two gates — and once funded, credit
            resolves one of two ways. Every arrow below runs live on{" "}
            <span className="casper-word">Casper</span>.
          </p>
          <div className="story-acts gates">
            <div className="story-act">
              <div className="story-stamp green">GATE 1 · AI UNDERWRITING</div>
              <h3>The model forms a credit opinion</h3>
              <p>
                Risk score, price, rationale, red flags — a full memo, hash-anchored. The AI can{" "}
                <b>REJECT</b> outright, or <b>APPROVE</b> and hand the file to the chain. Either way
                the opinion is auditable.
              </p>
              <div className="gate-verdicts">
                <span className="gv no">REJECT ✕</span>
                <span className="gv ok">APPROVE →</span>
              </div>
            </div>
            <div className="story-act blocked">
              <div className="story-stamp red">GATE 2 · CASPER POLICY</div>
              <h3>The contract decides if money moves</h3>
              <p>
                Risk ceiling, discount band, concentration caps — enforced inside{" "}
                <span className="mono-sm">fund_invoice</span>. An AI-approved invoice above the cap
                reverts with <span className="mono-sm">User error: 15</span>. Autonomous, never
                unbounded.
              </p>
              <div className="gate-verdicts">
                <span className="gv no">BLOCK ⛔</span>
                <span className="gv ok">FUND →</span>
              </div>
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
            <div className="story-act">
              <div className="story-stamp ink">AFTER FUNDING · TWO ENDINGS</div>
              <h3>Credit resolves — either way</h3>
              <p>
                <b>SETTLE</b>: the debtor repays face value and the pool earns yield. <b>DEFAULT</b>
                : the collector key writes it off and LPs absorb the loss through the share price.
                Both endings run live, and both move real numbers.
              </p>
              <div className="gate-verdicts">
                <span className="gv ok">SETTLE ↗ yield</span>
                <span className="gv no">DEFAULT ↘ loss</span>
              </div>
            </div>
          </div>
          {liveJudge && (
            <div className="side-quest">
              <span className="sq-kicker">AGENT ECONOMY · SIDE QUEST</span>
              <span className="sq-text">
                produce → sell → verify → <b>act</b>: another agent buys the risk report over{" "}
                <b>HTTP 402</b>, verifies the memo hash three ways (report · memo · on-chain anchor)
                and anchors its own acceptance.
              </span>
              <button className="linklike" onClick={() => openRunner("x402")}>
                Run it →
              </button>
            </div>
          )}
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
                concentration cap gets <b>rejected by the contract itself</b> — watch a real revert
                (<span className="mono-sm">User error: 15</span>) in the walkthrough.
              </p>
            </div>
            <div className="cap">
              <h3>💸 Get paid to your own wallet</h3>
              <p>
                Connect Casper Wallet and the desk pays the invoice advance to <b>your address</b>{" "}
                on the real chain. Read-only — we ask for a public key, never a signature.
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

        {/* ---- Built FOR agents — MCP front and center ---- */}
        {meta?.mcp && (
          <section className="mcp-band">
            <div className="mcp-band-head">
              <span className="mcp-band-kicker">🤖 BUILT FOR AGENTS · MCP SERVER</span>
              <h2>Don't just watch the desk. Plug YOUR agent in.</h2>
              <p>
                Faktura is itself a service <i>for</i> agents: six MCP tools expose the whole credit
                desk over stdio — against this very host. Every walkthrough step above advertises
                the tool that drives or audits it.
              </p>
            </div>
            <div className="mcp-band-tools">
              {[
                ["pool_stats", "read the pool — TVL, share price, exposure"],
                ["submit_invoice", "drive the underwriting pipeline end to end"],
                ["get_risk_report", "negotiate the x402 paywall, machine-to-machine"],
                ["verify_decision_hash", "audit our AI against the on-chain anchor"],
                ["list_funded_invoices", "read the live book"],
                ["list_verified_invoices", "every priceable credit history"],
              ].map(([name, what]) => (
                <button
                  key={name}
                  className="mcp-band-tool"
                  title="Open the MCP interface"
                  onClick={() => setMcpOpen(true)}
                >
                  <b className="mono">{name}</b>
                  <span>{what}</span>
                </button>
              ))}
            </div>
            <div className="mcp-band-cta">
              <code className="mcp-band-cmd">
                claude mcp add faktura -e FAKTURA_API=https://faktura.axiqo.xyz -- npx tsx
                src/mcp.ts
              </code>
              <button
                className="btn ghost sm"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(
                      "claude mcp add faktura -e FAKTURA_API=https://faktura.axiqo.xyz -- npx tsx src/mcp.ts",
                    )
                    .then(() => notify("MCP command copied"))
                    .catch(() => {});
                }}
              >
                Copy
              </button>
              <button className="btn-agent solid" onClick={() => setMcpOpen(true)}>
                Open the MCP interface →
              </button>
            </div>
          </section>
        )}

        {/* ---- Run it yourself ---- */}
        {liveJudge && (
          <section className="runit">
            <div className="runit-card">
              <div>
                <h2>Don't take our word for it. Trigger it yourself. Verify every transaction.</h2>
                <p>
                  Five guided walkthroughs — the full lifecycle, the policy firewall, an x402
                  purchase where the buyer verifies and acts on the report, an auditable AI
                  rejection, and a default workout. One click per step, one real agent-signed Casper
                  transaction per click, explorer links as they confirm. Your wallet never signs
                  anything.
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
          <h2 className="section-title">
            {meta?.mode === "showcase"
              ? "Desk preview — safe interactive showcase"
              : "The desk — live book & controls"}
          </h2>
          <p className="desk-head-sub">
            {meta?.mode === "showcase"
              ? "Reads come from a captured snapshot of the real testnet contract; new writes here are simulated (the guided walkthrough is the live surface)."
              : "Everything below reads and writes the live testnet contract."}
          </p>
          <button className="desk-toggle" onClick={() => setDeskOpen(!deskOpen)}>
            {deskOpen
              ? "▴ Collapse the full desk"
              : meta?.mode === "showcase"
                ? "▾ Open the full desk preview"
                : "▾ Open the full live desk"}
          </button>
        </section>

        {!deskOpen && (
          <DeskSummary
            stats={stats}
            tvl={tvl}
            sharePrice={sharePrice}
            invoices={invoices}
            events={events}
            mode={meta?.mode}
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
                <div className={`value ${sharePrice > 1 ? "good" : ""}`}>
                  {sharePrice.toFixed(4)}
                </div>
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
                              <td className="mono" data-label="Invoice">
                                {/* A REAL button so keyboard users can open the
                                    drawer; the whole-row click stays as a mouse
                                    enhancement. */}
                                <button
                                  className="row-open"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelected(r);
                                  }}
                                >
                                  {r.intake.invoiceNumber}
                                </button>
                              </td>
                              <td data-label="Supplier → Debtor">
                                {r.intake.supplierName} <span className="muted">→</span>{" "}
                                {r.intake.debtorName}
                              </td>
                              <td className="num mono" data-label="Face">
                                {fmtCspr(r.intake.amountCspr)}
                              </td>
                              <td className="num mono" data-label="Advance">
                                {r.decision?.approve
                                  ? fmtCspr(
                                      (r.intake.amountCspr * (10_000 - r.decision.discountBps)) /
                                        10_000,
                                    )
                                  : "—"}
                              </td>
                              <td data-label="Risk">
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
                              <td className="mono muted" data-label="Due">
                                {new Date(r.intake.dueTs).toISOString().slice(0, 10)}
                              </td>
                              <td data-label="Status">
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
      </div>
      {selected && (
        <Drawer
          record={selected}
          pool={pool}
          suspended={mcpOpen}
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
          suspended={mcpOpen}
          onClose={() => {
            setJudgeOpen(false);
            refresh();
          }}
        />
      )}
      {!runnerOpen && jhealth?.activeSession?.status === "active" && !jhealth.deskBusy && (
        <button
          className="lj-minipill"
          onClick={() => openRunner()}
          title="A live walkthrough is still in progress — click to resume"
        >
          ●{" "}
          {
            jhealth.activeSession.steps.filter(
              (st) => st.status === "done" || st.status === "reverted",
            ).length
          }
          /{jhealth.activeSession.steps.length} walkthrough in progress · Resume →
        </button>
      )}
      {runnerOpen && (
        <JudgeGuided
          health={jhealth}
          onHealth={setJhealth}
          wallet={wallet}
          initialPreset={runnerPreset}
          suspended={mcpOpen}
          onOpenMcp={() => setMcpOpen(true)}
          onClose={() => {
            setRunnerOpen(false);
            refresh();
            fetchRecent();
            probeJudge(); // the minimize pill needs a fresh activeSession snapshot
          }}
        />
      )}
      <ClickBridge />
      {mcpOpen && <McpDrawer meta={meta} notify={notify} onClose={() => setMcpOpen(false)} />}
      {toast && (
        <div
          className="toast"
          role={/fail|error|reject/i.test(toast) ? "alert" : "status"}
          aria-live="polite"
        >
          {toast}
        </div>
      )}
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
  mode,
}: {
  stats: ChainStats | undefined;
  tvl: number;
  sharePrice: number;
  invoices: InvoiceRecord[];
  events: FeedEvent[];
  onOpen: () => void;
  mode?: string;
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
        ▾ {mode === "showcase" ? "Open the full desk preview" : "Open the full live desk"} — full
        book, LP actions, custom intake, agent roles &amp; feed
      </button>
    </section>
  );
}

/**
 * The receipt of the LAST completed real walkthrough — persisted server-side.
 * More convincing than any static metric: it names the run, lists every step
 * and links every transaction.
 */
/** The trophies of a finished run — what was PROVEN, each with its tx. */
const PROOF_LABELS: Record<string, string> = {
  underwrite: "AI decision memo (hashed)",
  register: "Invoice registered on-chain",
  fund: "Supplier payout",
  attest: "Decision attestation anchored",
  settle: "Settlement — pool made whole",
  default: "Write-off — loss absorbed by LPs",
  "pick-expired": "Overdue inventory located",
  pick: "Verified invoice selected",
  x402: "Machine payment (HTTP 402)",
  consumer: "Consumer verdict anchored",
  "attest-reject": "Rejection anchored on-chain",
};

function ProofsCollected({ session }: { session: JudgeSession }) {
  const [copied, setCopied] = useState(false);
  const done = session.steps.filter((st) => st.status === "done" || st.status === "reverted");
  if (!done.length) return null;
  return (
    <div className="lj-proofs">
      <div className="lj-pe-kicker">PROOFS COLLECTED</div>
      <div className="lj-proofs-rows">
        {done.map((st) => (
          <div className="lj-proof-row" key={st.key}>
            <span className="lj-proof-mark">{st.status === "reverted" ? "⛔" : "✓"}</span>
            <span className="lj-proof-label">
              {st.status === "reverted" && st.key === "fund"
                ? "Policy revert — contract said no"
                : (PROOF_LABELS[st.key] ?? st.title)}
            </span>
            {st.txHash && (
              <a className="lr-tx mono" target="_blank" rel="noreferrer" href={st.explorerUrl}>
                {st.txHash.slice(0, 8)}… ↗
              </a>
            )}
          </div>
        ))}
      </div>
      {session.displayId && (
        <button
          className="linklike"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(`${location.origin}/api/judge/recent/${session.displayId}`)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
              .catch(() => {});
          }}
        >
          {copied ? "✓ Copied" : "⧉ Copy proof link"}
        </button>
      )}
    </div>
  );
}

function LatestRunReceipt({ runs, onOpen }: { runs: RecentRun[]; onOpen: () => void }) {
  const [copied, setCopied] = useState(false);
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
          <a
            className="linklike"
            href={`/api/judge/recent/${run.displayId}`}
            download={`${run.displayId}.json`}
            title="Signed-run receipt (faktura.credit-receipt.v1) — verify offline with npm run verify-receipt"
          >
            ⬇ Receipt
          </a>
          <button
            className="linklike"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(`${location.origin}/api/judge/recent/${run.displayId}`)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch(() => {});
            }}
            title="Copy a curl-able proof link to this run"
          >
            {copied ? "✓ Copied" : "⧉ Copy proof link"}
          </button>
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
      {meta?.release && meta.release.release !== "dev" && (
        <span
          className="ps-item ps-release"
          title={`This exact build: ${meta.release.release} @ ${meta.release.gitSha} (built ${meta.release.builtAt}) — pin any behavior you observe to this commit.`}
        >
          <span className="ps-label">Build</span>
          <span className="mono">
            {meta.release.release} · {meta.release.gitSha.slice(0, 7)}
          </span>
        </span>
      )}
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

  /** Inline field errors + a top-level submit error — never a browser alert()
   * that rips the visitor out of context. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!form.supplierName.trim()) e.supplierName = "Who is selling this invoice?";
    if (!form.debtorName.trim()) e.debtorName = "Who owes the money?";
    const amount = Number(form.amountCspr);
    if (!(amount > 0)) e.amountCspr = "Enter a face value above 0 CSPR.";
    const days = Number(form.dueDays);
    if (!(days >= 1 && days <= 365)) e.dueDays = "Due in 1–365 days.";
    if (!form.invoiceNumber.trim()) e.invoiceNumber = "An invoice reference is required.";
    const addr = form.supplierAddress.trim();
    if (addr && !/^(account-hash-|01|02)/.test(addr))
      e.supplierAddress = "Use an account-hash-… address or a 01/02 public key.";
    return e;
  };

  const submit = async () => {
    const e = validate();
    setErrors(e);
    setSubmitErr(null);
    const firstBad = Object.keys(e)[0];
    if (firstBad) {
      document.getElementById(`intake-${firstBad}`)?.focus();
      return;
    }
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
    } catch (err) {
      setSubmitErr((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** One accessible field: label↔input wired by id, inline error announced. */
  const field = (
    key: keyof typeof form,
    label: React.ReactNode,
    inputProps: React.InputHTMLAttributes<HTMLInputElement> = {},
    full = false,
  ) => (
    <div className={`field${full ? " full" : ""}`}>
      <label htmlFor={`intake-${key}`}>{label}</label>
      <input
        id={`intake-${key}`}
        value={form[key]}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `intake-${key}-err` : undefined}
        onChange={(e) => {
          set(key, e.target.value);
          if (errors[key]) setErrors(({ [key]: _drop, ...rest }) => rest);
        }}
        {...inputProps}
      />
      {errors[key] && (
        <span className="field-err" id={`intake-${key}-err`} role="alert">
          {errors[key]}
        </span>
      )}
    </div>
  );

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
        {field("supplierName", "Supplier (you)")}
        {field("debtorName", "Debtor (owes the invoice)")}
        {field("amountCspr", "Face value (CSPR)", {
          type: "number",
          min: 0.01,
          step: 0.01,
          inputMode: "decimal",
        })}
        {field("dueDays", "Due in (days)", { type: "number", min: 1, max: 365, step: 1 })}
        {field("invoiceNumber", "Invoice number")}
        {field("history", "Payment history")}
        <div className="field full">
          <label htmlFor="intake-description">Description</label>
          <textarea
            id="intake-description"
            rows={2}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </div>
        <div className="field full">
          <label htmlFor="intake-supplierAddress">
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
            id="intake-supplierAddress"
            value={form.supplierAddress}
            aria-invalid={errors.supplierAddress ? true : undefined}
            aria-describedby={errors.supplierAddress ? "intake-supplierAddress-err" : undefined}
            placeholder={
              supplierDefault
                ? `defaults to demo supplier ${supplierDefault.replace("entity-account-", "account-hash-").slice(0, 30)}…`
                : "account-hash-… (defaults to the demo supplier account)"
            }
            onChange={(e) => {
              set("supplierAddress", e.target.value);
              if (errors.supplierAddress) setErrors(({ supplierAddress: _d, ...rest }) => rest);
            }}
          />
          {errors.supplierAddress && (
            <span className="field-err" id="intake-supplierAddress-err" role="alert">
              {errors.supplierAddress}
            </span>
          )}
        </div>
        {submitErr && (
          <div className="field full">
            <span className="field-err" role="alert">
              Submission failed: {submitErr} — nothing was signed; fix and retry.
            </span>
          </div>
        )}
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
  suspended = false,
}: {
  record: InvoiceRecord;
  pool: PoolResponse | null;
  meta: Meta | null;
  busy: boolean;
  notify: (m: string) => void;
  onClose: () => void;
  onSettle: (id: number) => void;
  /** A higher overlay (MCP) is stacked on top — release the modal claim. */
  suspended?: boolean;
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
  const invoiceDialogRef = useModalA11y<HTMLDivElement>(!suspended, onClose);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div
        className="drawer"
        role="dialog"
        aria-modal={suspended ? undefined : "true"}
        aria-hidden={suspended || undefined}
        ref={invoiceDialogRef}
      >
        <button className="drawer-x" onClick={onClose} aria-label="Close invoice details">
          ✕
        </button>
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

/** Judge Demo: the two-gates story in slides. `inset` is DATA, not an index —
 * each slide declares which extra panel it wants (policy caps / x402 pricing). */
const JUDGE_STEPS: {
  actor: string;
  title: string;
  detail: string;
  /** Honest variant shown when the host runs in showcase mode. */
  showcaseDetail?: string;
  /** Optional data panel rendered under the detail text. */
  inset?: "policy" | "x402";
}[] = [
  {
    actor: "investor",
    title: "LPs fund the pool",
    detail:
      "Liquidity providers deposit native CSPR; LP shares mint at the current share price. This pool is the capital every invoice draws on — and the book that absorbs every loss.",
  },
  {
    actor: "underwriter",
    title: "Gate 1 — the AI underwrites",
    detail:
      "A receivable enters intake; the model reads it and returns a risk score, a discount and a written rationale with red flags. Gate 1 has two exits: an APPROVE moves on to the contract, and a REJECT is anchored on-chain too — an auditable desk proves what it declined.",
  },
  {
    actor: "underwriter",
    title: "Gate 2 — the contract enforces policy",
    detail:
      "The model proposes; Casper disposes. Risk ceiling, discount band and concentration caps live in the contract itself, so even a valid agent key with an AI approval cannot fund past them — fund_invoice simply reverts.",
    inset: "policy",
  },
  {
    actor: "underwriter",
    title: "Register, then fund the supplier",
    detail:
      "register_invoice writes the receivable and its decision hash; fund_invoice streams the advance from the pool to the supplier's account (never the debtor's). Connect a wallet in the live walkthrough and the advance lands in YOURS.",
    showcaseDetail:
      "On this showcase host the writes replay in memory — the seeded records link to the real Testnet register and fund deploys.",
  },
  {
    actor: "underwriter",
    title: "The decision memo is anchored",
    detail:
      "The SHA-256 of the FULL memo — rationale, red flags, applied numbers — is attested on-chain. Change one character of the story afterwards and the hash no longer matches the anchor.",
    showcaseDetail:
      "Anchoring is simulated for new showcase writes; the seeded attestations are real, explorer-linkable deploys.",
  },
  {
    actor: "debtor",
    title: "Settle — or default",
    detail:
      "On payment the pool realizes its yield through the share price. Past due + grace, only the collector key can write the invoice off — separation of duties the contract enforces — and LPs absorb the loss the same way. Both endings are part of the product.",
    showcaseDetail:
      "Settlement and write-off are simulated here; the seeded SETTLED and DEFAULTED invoices link to the real transactions.",
  },
  {
    actor: "oracle",
    title: "Side quest — agents trade the risk data (x402)",
    detail:
      "Any underwritten invoice's report is machine-payable: a consumer agent hits HTTP 402, pays with a native CSPR transfer carrying a one-time nonce, re-hashes the shipped memo against the on-chain anchor, applies its own policy and anchors its own verdict. The same surface ships as MCP tools.",
    inset: "x402",
  },
];

function JudgeDemo({
  meta,
  onClose,
  suspended = false,
}: {
  meta: Meta | null;
  onClose: () => void;
  suspended?: boolean;
}) {
  const [i, setI] = useState(0);
  const step = JUDGE_STEPS[i];
  const last = i === JUDGE_STEPS.length - 1;
  const live = meta?.mode === "live-testnet";
  const judgeDemoRef = useModalA11y<HTMLDivElement>(!suspended, onClose);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div
        className="judge"
        role="dialog"
        aria-modal={suspended ? undefined : "true"}
        aria-hidden={suspended || undefined}
        aria-label="Judge demo — the 30-second story"
        ref={judgeDemoRef}
      >
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
              <li key={n} className={n === i ? "active" : n < i ? "done" : ""}>
                <button
                  type="button"
                  className="jrow"
                  onClick={() => setI(n)}
                  aria-current={n === i ? "step" : undefined}
                >
                  <span className="jn">{n < i ? "✓" : n + 1}</span>
                  <span className="jt">{s.title}</span>
                  <span className="ja">{s.actor}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="judge-detail">
            <div className="jd-actor">
              {ACTOR_ICON[step.actor] ?? "•"} {step.actor}
            </div>
            <h3>{step.title}</h3>
            <p>{!live && step.showcaseDetail ? step.showcaseDetail : step.detail}</p>
            {step.inset === "policy" && meta?.policy && (
              <div className="jd-policy">
                On-chain hard caps — risk ≤ {meta.policy.maxRiskScore} · discount{" "}
                {(meta.policy.minDiscountBps / 100).toFixed(1)}–
                {(meta.policy.maxDiscountBps / 100).toFixed(0)}% · invoice ≤{" "}
                {meta.policy.maxSingleInvoiceBps / 100}% of pool · debtor ≤{" "}
                {meta.policy.maxDebtorExposureBps / 100}%.
              </div>
            )}
            {step.inset === "x402" && (
              <div className="jd-policy">
                Price {meta ? (Number(meta.x402Price) / 1e9).toFixed(2) : "2.50"} CSPR · settled
                with a native transfer carrying a one-time nonce · the report ships the full
                canonical decision memo, and the buyer re-hashes it against the on-chain anchor.
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

function JudgeHealthBar({ health, state }: { health: JudgeHealth | null; state?: LiveState }) {
  const [open, setOpen] = useState(false);
  if (!health) return null;
  // Ops detail (balances, budgets) is for engineers — visitors get one line.
  // Anything abnormal auto-expands so the reason is never hidden.
  const s = state ?? deriveLiveState(true, health);
  const abnormal = s !== "ready" || health.low.length > 0 || !health.rpcOk || !health.contractOk;
  const expanded = open || abnormal;
  return (
    <div className="lj-health">
      <span className={`live-dot ${LIVE_COPY[s].dot}`} /> {LIVE_COPY[s].pill}
      <span className="lj-hsep">·</span> 5 stories
      <span className="lj-hsep">·</span> real Testnet
      <button
        className="lj-health-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expanded}
      >
        System health &amp; budgets {expanded ? "▴" : "▾"}
      </button>
      {expanded && (
        <>
          <span className="lj-hsep">·</span>
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
  predict,
  predicted,
  onPredict,
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
  /** Predict-then-verify config for THIS step, when it has one. */
  predict?: {
    question: string;
    options: { id: string; label: string }[];
    answer: string;
    reveal: string;
  };
  predicted?: string;
  onPredict?: (choice: string) => void;
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
          {done && predict && predicted && (
            <div className={`lj-predict-reveal ${predicted === predict.answer ? "hit" : "miss"}`}>
              Your prediction:{" "}
              <b>{predict.options.find((o) => o.id === predicted)?.label ?? predicted}</b> ·{" "}
              {predicted === predict.answer ? "correct ✓" : "not this time ✗"} — {predict.reveal}
            </div>
          )}
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
          <div className="lj-signing" aria-live="polite">
            <div className="lj-signing-top">
              <span className="lj-spinner" /> Signing on Casper…
              <ElapsedTimer startTs={runStartTs} />
            </div>
            <div className="lj-wait-bar">
              <span className="lj-wait-fill" />
            </div>
            {/* Live sub-steps streamed from the signer — the wait is a story,
                not a silent bar. The tx link appears the moment the deploy is
                submitted, minutes before finality. */}
            <div className="lj-phase">
              <span className="lj-phase-dot" />
              {step.phaseNote ?? "connecting to the Casper node…"}
              {step.txHash && (
                <a className="lr-tx mono" target="_blank" rel="noreferrer" href={step.explorerUrl}>
                  tx {step.txHash.slice(0, 10)}… ↗
                </a>
              )}
            </div>
            <span className="lj-run-hint">
              One real transaction · finality usually 30–120 s · keep this open
            </span>
          </div>
        )}
        {step.status === "running" && !running && (
          /* Reattached after a refresh: the transaction kept settling
             server-side while the page was away — show the live wait (timer
             continues from the SERVER's start time) and the poller above
             swaps in the result the moment it lands. */
          <div className="lj-signing" aria-live="polite">
            <div className="lj-signing-top">
              <span className="lj-spinner" /> Still settling on Casper — reattached
              <ElapsedTimer startTs={step.startedTs ?? Date.now()} />
            </div>
            <div className="lj-wait-bar">
              <span className="lj-wait-fill" />
            </div>
            <div className="lj-phase">
              <span className="lj-phase-dot" />
              {step.phaseNote ?? "waiting for on-chain finality…"}
              {step.txHash && (
                <a className="lr-tx mono" target="_blank" rel="noreferrer" href={step.explorerUrl}>
                  tx {step.txHash.slice(0, 10)}… ↗
                </a>
              )}
            </div>
            <span className="lj-run-hint">
              Your refresh didn&apos;t interrupt anything — the desk kept signing; this card updates
              automatically when the transaction confirms.
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
        {step.status === "ready" && !running && !walletLock && predict && !predicted && (
          /* Predict-then-verify: make the judge commit to a call BEFORE the
             chain answers — the wait becomes a reveal, not dead time. */
          <div className="lj-predict">
            <div className="lj-predict-q">{predict.question}</div>
            <div className="lj-predict-opts">
              {predict.options.map((o) => (
                <button key={o.id} className="lj-predict-btn" onClick={() => onPredict?.(o.id)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {step.status === "ready" && !running && !walletLock && (!predict || predicted) && (
          <div className="lj-step-run">
            {predict && predicted && (
              <span className="lj-predict-locked">
                Your call:{" "}
                <b>{predict.options.find((o) => o.id === predicted)?.label ?? predicted}</b> — now
                ask Casper.
              </span>
            )}
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

/** Picker metadata: group, promised time, one-line hook — main quest first. */
const PRESET_META: Record<
  string,
  { group: "main" | "challenge"; time: string; hook: string; wallet?: "optional-payout" }
> = {
  happy: {
    group: "main",
    time: "3–6 min",
    hook: "Supplier gets paid; debtor settles. The whole credit loop.",
    // The ONE story with a payout — a connected wallet receives the advance.
    wallet: "optional-payout",
  },
  "policy-block": {
    group: "challenge",
    time: "1–3 min",
    hook: "Fastest proof — watch the contract refuse an AI-approved invoice.",
  },
  x402: {
    group: "challenge",
    time: "1–3 min",
    hook: "Agent economy — buy a report, verify it three ways, act on it.",
  },
  default: {
    group: "challenge",
    time: "1–2 min",
    hook: "Credit loss — the collector writes off an overdue invoice.",
  },
  "ai-reject": {
    group: "challenge",
    time: "1–2 min",
    hook: "The AI says no to bad paper — and even the no is anchored.",
  },
};

/** Predict-then-verify moments: cheap interactivity with a real answer. */
const PREDICTIONS: Record<
  string,
  { question: string; options: { id: string; label: string }[]; answer: string; reveal: string }
> = {
  "policy-block:fund": {
    question: "What do you think Casper will do with this AI-approved invoice?",
    options: [
      { id: "allow", label: "ALLOW funding" },
      { id: "block", label: "BLOCK funding" },
    ],
    answer: "block",
    reveal: "Casper BLOCKED it — the single-invoice cap is enforced by the contract itself.",
  },
  "default:default": {
    question: "After this write-off, what happens to the LP share value?",
    options: [
      { id: "up", label: "UP" },
      { id: "down", label: "DOWN" },
      { id: "same", label: "UNCHANGED" },
    ],
    answer: "down",
    reveal: "DOWN — the loss is absorbed by LPs through the share price. Real credit, real losses.",
  },
  "ai-reject:underwrite": {
    question: "Shell-company debtor, one disputed invoice, vague scope — what will the AI do?",
    options: [
      { id: "approve", label: "APPROVE anyway" },
      { id: "reject", label: "REJECT it" },
    ],
    answer: "reject",
    reveal:
      "REJECTED — and the memo with every red flag is about to be anchored on-chain, hash and all.",
  },
};

function JudgeGuided({
  health,
  onHealth,
  wallet,
  initialPreset,
  onOpenMcp,
  onClose,
  suspended = false,
}: {
  health: JudgeHealth | null;
  onHealth: (h: JudgeHealth | null) => void;
  wallet: WalletState;
  /** Preset the caller wants started immediately (hero CTA deep-link). */
  initialPreset?: string | null;
  onOpenMcp: () => void;
  onClose: () => void;
  /** True while a higher overlay (MCP) is stacked on top — this dialog
   * releases its focus trap, Escape handler and aria-modal claim. */
  suspended?: boolean;
}) {
  const [presets, setPresets] = useState<JudgePreset[]>([]);
  const [session, setSession] = useState<JudgeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runStartTs, setRunStartTs] = useState(0);
  /** Predict-then-verify answers, keyed by "preset:stepKey". */
  const [predictions, setPredictions] = useState<Record<string, string>>({});
  /** Wallet balance snapshots for the payout delta card. */
  const [walletBefore, setWalletBefore] = useState<number | null>(null);
  const [walletBeforeFailed, setWalletBeforeFailed] = useState(false);
  const [walletAfter, setWalletAfter] = useState<number | null>(null);
  /** Payout quota hit — shown as guidance at the gate, never as an error. */
  const [payoutNotice, setPayoutNotice] = useState<string | null>(null);
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
    // Snapshot the payout wallet BEFORE anything moves — the delta card is
    // the reward moment ("your balance actually changed on a real chain").
    // AWAITED on purpose: if this raced the walkthrough, a slow read could
    // land after funding and report the post-payout balance as "before".
    if (supplierAddress && attempt === 0) {
      setWalletBefore(null);
      setWalletBeforeFailed(false);
      setWalletAfter(null);
      try {
        const b = await judge.balance(supplierAddress);
        setWalletBefore(b.cspr ?? null);
        setWalletBeforeFailed(b.cspr == null);
      } catch {
        // NEVER pretend the balance was 0 — a failed read must not turn into
        // "advance received +101.96" for a wallet that held 100 all along.
        setWalletBefore(null);
        setWalletBeforeFailed(true);
      }
    }
    try {
      // With a wallet connected, the desk pays the advance to THEIR address.
      setSession(await judge.createSession(preset, supplierAddress));
      setPayoutNotice(null);
      setBusy(false);
    } catch (e) {
      // The visitor's own previous walkthrough still has a transaction
      // settling — the server refuses to replace it AND hands it back to us.
      // Auto-reattach instead of stranding them on a wall of 409s (they may
      // have dismissed the resume banner already).
      const prior = (e as ApiError).body?.session as JudgeSession | undefined;
      if ((e as ApiError).status === 409 && prior) {
        setSession(prior);
        setErr(
          "Your previous walkthrough still has a transaction settling — brought you back to it; it updates automatically.",
        );
        setBusy(false);
        return;
      }
      // Payout quota hit: this is GUIDANCE, not an error — send the visitor
      // back to the gate with the demo-supplier option front and center.
      if ((e as ApiError).body?.payoutBlocked) {
        setPayoutNotice((e as Error).message);
        setPendingPreset(preset);
        setBusy(false);
        return;
      }
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
    if (pendingPreset && wallet.connected && wallet.publicKey && !busy && !payoutNotice) {
      void doStart(pendingPreset, wallet.publicKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.connected, wallet.publicKey]);

  // A walkthrough that pays the visitor's wallet is BOUND to that wallet:
  // disconnecting (or switching accounts) locks further steps until reconnect.
  const walletMismatch =
    !!session?.wallet && (!wallet.connected || wallet.publicKey !== session.wallet);

  // The reward moment: as soon as the fund step confirms, fetch the wallet's
  // NEW balance automatically — no manual refresh to see your money arrive.
  // Balance indexing can lag finality by a few seconds, so poll (3 s × 5)
  // until the increase is actually visible instead of freezing a stale read.
  const fundDone = !!session?.steps.some((st) => st.key === "fund" && st.status === "done");
  useEffect(() => {
    if (!session?.wallet || !fundDone || walletAfter != null) return;
    const wallet = session.wallet;
    let cancelled = false;
    const read = async (tries: number) => {
      let v: number | null = null;
      try {
        v = (await judge.balance(wallet)).cspr ?? null;
      } catch {
        /* transient RPC blip — the retry below covers it */
      }
      if (cancelled) return;
      const grew = v != null && (walletBefore == null || v > walletBefore);
      if (grew || tries >= 5) {
        if (v != null) setWalletAfter(v);
        return;
      }
      setTimeout(() => void read(tries + 1), 3000);
    };
    void read(0);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundDone, session?.wallet]);

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
    setPredictions({});
    setWalletBefore(null);
    setWalletBeforeFailed(false);
    setWalletAfter(null);
    setPayoutNotice(null);
    judge
      .health()
      .then(onHealth)
      .catch(() => {});
  };

  // While OUR step is signing, poll the session so the live phase notes and
  // the early deploy hash stream into the waiting card — the visitor watches
  // the sub-steps instead of a silent bar.
  useEffect(() => {
    if (!busy || !session) return;
    const id = session.id;
    const iv = setInterval(() => {
      judge
        .getSession(id)
        .then((fresh) => {
          // Never let a late poll overwrite the final state runNext just set.
          if (fresh.steps[fresh.cursor]?.status === "running") setSession(fresh);
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, session?.id]);

  // Reattach after refresh: if the current step is RUNNING server-side (the
  // transaction kept settling while the page was away), poll the
  // authoritative session until the outcome lands — the visitor watches it
  // flip to done/failed instead of staring at a stuck card.
  const serverRunning =
    !!session &&
    session.status === "active" &&
    session.steps[session.cursor]?.status === "running" &&
    !busy;
  useEffect(() => {
    if (!serverRunning || !session) return;
    const iv = setInterval(() => {
      judge
        .getSession(session.id)
        .then((fresh) => {
          setSession(fresh);
          if (fresh.steps[fresh.cursor]?.status !== "running") {
            judge
              .health()
              .then(onHealth)
              .catch(() => {});
          }
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRunning, session?.id]);

  // While the desk is busy and we are on the picker, keep availability fresh
  // so the busy banner clears itself the moment the other run finishes.
  useEffect(() => {
    if (!health?.deskBusy || session) return;
    const iv = setInterval(() => {
      judge
        .health()
        .then(onHealth)
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health?.deskBusy, !!session]);

  /** Close/leave is a DECISION, not an accident: while a transaction settles
   * the visitor is warned it continues server-side; an active session offers
   * "continue later" (resume) vs a true server-side abandon. */
  const [confirmClose, setConfirmClose] = useState<null | {
    kind: "settling" | "leave";
    target: "close" | "picker";
  }>(null);
  const requestLeave = (target: "close" | "picker") => {
    if (!session || session.status !== "active") {
      if (target === "close") onClose();
      else reset();
      return;
    }
    setConfirmClose({ kind: busy ? "settling" : "leave", target });
  };
  const requestClose = () => requestLeave("close");
  const leaveWithoutAbandon = () => {
    const t = confirmClose?.target ?? "close";
    setConfirmClose(null);
    if (t === "close") {
      onClose();
      return;
    }
    // Back to the picker: ONE leave semantic everywhere — the session goes
    // into the resumable slot immediately (reset() would make it vanish from
    // this screen while still active server-side).
    setResumable(session);
    setSession(null);
    setErr(null);
  };
  const abandonSafely = async () => {
    if (!session) return;
    try {
      await judge.abandon(session.id);
    } catch (e) {
      if ((e as ApiError).status === 409) {
        setConfirmClose((c) => (c ? { ...c, kind: "settling" } : c));
        return;
      }
      /* 404/expired — nothing left to abandon */
    }
    const t = confirmClose?.target ?? "close";
    setConfirmClose(null);
    reset();
    if (t === "close") onClose();
  };
  const pageRef = useModalA11y<HTMLDivElement>(!suspended && !confirmClose, () => requestClose());
  // The confirm layer is its own alertdialog: its trap keeps Tab inside the
  // three buttons instead of leaking to the runner behind it.
  const confirmRef = useModalA11y<HTMLDivElement>(!!confirmClose, () => setConfirmClose(null));

  const paused = health?.paused;
  // Same six-state machine as the homepage — the runner must never contradict
  // the hero ("warming up" there, "node down" here).
  const runnerState = deriveLiveState(true, health);
  const doneCount = session
    ? session.steps.filter((s) => s.status === "done" || s.status === "reverted").length
    : 0;

  return (
    <div
      className="lj-page"
      role="dialog"
      aria-modal={suspended ? undefined : "true"}
      aria-hidden={suspended || undefined}
      aria-label="Guided live walkthrough"
      ref={pageRef}
    >
      <header className="lj-top">
        <div className="lj-brand">
          FAKTU<em>RA</em> <span className="lj-live">● LIVE JUDGE MODE</span>
        </div>
        <button className="lj-close" onClick={requestClose} data-autofocus>
          ✕ close
        </button>
      </header>

      <JudgeHealthBar health={health} state={runnerState} />

      {(runnerState === "paused" || runnerState === "warming") && (
        <div className="lj-paused" aria-live="polite">
          {LIVE_COPY[runnerState].sub}
        </div>
      )}

      {runnerState === "busy" && !session && (
        <div className="lj-busy" aria-live="polite">
          <b>Another live walkthrough is signing right now.</b> The desk signs one story at a time —
          estimated availability ~1–2 minutes. You can browse the stories below meanwhile.
          <span className="lj-busy-actions">
            <button
              className="linklike"
              onClick={() => {
                onClose();
                setTimeout(
                  () =>
                    document
                      .querySelector(".latest-run")
                      ?.scrollIntoView({ behavior: "smooth", block: "center" }),
                  60,
                );
              }}
            >
              Watch the latest verified run →
            </button>
            <button
              className="linklike"
              onClick={() => {
                judge
                  .health()
                  .then(onHealth)
                  .catch(() => {});
              }}
            >
              ↻ Refresh availability
            </button>
          </span>
        </div>
      )}

      {!session && (
        <div className="lj-intro">
          <p className="lj-intro-kicker">You are the credit desk.</p>
          <h1>Move real capital on Casper — one step, one agent-signed transaction at a time.</h1>
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
                    // The health snapshot can lag — fetch the authoritative
                    // session state so the current step arrives runnable.
                    void judge
                      .getSession(resumable.id)
                      .then(setSession)
                      .catch(() => setSession(resumable));
                    setResumable(null);
                  }}
                >
                  Resume →
                </button>
                {resumable.steps.some((st) => st.status === "running") ? (
                  <button
                    className="lj-back"
                    disabled
                    title="A real transaction is still settling in this walkthrough — resume it or wait a moment; replacing it now could corrupt the payout ledger."
                  >
                    finishing a transaction…
                  </button>
                ) : (
                  <button className="lj-back" onClick={() => setResumable(null)}>
                    Choose another story
                  </button>
                )}
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
              {payoutNotice && <div className="lj-payout-notice">{payoutNotice}</div>}
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
              {(["main", "challenge"] as const).map((group) => {
                const cards = presets.filter((p) => PRESET_META[p.id]?.group === group);
                if (!cards.length) return null;
                return (
                  <div key={group}>
                    <div className="lj-group-lbl">
                      {group === "main" ? "MAIN STORY" : "CHALLENGES"}
                    </div>
                    <div className={`lj-presets ${group}`}>
                      {cards.map((p) => {
                        const key = p.id === "policy-block" ? "policyBlock" : p.id;
                        const cr = health?.canRun?.[key];
                        const meta = PRESET_META[p.id];
                        return (
                          <button
                            key={p.id}
                            className={`lj-preset ${p.id === "policy-block" ? "ace" : ""} ${group}`}
                            disabled={paused || busy || cr?.ok === false || !!health?.deskBusy}
                            title={cr?.reason ?? undefined}
                            onClick={() => start(p.id)}
                          >
                            <div className="lj-preset-head">
                              <div className="lj-preset-title">{p.title}</div>
                              {meta && <span className="lj-preset-time">{meta.time}</span>}
                            </div>
                            <div className="lj-preset-sub">
                              {cr?.ok === false
                                ? cr?.reason
                                : health?.deskBusy
                                  ? "desk busy — one story signs at a time; free again in ~1–2 min"
                                  : (meta?.hook ?? p.subtitle)}
                            </div>
                            <div className="lj-preset-meta">
                              {p.steps.length} steps ·{" "}
                              {p.steps.filter((s) => s.kind === "chain").length} real transaction
                              {p.steps.filter((s) => s.kind === "chain").length === 1 ? "" : "s"}
                              {p.id === "policy-block" && (
                                <span className="lj-ace-tag">the one to watch</span>
                              )}
                            </div>
                            {/* Who needs a wallet? Answered on the card itself. */}
                            {meta?.wallet === "optional-payout" ? (
                              <span className="lj-wallet-tag on">
                                ◈ connect a wallet & the advance is paid to YOU (optional)
                              </span>
                            ) : (
                              <span className="lj-wallet-tag">no wallet needed</span>
                            )}
                            <span className="lj-preset-go">Begin →</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </>
          )}
          {err && <div className="lj-err">{err}</div>}
        </div>
      )}

      {session && (
        <div className="lj-run">
          <button className="lj-back" onClick={() => requestLeave("picker")} disabled={busy}>
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
            {session.steps.map((s, i) => {
              const predKey = `${session.preset}:${s.key}`;
              // Defensive: an active session must NEVER present its current
              // step as "locked" (a stale snapshot would freeze the flow with
              // no button to click). The server re-validates every /next
              // anyway, so treating it as ready is always safe.
              const step =
                session.status === "active" && i === session.cursor && s.status === "locked"
                  ? { ...s, status: "ready" as const }
                  : s;
              return (
                <GuidedStep
                  key={s.key}
                  step={step}
                  index={i}
                  total={session.steps.length}
                  isCurrent={i === session.cursor && session.status === "active"}
                  onRun={runNext}
                  running={busy && i === session.cursor}
                  runStartTs={runStartTs}
                  nextTitle={session.steps[i + 1]?.title}
                  walletLock={walletMismatch ? session.wallet : null}
                  onReconnect={() => void connectWallet()}
                  onAbandon={() => requestLeave("picker")}
                  onOpenMcp={onOpenMcp}
                  predict={PREDICTIONS[predKey]}
                  predicted={predictions[predKey]}
                  onPredict={(choice) => setPredictions((p) => ({ ...p, [predKey]: choice }))}
                />
              );
            })}
          </div>

          {session.wallet &&
            walletAfter != null &&
            (walletBefore != null || walletBeforeFailed) && (
              <div className="lj-wallet-delta">
                <div className="lj-pe-kicker">YOUR WALLET · REAL BALANCE MOVE</div>
                {walletBefore != null ? (
                  <div className="lj-wd-rows">
                    <span>before funding</span>
                    <b className="mono">{walletBefore.toFixed(2)} CSPR</b>
                    <span>advance received</span>
                    <b className="mono good">
                      +{Math.max(0, walletAfter - walletBefore).toFixed(2)} CSPR
                    </b>
                    <span>after funding</span>
                    <b className="mono">{walletAfter.toFixed(2)} CSPR</b>
                  </div>
                ) : (
                  // The pre-funding read failed — show only what we KNOW instead
                  // of inventing a delta from a fake zero.
                  <div className="lj-wd-rows">
                    <span>before funding</span>
                    <b className="mono">unavailable</b>
                    <span>advance expected</span>
                    <b className="mono good">
                      +
                      {(() => {
                        const d = session.steps.find((st) => st.key === "underwrite")?.decision;
                        const face = 2;
                        return d
                          ? ((face * (10_000 - d.discountBps)) / 10_000).toFixed(2)
                          : "≈1.96";
                      })()}{" "}
                      CSPR
                    </b>
                    <span>after funding</span>
                    <b className="mono">{walletAfter.toFixed(2)} CSPR</b>
                  </div>
                )}
              </div>
            )}

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
              <div className="lj-finish-actions">
                {session.displayId && (
                  <a
                    className="linklike"
                    href={`/api/judge/recent/${session.displayId}`}
                    download={`${session.displayId}.json`}
                  >
                    ⬇ Download run receipt (JSON)
                  </a>
                )}
                <button className="lj-run-btn ghost" onClick={reset}>
                  Run another walkthrough →
                </button>
              </div>
              <ProofsCollected session={session} />
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

      {confirmClose && (
        <div className="lj-confirm-bd" onClick={() => setConfirmClose(null)}>
          <div
            className="lj-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-live="assertive"
            ref={confirmRef}
            onClick={(e) => e.stopPropagation()}
          >
            {confirmClose.kind === "settling" ? (
              <>
                <b>A real Casper transaction is still settling.</b>
                <p>
                  Closing this page won&apos;t stop it — the desk finishes the step server-side
                  either way. Best to keep this open a few more seconds and watch it confirm.
                </p>
                <div className="lj-confirm-actions">
                  <button className="lj-wallet-btn" onClick={() => setConfirmClose(null)}>
                    Keep waiting
                  </button>
                  <button className="lj-back" onClick={leaveWithoutAbandon}>
                    Close anyway — the transaction continues
                  </button>
                </div>
              </>
            ) : (
              <>
                <b>Leave this walkthrough?</b>
                <p>
                  <i>Continue later</i> minimizes: a progress pill stays on the homepage and your
                  run resumes exactly where it stopped. <i>Abandon safely</i> ends it server-side
                  and frees the desk (and any payout reservation) for the next visitor.
                </p>
                <div className="lj-confirm-actions">
                  <button className="lj-wallet-btn" onClick={() => setConfirmClose(null)}>
                    Stay
                  </button>
                  <button className="lj-back" onClick={leaveWithoutAbandon}>
                    Continue later
                  </button>
                  <button className="lj-back danger" onClick={() => void abandonSafely()}>
                    Abandon safely
                  </button>
                </div>
              </>
            )}
          </div>
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
 * The MCP agent interface, productized: six tool cards with signature, params,
 * an agent prompt, and a terminal-style demo output. pool_stats and
 * verify_decision_hash can swap their sample for a LIVE call against this very
 * host (same REST endpoints the MCP server wraps) — the JSON shown is exactly
 * what an MCP-connected agent receives.
 */
type McpToolSpec = {
  name: string;
  badge: string;
  badgeKind: "read" | "write" | "pay" | "audit";
  headline: string;
  detail: string;
  params: { k: string; d: string }[];
  ask: string;
  sample: string;
  live?: "pool" | "verify";
};

const MCP_TOOLS: McpToolSpec[] = [
  {
    name: "pool_stats",
    badge: "READ · LIVE CHAIN",
    badgeKind: "read",
    headline: "One call: the whole balance sheet.",
    detail:
      "TVL, LP share price, funded/settled/defaulted totals and the attestation count — read straight from the Casper Testnet contract. Identical output hosted or local.",
    params: [{ k: "—", d: "no arguments" }],
    ask: "What's the state of the Faktura pool right now?",
    live: "pool",
    sample: `{
  "contract": "hash-fb209bb1d3a1d5e6…",
  "tvlCspr": 151.73,
  "liquidCspr": 96.77,
  "deployedCspr": 54.96,
  "lpSharePrice": 0.7586,
  "totalFundedCspr": 233.23,
  "totalSettledCspr": 130.0,
  "totalDefaultedCspr": 51.46,
  "invoiceCount": 27,
  "aiAttestationsOnChain": 14
}`,
  },
  {
    name: "submit_invoice",
    badge: "AI PIPELINE · MODE-AWARE",
    badgeKind: "write",
    headline: "Feed the underwriter a receivable.",
    detail:
      "Runs the REAL pipeline: deterministic pre-checks, live LLM risk scoring, policy clamps. On this hosted showcase the chain writes are simulated ('showcase:'-tagged hashes); a local live-mode stack signs the actual register / fund / attest deploys with your keys.",
    params: [
      { k: "supplierName · debtorName", d: "who sells, who owes" },
      { k: "amountCspr · dueInDays", d: "face value and tenor" },
      { k: "invoiceNumber · description · history?", d: "the paper the model reads" },
      { k: "supplierAddress?", d: "account-hash that receives the advance" },
    ],
    ask: "Sell this 40k receivable from Aurora Retail, due in 30 days — what does the desk say?",
    sample: `{
  "status": "approved",
  "riskScore": 24,
  "discountBps": 260,
  "redFlags": [],
  "rationale": "Established counterparty, 6/6 prior
    invoices paid within terms; 30-day tenor
    supports a sub-3% discount.",
  "decisionHash": "sha256:c9b1e7d40a52f688…",
  "chainTxs": { "registerHash": "showcase:sim…" }
}
// hosted: writes simulated ("showcase:" tag).
// local live mode → real Testnet deploy hashes.`,
  },
  {
    name: "get_risk_report",
    badge: "x402 · MACHINE-PAYABLE",
    badgeKind: "pay",
    headline: "Negotiate an HTTP 402 paywall, agent-to-agent.",
    detail:
      "This tool never spends your money: call once and it returns the 402 PaymentRequirements; YOU pay from any wallet or agent (native CSPR transfer, nonce as transfer-id), call again with the proof, and the verified report unlocks — full canonical decision memo included, ready to re-hash.",
    params: [
      { k: "invoiceId", d: "which credit history to buy" },
      { k: "paymentDeployHash?", d: "your settlement transfer" },
      { k: "nonce?", d: "from the 402 challenge you are settling" },
    ],
    ask: "Buy the risk report for invoice #12 — here's my payment deploy hash.",
    sample: `// call 1 — no proof → the machine-readable paywall
{
  "httpStatus": 402,
  "accepts": [{
    "maxAmountRequired": "2500000000",
    "payTo": "0202bc7169…",
    "extra": { "transferIdNonce": "784551" }
  }]
}
// you pay: 2.5 CSPR native transfer, id = nonce
// call 2 — with deployHash + nonce → unlocked
{
  "httpStatus": 200,
  "riskScore": 24,
  "discountBps": 260,
  "decisionHash": "sha256:c9b1e7d40a52f688…",
  "memo": { "schema": "faktura.decision.v1", "…": "…" }
}`,
  },
  {
    name: "verify_decision_hash",
    badge: "AUDIT · TRUSTLESS",
    badgeKind: "audit",
    headline: "Audit our AI. Don't take our word.",
    detail:
      "Re-computes the SHA-256 of the FULL canonical memo document — rationale and red flags included — then compares that fresh hash against BOTH the local record and the on-chain anchor. Comparing two stored strings would prove nothing; a fresh re-hash betrays any after-the-fact edit.",
    params: [{ k: "invoiceId", d: "on-chain invoice id" }],
    ask: "Prove the AI decision on invoice #12 wasn't rewritten after the fact.",
    live: "verify",
    sample: `{
  "invoiceId": 12,
  "recomputedMemoHash": "sha256:c9b1e7d40a52f688…",
  "storedLocalHash":    "sha256:c9b1e7d40a52f688…",
  "onchainAnchoredHash": "sha256:c9b1e7d40a52f688…",
  "localMatch": true,
  "onchainMatch": true,
  "match": true,
  "verdict": "MATCH — the full memo document
    re-hashes to exactly what was anchored",
  "registerTx": "https://testnet.cspr.live/deploy/…"
}`,
  },
  {
    name: "list_funded_invoices",
    badge: "READ · LIVE BOOK",
    badgeKind: "read",
    headline: "What is the pool exposed to right now?",
    detail:
      "Every invoice currently financed (on-chain state FUNDED) with face, advance, risk score and due date — the live credit book, as an agent sees it.",
    params: [{ k: "—", d: "no arguments" }],
    ask: "Which invoices are we exposed to right now, and when are they due?",
    sample: `{
  "count": 2,
  "funded": [{
    "id": 27,
    "faceCspr": 6.9,
    "advanceCspr": 6.76,
    "riskScore": 18,
    "discountBps": 200,
    "dueIso": "2026-08-17T09:41:22.000Z",
    "decisionHash": "sha256:3e1f0a92c45b8d67…"
  }, …]
}`,
  },
  {
    name: "list_verified_invoices",
    badge: "READ · PRICEABLE UNIVERSE",
    badgeKind: "read",
    headline: "Every credit history you can buy.",
    detail:
      "Only invoices whose canonical memo ACTUALLY verifies make this list — the memo document re-hashes to the local decision hash and matches the on-chain anchor. LISTED, FUNDED, SETTLED or DEFAULTED: a closed receivable still has a verifiable history worth pricing via get_risk_report.",
    params: [{ k: "—", d: "no arguments" }],
    ask: "List every invoice with a verifiable decision memo I could buy a report on.",
    sample: `{
  "count": 4,
  "verified": [
    { "id": 30, "state": "SETTLED",
      "riskScore": 20, "memoVerified": true,
      "decisionHash": "sha256:1cde…" },
    { "id": 27, "state": "FUNDED",
      "riskScore": 18, "memoVerified": true,
      "decisionHash": "sha256:3e1f…" },
    { "id": 25, "state": "DEFAULTED",
      "riskScore": 20, "memoVerified": true,
      "decisionHash": "sha256:5a88…" }
  ]
}`,
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
  /** Per-tool LIVE output (replaces the recorded sample once fetched). */
  const [liveOut, setLiveOut] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
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
  const runLive = async (t: McpToolSpec) => {
    setBusy(t.name);
    try {
      if (t.live === "pool") {
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
              ? Number(
                  ((BigInt(s.liquid) + BigInt(s.deployed)) * 10_000n) / BigInt(s.totalShares),
                ) / 10_000
              : 1,
          totalFundedCspr: cspr(s.totalFunded),
          totalSettledCspr: cspr(s.totalSettled),
          totalDefaultedCspr: cspr(s.totalDefaulted),
          invoiceCount: s.invoiceCount,
          aiAttestationsOnChain: s.attestationCount,
        };
        setLiveOut((o) => ({ ...o, [t.name]: JSON.stringify(body, null, 2) }));
      } else if (t.live === "verify") {
        const [inv, p] = await Promise.all([api.invoices(), api.pool()]);
        const onchainById = new Map(p.onchain.map((o: { id: number }) => [o.id, o]));
        // A verification demo is only honest against a record that HAS the
        // canonical memo document — that is the thing being re-hashed.
        const target = inv.find((r) => r.decision && r.memo && r.id > 0 && onchainById.has(r.id));
        if (!target) {
          setLiveOut((o) => ({
            ...o,
            [t.name]:
              '{ "error": "no invoice with a canonical memo on this host yet — underwrite one first" }',
          }));
          return;
        }
        const onchain = onchainById.get(target.id) as unknown as { decisionHash: string };
        // Re-hash the FULL memo document in the browser — same bytes, same
        // SHA-256 the chain anchors. Comparing two stored strings proves
        // nothing; this proves the story was never rewritten.
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(target.memo)),
        );
        const recomputedMemoHash = `sha256:${[...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`;
        const localMatch = recomputedMemoHash === target.decision!.decisionHash;
        const onchainMatch = recomputedMemoHash === onchain.decisionHash;
        const match = localMatch && onchainMatch;
        const body = {
          invoiceId: target.id,
          recomputedMemoHash,
          storedLocalHash: target.decision!.decisionHash,
          onchainAnchoredHash: onchain.decisionHash,
          localMatch,
          onchainMatch,
          match,
          verdict: match
            ? "MATCH — the full memo document re-hashes to exactly what was anchored on-chain"
            : "MISMATCH — the memo does not re-hash to the anchor",
          registerTx:
            target.chain.registerHash && !isSimulatedHash(target.chain.registerHash)
              ? `${p.explorer}/deploy/${target.chain.registerHash}`
              : undefined,
        };
        setLiveOut((o) => ({ ...o, [t.name]: JSON.stringify(body, null, 2) }));
      }
    } catch {
      notify("Live preview failed — node hiccup, try again");
    } finally {
      setBusy(null);
    }
  };

  const dialogRef = useModalA11y<HTMLDivElement>(true, onClose);
  return (
    <>
      <div className="drawer-backdrop mcp-top-bd" onClick={onClose} />
      <div
        className="drawer mcp-drawer mcp-top mcp2"
        role="dialog"
        aria-modal="true"
        aria-label="MCP Agent Interface"
        ref={dialogRef}
      >
        <div className="mcp2-topbar">
          <span className="mono">MCP AGENT INTERFACE</span>
          <button
            className="mcp2-close"
            onClick={onClose}
            aria-label="Close MCP interface"
            data-autofocus
          >
            ✕ Close
          </button>
        </div>
        {/* ---- hero ---- */}
        <div className="mcp2-hero">
          <div className="mcp2-hero-text">
            <div className="mcp2-kicker">🤖 AGENT-NATIVE INTERFACE · MODEL CONTEXT PROTOCOL</div>
            <h2>
              Your agent talks to this desk directly{" "}
              <span className={`badge ${meta?.mode === "live-testnet" ? "FUNDED" : "LISTED"}`}>
                {meta?.mode === "live-testnet" ? "LIVE TESTNET" : "SHOWCASE"}
              </span>
            </h2>
            <p>
              The whole credit desk — pool, book, underwriter, x402 oracle, audit trail — ships as{" "}
              <b>six MCP tools over stdio</b>, defined in{" "}
              <span className="mono">agents/src/mcp.ts</span>. Point any MCP-capable agent at this
              very host and it can read the chain, drive the pipeline and audit the AI without a
              browser.
            </p>
          </div>
          <div className="mcp2-modes">
            <div className="mcp2-mode">
              <b>◉ HOSTED — this site</b>
              <span>
                Live AI underwriting + live chain reads. Chain <i>writes</i> are simulated
                (&lsquo;showcase:&rsquo; tags) — the guided walkthrough stays the only public
                signing surface.
              </span>
            </div>
            <div className="mcp2-mode">
              <b>◈ LOCAL LIVE — your keys</b>
              <span>
                Clone the repo, add funded testnet keys, and the same six tools sign real Casper
                deploys: register, fund, attest.
              </span>
            </div>
          </div>
        </div>

        {/* ---- quick start ---- */}
        <div className="section">
          <h3>Quick start — three commands</h3>
          <div className="mcp2-qs">
            {[
              { n: "1", label: "one-time setup", cmd: setupCmd },
              { n: "2", label: "speak MCP to this host (from agents/)", cmd: quick },
              { n: "3", label: "or register with Claude Code (from agents/)", cmd: claudeCmd },
            ].map((s) => (
              <div className="mcp2-term mcp2-term-cmd" key={s.n}>
                <div className="mcp2-term-bar">
                  <span className="mcp2-dot r" />
                  <span className="mcp2-dot y" />
                  <span className="mcp2-dot g" />
                  <span className="mcp2-term-title">
                    {s.n} · {s.label}
                  </span>
                  <button className="mcp2-copy" onClick={() => copy(s.cmd)}>
                    ⧉ copy
                  </button>
                </div>
                <pre>
                  <span className="mcp2-prompt">$ </span>
                  {s.cmd}
                </pre>
              </div>
            ))}
          </div>
          <div className="note" style={{ marginTop: 6 }}>
            POSIX shell (macOS / Linux / WSL) · Node 20+. Works with Claude Code, Claude Desktop and
            any MCP client that speaks stdio.
          </div>
        </div>

        {/* ---- the six tools ---- */}
        <div className="section">
          <h3>The six tools — with real output</h3>
          {MCP_TOOLS.map((t, i) => {
            const live = liveOut[t.name];
            return (
              <div className={`mcp2-tool k-${t.badgeKind}`} key={t.name}>
                <div className="mcp2-tool-head">
                  <span className="mcp2-tool-num mono">{String(i + 1).padStart(2, "0")}</span>
                  <b className="mono">{t.name}</b>
                  <span className={`mcp2-badge k-${t.badgeKind}`}>{t.badge}</span>
                </div>
                <div className="mcp2-tool-grid">
                  <div className="mcp2-tool-info">
                    <div className="mcp2-tool-headline">{t.headline}</div>
                    <div className="mcp2-tool-detail">{t.detail}</div>
                    <div className="mcp2-params">
                      {t.params.map((p) =>
                        p.k === "—" ? (
                          <div className="mcp2-param mcp2-param-none" key={p.k}>
                            <span>no arguments — call it bare</span>
                          </div>
                        ) : (
                          <div className="mcp2-param" key={p.k}>
                            <code>{p.k}</code>
                            <span>{p.d}</span>
                          </div>
                        ),
                      )}
                    </div>
                    <div className="mcp2-ask">
                      <span className="mcp2-ask-label">you say</span>
                      <span className="mcp2-ask-text">“{t.ask}”</span>
                    </div>
                  </div>
                  <div className="mcp2-term">
                    <div className="mcp2-term-bar">
                      <span className="mcp2-dot r" />
                      <span className="mcp2-dot y" />
                      <span className="mcp2-dot g" />
                      <span className="mcp2-term-title">faktura-mcp · {t.name}</span>
                      <span className={`mcp2-term-tag ${live ? "live" : ""}`}>
                        {live ? "● LIVE OUTPUT" : "SAMPLE OUTPUT"}
                      </span>
                      {t.live && (
                        <button
                          className="mcp2-copy"
                          disabled={busy === t.name}
                          onClick={() => void runLive(t)}
                          title="Call this host's real REST endpoint — the same one the MCP tool wraps"
                        >
                          {busy === t.name ? "running…" : live ? "↻ re-run live" : "▸ run live"}
                        </button>
                      )}
                    </div>
                    <pre>{live ?? t.sample}</pre>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ---- footer ---- */}
        <div className="mcp2-foot">
          <div className="mcp2-foot-works">
            works with <b>Claude Code</b> · <b>Claude Desktop</b> · any stdio MCP client
          </div>
          <button className="btn-agent solid" onClick={() => copy(claudeCmd)}>
            ⧉ Copy the install command
          </button>
          <span className="mcp2-foot-note">
            Every guided-walkthrough step also advertises the tool that drives or audits it — run
            one, then let your agent redo it.
          </span>
        </div>
      </div>
    </>
  );
}
