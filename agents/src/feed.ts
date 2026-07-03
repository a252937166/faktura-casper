import { EventEmitter } from "node:events";

/** A single line in the live agent activity feed (also persisted). */
export interface FeedEvent {
  ts: number;
  actor: "underwriter" | "collector" | "oracle" | "system";
  kind: string;
  message: string;
  /** Related invoice id, if any. */
  invoiceId?: number;
  /** On-chain deploy hash, if the action produced one. */
  deployHash?: string;
  /** Extra payload for the UI. */
  data?: Record<string, unknown>;
}

class Feed extends EventEmitter {
  history: FeedEvent[] = [];

  publish(event: Omit<FeedEvent, "ts">) {
    const full: FeedEvent = { ts: Date.now(), ...event };
    this.history.push(full);
    if (this.history.length > 500) this.history.shift();
    this.emit("event", full);
    const tag = full.actor.toUpperCase().padEnd(11);
    console.log(`[${new Date(full.ts).toISOString()}] ${tag} ${full.message}`);
    return full;
  }
}

export const feed = new Feed();
