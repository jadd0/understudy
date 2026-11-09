import { sql } from "drizzle-orm";
import { inScope, inWindow, int, num, rate, rowsOf, type Query } from "./query";

export interface Pctl {
  p50: number | null;
  p95: number | null;
}
export interface HandoffGroup extends Pctl {
  queue: string;
  reason: string;
  count: number;
}
export interface HandoffStats {
  opened: number;
  turns: number;
  /** Handoffs opened / turns run in the window; null with no turns. */
  rate: number | null;
  openNow: number;
  claimSeconds: Pctl;
  resolveSeconds: Pctl;
  groups: HandoffGroup[];
}

const claim = "extract(epoch from h.claimed_at - h.opened_at)";
const resolve = "extract(epoch from h.resolved_at - h.opened_at)";

export async function getHandoffs(q: Query): Promise<HandoffStats> {
  const from = sql`from handoffs h join conversations c on c.id = h.conversation_id
    where ${inScope(q)} and ${inWindow(sql`h.opened_at`, q)}`;
  const groups = await rowsOf<{ queue: string; reason: string; n: unknown; c50: unknown; c95: unknown }>(
    sql`select h.queue::text as queue, h.reason::text as reason, count(*) as n,
        percentile_cont(0.5) within group (order by ${sql.raw(claim)}) as c50,
        percentile_cont(0.95) within group (order by ${sql.raw(claim)}) as c95
      ${from} group by 1, 2 order by 3 desc, 1, 2`,
  );
  const [all] = await rowsOf<{ n: unknown; c50: unknown; c95: unknown; r50: unknown; r95: unknown }>(
    sql`select count(*) as n,
        percentile_cont(0.5) within group (order by ${sql.raw(claim)}) as c50,
        percentile_cont(0.95) within group (order by ${sql.raw(claim)}) as c95,
        percentile_cont(0.5) within group (order by ${sql.raw(resolve)}) as r50,
        percentile_cont(0.95) within group (order by ${sql.raw(resolve)}) as r95
      ${from}`,
  );
  const [open] = await rowsOf<{ n: unknown }>(
    sql`select count(*) as n from handoffs h join conversations c on c.id = h.conversation_id where ${inScope(q)} and h.status = 'open'`,
  );
  const [t] = await rowsOf<{ n: unknown }>(
    sql`select count(*) as n from turns t join conversations c on c.id = t.conversation_id
      where ${inScope(q)} and ${inWindow(sql`t.created_at`, q)} and coalesce(t.outcome, '') <> 'handback'`,
  );
  const opened = int(all.n);
  return {
    opened,
    turns: int(t.n),
    rate: rate(opened, int(t.n)),
    openNow: int(open.n),
    claimSeconds: { p50: num(all.c50), p95: num(all.c95) },
    resolveSeconds: { p50: num(all.r50), p95: num(all.r95) },
    groups: groups.map((g) => ({ queue: g.queue, reason: g.reason, count: int(g.n), p50: num(g.c50), p95: num(g.c95) })),
  };
}
