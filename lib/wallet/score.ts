import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ConfigInvalid } from "./errors";

/**
 * Recent spend with a half-life: each debit to this creator counts amount * 0.5^(age / half-life).
 * Computed from the ledger at read time, never stored. Whole cents, by the database clock.
 */
export async function highValueScore(fanId: string, creatorId: string): Promise<number> {
  const halfLifeDays = await getConfig<number>("fan.high_value_half_life_days", creatorId);
  if (typeof halfLifeDays !== "number" || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new ConfigInvalid("fan.high_value_half_life_days");
  }
  const { rows } = await db.execute(sql`
    select coalesce(round(sum(-amount_cents * power(0.5, extract(epoch from now() - created_at) / 86400.0 / ${halfLifeDays}::float8))), 0)::int as score
    from ledger_entries
    where fan_id = ${fanId} and creator_id = ${creatorId} and amount_cents < 0`);
  return Number((rows[0] as { score: number }).score);
}

export async function isHighValue(fanId: string, creatorId: string): Promise<boolean> {
  const threshold = await getConfig<number>("fan.high_value_threshold_cents", creatorId);
  return (await highValueScore(fanId, creatorId)) >= threshold;
}
