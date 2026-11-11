import { and, eq, inArray, sql } from "drizzle-orm";
import type { EngineCtx } from "../ctx.js";
import type { HostPort } from "../ports/host.js";
import type { EngineTx } from "../ports/db.js";
import { conversations, messages, offers, turns } from "../db/schema.js";
import { deliverOffsets, splitBubbles } from "../drafting/bubbles.js";
import { openHandoff } from "../conversation/handoff.js";
import { elapsedSinceFirstInbound, lastHerBody, msTotalOf, turnValues } from "./record.js";
import type { Lease } from "../conversation/lease.js";
import type { CommitPlan, CommitResult } from "./plan.js";
import { recordStrike } from "../conversation/strikes.js";
import { strikeNotice, unrepeatedTemplate } from "../drafting/templates.js";

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
    if (plan.handoff) handoffId = await openHandoff(tx, lease.conversationId, plan.handoff.queue, plan.handoff.reason, plan.sla);
    let notice: string | null = null;
    let paused = false;
    if (plan.strike) {
      const n = await recordStrike(tx, {
        creatorId: lease.creatorId,
        fanId: lease.fanId,
        windowDays: plan.strike.windowDays,
        conversationId: lease.conversationId,
        turnId: turn.id,
        reason: plan.strike.reason,
      });
      paused = n >= plan.strike.maxStrikes;
      notice = strikeNotice(n, plan.strike.maxStrikes);
      // Every strike tells Trust & Safety; the last one also takes the chat out of the AI's hands (no account flag).
      handoffId = await openHandoff(tx, lease.conversationId, "ts", plan.strike.reason, plan.sla);
      if (paused) {
        await tx.update(conversations).set({ mode: "handoff_ts" }).where(eq(conversations.id, lease.conversationId));
        await supersedeUnseenBubbles(tx, lease.conversationId);
      }
    }
    if (plan.alert) {
      const alertId = await openHandoff(tx, lease.conversationId, "creator", "high_value_alert", plan.sla);
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
      if ((plan.hardStop || plan.reply.fixed) && !isDraft) {
        plan.reply = { ...plan.reply, body: unrepeatedTemplate(plan.reply.body, await lastHerBody(tx, lease.conversationId)) };
      }
      // A held draft stays one row; a sent reply is one bubble per line (at most MAX_BUBBLES), the offer on the last.
      const bubbles = isDraft || plan.hardStop || plan.reply.fixed ? [plan.reply.body] : splitBubbles(plan.reply.body);
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
    if (notice !== null) {
      // The platform notice follows her line by one bubble gap, and goes at once when there is no line.
      const after = deliverInMs.length > 0 ? Math.max(...deliverInMs) + plan.typing.gapMs : 0;
      const [m] = await tx
        .insert(messages)
        .values({
          conversationId: lease.conversationId,
          sender: "system",
          body: notice,
          turnId: turn.id,
          status: "sent",
          createdAt: sql`now() + make_interval(secs => ${messageIds.length / 1000})` as unknown as Date,
          deliverAt: after === 0 ? null : (sql`now() + make_interval(secs => ${after / 1000})` as unknown as Date),
        })
        .returning({ id: messages.id });
      messageIds.push(m.id);
      deliverInMs = [...deliverInMs, after];
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
    handoffId = await openHandoff(tx, lease.conversationId, "ts", plan.hardStop.reason, plan.sla);
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
