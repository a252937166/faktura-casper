/**
 * Release provenance, injected at deploy time (systemd env file):
 *   FAKTURA_RELEASE   — git tag of the running build (e.g. v0.2.4-final)
 *   FAKTURA_GIT_SHA   — exact commit the bundle was built from
 *   FAKTURA_BUILD_TIME — ISO timestamp of the build
 * Surfaced on /api/meta, /api/judge/health and every downloadable receipt so
 * an auditor can pin any observed behavior to an exact commit.
 */
export const RELEASE = {
  release: process.env.FAKTURA_RELEASE ?? "dev",
  gitSha: process.env.FAKTURA_GIT_SHA ?? "unknown",
  builtAt: process.env.FAKTURA_BUILD_TIME ?? "unknown",
};
