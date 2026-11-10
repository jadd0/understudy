import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "@neondatabase/serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import type { EngineDb } from "../ports/db.js";

/** The table that records which engine migrations ran; the host's migrations use drizzle's default table. */
export const ENGINE_MIGRATIONS_TABLE = "__understudy_engine_migrations";

/** Every migration run on a database takes this session advisory lock, so two runners never interleave. */
export const MIGRATION_LOCK_KEY = 727001;

/** Where the package's generated migrations live, resolved from this file with path joins (a `new URL(..., import.meta.url)` is bundled as an asset by the app's build) so it works from any working directory. */
export const ENGINE_MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

/**
 * Creates or updates the engine's tables. It needs no host table, so run it before the host's own migrations: the
 * host's tables point foreign keys at the engine's. Safe to call on every start and from concurrent processes.
 */
export async function migrateEngine(db: EngineDb): Promise<void> {
  // A client built by drizzle(pool) carries its pool; the lock needs one connection that stays open for the run.
  const pool = (db as unknown as { $client?: Pool }).$client;
  if (!pool) throw new Error("migrateEngine needs a database made by drizzle(pool)");
  const lock = await pool.connect();
  try {
    await lock.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await migrate(db, { migrationsFolder: ENGINE_MIGRATIONS_FOLDER, migrationsTable: ENGINE_MIGRATIONS_TABLE });
  } finally {
    await lock.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lock.release();
  }
}
