import { sql } from "drizzle-orm";
import { cfgNum, inScope, inWindow, int, rowsOf, type Query } from "./query";

export interface Responsible {
  /** Committed turns in the window where Jev put the hardship check at or above the floor: pitching was blocked. */
  hardshipTurns: number;
  /** Of those, turns that still routed to an offer. Must be 0; any other number is a defect. */
  pitchedDespiteHardship: number;
  /** Conversations whose no-pitch cooldown (set by hardship) is running at `now`. */
  hardshipCooldownsActive: number;
  /** Distinct fans whose spend since 00:00 UTC has reached their effective daily cap at `now`. */
  fansAtCapToday: number;
}

/**
 * Responsible-selling rules. Turn rows keep Jev's parsed answers but not which pacing rule blocked a pitch, so the per-reason
 * split covers what the data can show: hardship from the turn, the cooldown and the cap from current state.
 */
export async function getResponsible(q: Query): Promise<Responsible> {
  const now = sql`${q.now.toISOString()}::timestamptz`;
  const [h] = await rowsOf<{ n: unknown; bad: unknown }>(sql`
    select count(*) as n, count(*) filter (where t.route = 'offer') as bad
    from turns t join conversations c on c.id = t.conversation_id
    where ${inScope(q)} and ${inWindow(sql`t.created_at`, q)}
      and t.outcome in ('replied', 'handoff', 'suggested')
      and (t.jev_in #>> '{parsed,p,hardship}')::float8 >= ${cfgNum("floor.safety.hardship", sql`c.creator_id`)}`);
  const [cd] = await rowsOf<{ n: unknown }>(
    sql`select count(*) as n from conversations c where ${inScope(q)} and c.no_pitch_until > ${now}`,
  );
  const [cap] = await rowsOf<{ n: unknown }>(sql`
    select count(*) as n from (
      select f.fan_id,
        coalesce((select w.daily_cap_cents from wallets w where w.fan_id = f.fan_id),
                 ${cfgNum("wallet.daily_cap_cents", sql`f.creator_id`)}) as cap,
        (select coalesce(sum(-l.amount_cents), 0) from ledger_entries l
          where l.fan_id = f.fan_id and l.amount_cents < 0
            and l.created_at >= (date_trunc('day', ${now} at time zone 'UTC') at time zone 'UTC')
            and l.created_at <= ${now}) as spent
      from (select distinct c.fan_id, c.creator_id from conversations c where ${inScope(q)}) f) s
    where s.spent >= s.cap`);
  return {
    hardshipTurns: int(h.n),
    pitchedDespiteHardship: int(h.bad),
    hardshipCooldownsActive: int(cd.n),
    fansAtCapToday: int(cap.n),
  };
}
