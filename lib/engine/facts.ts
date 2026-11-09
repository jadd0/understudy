import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getConfig } from "@/lib/config";
import { capAllows } from "@/lib/wallet/cap";
import { isHighValue } from "@/lib/wallet/score";
import type { Facts } from "./types";

/** What the database knows about the fan; whether this batch starts a new session depends on the batch and is added by the turn. */
export type LoadedFacts = Omit<Facts, "sessionStart">;

export interface FactsCfg {
  declineWindowMinutes: number;
  velocityWindowMinutes: number;
}

/**
 * What routing and pacing read about one conversation, in a single round trip against the database clock.
 * A round is one fan batch plus a turn that replied to it; `roundsSinceOffer` counts the replied turns after the
 * last offer, so the offer turn's own bubbles and the fan's burst size never change the count; a reaction to a tip or an unlock
 * answers no fan batch and is not a round.
 * Reads only: the engine never takes a wallet lock, so the cap is derived here (a matured raise counts)
 * rather than applied the way `effectiveCap` does under the wallet lock.
 */
export async function loadFacts(
  conversationId: string,
  fanId: string,
  creatorId: string,
  cfg: FactsCfg,
): Promise<LoadedFacts> {
  const platformCap = await getConfig<number>("wallet.daily_cap_cents");
  const highValue = await isHighValue(fanId, creatorId);
  const { rows } = await db.execute(sql`
    select
      coalesce((select no_pitch_until > now() from conversations where id = ${conversationId}), false) as no_pitch_active,
      (select count(*)::int from offers
        where conversation_id = ${conversationId} and status = 'declined'
          and resolved_at > now() - make_interval(mins => ${cfg.declineWindowMinutes}::int)) as declines,
      (select count(*)::int from ledger_entries
        where fan_id = ${fanId} and kind = 'unlock'
          and created_at > now() - make_interval(mins => ${cfg.velocityWindowMinutes}::int)) as unlocks,
      (select coalesce(sum(-amount_cents), 0)::int from ledger_entries
        where fan_id = ${fanId} and amount_cents < 0
          and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')) as spent,
      (select case when pending_cap_cents is not null and pending_cap_at <= now() then pending_cap_cents
                   else daily_cap_cents end
         from wallets where fan_id = ${fanId}) as own_cap,
      (select count(*)::int from turns t
        where t.conversation_id = ${conversationId} and t.outcome = 'replied' and t.offer_id is null
          and cardinality(t.inbound_ids) > 0
          and t.created_at > coalesce((select max(created_at) from offers where conversation_id = ${conversationId}),
                                      'epoch'::timestamptz)) as since_offer,
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
    unlocks: number;
    spent: number;
    own_cap: number | null;
    since_offer: number;
    unresolved: boolean;
    open_offer: boolean;
    unlocked: boolean;
    just_unlocked: boolean;
  };
  const capCents = r.own_cap ?? platformCap;
  return {
    noPitchActive: r.no_pitch_active,
    declinesInWindow: r.declines,
    atCap: !capAllows(r.spent, 1, capCents),
    spentTodayCents: r.spent,
    capCents,
    unlocksInWindow: r.unlocks,
    roundsSinceOffer: r.since_offer,
    highValue,
    hasUnresolvedHandoff: r.unresolved,
    hasOpenOffer: r.open_offer,
    hasUnlocked: r.unlocked,
    justUnlocked: r.just_unlocked,
  };
}
