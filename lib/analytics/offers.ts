import { sql } from "drizzle-orm";
import { inScope, inWindow, int, rate, rowsOf, type Query } from "./query";

export interface OfferFunnel {
  made: number;
  /** An unlock by the same fan of the same item, after the offer was made and before it expired. */
  unlocked: number;
  declined: number;
  /** Status expired, or still open past its expiry. */
  expired: number;
  stillOpen: number;
  /** unlocked / made. */
  acceptanceRate: number | null;
  /** Reply turns that carried an offer / reply turns. */
  offerRate: number | null;
  offerTurns: number;
  replyTurns: number;
}

/**
 * Funnel for offers made in the window. An offer counts as converted through the `unlocks` join (so another fan's
 * unlock, or one that happened before the offer existed, is never credited to it), or when an unlock debit was paid
 * for this very offer: a re-purchase of an item he already owned keeps its first `unlocks` row, so only the ledger
 * shows it.
 */
export async function getOfferFunnel(q: Query): Promise<OfferFunnel> {
  const [f] = await rowsOf<{ made: unknown; unlocked: unknown; declined: unknown; expired: unknown; open: unknown }>(sql`
    with o as (
      select ofr.id, ofr.status, ofr.expires_at,
        (exists (select 1 from unlocks u
                 where u.fan_id = c.fan_id and u.item_id = ofr.item_id
                   and u.created_at >= ofr.created_at and u.created_at <= ofr.expires_at)
         or exists (select 1 from ledger_entries l where l.offer_id = ofr.id and l.kind = 'unlock')) as converted
      from offers ofr join conversations c on c.id = ofr.conversation_id
      where ${inScope(q)} and ${inWindow(sql`ofr.created_at`, q)})
    select count(*) as made,
      count(*) filter (where converted) as unlocked,
      count(*) filter (where not converted and status = 'declined') as declined,
      count(*) filter (where not converted and status <> 'declined' and (status = 'expired' or (status = 'open' and expires_at <= ${q.now.toISOString()}::timestamptz))) as expired,
      count(*) filter (where not converted and status in ('open', 'accepted') and expires_at > ${q.now.toISOString()}::timestamptz) as open
    from o`);
  const [r] = await rowsOf<{ replies: unknown; offers: unknown }>(sql`
    select count(*) filter (where t.outcome = 'replied') as replies,
           count(*) filter (where t.outcome = 'replied' and t.route = 'offer') as offers
    from turns t join conversations c on c.id = t.conversation_id
    where ${inScope(q)} and ${inWindow(sql`t.created_at`, q)}`);
  const made = int(f.made);
  return {
    made,
    unlocked: int(f.unlocked),
    declined: int(f.declined),
    expired: int(f.expired),
    stillOpen: int(f.open),
    acceptanceRate: rate(int(f.unlocked), made),
    offerRate: rate(int(r.offers), int(r.replies)),
    offerTurns: int(r.offers),
    replyTurns: int(r.replies),
  };
}
