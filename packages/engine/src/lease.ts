import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { EngineCtx } from "./ctx";
import { msTotalOf, turnValues } from "./record";
import type { TurnRecord } from "./plan";
import { conversations, handoffs, messages, turns } from "./schema";
import { openHandoff, type HandoffSla } from "./handoff";

export interface Lease {
  conversationId: string;
  token: string;
  version: number;
  creatorId: string;
  fanId: string;
}

/**
 * Takes the conversation for one turn, or returns null. Only an AI-mode conversation with the AI switched on for
 * both the conversation and the creator, and no live lease, can be taken. All time is the database clock.
 */
export async function acquireLease(ctx: EngineCtx, conversationId: string, leaseMs: number): Promise<Lease | null> {
  const token = randomUUID();
  const { rows } = await ctx.db.execute(sql`
    update conversations c
    set lease_token = ${token}::uuid, lease_until = now() + make_interval(secs => ${leaseMs / 1000})
    where c.id = ${conversationId} and c.mode = 'ai' and c.ai_enabled
      and (c.lease_until is null or c.lease_until < now())
      and coalesce((select s.ai_enabled from creator_settings s where s.creator_id = c.creator_id), true)
    returning c.version, c.creator_id as "creatorId", c.fan_id as "fanId"`);
  const row = rows[0] as { version: number; creatorId: string; fanId: string } | undefined;
  return row ? { conversationId, token, version: row.version, creatorId: row.creatorId, fanId: row.fanId } : null;
}

/** Gives the conversation back without a commit. A no-op if the lease is no longer ours. */
export async function releaseLease(ctx: EngineCtx, lease: Lease): Promise<void> {
  await ctx.db
    .update(conversations)
    .set({ leaseToken: null, leaseUntil: null })
    .where(and(eq(conversations.id, lease.conversationId), eq(conversations.leaseToken, lease.token)));
}

export interface FailureResult {
  failedTurns: number;
  escalated: boolean;
  turnId: string;
}

/**
 * A turn that could not finish (decider down, generator error, config or persona missing): no reply, a turn row
 * with outcome `error`, the lease released and the conversation left in AI mode. Reaching `maxAttempts` failed
 * turns in a row hands the conversation to the creator.
 */
export async function recordFailure(ctx: EngineCtx, lease: Lease, rec: TurnRecord, maxAttempts: number, sla: HandoffSla): Promise<FailureResult> {
  return ctx.db.transaction(async (tx) => {
    const [conv] = await tx
      .update(conversations)
      .set({ failedTurns: sql`${conversations.failedTurns} + 1` as unknown as number, leaseToken: null, leaseUntil: null })
      .where(and(eq(conversations.id, lease.conversationId), eq(conversations.leaseToken, lease.token)))
      .returning({ failedTurns: conversations.failedTurns, mode: conversations.mode });

    let handoffId: string | null = null;
    let escalated = false;
    if (conv && conv.failedTurns >= maxAttempts && conv.mode === "ai") {
      handoffId = await openHandoff(tx, lease.conversationId, "creator", "engine_error", sla);
      await tx
        .update(conversations)
        .set({ mode: "handoff_creator", version: sql`${conversations.version} + 1` as unknown as number })
        .where(eq(conversations.id, lease.conversationId));
      escalated = true;
    }
    const [turn] = await tx
      .insert(turns)
      .values({ ...turnValues(lease.conversationId, rec, "error"), handoffId, msTotal: await msTotalOf(tx, rec.inboundIds) })
      .returning({ id: turns.id });
    return { failedTurns: conv?.failedTurns ?? 0, escalated, turnId: turn.id };
  });
}

/**
 * Hands a conversation back to the AI. Messages a human already handled stay unanswered by the AI: every fan
 * message older than the last human message and still waiting for a turn is stamped with a sentinel turn, in the
 * same transaction as the mode change. Later messages are answered by the next AI turn.
 * `allWaiting` stamps every waiting fan message instead: a Trust & Safety release, where whatever the fan wrote
 * while support held the chat was written to support, not to her.
 */
export async function handBack(ctx: Pick<EngineCtx, "db">, conversationId: string, opts: { allWaiting?: boolean } = {}): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [conv] = await tx
      .update(conversations)
      .set({ mode: "ai", version: sql`${conversations.version} + 1` as unknown as number, leaseToken: null, leaseUntil: null, failedTurns: 0 })
      .where(eq(conversations.id, conversationId))
      .returning({ id: conversations.id });
    if (!conv) return;
    await tx
      .update(handoffs)
      .set({ status: "resolved", resolvedAt: sql`now()`, resolvedBy: "human" })
      .where(and(eq(handoffs.conversationId, conversationId), ne(handoffs.status, "resolved")));
    // Only messages a human already had the chance to answer: those older than the last human message. A fan
    // message written after it, or with no human message at all, is still waiting for the AI.
    const waiting = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.sender, "fan"),
          sql`${messages.turnId} is null`,
          opts.allWaiting
            ? undefined
            : sql`${messages.createdAt} < coalesce((select max(o.created_at) from messages o
                where o.conversation_id = ${conversationId} and o.sender in ('creator', 'admin') and o.status = 'sent'),
                '-infinity'::timestamptz)`,
        ),
      );
    if (waiting.length === 0) return;
    const [sentinel] = await tx
      .insert(turns)
      .values({ conversationId, inboundIds: waiting.map((w) => w.id), outcome: "handback" })
      .returning({ id: turns.id });
    await tx.update(messages).set({ turnId: sentinel.id }).where(inArray(messages.id, waiting.map((w) => w.id)));
  });
}

