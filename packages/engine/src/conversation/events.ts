import { sql } from "drizzle-orm";
import { getConfig } from "../config/load";
import type { EngineCtx } from "../ctx";
import type { JevLine } from "../drafting/thread";

/** The client message id prefix of the system row a tip leaves in the chat (`tip:<fan>:<key>`). */
export const TIP_ROW_PREFIX = "tip:";

/**
 * Something the fan did in the app that she should react to: a tip (its system row's id) or an unlock (the offer's
 * id and the item's title). Never an amount: the model is not told what anything cost.
 */
export type PendingEvent = { kind: "tip"; id: string } | { kind: "unlock"; id: string; title: string };

/** What a turn records in `jev_in.events`, so the same unlock is never reacted to twice. */
export interface EventRecord {
  tips: string[];
  unlocks: string[];
}

export const eventRecord = (events: readonly PendingEvent[]): EventRecord => ({
  tips: events.filter((e) => e.kind === "tip").map((e) => e.id),
  unlocks: events.filter((e) => e.kind === "unlock").map((e) => e.id),
});

/**
 * Tips and unlocks in this conversation that no turn has reacted to yet, oldest first. A tip is waiting while its
 * system row has no `turn_id`; an unlock while no applied turn lists its offer in `jev_in.events.unlocks`. Only
 * events from the last `windowMinutes`, and newer than the last message a human sent (a human who wrote since has
 * already had the chance to react), count, so older rows written before reactions existed are never thanked.
 */
export async function loadEvents(ctx: EngineCtx, conversationId: string, windowMinutes: number): Promise<PendingEvent[]> {
  const { rows } = await ctx.db.execute(sql`
    with human as (
      select coalesce(max(created_at), '-infinity'::timestamptz) as at from messages
      where conversation_id = ${conversationId} and sender in ('creator', 'admin') and status = 'sent'
    )
    select 'tip' as kind, m.id, null::uuid as item_id, m.created_at as at
    from messages m, human
    where m.conversation_id = ${conversationId} and m.sender = 'system' and m.status = 'sent' and m.turn_id is null
      and m.client_msg_id like ${`${TIP_ROW_PREFIX}%`}
      and m.created_at > now() - make_interval(mins => ${windowMinutes}::int) and m.created_at > human.at
    union all
    select 'unlock' as kind, o.id, o.item_id, o.resolved_at as at
    from offers o, human
    where o.conversation_id = ${conversationId} and o.status = 'accepted'
      and o.resolved_at > now() - make_interval(mins => ${windowMinutes}::int) and o.resolved_at > human.at
      and not exists (
        select 1 from turns t
        where t.conversation_id = ${conversationId} and t.outcome not in ('superseded', 'error')
          and coalesce(t.jev_in -> 'events' -> 'unlocks', '[]'::jsonb) @> jsonb_build_array(o.id::text))
    order by at, id`);
  const found = rows as { kind: "tip" | "unlock"; id: string; item_id: string | null }[];
  const items = await ctx.host.items(found.flatMap((r) => (r.item_id ? [r.item_id] : [])));
  return found.map((r) =>
    r.kind === "tip" ? { kind: "tip", id: r.id } : { kind: "unlock", id: r.id, title: (r.item_id && items.get(r.item_id)?.title) || "" },
  );
}

/** Whether a conversation holds an event still waiting for a reaction; reads the window for its creator. */
export async function hasPendingEvents(ctx: EngineCtx, conversationId: string, creatorId: string): Promise<boolean> {
  const windowMinutes = await getConfig<number>(ctx, "engine.event_window_minutes", creatorId);
  return (await loadEvents(ctx, conversationId, windowMinutes)).length > 0;
}

/** Jev's view of an event: a platform line in `earlier_messages`, with no amount. */
export function eventJevLines(events: readonly PendingEvent[]): JevLine[] {
  return events.map((e) => ({ from: "platform" as const, text: e.kind === "tip" ? "He just sent her a tip." : `He just unlocked her ${e.title}.` }));
}

/** The marker that ends Claude's chat on a turn with no new fan message, so the reply is a new message, not a continuation of her last. */
export function eventMarker(events: readonly PendingEvent[]): string {
  const parts = events.map((e) => (e.kind === "tip" ? "he sent you a tip" : `he unlocked ${e.title}`));
  return `— ${[...new Set(parts)].join(", ")} —`;
}

/** One offer from this chat as Claude is told about it: the item's title and what became of it. Never a price. */
export interface OfferOutcome {
  title: string;
  outcome: "owned" | "open" | "declined" | "expired";
}

/**
 * The latest offer of each item in this conversation, newest first, at most `limit`. "Owned" comes from the fan's
 * unlocks, not the offer's status: a re-offer of an item he already had may be open, declined or expired, and he
 * still owns it.
 */
export async function loadOfferOutcomes(ctx: EngineCtx, conversationId: string, fanId: string, limit: number): Promise<OfferOutcome[]> {
  if (limit <= 0) return [];
  const { rows } = await ctx.db.execute(sql`
    select item_id, outcome from (
      select distinct on (o.item_id) o.item_id, o.created_at,
        case
          when o.status = 'open' and o.expires_at > now() then 'open'
          when o.status = 'declined' then 'declined'
          else 'expired'
        end as outcome
      from offers o
      where o.conversation_id = ${conversationId}
      order by o.item_id, o.created_at desc, o.id desc
    ) latest
    order by created_at desc
    limit ${limit}`);
  const latest = rows as { item_id: string; outcome: Exclude<OfferOutcome["outcome"], "owned"> }[];
  const ids = latest.map((r) => r.item_id);
  const [items, owned] = await Promise.all([ctx.host.items(ids), ctx.host.owns(fanId, ids)]);
  return latest.map((r) => ({ title: items.get(r.item_id)?.title ?? "", outcome: owned.has(r.item_id) ? "owned" : r.outcome }));
}
