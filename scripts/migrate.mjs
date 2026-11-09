// Applies the engine's migrations, then the host's, to DATABASE_URL (or the URL given as the first argument).
// Engine first: the host's tables point foreign keys at the engine's. Each set takes the same advisory lock.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_TABLE = "__understudy_engine_migrations";
export const LOCK_KEY = 727001;

/** Runs both migration sets on `url` under one session advisory lock, so concurrent runs never interleave. */
export async function migrateAll(url) {
  const pool = new Pool({ connectionString: String(url) });
  const lock = await pool.connect();
  try {
    await lock.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: path.join(root, "packages/engine/drizzle"), migrationsTable: ENGINE_TABLE });
    await migrate(db, { migrationsFolder: path.join(root, "drizzle") });
  } finally {
    await lock.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    lock.release();
    await pool.end();
  }
}

/** True when the database was built before the engine had its own migrations table (it has the host's only). */
export async function isPreEngineDatabase(url) {
  const pool = new Pool({ connectionString: String(url) });
  try {
    const { rows } = await pool.query(
      `select
         exists (select 1 from pg_tables where tablename = $1) as has_engine,
         exists (select 1 from pg_tables where tablename = '__drizzle_migrations') as has_host`,
      [ENGINE_TABLE],
    );
    return rows[0].has_host && !rows[0].has_engine;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("migrate: DATABASE_URL is not set");
    process.exit(1);
  }
  migrateAll(url).then(
    () => console.log("migrate: engine and host migrations applied"),
    (e) => {
      console.error("migrate failed:", e?.cause?.code ?? e?.code ?? e?.name ?? "error");
      process.exit(1);
    },
  );
}
