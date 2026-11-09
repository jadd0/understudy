import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
// @ts-expect-error -- plain ESM script without types
import { ensureTestDb } from "./scripts/test-db.mjs";
// @ts-expect-error -- plain ESM script without types
import { pointAtLocalNeon } from "./scripts/neon-local.mjs";

// Points every test at the per-branch database on the local Postgres, migrated and emptied once per run.
export default async function setup() {
  const url: string = await ensureTestDb();
  const name = new URL(url).pathname;
  if (!name.includes("_test_")) throw new Error("refusing to truncate a non-test database");

  neonConfig.webSocketConstructor = ws;
  pointAtLocalNeon(url);
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'",
    );
    const list = rows.map((r: { tablename: string }) => `"${r.tablename}"`).join(", ");
    if (list) await pool.query(`truncate ${list} restart identity cascade`);
  } finally {
    await pool.end();
  }
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "test-secret-not-for-production";
}
