// Plays the scenario bank (data/evals/threads) through the real engine with real Jev and Claude, in a database
// built for it, then writes docs/evals/engine.json and the engine section of docs/EVALS.md.
// Usage: npm run eval:engine [-- --threads "<glob>"] [-- --db <name>_eval] [-- --write]
// A run over a subset of the bank prints its report and writes nothing unless --write is given.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
// @ts-expect-error -- plain ESM script without types
import { baseDatabase, ensureDb } from "./test-db.mjs";

/** A mistake in how the script was run; its message is ours and safe to print. */
class Usage extends Error {}

const DEFAULT_GLOB = "data/evals/threads/*.json";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const glob = arg("threads") ?? DEFAULT_GLOB;
  const base = baseDatabase() as { name: string };
  const dbName = arg("db") ?? `${base.name}_eval`;
  if (!/_eval$/.test(dbName) || dbName === base.name) throw new Usage(`--db must name a database ending in _eval, not "${dbName}"`);

  // The database client binds to DATABASE_URL when it is first imported, so the eval URL is set before anything imports it.
  // The eval database is disposable: one whose migrations fail (rows or enum values from an older schema) is rebuilt.
  const url = new URL(await ensureDb(dbName, { recreate: true }));
  process.env.DATABASE_URL = url.toString();
  console.log(`eval database: ${url.host}/${dbName}`);
  for (const key of ["TYPESAFE_SECRET_KEY", "CLAUDE_SECRET_KEY"]) {
    if (!process.env[key]) throw new Usage(`${key} is not set; the live eval needs real providers`);
  }

  const { loadThreads } = await import("@/lib/evals/threads");
  const { runThreads, assertEvalDatabase } = await import("@/lib/evals/runner");
  const { prepareEvalWorld } = await import("@/lib/evals/world");
  const { scoreRun } = await import("@/lib/evals/score");
  const { analyticsSummary, renderEngineSection, spliceEngineSection } = await import("@/lib/evals/render");
  const { defaultDeps } = await import("@/lib/host/deps");
  const { getConfig } = await import("@/lib/config");

  assertEvalDatabase();
  const threads = loadThreads(glob);
  if (threads.length === 0) throw new Usage(`no threads match ${glob}`);
  const turnCount = threads.reduce((s, t) => s + t.turns.length, 0);
  // About 2K Jev tokens in, 2.5K Haiku tokens in, 80 out, plus the memory call: well under a tenth of a cent a turn.
  console.log(`threads: ${threads.length}, fan turns: ${turnCount}, estimated cost: under $${(turnCount * 0.002).toFixed(2)}`);

  const world = await prepareEvalWorld();
  const deps = await defaultDeps();
  const started = Date.now();
  const observations = await runThreads(threads, { deps, creatorId: world.creatorId, runTag: randomUUID().slice(0, 8) }, (id, obs) => {
    const bad = obs.filter((o) => o.outcome === "error").length;
    console.log(`  ${id}: ${obs.length} turns${bad ? `, ${bad} errored` : ""}`);
  });
  const wallSeconds = (Date.now() - started) / 1000;

  const report = scoreRun(observations);
  const meta = {
    at: new Date().toISOString(),
    database: dbName,
    models: {
      jev: await getConfig<string>("jev.model"),
      generate: await getConfig<string>("model.generate"),
      memory: await getConfig<string>("model.memory"),
    },
    cardVersion: world.cardVersion,
    threads: report.threads,
    costMicros: report.cost.totalMicros,
    wallSeconds,
  };
  console.log(
    `safety violations: ${report.safety.count}, errored turns: ${report.errors.length}, expectation misses: ${report.failures.length}, ` +
      `measured cost: $${(report.cost.totalMicros / 1_000_000).toFixed(4)}`,
  );
  for (const v of report.safety.violations) console.log(`  VIOLATION ${v.threadId} turn ${v.turnIndex + 1}: ${v.kind} (${v.evidence})`);

  const write = glob === DEFAULT_GLOB || process.argv.includes("--write");
  if (write) {
    mkdirSync("docs/evals", { recursive: true });
    writeFileSync("docs/evals/engine.json", `${JSON.stringify({ ...analyticsSummary(report), routeAccuracyByRow: report.routeAccuracy, meta, report, turns: observations }, null, 2)}\n`);
    writeFileSync("docs/EVALS.md", spliceEngineSection(readFileSync("docs/EVALS.md", "utf8"), renderEngineSection(report, meta)));
    console.log("wrote docs/evals/engine.json and docs/EVALS.md");
  } else {
    console.log("subset run: nothing written (pass --write to write anyway)");
  }
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  const err = e as { name?: string; code?: string };
  // Anything but our own usage error may carry fan text or a connection string: class and code only.
  console.error("eval:engine failed:", [err?.name, err?.code].filter(Boolean).join(" ") || "error", e instanceof Usage ? e.message : "");
  process.exit(2);
});
