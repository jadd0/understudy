import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { EngineCtx } from "./ctx";
import { messages } from "./schema";
import { hasPendingEvents, loadEvents } from "./events";
import type { ChatMessage } from "./thread";

interface InboundRow {
  id: string;
  body: string;
}

/**
 * Fan messages no turn has answered, newer than the last message a human sent. AI replies do not count: a turn
 * stamps what it answered, so a fan message that arrived while a reply was being written is still waiting.
 */
export async function loadInbound(ctx: EngineCtx, conversationId: string): Promise<InboundRow[]> {
  const { rows } = await ctx.db.execute(sql`
    select m.id, m.body from messages m
    where m.conversation_id = ${conversationId} and m.sender = 'fan' and m.turn_id is null
      and m.created_at > coalesce((select max(o.created_at) from messages o
                                   where o.conversation_id = ${conversationId} and o.sender in ('creator', 'admin') and o.status = 'sent'),
                                  'epoch'::timestamptz)
    order by m.created_at, m.id`);
  return rows as unknown as InboundRow[];
}

/** Rows read per round of history; bounds the query, and `lastRounds` then cuts at round boundaries. */
export const HISTORY_ROWS_PER_ROUND = 30;

export async function loadHistory(ctx: EngineCtx, conversationId: string, rounds: number): Promise<ChatMessage[]> {
  const rows = await ctx.db
    .select({ id: messages.id, sender: messages.sender, body: messages.body, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "sent"), ne(messages.sender, "system")))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(Math.max(1, rounds) * HISTORY_ROWS_PER_ROUND);
  return rows.reverse();
}

/** True while the fan's composer says he is typing (database clock). */
export async function loadTyping(ctx: EngineCtx, conversationId: string): Promise<boolean> {
  const { rows } = await ctx.db.execute(sql`select coalesce(fan_typing_until > now(), false) as typing from conversations where id = ${conversationId}`);
  return (rows[0] as { typing: boolean } | undefined)?.typing ?? false;
}

/** True when unanswered fan messages, or tips and unlocks, exist beyond the ones the draft's pass saw. */
export async function newWorkSince(ctx: EngineCtx, conversationId: string, seen: readonly string[], windowMinutes: number): Promise<boolean> {
  const [inbound, events] = await Promise.all([loadInbound(ctx, conversationId), loadEvents(ctx, conversationId, windowMinutes)]);
  return [...inbound.map((m) => m.id), ...events.map((e) => e.id)].some((id) => !seen.includes(id));
}

/** Whether a conversation holds anything a turn should still take: an unanswered fan message or a pending event. */
export async function hasPendingWork(ctx: EngineCtx, conversationId: string, creatorId: string): Promise<boolean> {
  const [inbound, events] = await Promise.all([loadInbound(ctx, conversationId), hasPendingEvents(ctx, conversationId, creatorId)]);
  return inbound.length > 0 || events;
}
