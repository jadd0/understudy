import { sql } from "drizzle-orm";
import type { EngineCtx } from "./ctx";
import type { Facts } from "./types";

/** What the database knows about the fan; whether this batch starts a new session depends on the batch and is added by the turn. */
export type LoadedFacts = Omit<Facts, "sessionStart">;

export interface FactsCfg {
  declineWindowMinutes: number;
  velocityWindowMinutes: number;
}

/**
 * What routing and pacing read about one conversation, with one round trip to the database clock for the engine's own tables.
 * A round is one fan batch plus a turn that replied to it; `roundsSinceOffer` counts the replied turns after the
 * last offer, so the offer turn's own bubbles and the fan's burst size never change the count; a reaction to a tip or an unlock
 * answers no fan batch and is not a round.
 * Reads only. What the host owns (spend, cap, unlocks, high value) comes from `host.fanFacts`; the rest is the engine's own tables.
 */
export async function loadFacts(
  ctx: EngineCtx,
  conversationId: string,
  fanId: string,
  creatorId: string,
  cfg: FactsCfg,
): Promise<LoadedFacts> {
  const hostFacts = await ctx.host.fanFacts({ fanId, creatorId, velocityWindowMinutes: cfg.velocityWindowMinutes });
  const { rows } = await ctx.db.execute(sql`
    select
      coalesce((select no_pitch_until > now() from conversations where id = ${conversationId}), false) as no_pitch_active,
      (select count(*)::int from offers
        where conversation_id = ${conversationId} and status = 'declined'
          and resolved_at > now() - make_interval(mins => ${cfg.declineWindowMinutes}::int)) as declines,
      (select count(*)::int from turns t
        where t.conversation_id = ${conversationId} and t.outcome = 'replied' and t.offer_id is null
          and cardinality(t.inbound_ids) > 0
          and t.created_at > coalesce((select max(created_at) from offers where conversation_id = ${conversationId}),
                                      'epoch'::timestamptz)) as since_offer,
      coalesce((select hold_suppressed_until > now() from conversations where id = ${conversationId}), false) as hold_suppressed,
      exists(select 1 from handoffs where conversation_id = ${conversationId} and status <> 'resolved') as unresolved,
      exists(select 1 from offers where conversation_id = ${conversationId} and status = 'open' and expires_at > now()) as open_offer,
      exists(select 1 from offers where conversation_id = ${conversationId} and status = 'accepted') as unlocked,
      exists(
        select 1 from offers o where o.conversation_id = ${conversationId} and o.status = 'accepted'
          and o.resolved_at > coalesce(
            (select max(m.created_at) from messages m where m.conversation_id = ${conversationId} and m.sender in ('ai', 'creator', 'admin') and m.status = 'sent'),
            '-infinity'::timestamptz)
      ) as just_unlocked`);
  const r = rows[0] as {
    no_pitch_active: boolean;
    declines: number;
    since_offer: number;
    hold_suppressed: boolean;
    unresolved: boolean;
    open_offer: boolean;
    unlocked: boolean;
    just_unlocked: boolean;
  };
  return {
    noPitchActive: r.no_pitch_active,
    declinesInWindow: r.declines,
    atCap: hostFacts.atCap,
    spentTodayCents: hostFacts.spentTodayCents,
    capCents: hostFacts.capCents,
    unlocksInWindow: hostFacts.unlocksInWindow,
    roundsSinceOffer: r.since_offer,
    highValue: hostFacts.highValue,
    holdSuppressed: r.hold_suppressed,
    hasUnresolvedHandoff: r.unresolved,
    hasOpenOffer: r.open_offer,
    hasUnlocked: r.unlocked,
    justUnlocked: r.just_unlocked,
  };
}
