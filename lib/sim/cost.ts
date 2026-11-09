import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { simRuns, turns } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { costMicros } from "@/lib/engine/cost";
import type { GenerateUsage } from "@/platform/ports/generator";

/** One sim model call in whole micro-dollars, from the model's own `price.<model>.*` config rows. */
export async function simCallMicros(model: string, usage: GenerateUsage): Promise<number> {
  const [input, output, cacheRead, cacheWrite] = await Promise.all(
    ["input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_write_per_mtok"].map((k) => getConfig<number>(`price.${model}.${k}`)),
  );
  return costMicros({ input, output, cacheRead, cacheWrite }, usage);
}

/** What the engine spent answering this conversation (Jev, Claude, memory). */
export async function engineCostMicros(conversationId: string | null): Promise<number> {
  if (!conversationId) return 0;
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${turns.costMicros}), 0)::float8` })
    .from(turns)
    .where(eq(turns.conversationId, conversationId));
  return Number(row.total);
}

/** A run's cost: its own model calls plus the engine's turns in its conversation. Always read from the database, never cached. */
export async function runCostMicros(runId: string): Promise<number> {
  const [run] = await db.select({ cost: simRuns.costMicros, conversationId: simRuns.conversationId }).from(simRuns).where(eq(simRuns.id, runId));
  if (!run) return 0;
  return run.cost + (await engineCostMicros(run.conversationId));
}

/** The whole batch's cost, so one batch cannot spend past `sim.max_cost_micros_per_batch`. */
export async function batchCostMicros(batchId: string): Promise<number> {
  const runs = await db.select({ id: simRuns.id }).from(simRuns).where(eq(simRuns.batchId, batchId));
  let total = 0;
  for (const r of runs) total += await runCostMicros(r.id);
  return total;
}
