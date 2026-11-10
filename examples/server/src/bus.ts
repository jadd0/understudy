import { eq } from "drizzle-orm";
import type { EngineDb, Events, HostPort } from "@jadd0/understudy-engine";
import { messages, offers } from "@jadd0/understudy-engine/schema";
import type { Webhook } from "./webhook";

export type Listener = (event: string, data: unknown) => void;

export interface Bus extends Events {
  /** Listens to one conversation's stream; returns the function that stops it. */
  subscribe(conversationId: string, listener: Listener): () => void;
  /** Listeners across all conversations; back to 0 when every client has gone. */
  subscriberCount(): number;
  /** Cancels bubbles still waiting for their delay. */
  close(): void;
}

export interface BusOptions {
  db: EngineDb;
  host: Pick<HostPort, "items">;
  webhook?: Webhook;
}

export interface Bubble {
  id: string;
  sender: string;
  body: string;
  offer?: { id: string; itemId: string; title: string; priceCents: number };
}

/**
 * The in-process `Events` adapter. The engine says a bubble exists and when it is due; the bus waits that long,
 * re-reads the row (a takeover may have superseded it meanwhile) and hands it to every open stream of the
 * conversation. Every event, delivered or not, also goes to the webhook.
 */
export function createBus(opts: BusOptions): Bus {
  const listeners = new Map<string, Set<Listener>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const publish = (conversationId: string, event: string, data: unknown) => {
    for (const l of [...(listeners.get(conversationId) ?? [])]) {
      try {
        l(event, data);
      } catch {
        // A stream that cannot be written to is closing; its own close handler unsubscribes it.
      }
    }
  };

  async function loadBubble(messageId: string): Promise<(Bubble & { status: string }) | null> {
    const [row] = await opts.db
      .select({
        id: messages.id,
        sender: messages.sender,
        body: messages.body,
        status: messages.status,
        offerId: offers.id,
        itemId: offers.itemId,
        priceCents: offers.priceCents,
      })
      .from(messages)
      .leftJoin(offers, eq(offers.id, messages.offerId))
      .where(eq(messages.id, messageId));
    if (!row) return null;
    const bubble: Bubble & { status: string } = { id: row.id, sender: row.sender, body: row.body, status: row.status };
    if (row.offerId && row.itemId && row.priceCents !== null) {
      const title = (await opts.host.items([row.itemId])).get(row.itemId)?.title ?? "";
      bubble.offer = { id: row.offerId, itemId: row.itemId, title, priceCents: row.priceCents };
    }
    return bubble;
  }

  async function deliver(conversationId: string, messageId: string) {
    const bubble = await loadBubble(messageId);
    if (!bubble || bubble.status !== "sent") return;
    const { status: _status, ...data } = bubble;
    void _status;
    publish(conversationId, "message", data);
    opts.webhook?.send({ event: "message.delivered", conversationId, messageId });
  }

  return {
    async emit(channel, event, payload) {
      const conversationId = channel.startsWith("conversation:") ? channel.slice("conversation:".length) : null;
      opts.webhook?.send({ ...payload, event, channel, conversationId: conversationId ?? (payload.conversationId as string | undefined) ?? null });
      if (!conversationId) return;
      if (event === "typing") publish(conversationId, "typing", { holdMs: payload.holdMs });
      else if (event === "conversation.mode") publish(conversationId, "mode", { mode: payload.mode });
      else if (event === "message.created") {
        const delay = Math.max(0, Number(payload.deliverInMs) || 0);
        const messageId = String(payload.messageId);
        const t = setTimeout(() => {
          timers.delete(t);
          deliver(conversationId, messageId).catch((e) => console.error(`bus: delivery failed ${(e as Error)?.name ?? "error"}`));
        }, delay);
        timers.add(t);
      }
    },
    subscribe(conversationId, listener) {
      const set = listeners.get(conversationId) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(conversationId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(conversationId);
      };
    },
    subscriberCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
