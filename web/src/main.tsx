import ReactDOM from "react-dom/client";
import { ClickProvider } from "@make-software/csprclick-ui";
import { CONTENT_MODE } from "@make-software/csprclick-core-types";
import App from "./App";
import "./styles.css";

/**
 * CSPR.click multi-wallet sign-in (Casper Wallet, Ledger, MetaMask Snap,
 * Torus). The template appId works on localhost; production uses our own id
 * (VITE_CSPRCLICK_APP_ID at build time). If the SDK cannot load, the app
 * falls back to the direct Casper Wallet extension path — connect never dies.
 * No StrictMode: its double-mount re-initializes the SDK iframe.
 */
const clickOptions = {
  appName: "Faktura",
  appId: import.meta.env.VITE_CSPRCLICK_APP_ID ?? "csprclick-template",
  contentMode: CONTENT_MODE.IFRAME,
  providers: ["casper-wallet", "ledger", "metamask-snap", "torus-wallet"],
  chainName: "casper-test",
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ClickProvider options={clickOptions}>
    <App />
  </ClickProvider>,
);
