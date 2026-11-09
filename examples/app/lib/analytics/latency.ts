import { sql } from "drizzle-orm";
import { inScope, inWindow, int, num, rowsOf, type Query } from "./query";
import type { Pctl } from "./handoffs";

export const STAGES = ["ms_jev_in", "ms_gen", "ms_jev_out", "ms_total"] as const;
export type Stage = (typeof STAGES)[number];
export type Latency = Record<Stage, Pctl & { samples: number }>;

/** p50 and p95 in milliseconds per stage, computed in SQL over turns that recorded that stage. */
export async function getLatency(q: Query): Promise<Latency> {
  const cols = STAGES.map(
    (s) => sql`percentile_cont(0.5) within group (order by t.${sql.raw(s)}) as ${sql.raw(`${s}_50`)},
      percentile_cont(0.95) within group (order by t.${sql.raw(s)}) as ${sql.raw(`${s}_95`)},
      count(t.${sql.raw(s)}) as ${sql.raw(`${s}_n`)}`,
  );
  const [r] = await rowsOf<Record<string, unknown>>(sql`
    select ${sql.join(cols, sql`, `)}
    from turns t join conversations c on c.id = t.conversation_id
    where ${inScope(q)} and ${inWindow(sql`t.created_at`, q)}`);
  const out = {} as Latency;
  for (const s of STAGES) out[s] = { p50: num(r[`${s}_50`]), p95: num(r[`${s}_95`]), samples: int(r[`${s}_n`]) };
  return out;
}
