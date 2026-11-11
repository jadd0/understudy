import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { getConfig } from "../config/load.js";
import type { EngineCtx } from "../ctx.js";
import { processConversation } from "../turn/process.js";
import { conversations, handoffs } from "../db/schema.js";
import { describeError } from "../turn/result.js";
import type { HandoffReason } from "../types.js";

export interface EscalationResult {
  autoResolved: number;
  tsBreaches: number;
}

/** One pass handles at most this many rows, so a backlog never outruns the sweep's function budget. */
const MAX_ROWS_PER_PASS = 50;

/** The channel the Trust & Safety breach is announced on. */
export const OPS_CHANNEL = "ops";

/**
 * Settles what has waited too long, once per sweep. An unclaimed creator-queue handoff past its due time whose
 * reason the config lists is resolved by policy: the chat goes back to the AI, which answers what is waiting, and
 * the same chat's next hold is a deflect for a while. A claimed handoff has a person on it and is never touched.
 * A Trust & Safety handoff past its due time is stamped late once and announced; a timer never resolves it.
 * Every comparison uses the database clock.
 */
export async function runEscalations(ctx: EngineCtx): Promise<EscalationResult> {
  const resolved = await resolveDueCreatorHandoffs(ctx);
  for (const r of resolved) {
    await ctx.deps.events
      .emit(`creator:${r.creatorId}`, "inbox.changed", { conversationId: r.conversationId })
      .catch((e) => console.error(`engine: emit failed ${describeError(e)}`));
    if (!r.handedBack) continue;
    await ctx.deps.events
      .emit(`conversation:${r.conversationId}`, "conversation.mode", { conversationId: r.conversationId })
      .catch((e) => console.error(`engine: emit failed ${describeError(e)}`));
    // Outside the transaction: a turn takes its own lease and calls the providers.
    await processConversation(ctx, r.conversationId).catch((e) => console.error(`engine: escalation answer ${describeError(e)}`));
  }
  return { autoResolved: resolved.length, tsBreaches: await stampTsBreaches(ctx) };
}

interface Resolved {
  conversationId: string;
  creatorId: string;
  /** The chat went back to the AI; an alert is resolved without moving the mode. */
  handedBack: boolean;
}

async function resolveDueCreatorHandoffs(ctx: EngineCtx): Promise<Resolved[]> {
  const owners = await ctx.db.execute(sql`
    select distinct c.creator_id from handoffs h join conversations c on c.id = h.conversation_id
    where h.queue = 'creator' and h.status = 'open' and h.due_at < now()`);
  const done: Resolved[] = [];
  for (const { creator_id: creatorId } of owners.rows as { creator_id: string }[]) {
    const room = MAX_ROWS_PER_PASS - done.length;
    if (room <= 0) break;
    const reasons = await getConfig<HandoffReason[]>(ctx, "escalation.auto_resolve_reasons", creatorId);
    if (reasons.length === 0) continue;
    const suppressMinutes = await getConfig<number>(ctx, "escalation.hold_suppress_minutes", creatorId);
    const due = await ctx.db
      .select({ id: handoffs.id, conversationId: handoffs.conversationId })
      .from(handoffs)
      .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
      .where(
        and(
          eq(conversations.creatorId, creatorId),
          eq(handoffs.queue, "creator"),
          eq(handoffs.status, "open"),
          lt(handoffs.dueAt, sql`now()`),
          inArray(handoffs.reason, reasons),
        ),
      )
      .orderBy(asc(handoffs.dueAt), asc(handoffs.id))
      .limit(room);
    for (const row of due) {
      try {
        const r = await resolveOne(ctx, row.id, row.conversationId, creatorId, suppressMinutes);
        if (r) done.push(r);
      } catch (e) {
        console.error(`engine: escalation ${describeError(e)}`);
      }
    }
  }
  return done;
}

/**
 * One handoff, under the conversation's lock (conversation before anything else, as everywhere). The checks that
 * chose it are made again here: a person who took the chat between the read and the lock wins.
 */
async function resolveOne(ctx: EngineCtx, handoffId: string, conversationId: string, creatorId: string, suppressMinutes: number): Promise<Resolved | null> {
  return ctx.db.transaction(async (tx) => {
    const [conv] = await tx.select({ mode: conversations.mode }).from(conversations).where(eq(conversations.id, conversationId)).for("update");
    if (!conv) return null;
    const [h] = await tx
      .select({ reason: handoffs.reason })
      .from(handoffs)
      .where(and(eq(handoffs.id, handoffId), eq(handoffs.queue, "creator"), eq(handoffs.status, "open"), lt(handoffs.dueAt, sql`now()`)))
      .for("update");
    if (!h) return null;
    // An alert never held the chat, so there is nothing to give back; every other reason did.
    const alertOnly = h.reason === "high_value_alert";
    if (!alertOnly && conv.mode !== "handoff_creator") return null;

    await tx
      .update(handoffs)
      .set({ status: "resolved", resolvedAt: sql`now()`, resolvedBy: "sla" })
      .where(eq(handoffs.id, handoffId));
    if (!alertOnly) {
      await tx
        .update(conversations)
        .set({
          mode: "ai",
          version: sql`${conversations.version} + 1` as unknown as number,
          leaseToken: null,
          leaseUntil: null,
          failedTurns: 0,
          holdSuppressedUntil: sql`now() + ${suppressMinutes}::numeric * interval '1 minute'` as unknown as Date,
        })
        .where(eq(conversations.id, conversationId));
    }
    return { conversationId, creatorId, handedBack: !alertOnly };
  });
}

/** Stamps each late, unclaimed Trust & Safety handoff once and announces it (an admin who claimed it is on it). Nothing else about it changes. */
async function stampTsBreaches(ctx: EngineCtx): Promise<number> {
  const { rows } = await ctx.db.execute(sql`
    update handoffs set sla_breached_at = now()
    where id in (
      select id from handoffs
      where queue = 'ts' and status = 'open' and due_at < now() and sla_breached_at is null
      order by due_at, id limit ${MAX_ROWS_PER_PASS}
      for update skip locked)
    and sla_breached_at is null
    returning id, conversation_id, reason`);
  for (const r of rows as { id: string; conversation_id: string; reason: string }[]) {
    await ctx.deps.events
      .emit(OPS_CHANNEL, "ts.sla_breached", { conversationId: r.conversation_id, handoffId: r.id, reason: r.reason })
      .catch((e) => console.error(`engine: emit failed ${describeError(e)}`));
  }
  return rows.length;
}
