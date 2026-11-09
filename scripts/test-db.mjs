// Creates (if absent) the per-branch test database `<base>_test_<branch-slug>` on the local Postgres
// (docker-compose.yml), applies the migrations, and prints its URL on stdout.
// Usage: node scripts/test-db.mjs   (docker compose up -d first)
// The base is TEST_DATABASE_BASE_URL (environment, then examples/app/.env.local), else the compose database.
// DATABASE_URL is never read: it names the hosted database, and tests run locally. A non-local base is refused
// unless TEST_DB_ALLOW_HOSTED=1, which the gate never sets (the scale measurements use it on purpose).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { isPreEngineDatabase, LOCK_KEY, migrateAll } from "../examples/app/scripts/migrate.mjs";
import { DEFAULT_LOCAL_BASE, isLocalHost, pointAtLocalNeon } from "./neon-local.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The base connection string test databases are derived from; local unless hosted use is asked for by name. */
export function baseUrl(env = process.env) {
  let url = env.TEST_DATABASE_BASE_URL;
  const file = path.join(root, "examples/app/.env.local");
  if (!url && existsSync(file)) {
    const m = readFileSync(file, "utf8").match(/^TEST_DATABASE_BASE_URL=(.*)$/m);
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  url ||= DEFAULT_LOCAL_BASE;
  if (!isLocalHost(new URL(url).hostname) && env.TEST_DB_ALLOW_HOSTED !== "1") {
    throw new Error("test databases are local only: TEST_DATABASE_BASE_URL names a non-local host");
  }
  pointAtLocalNeon(url);
  return url;
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

/** A database this script may drop: a derived test database. Never the base database, never a name without `_test_`. */
export function assertDisposable(name) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unsafe database name");
  if (!name.includes("_test_")) throw new Error("refusing to drop a database whose name has no _test_");
  if (name === baseDatabase().name) throw new Error("refusing to drop the base database");
}

/**
 * Drops `name` and creates it again, on one admin connection that holds the migrations' advisory lock key, so no
 * other runner is between "found it" and "migrated it" while it is replaced. `admin` is a pg Pool.
 */
export async function recreateDisposable(admin, name) {
  assertDisposable(name);
  const client = await admin.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`drop database if exists "${name}" with (force)`);
    await client.query(`create database "${name}"`);
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/**
 * Creates `name` next to the base database if absent, applies the migrations, and returns its URL. Never touches
 * the base database. With `recreate`, a database whose migrations fail is dropped and built again once: a test
 * database is disposable, and rows left by older tests can block a newer migration (an enum cast).
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
    // in one migration run on a database whose enum predates it) means a stale database. Anything else, such
    // as a lock or a duplicate from another process, must never drop a database a test run may be using.
    const code = String(e?.cause?.code ?? e?.code ?? "");
    if (!recreate || !(code.startsWith("22") || code === "55P04")) throw e;
    console.error(`test-db: migrations failed on ${name} (${e?.cause?.code ?? e?.code ?? "error"}); dropping and recreating it`);
    const again = new Pool({ connectionString: url.toString() });
    try {
      await recreateDisposable(again, name);
    } finally {
      await again.end();
    }
    await applyMigrations(target);
  }
  return target.toString();
}

/**
 * Applies the engine's migrations, then the host's, under one session advisory lock, so concurrent test runs never
 * migrate at the same time. A database built before the engine had its own migrations table is dropped and rebuilt
 * once: it holds the old combined set, which the two new baselines cannot be applied over.
 */
async function applyMigrations(url) {
  if (await isPreEngineDatabase(url)) {
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    assertDisposable(name);
    console.error(`test-db: ${name} predates the engine migrations; dropping and recreating it`);
    const admin = new Pool({ connectionString: baseDatabase().url.toString() });
    try {
      await recreateDisposable(admin, name);
    } finally {
      await admin.end();
    }
  }
  await migrateAll(url);
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
