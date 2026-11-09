import { sql } from "drizzle-orm";
import { bucketStarts } from "./range";
import { EVAL_FAN_EMAIL, bucketMs, cfgNum, dense, inScope, inWindow, int, num, rowsOf, simFan, type Query, type Series } from "./query";

export interface TopFan {
  fanId: string;
  creatorId: string;
  isSim: boolean;
  /** High-value score in cents: Σ debit × 0.5^(age / half-life), by the injected `now`. */
  scoreCents: number;
  spentCents: number;
}
export interface Revenue {
  unlockCents: number;
  tipCents: number;
  totalCents: number;
  /** Over conversations that had any message in the window, those with no spend counting as 0. */
  perConversation: { conversations: number; meanCents: number | null; p50Cents: number | null; paying: number };
  series: Series<{ unlockCents: number; tipCents: number }>[];
}

// A debit to the creator in a conversation the viewer may read, or one with no conversation (a bare tip).
const debits = (q: Query) => sql`from ledger_entries l left join conversations c on c.id = l.conversation_id
  where l.creator_id in (${sql.join(q.creatorIds.map((i) => sql`${i}::uuid`), sql`, `)})
    and l.amount_cents < 0 and l.kind in ('unlock', 'tip')
    and (${q.includeEval ? sql`true` : sql`not exists (select 1 from users ef where ef.id = l.fan_id and ef.email like ${EVAL_FAN_EMAIL})`})
    and ${simFan(q, sql`l.fan_id`)}
    and (l.conversation_id is null or ${inScope(q)})`;

export async function getRevenue(q: Query): Promise<Revenue> {
  if (q.creatorIds.length === 0) return emptyRevenue(q);
  const window = inWindow(sql`l.created_at`, q);
  const [tot] = await rowsOf<{ u: unknown; t: unknown }>(sql`
    select coalesce(sum(-l.amount_cents) filter (where l.kind = 'unlock'), 0) as u,
           coalesce(sum(-l.amount_cents) filter (where l.kind = 'tip'), 0) as t
    ${debits(q)} and ${window}`);
  const byBucket = await rowsOf<{ t: number; u: unknown; tip: unknown }>(sql`
    select ${bucketMs(sql`l.created_at`, q.bucket)} as t,
           coalesce(sum(-l.amount_cents) filter (where l.kind = 'unlock'), 0) as u,
           coalesce(sum(-l.amount_cents) filter (where l.kind = 'tip'), 0) as tip
    ${debits(q)} and ${window} group by 1`);
  const [per] = await rowsOf<{ n: unknown; mean: unknown; p50: unknown; paying: unknown }>(sql`
    with active as (
      select distinct m.conversation_id as id from messages m join conversations c on c.id = m.conversation_id
      where ${inScope(q)} and ${inWindow(sql`m.created_at`, q)}),
    spend as (
      select l.conversation_id as id, sum(-l.amount_cents) as cents
      from ledger_entries l
      where l.conversation_id is not null and l.amount_cents < 0 and l.kind in ('unlock', 'tip') and ${window}
      group by 1),
    per as (select a.id, coalesce(s.cents, 0) as cents from active a left join spend s on s.id = a.id)
    select count(*) as n, avg(cents) as mean, percentile_cont(0.5) within group (order by cents) as p50,
           count(*) filter (where cents > 0) as paying
    from per`);
  const unlockCents = int(tot.u);
  const tipCents = int(tot.t);
  return {
    unlockCents,
    tipCents,
    totalCents: unlockCents + tipCents,
    perConversation: { conversations: int(per.n), meanCents: num(per.mean), p50Cents: num(per.p50), paying: int(per.paying) },
    series: dense(
      bucketStarts(q.from, q.to, q.bucket),
      byBucket.map((r) => ({ t: Number(r.t), unlockCents: int(r.u), tipCents: int(r.tip) })),
      { unlockCents: 0, tipCents: 0 },
    ),
  };
}

function emptyRevenue(q: Query): Revenue {
  return {
    unlockCents: 0,
    tipCents: 0,
    totalCents: 0,
    perConversation: { conversations: 0, meanCents: null, p50Cents: null, paying: 0 },
    series: dense(bucketStarts(q.from, q.to, q.bucket), [], { unlockCents: 0, tipCents: 0 }),
  };
}

/** Fans ranked by the high-value score as of `q.now`. The half-life is the creator's config row, else the platform's. */
export async function getTopFans(q: Query, limit = 10): Promise<TopFan[]> {
  if (q.creatorIds.length === 0) return [];
  const rows = await rowsOf<{ fan_id: string; creator_id: string; is_sim: boolean; score: unknown; spent: unknown }>(sql`
    select l.fan_id, l.creator_id, u.is_sim,
      coalesce(round(sum(-l.amount_cents * power(0.5,
        extract(epoch from ${q.now.toISOString()}::timestamptz - l.created_at) / 86400.0
        / ${cfgNum("fan.high_value_half_life_days", sql`l.creator_id`)}))), 0) as score,
      sum(-l.amount_cents) as spent
    from ledger_entries l
    join users u on u.id = l.fan_id
    where l.creator_id in (${sql.join(q.creatorIds.map((i) => sql`${i}::uuid`), sql`, `)})
      and l.amount_cents < 0 and l.created_at <= ${q.now.toISOString()}::timestamptz
      and (${q.includeEval ? sql`true` : sql`u.email is null or u.email not like ${EVAL_FAN_EMAIL}`})
      and ${simFan(q, sql`l.fan_id`)}
      and (l.conversation_id is null or exists (select 1 from conversations c where c.id = l.conversation_id and ${inScope(q)}))
    group by l.fan_id, l.creator_id, u.is_sim
    order by score desc, spent desc, l.fan_id
    limit ${limit}`);
  return rows.map((r) => ({
    fanId: r.fan_id,
    creatorId: r.creator_id,
    isSim: r.is_sim,
    scoreCents: int(r.score),
    spentCents: int(r.spent),
  }));
}
