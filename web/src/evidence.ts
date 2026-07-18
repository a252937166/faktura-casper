/**
 * THE single source of truth for every on-chain evidence link the site shows.
 *
 * Rule: no transaction hash is ever hand-typed in a component. Components
 * import from here; this file is updated only from verified explorer links
 * (each value below was resolved against the live testnet RPC before being
 * committed). README.md / DORAHACKS.md quote the same values.
 */

export const EXPLORER = "https://testnet.cspr.live";

export const EVIDENCE = {
  /** FakturaHub contract package on Casper Testnet. */
  contractPackage: "fb209bb1d3a1d5e675841f7d184ab7fa96d65adc099f6fd0105f29115fb49d7e",
  contractPackageUrl: `${EXPLORER}/contract-package/fb209bb1d3a1d5e675841f7d184ab7fa96d65adc099f6fd0105f29115fb49d7e`,

  /** Contract deploy transaction. */
  deployTx: "b59b32927dc57f614a56de4012990f4303542ac12f821c21e0408ade3fe90d5d",
  deployTxUrl: `${EXPLORER}/transaction/b59b32927dc57f614a56de4012990f4303542ac12f821c21e0408ade3fe90d5d`,

  /**
   * The canonical policy-firewall revert: fund_invoice REVERTED with
   * `User error: 15` (SingleInvoiceCapExceeded) after the AI approved the
   * invoice — verified on-chain (2026-07-04, execution error_message
   * "User error: 15"). The guided walkthrough reproduces this on demand.
   */
  policyRevertTx: "830ebd775835ffdeba1122b99695a0bf589de442f80d1c31c1d43c4e7039aaea",
  policyRevertTxUrl: `${EXPLORER}/transaction/830ebd775835ffdeba1122b99695a0bf589de442f80d1c31c1d43c4e7039aaea`,
  policyRevertError: "User error: 15 (SingleInvoiceCapExceeded)",

  /** Submission artifacts. */
  repoUrl: "https://github.com/a252937166/faktura-casper",
  // Pinned to the release TAG (not a moving branch) so the evidence a judge
  // opens is exactly what was frozen at submission time.
  evidencePackUrl: "https://github.com/a252937166/faktura-casper/blob/v0.2.4-final/DORAHACKS.md",
  releaseTag: "v0.2.3-final",
  releaseUrl: "https://github.com/a252937166/faktura-casper/releases/tag/v0.2.3-final",
  videoUrl: "https://youtu.be/47ZNPZlRXVA",
} as const;
