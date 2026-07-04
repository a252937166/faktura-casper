import { chain } from "./chain.js";
import { config } from "./config.js";
import { feed } from "./feed.js";
import { findByChainId, upsertInvoice } from "./store.js";

const GRACE_MS = Number(process.env.FAKTURA_GRACE_MS ?? 90_000);

/**
 * The collector agent: watches funded invoices on-chain, reconciles local
 * state with chain state (settlements arrive from debtors directly), and
 * autonomously writes off invoices that blow past due date + grace.
 */
export function startCollector() {
  let running = false;

  const tick = async () => {
    if (running || !config.contract) return;
    running = true;
    try {
      const invoices = await chain.invoices(1, 500);
      for (const inv of invoices) {
        const local = findByChainId(inv.id);

        // Reconcile settlements observed on-chain.
        if (inv.state === 2 && local && local.status !== "settled") {
          local.status = "settled";
          upsertInvoice(local);
          feed.publish({
            actor: "collector",
            kind: "reconcile",
            message: `Invoice #${inv.id} settled on-chain — face value collected, yield realized by the pool`,
            invoiceId: inv.id,
          });
          await safeAttest("SETTLE_CONFIRM", inv.id);
        }

        // Autonomous default handling.
        if (inv.state === 1 && Date.now() > inv.dueTs + GRACE_MS) {
          feed.publish({
            actor: "collector",
            kind: "default",
            message: `Invoice #${inv.id} is ${Math.round((Date.now() - inv.dueTs) / 1000)}s past due (grace ${GRACE_MS / 1000}s) — marking default`,
            invoiceId: inv.id,
          });
          try {
            const res = await chain.markDefault(inv.id);
            if (local) {
              local.status = "defaulted";
              local.chain.defaultHash = res.deployHashes.at(-1);
              upsertInvoice(local);
            }
            feed.publish({
              actor: "collector",
              kind: "onchain",
              message: `Invoice #${inv.id} written off on-chain; loss absorbed by pool share price`,
              invoiceId: inv.id,
              deployHash: res.deployHashes.at(-1),
            });
            await safeAttest("DEFAULT_FLAG", inv.id);
          } catch (e) {
            feed.publish({
              actor: "system",
              kind: "warn",
              message: `mark_default(${inv.id}) failed: ${(e as Error).message.slice(0, 160)}`,
            });
          }
        }
      }
    } catch (e) {
      feed.publish({
        actor: "system",
        kind: "warn",
        message: `collector tick failed: ${(e as Error).message.slice(0, 160)}`,
      });
    } finally {
      running = false;
    }
  };

  setInterval(tick, config.collector.intervalMs);
  feed.publish({
    actor: "collector",
    kind: "boot",
    message: `Collector agent online — watching due dates every ${config.collector.intervalMs / 1000}s (grace ${GRACE_MS / 1000}s)`,
  });
}

async function safeAttest(kind: string, id: number) {
  try {
    const att = await chain.attest(
      kind,
      id,
      `sha256:auto-${kind}-${id}`,
      "collector-v1",
      "collector",
    );
    const local = findByChainId(id);
    if (local) {
      local.chain.attestHashes.push(att.deployHashes.at(-1) ?? "");
      upsertInvoice(local);
    }
  } catch {
    /* attestation is best-effort */
  }
}
