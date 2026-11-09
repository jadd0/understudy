// Creates (if absent) the per-branch test database `<base>_test_<branch-slug>` in the same Neon
// project as DATABASE_URL, applies the migrations, and prints its URL on stdout.
// Usage: node scripts/test-db.mjs   (DATABASE_URL from the environment or .env.local)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function baseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = path.join(root, ".env.local");
  if (existsSync(file)) {
    const m = readFileSync(file, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL is not set");
}

function branchSlug() {
  const branch =
    process.env.TEST_DB_BRANCH ||
    execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim() ||
    "detached";
  return branch.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

/** The connection URL of the project's main database; its name is the base for every derived database. */
export function baseDatabase() {
  const url = new URL(baseUrl());
  return { url, name: url.pathname.replace(/^\//, "") };
}

/**
 * Creates `name` in the same Neon project if absent, applies the migrations, and returns its URL. Never touches
 * the base database. With `recreate`, a database whose migrations fail is dropped and built again once: a test
 * database is disposable, and rows left by older tests can block a newer migration (an enum cast, ).
 */
export async function ensureDb(name, { recreate = false } = {}) {
  const url = baseDatabase().url;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unsafe database name");
  if (name === baseDatabase().name) throw new Error("refusing to prepare the base database");

  const admin = new Pool({ connectionString: url.toString() });
  try {
    const found = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (found.rowCount === 0) await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const target = new URL(url);
  target.pathname = `/${name}`;
  try {
    await applyMigrations(target);
  } catch (e) {
    // Only a data error (SQLSTATE class 22, e.g. an enum cast over an old row) or 55P04 (an enum value added and used
    // in one migration run on a database whose enum predates it, ) means a stale database. Anything else, such
    // as a lock or a duplicate from another process, must never drop a database a test run may be using.
    const code = String(e?.cause?.code ?? e?.code ?? "");
    if (!recreate || !(code.startsWith("22") || code === "55P04")) throw e;
    console.error(`test-db: migrations failed on ${name} (${e?.cause?.code ?? e?.code ?? "error"}); dropping and recreating it`);
    const again = new Pool({ connectionString: url.toString() });
    try {
      await again.query(`drop database if exists "${name}" with (force)`);
      await again.query(`create database "${name}"`);
    } finally {
      await again.end();
    }
    await applyMigrations(target);
  }
  return target.toString();
}

/** Applies the migrations under a session advisory lock, so concurrent test runs never migrate at the same time. */
async function applyMigrations(url) {
  const pool = new Pool({ connectionString: url.toString() });
  const lock = await pool.connect();
  try {
    await lock.query("select pg_advisory_lock(727001)");
    await migrate(drizzle(pool), { migrationsFolder: path.join(root, "drizzle") });
  } finally {
    await lock.query("select pg_advisory_unlock(727001)").catch(() => undefined);
    lock.release();
    await pool.end();
  }
}

export async function ensureTestDb() {
  // TEST_DB_SCOPE gives a run its own database on the branch: the gate's test shards (scripts/test-sharded.sh) use
  // s1..sN, so neither each other nor an ad-hoc vitest run on the same branch can disturb their rows.
  const scope = (process.env.TEST_DB_SCOPE ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 8);
  return ensureDb(`${baseDatabase().name}_test_${branchSlug()}${scope ? `_${scope}` : ""}`, { recreate: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureTestDb().then(
    (u) => console.log(u),
    (e) => {
      console.error("test-db failed:", e?.code ?? e?.name ?? "error");
      process.exit(1);
    },
  );
}
