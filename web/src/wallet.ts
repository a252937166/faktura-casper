/**
 * Casper Wallet (browser extension) integration — connect-only.
 *
 * We only ever ask for the visitor's PUBLIC key so the desk can pay the
 * invoice advance to their own wallet in the live walkthrough. No signing,
 * no transaction requests, nothing leaves the wallet.
 *
 * The extension injects `window.CasperWalletProvider` (a factory) and fires
 * `CasperWalletEventTypes` events on window when the active key changes.
 */

interface CasperWalletProviderLike {
  requestConnection(): Promise<boolean>;
  disconnectFromSite(): Promise<boolean>;
  isConnected(): Promise<boolean>;
  getActivePublicKey(): Promise<string>;
}

declare global {
  interface Window {
    CasperWalletProvider?: (options?: { timeout?: number }) => CasperWalletProviderLike;
    CasperWalletEventTypes?: Record<string, string>;
  }
}

export interface WalletState {
  /** Extension detected in this browser. */
  available: boolean;
  /** Connected & unlocked with an active key. */
  connected: boolean;
  /** Active public key hex (01… / 02…), lowercase. */
  publicKey: string | null;
  /** Last connect error worth showing (extension locked, user rejected…). */
  error: string | null;
}

let state: WalletState = { available: false, connected: false, publicKey: null, error: null };
const listeners = new Set<(s: WalletState) => void>();
let provider: CasperWalletProviderLike | null = null;

function emit(next: Partial<WalletState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l(state));
}

function getProvider(): CasperWalletProviderLike | null {
  if (provider) return provider;
  if (typeof window.CasperWalletProvider === "function") {
    provider = window.CasperWalletProvider();
  }
  return provider;
}

/** The extension injects lazily — poll briefly at startup before giving up. */
function detect(triesLeft = 10) {
  if (getProvider()) {
    emit({ available: true });
    void restore();
    return;
  }
  if (triesLeft > 0) setTimeout(() => detect(triesLeft - 1), 300);
}

async function restore() {
  const p = getProvider();
  if (!p) return;
  try {
    if (await p.isConnected()) {
      const key = await p.getActivePublicKey();
      emit({ connected: true, publicKey: key.toLowerCase(), error: null });
    }
  } catch {
    /* locked or not yet approved — stay disconnected quietly */
  }
}

export function initWallet(onChange: (s: WalletState) => void): () => void {
  listeners.add(onChange);
  onChange(state);
  detect();

  const onKeyChanged = (e: Event) => {
    try {
      const detail = JSON.parse((e as CustomEvent).detail);
      if (detail?.activeKey)
        emit({ connected: true, publicKey: String(detail.activeKey).toLowerCase() });
    } catch {
      /* malformed event — ignore */
    }
  };
  const onDisconnected = () => emit({ connected: false, publicKey: null });
  const types = window.CasperWalletEventTypes;
  if (types) {
    window.addEventListener(types.ActiveKeyChanged, onKeyChanged);
    window.addEventListener(types.Connected, onKeyChanged);
    window.addEventListener(types.Disconnected, onDisconnected);
  }
  return () => {
    listeners.delete(onChange);
    if (types) {
      window.removeEventListener(types.ActiveKeyChanged, onKeyChanged);
      window.removeEventListener(types.Connected, onKeyChanged);
      window.removeEventListener(types.Disconnected, onDisconnected);
    }
  };
}

export async function connectWallet(): Promise<void> {
  const p = getProvider();
  if (!p) {
    window.open("https://www.casperwallet.io/", "_blank", "noreferrer");
    return;
  }
  try {
    emit({ error: null });
    const ok = await p.requestConnection();
    if (!ok) {
      emit({ error: "Connection was declined in the wallet." });
      return;
    }
    const key = await p.getActivePublicKey();
    emit({ connected: true, publicKey: key.toLowerCase(), error: null });
  } catch (e) {
    emit({
      error: (e as Error)?.message?.slice(0, 120) || "Wallet is locked — unlock it and retry.",
    });
  }
}

export async function disconnectWallet(): Promise<void> {
  const p = getProvider();
  try {
    await p?.disconnectFromSite();
  } catch {
    /* already disconnected */
  }
  emit({ connected: false, publicKey: null, error: null });
}

export const shortKey = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;
