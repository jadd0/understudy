import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { EngineCtx } from "./ctx";
import type { HostPort } from "./host";
import type { EngineTx } from "./ports/db";
import { conversations, handoffs, messages, offers, turns } from "./schema";
import { deliverOffsets, splitBubbles } from "./bubbles";
import { openHandoff } from "./handoff";
import { unrepeatedTemplate } from "./templates";
import type { HandoffQueue, HandoffReason, RouteName } from "./types";

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
      and exists (select 1 from creators cr where cr.id = c.creator_id and cr.ai_enabled)
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

export interface TurnRecord {
  inboundIds: string[];
  route: RouteName | null;
  jevIn: unknown;
  jevOut: unknown;
  draft: string | null;
  personaVersion: number | null;
  models: unknown;
  tokens: unknown;
  costMicros: number;
  msJevIn: number | null;
  msGen: number | null;
  msJevOut: number | null;
  attempts: number | null;
}

export interface CommitPlan {
  /** Outcome recorded when the reply part applies: replied | handoff | hard_stop | suggested. */
  outcome: string;
  turn: TurnRecord;
  /** What to say. A `draft` is held for the creator (never shown to the fan); anything else is sent. */
  reply: { body: string; kind: "sent" | "draft"; sender?: "ai" | "system" } | null;
  offer: { itemId: string; priceCents: number; ttlMinutes: number } | null;
  /** An offer the fan just declined. */
  declineOfferId: string | null;
  /** Handoff this turn opens or escalates, and the mode the conversation moves to with it. */
  handoff: { queue: HandoffQueue; reason: HandoffReason } | null;
  setMode: "handoff_creator" | "handoff_ts" | null;
  /** hard_stop: this is the safety outcome, applied whatever happened to the conversation during the turn. */
  hardStop: { reason: HandoffReason; flagUser: boolean } | null;
  /** Open a high_value_alert for the creator; the AI keeps replying. */
  alert: boolean;
  hardshipCooldownHours: number | null;
  /** Tip rows this turn reacted to: stamped with its turn id like the inbound, but kept out of `inbound_ids`, which counts fan messages. */
  eventMessageIds?: string[];
  typing: { cps: number; maxMs: number; gapMs: number };
}

export type CommitResult =
  | { applied: true; turnId: string; messageIds: string[]; offerId: string | null; handoffId: string | null; deliverInMs: number[] }
  /** A lost compare-and-set still delivers a hard stop's template (`messageIds`); a plain draft is stored unsent. */
  | { applied: false; turnId: string; handoffId: string | null; messageIds: string[]; deliverInMs: number[] };

function turnValues(conversationId: string, rec: TurnRecord, outcome: string) {
  return {
    conversationId,
    inboundIds: rec.inboundIds,
    route: rec.route,
    jevIn: rec.jevIn,
    jevOut: rec.jevOut,
    draft: rec.draft,
    outcome,
    personaVersion: rec.personaVersion,
    models: rec.models,
    tokens: rec.tokens,
    costMicros: rec.costMicros,
    msJevIn: rec.msJevIn,
    msGen: rec.msGen,
    msJevOut: rec.msJevOut,
    attempts: rec.attempts,
  };
}

/** The body of her last bubble the fan can see or will see (AI or a human on her side), or null. */
async function lastHerBody(tx: EngineTx, conversationId: string): Promise<string | null> {
  const [row] = await tx
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        inArray(messages.sender, ["ai", "creator", "admin"]),
        eq(messages.status, "sent"),
      ),
    )
    .orderBy(sql`${messages.sortAt} desc`, sql`${messages.id} desc`)
    .limit(1);
  return row?.body ?? null;
}

async function elapsedSinceFirstInbound(tx: EngineTx, inboundIds: string[]): Promise<number> {
  if (inboundIds.length === 0) return 0;
  const [row] = await tx
    .select({ ms: sql<number>`coalesce(extract(epoch from now() - min(${messages.createdAt})) * 1000, 0)::float8` })
    .from(messages)
    .where(inArray(messages.id, inboundIds));
  return Number(row.ms);
}

/** `ms_total` for a turn that did not commit a reply: time since the first message it was handling. */
async function msTotalOf(tx: EngineTx, inboundIds: string[]): Promise<number | null> {
  return inboundIds.length === 0 ? null : Math.round(await elapsedSinceFirstInbound(tx, inboundIds));
}

/**
 * AI bubbles the fan has not seen yet (`deliver_at` still ahead) are superseded, and an open offer one of them
 * carried is expired: the fan never saw it, so it must not stay redeemable. Used by a takeover and a hard stop.
 */
export async function supersedeUnseenBubbles(tx: EngineTx, conversationId: string): Promise<void> {
  const gone = await tx
    .update(messages)
    .set({ status: "superseded" })
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.sender, "ai"),
        eq(messages.status, "sent"),
        sql`${messages.deliverAt} > now()`,
      ),
    )
    .returning({ offerId: messages.offerId });
  const offerIds = gone.map((g) => g.offerId).filter((id): id is string => id !== null);
  if (offerIds.length === 0) return;
  await tx
    .update(offers)
    .set({ status: "expired", resolvedAt: sql`now()` })
    .where(and(inArray(offers.id, offerIds), eq(offers.status, "open")));
}

/**
 * Saves a turn in two parts, in one transaction. The safety part of a hard stop is unconditional: it holds
 * whatever the conversation did during the turn, because Trust & Safety outranks a creator takeover. The reply
 * part is a compare-and-set on (mode='ai', version, lease token): if a takeover or a re-lease got there first the
 * turn is recorded `superseded`, the draft is kept unsent, and nothing else is written. Config is read by the
 * caller; inside this transaction only `tx` is used.
 */
export async function commitTurn(ctx: EngineCtx, lease: Lease, plan: CommitPlan): Promise<CommitResult> {
  const { host } = ctx;
  return ctx.db.transaction(async (tx) => {
    const set: Partial<typeof conversations.$inferInsert> = {
      version: sql`${conversations.version} + 1` as unknown as number,
      leaseToken: null,
      leaseUntil: null,
      failedTurns: 0,
    };
    if (plan.setMode) set.mode = plan.setMode;
    if (plan.hardshipCooldownHours != null) {
      set.noPitchUntil = sql`now() + make_interval(hours => ${plan.hardshipCooldownHours})` as unknown as Date;
    }
    if (plan.offer) set.lastPitchAt = sql`now()` as unknown as Date;

    const cas = await tx
      .update(conversations)
      .set(set)
      .where(
        and(
          eq(conversations.id, lease.conversationId),
          eq(conversations.mode, "ai"),
          eq(conversations.version, lease.version),
          eq(conversations.leaseToken, lease.token),
        ),
      )
      .returning({ id: conversations.id });

    if (cas.length === 0) return recordSuperseded(tx, lease, plan, host);

    const elapsedMs = await elapsedSinceFirstInbound(tx, plan.turn.inboundIds);
    const [turn] = await tx
      .insert(turns)
      // A reaction to a tip or an unlock answers no fan message, so it has no latency to report.
      .values({ ...turnValues(lease.conversationId, plan.turn, plan.outcome), msTotal: plan.turn.inboundIds.length ? Math.round(elapsedMs) : null })
      .returning({ id: turns.id });

    let handoffId: string | null = null;
    if (plan.handoff) handoffId = await openHandoff(tx, lease.conversationId, plan.handoff.queue, plan.handoff.reason);
    if (plan.alert) {
      const alertId = await openHandoff(tx, lease.conversationId, "creator", "high_value_alert");
      handoffId ??= alertId;
    }
    // The template must not follow an older, still-undelivered bubble. Offers are locked before the user row:
    // the platform order is conversation, offer, wallet, user (AGENTS.md), the one an unlock also takes.
    if (plan.hardStop) await supersedeUnseenBubbles(tx, lease.conversationId);
    if (plan.hardStop?.flagUser) await host.flagFan(tx, lease.fanId, plan.hardStop.reason);

    if (plan.declineOfferId) {
      await tx
        .update(offers)
        .set({ status: "declined", resolvedAt: sql`now()` })
        .where(and(eq(offers.id, plan.declineOfferId), eq(offers.status, "open")));
    }

    let offerId: string | null = null;
    if (plan.offer) {
      const [o] = await tx
        .insert(offers)
        .values({
          conversationId: lease.conversationId,
          itemId: plan.offer.itemId,
          priceCents: plan.offer.priceCents,
          expiresAt: sql`now() + make_interval(mins => ${plan.offer.ttlMinutes})`,
          turnId: turn.id,
        })
        .returning({ id: offers.id });
      offerId = o.id;
    }

    const messageIds: string[] = [];
    let deliverInMs: number[] = [];
    if (plan.reply) {
      const isDraft = plan.reply.kind === "draft";
      // A hard stop that comes round again straight after the same template says it in other words.
      if (plan.hardStop && !isDraft) {
        plan.reply = { ...plan.reply, body: unrepeatedTemplate(plan.reply.body, await lastHerBody(tx, lease.conversationId)) };
      }
      // A held draft stays one row; a sent reply is one bubble per line (at most MAX_BUBBLES), the offer on the last.
      const bubbles = isDraft || plan.hardStop ? [plan.reply.body] : splitBubbles(plan.reply.body);
      const offsets = deliverOffsets(bubbles, {
        elapsedMs,
        cps: plan.typing.cps,
        maxMs: plan.typing.maxMs,
        gapMs: plan.typing.gapMs,
        immediate: isDraft || plan.hardStop !== null,
      });
      for (let i = 0; i < bubbles.length; i++) {
        const [m] = await tx
          .insert(messages)
          .values({
            conversationId: lease.conversationId,
            sender: plan.reply.sender ?? "ai",
            body: bubbles[i],
            offerId: i === bubbles.length - 1 ? offerId : null,
            turnId: turn.id,
            status: isDraft ? "blocked" : "sent",
            suggested: isDraft,
            // Bubbles share the transaction's now(); one millisecond apart keeps their order readable.
            createdAt: sql`now() + make_interval(secs => ${i / 1000})` as unknown as Date,
            deliverAt: isDraft || offsets[i] === 0 ? null : (sql`now() + make_interval(secs => ${offsets[i] / 1000})` as unknown as Date),
          })
          .returning({ id: messages.id });
        messageIds.push(m.id);
      }
      deliverInMs = isDraft ? [] : offsets;
    }

    await tx.update(turns).set({ offerId, handoffId }).where(eq(turns.id, turn.id));
    if (plan.turn.inboundIds.length > 0) {
      await tx.update(messages).set({ turnId: turn.id }).where(inArray(messages.id, plan.turn.inboundIds));
    }
    if (plan.eventMessageIds?.length) {
      await tx
        .update(messages)
        .set({ turnId: turn.id })
        .where(and(inArray(messages.id, plan.eventMessageIds), sql`${messages.turnId} is null`));
    }
    return { applied: true, turnId: turn.id, messageIds, offerId, handoffId, deliverInMs };
  });
}

/** The reply part lost the compare-and-set. Only the safety outcome (if any) and the unsent record are written. */
async function recordSuperseded(tx: EngineTx, lease: Lease, plan: CommitPlan, host: HostPort): Promise<CommitResult> {
  let handoffId: string | null = null;
  if (plan.hardStop) {
    // Platform lock order (AGENTS.md): the conversation row first, then offers, then the user.
    await tx
      .update(conversations)
      .set({
        mode: sql`case when ${conversations.mode} = 'human_ts' then ${conversations.mode} else 'handoff_ts'::conversation_mode end` as unknown as "handoff_ts",
        version: sql`${conversations.version} + 1` as unknown as number,
      })
      .where(eq(conversations.id, lease.conversationId));
    handoffId = await openHandoff(tx, lease.conversationId, "ts", plan.hardStop.reason);
    await supersedeUnseenBubbles(tx, lease.conversationId);
    if (plan.hardStop.flagUser) await host.flagFan(tx, lease.fanId, plan.hardStop.reason);
  }
  // Release the lease only if it is still ours; a re-lease belongs to someone else.
  await tx
    .update(conversations)
    .set({ leaseToken: null, leaseUntil: null })
    .where(and(eq(conversations.id, lease.conversationId), eq(conversations.leaseToken, lease.token)));

  const [turn] = await tx
    .insert(turns)
    .values({ ...turnValues(lease.conversationId, plan.turn, "superseded"), handoffId, msTotal: await msTotalOf(tx, plan.turn.inboundIds) })
    .returning({ id: turns.id });
  const messageIds: string[] = [];
  if (plan.reply) {
    // A hard stop's template (resources for someone in crisis, the minor notice) reaches the fan whoever won the
    // race; any other draft is kept unsent.
    const deliver = plan.hardStop !== null && plan.reply.kind === "sent";
    const body = deliver ? unrepeatedTemplate(plan.reply.body, await lastHerBody(tx, lease.conversationId)) : plan.reply.body;
    const [m] = await tx
      .insert(messages)
      .values({
        conversationId: lease.conversationId,
        sender: deliver ? (plan.reply.sender ?? "ai") : "ai",
        body,
        turnId: turn.id,
        status: deliver ? "sent" : "superseded",
      })
      .returning({ id: messages.id });
    if (deliver) messageIds.push(m.id);
  }
  return { applied: false, turnId: turn.id, handoffId, messageIds, deliverInMs: messageIds.map(() => 0) };
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
export async function recordFailure(ctx: EngineCtx, lease: Lease, rec: TurnRecord, maxAttempts: number): Promise<FailureResult> {
  return ctx.db.transaction(async (tx) => {
    const [conv] = await tx
      .update(conversations)
      .set({ failedTurns: sql`${conversations.failedTurns} + 1` as unknown as number, leaseToken: null, leaseUntil: null })
      .where(and(eq(conversations.id, lease.conversationId), eq(conversations.leaseToken, lease.token)))
      .returning({ failedTurns: conversations.failedTurns, mode: conversations.mode });

    let handoffId: string | null = null;
    let escalated = false;
    if (conv && conv.failedTurns >= maxAttempts && conv.mode === "ai") {
      handoffId = await openHandoff(tx, lease.conversationId, "creator", "engine_error");
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
export async function handBack(ctx: EngineCtx, conversationId: string, opts: { allWaiting?: boolean } = {}): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [conv] = await tx
      .update(conversations)
      .set({ mode: "ai", version: sql`${conversations.version} + 1` as unknown as number, leaseToken: null, leaseUntil: null, failedTurns: 0 })
      .where(eq(conversations.id, conversationId))
      .returning({ id: conversations.id });
    if (!conv) return;
    await tx
      .update(handoffs)
      .set({ status: "resolved", resolvedAt: sql`now()` })
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
