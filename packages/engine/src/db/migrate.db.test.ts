import { randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { afterAll, describe, expect, test } from "vitest";
import { ENGINE_MIGRATIONS_TABLE, migrateEngine } from "./migrate";
import type { EngineDb } from "../ports/db";

// An empty database of its own, so no host table exists when the engine migrates.
const name = `understudy_test_migrate_${randomUUID().slice(0, 8)}`;
const base = new URL(process.env.DATABASE_URL!);
const admin = new Pool({ connectionString: base.toString() });
const target = new URL(base);
target.pathname = `/${name}`;
let pool: Pool | undefined;

afterAll(async () => {
  await pool?.end();
  // A closed client's server backend can outlive end() for a moment behind a WebSocket proxy; a forced drop then
  // kills it and the termination reaches a client that is already closing, as an unhandled error. Wait it out first.
  for (let i = 0; i < 50; i++) {
    const { rows } = await admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [name]);
    if (rows[0].n === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.end();
});

async function fresh() {
  await admin.query(`create database "${name}"`);
  pool = new Pool({ connectionString: target.toString() });
  return { pool, db: drizzle(pool) as unknown as EngineDb };
}

const ENGINE_TABLES = [
  "conversations", "creator_settings", "fan_memory", "handoffs", "messages", "offers", "persona_cards", "persona_chunks", "strikes", "turns",
];

describe("migrateEngine", () => {
  test("migrate on an empty database creates every engine table and records in __understudy_engine_migrations", async () => {
    const { pool, db } = await fresh();
    await migrateEngine(db);
    const tables = await pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(ENGINE_TABLES);
    const recorded = await pool.query(`select count(*)::int as n from drizzle."${ENGINE_MIGRATIONS_TABLE}"`);
    expect(recorded.rows[0].n).toBe(7);
  });

  test("migrate twice is a no-op", async () => {
    const db = drizzle(pool!) as unknown as EngineDb;
    await migrateEngine(db);
    const recorded = await pool!.query(`select count(*)::int as n from drizzle."${ENGINE_MIGRATIONS_TABLE}"`);
    expect(recorded.rows[0].n).toBe(7);
  });

  test("no engine table has a foreign key into users, creators or catalogue_items", async () => {
    const fks = await pool!.query(`
      select tc.table_name as from_table, ccu.table_name as to_table
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`);
    expect(fks.rows.length).toBeGreaterThan(5);
    expect(fks.rows.filter((r) => ["users", "creators", "catalogue_items"].includes(r.to_table))).toEqual([]);
    expect(new Set(fks.rows.map((r) => r.to_table))).toEqual(new Set(["conversations", "offers", "turns", "handoffs"]));
  });
});
