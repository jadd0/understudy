import { sql } from "drizzle-orm";
import { bucketStarts } from "./range";
import { bucketMs, dense, inScope, inWindow, int, rate, rowsOf, type Query, type Series } from "./query";

export interface Cost {
  totalMicros: number;
  /** Turns with outcome `replied`: a superseded or failed draft costs tokens but is not a reply. */
  replies: number;
  /** Σ cost / replies, in whole micro-dollars; null with no replies. */
  perReplyMicros: number | null;
  series: Series<{ micros: number; replies: number }>[];
  byModel: { model: string; stage: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedMicros: number | null }[];
}

const STAGE_MODEL: Record<string, "jev" | "generate" | "memory"> = {
  jev_in: "jev",
  offer_pick: "jev",
  jev_out: "jev",
  generate: "generate",
  memory: "memory",
};

/**
 * Spend over the window. The total and per-bucket figures are the stored `cost_micros`; the by-model split
 * re-prices the stored token counts at the current `price.*` config rows, so it is an estimate.
 */
export async function getCost(q: Query): Promise<Cost> {
  const from = sql`from turns t join conversations c on c.id = t.conversation_id
    where ${inScope(q)} and ${inWindow(sql`t.created_at`, q)}`;
  const [tot] = await rowsOf<{ micros: unknown; replies: unknown }>(
    sql`select coalesce(sum(t.cost_micros), 0) as micros, count(*) filter (where t.outcome = 'replied') as replies ${from}`,
  );
  const buckets = await rowsOf<{ t: number; micros: unknown; replies: unknown }>(
    sql`select ${bucketMs(sql`t.created_at`, q.bucket)} as t, coalesce(sum(t.cost_micros), 0) as micros,
      count(*) filter (where t.outcome = 'replied') as replies ${from} group by 1`,
  );

  const parts = Object.entries(STAGE_MODEL).map(
    ([stage, key]) => sql`select ${stage}::text as stage, t.models ->> ${key} as model,
      coalesce(sum((t.tokens -> ${stage} ->> 'inputTokens')::bigint), 0) as i,
      coalesce(sum((t.tokens -> ${stage} ->> 'outputTokens')::bigint), 0) as o,
      coalesce(sum((t.tokens -> ${stage} ->> 'cacheReadTokens')::bigint), 0) as cr,
      coalesce(sum((t.tokens -> ${stage} ->> 'cacheWriteTokens')::bigint), 0) as cw
      ${from} and t.tokens ? ${stage} group by 2`,
  );
  const tokenRows = await rowsOf<{ stage: string; model: string | null; i: unknown; o: unknown; cr: unknown; cw: unknown }>(
    sql.join(parts, sql` union all `),
  );
  const prices = new Map(
    (await rowsOf<{ key: string; v: unknown }>(sql`select key, (value #>> '{}')::float8 as v from config where creator_id is null and key like 'price.%'`)).map(
      (r) => [r.key, Number(r.v)],
    ),
  );
  const byModel = tokenRows
    .filter((r) => r.model)
    .map((r) => {
      const p = (kind: string) => prices.get(`price.${r.model}.${kind}_per_mtok`);
      const known = p("input") !== undefined && p("output") !== undefined;
      const micros = known
        ? Math.round(
            (int(r.i) * p("input")! + int(r.o) * p("output")! + int(r.cr) * (p("cache_read") ?? 0) + int(r.cw) * (p("cache_write") ?? 0)) / 1_000_000,
          )
        : null;
      return {
        model: r.model!,
        stage: r.stage,
        inputTokens: int(r.i),
        outputTokens: int(r.o),
        cacheReadTokens: int(r.cr),
        cacheWriteTokens: int(r.cw),
        estimatedMicros: micros,
      };
    })
    .sort((a, b) => (b.estimatedMicros ?? 0) - (a.estimatedMicros ?? 0) || a.stage.localeCompare(b.stage));

  const totalMicros = int(tot.micros);
  const replies = int(tot.replies);
  return {
    totalMicros,
    replies,
    perReplyMicros: rate(totalMicros, replies),
    series: dense(
      bucketStarts(q.from, q.to, q.bucket),
      buckets.map((r) => ({ t: Number(r.t), micros: int(r.micros), replies: int(r.replies) })),
      { micros: 0, replies: 0 },
    ),
    byModel,
  };
}
