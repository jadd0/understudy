import { sql } from "drizzle-orm";
import { bucketStarts } from "./range";
import { bucketMs, dense, inScope, inWindow, int, rowsOf, type Query, type Series } from "./query";

/** Outcomes of a turn that answered the fan or handed the conversation on. The rest are superseded, error, handback. */
export const COMMITTED_OUTCOMES = ["replied", "handoff", "hard_stop", "suggested"] as const;

export interface Routes {
  total: number;
  byRoute: { route: string; count: number }[];
  byOutcome: { outcome: string; count: number }[];
  series: Series<{ turns: number; committed: number }>[];
}

// Turns without a route (an error, a hand-back stamp) are grouped as "none"; a hand-back stamp is not a turn the engine ran.
const turnsFrom = (q: Query) => sql`from turns t join conversations c on c.id = t.conversation_id
  where ${inScope(q)} and ${inWindow(sql`t.created_at`, q)} and coalesce(t.outcome, '') <> 'handback'`;

export async function getRoutes(q: Query): Promise<Routes> {
  const from = turnsFrom(q);
  const byRoute = await rowsOf<{ k: string; n: unknown }>(sql`select coalesce(t.route::text, 'none') as k, count(*) as n ${from} group by 1 order by 2 desc, 1`);
  const byOutcome = await rowsOf<{ k: string; n: unknown }>(sql`select coalesce(t.outcome, 'none') as k, count(*) as n ${from} group by 1 order by 2 desc, 1`);
  const committed = sql.raw(COMMITTED_OUTCOMES.map((o) => `'${o}'`).join(", "));
  const buckets = await rowsOf<{ t: number; n: unknown; ok: unknown }>(
    sql`select ${bucketMs(sql`t.created_at`, q.bucket)} as t, count(*) as n, count(*) filter (where t.outcome in (${committed})) as ok ${from} group by 1`,
  );
  return {
    total: byRoute.reduce((s, r) => s + int(r.n), 0),
    byRoute: byRoute.map((r) => ({ route: r.k, count: int(r.n) })),
    byOutcome: byOutcome.map((r) => ({ outcome: r.k, count: int(r.n) })),
    series: dense(
      bucketStarts(q.from, q.to, q.bucket),
      buckets.map((r) => ({ t: Number(r.t), turns: int(r.n), committed: int(r.ok) })),
      { turns: 0, committed: 0 },
    ),
  };
}
