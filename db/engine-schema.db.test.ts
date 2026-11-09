import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { config } from "@/db/schema";
import { ENGINE_CONFIG, seed } from "@/db/seed";

describe("engine migration", () => {
  test("the enums and columns the engine needs exist", async () => {
    const enums = await db.execute(
      `select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder)::text[] as labels
       from pg_type t join pg_enum e on e.enumtypid = t.oid
       where t.typname in ('handoff_reason','turn_route') group by t.typname order by t.typname` as never,
    );
    const byName = Object.fromEntries((enums.rows as { typname: string; labels: string[] }[]).map((r) => [r.typname, r.labels]));
    expect(byName.turn_route).toEqual(["reply", "offer", "hold_creator", "hard_stop", "deflect", "ai_disclosure"]);
    expect(byName.handoff_reason).toHaveLength(12);

    const cols = await db.execute(
      `select table_name || '.' || column_name as c from information_schema.columns
       where (table_name, column_name) in (('messages','turn_id'),('messages','suggested'),('messages','deliver_at'),
         ('conversations','no_pitch_until'),('conversations','failed_turns'),('turns','attempts'),('turns','handoff_id'),('turns','ms_total'))` as never,
    );
    expect((cols.rows as { c: string }[]).map((r) => r.c).sort()).toEqual([
      "conversations.failed_turns",
      "conversations.no_pitch_until",
      "messages.deliver_at",
      "messages.suggested",
      "messages.turn_id",
      "turns.attempts",
      "turns.handoff_id",
      "turns.ms_total",
    ]);
  });
});

describe("engine seed", () => {
  test("every model id the engine uses has its price rows, and re-seeding keeps an edited value", async () => {
    await seed({}, () => {});
    await db.update(config).set({ value: 999 }).where(eq(config.key, "engine.debounce_ms"));
    await seed({}, () => {});
    const rows = await db.select().from(config);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    for (const key of Object.keys(ENGINE_CONFIG)) expect(byKey.has(key), key).toBe(true);
    expect(byKey.get("engine.debounce_ms")).toBe(999);

    const models = ["jev.model", "model.generate", "model.memory"].map((k) => byKey.get(k) as string);
    expect(models).toEqual(["jev-1.14.0", "claude-haiku-5-5", "claude-haiku-5-5"]);
    for (const m of new Set(models)) {
      expect(Number.isInteger(byKey.get(`price.${m}.input_per_mtok`)), m).toBe(true);
      expect(Number.isInteger(byKey.get(`price.${m}.output_per_mtok`)), m).toBe(true);
    }
    expect(byKey.get("price.claude-haiku-5-5.cache_read_per_mtok")).toBe(10000);
  });
});
