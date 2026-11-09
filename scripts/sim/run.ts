// The fan simulator's command line. Usage: npm run sim -- --persona <slug> | --mix normal | --random [n] [--seed s]
// [--include-minor] [--include-shared] | --all, with --mode demo|auto (default auto); --stop [runId]; --reset; --export <runId|all>; --list; --docs.
// Runs talk to the database named by DATABASE_URL (the dev database, on purpose); a per-branch test database is refused.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { simRuns } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { exportThread, writeThread } from "@/lib/sim/export";
import { loadPersonas, NORMAL_MIX, personaBySlug, touchesSharedState, type Persona } from "@/lib/sim/persona";
import { newSeed, pickPersonas } from "@/lib/sim/random";
import { driveRun } from "@/lib/sim/drive";
import { beatResults, stopRuns } from "@/lib/sim/run";
import { resetSim } from "@/lib/sim/reset";
import { runCostMicros } from "@/lib/sim/cost";
import { summariseRun } from "@/lib/sim/score";
import { simDeps } from "@/lib/sim/deps";
import { spawnRun, type Spawned } from "@/lib/sim/spawn";
import { writeDocSections } from "@/lib/sim/docs";

export type Plan =
  | { kind: "spawn"; personas: string[]; mode: "demo" | "auto"; seed?: string; includeShared: boolean }
  | { kind: "stop"; runId?: string }
  | { kind: "reset" }
  | { kind: "export"; target: string }
  | { kind: "list" }
  | { kind: "docs" };

export class Usage extends Error {}

/** Turns argv into a plan. Pure, so the flag rules are tested without a database. */
export function parseArgs(argv: string[], personas: Persona[]): Plan {
  const has = (f: string) => argv.includes(`--${f}`);
  const val = (f: string): string | undefined => {
    const i = argv.indexOf(`--${f}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : undefined;
  };
  const mode = (val("mode") ?? "auto") as "demo" | "auto";
  if (mode !== "demo" && mode !== "auto") throw new Usage(`--mode must be demo or auto, not "${mode}"`);
  if (has("reset")) return { kind: "reset" };
  if (has("list")) return { kind: "list" };
  if (has("docs")) return { kind: "docs" };
  if (has("stop")) return { kind: "stop", runId: val("stop") };
  if (has("export")) {
    const target = val("export");
    if (!target) throw new Usage("--export needs a run id or all");
    return { kind: "export", target };
  }
  const includeMinor = has("include-minor");
  const includeShared = has("include-shared");
  const seed = val("seed");
  if (has("persona")) {
    const slug = val("persona");
    if (!slug) throw new Usage("--persona needs a slug");
    const p = personaBySlug(slug, personas);
    if (touchesSharedState(p) && !includeShared) throw new Usage(`"${slug}" changes Juno's real shared state (global AI switch or never-list) while it runs; add --include-shared to run it on purpose`);
    return { kind: "spawn", personas: [slug], mode, seed, includeShared };
  }
  if (has("mix")) {
    if (val("mix") !== "normal") throw new Usage("--mix only knows: normal");
    return { kind: "spawn", personas: [...NORMAL_MIX], mode, seed, includeShared };
  }
  if (has("random")) {
    const n = Number(val("random") ?? "1");
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Usage("--random takes a count from 1 to 50");
    const s = seed ?? newSeed();
    return { kind: "spawn", personas: pickPersonas(personas, n, s, { includeMinor, includeShared }).map((p) => p.slug), mode, seed: s, includeShared };
  }
  if (has("all")) {
    return { kind: "spawn", personas: personas.filter((p) => includeShared || !touchesSharedState(p)).map((p) => p.slug), mode, seed, includeShared };
  }
  throw new Usage("nothing to do: give --persona <slug>, --mix normal, --random [n], --all, --list, --stop, --reset or --export");
}

function assertDevDatabase(url = process.env.DATABASE_URL ?? ""): string {
  const name = url ? new URL(url).pathname.replace(/^\//, "") : "";
  if (!name) throw new Usage("DATABASE_URL is not set");
  if (name.includes("_test_")) throw new Usage(`refusing database "${name}": the sim runs against the dev database, never a test database`);
  return name;
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

async function runAll(spawned: Spawned[], personas: Persona[]): Promise<boolean> {
  const deps = await simDeps();
  const maxConcurrent = await getConfig<number>("sim.max_concurrent_runs");
  const started = Date.now();
  const queue = [...spawned];
  const drive = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) await driveRun(s.runId, deps, 30 * 60_000);
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, spawned.length) }, drive));

  console.log(`\n${pad("persona", 18)}${pad("status", 10)}${pad("beats", 8)}${pad("viol", 6)}${pad("fail", 6)}${pad("pend", 6)}${pad("blocked", 8)}${pad("sim cost", 10)}engine cost`);
  let violations = 0;
  let bad = 0;
  for (const s of spawned) {
    const [row] = await db.select().from(simRuns).where(eq(simRuns.id, s.runId));
    const sum = summariseRun(beatResults(row.log));
    const engine = (await runCostMicros(s.runId)) - row.costMicros;
    violations += sum.violations;
    if (row.status !== "done" || sum.failures > 0) bad++;
    console.log(`${pad(s.persona, 18)}${pad(row.status, 10)}${pad(`${row.nextBeat}/${personaBySlug(s.persona, personas).beats.length}`, 8)}${pad(sum.violations, 6)}${pad(sum.failures, 6)}${pad(sum.pending, 6)}${pad(sum.blocked, 8)}${pad(usd(row.costMicros), 10)}${usd(engine)}${row.stopReason ? `  (${row.stopReason})` : ""}`);
    for (const r of beatResults(row.log))
      for (const f of [...r.score.failures, ...r.score.violations.map((v) => ({ beat: r.index, kind: v.kind, detail: v.evidence }))]) console.log(`    beat ${f.beat} ${f.kind}: ${f.detail}`);
    for (const r of beatResults(row.log)) for (const f of r.score.pending) console.log(`    beat ${f.beat} pending engine PR ${f.pr}: ${f.kind} ${f.detail}`);
  }
  console.log(`\nviolations: ${violations}   runs needing attention: ${bad}   wall: ${((Date.now() - started) / 1000).toFixed(0)}s`);
  return violations === 0 && bad === 0;
}

export async function main(argv: string[]): Promise<number> {
  const personas = loadPersonas();
  const plan = parseArgs(argv, personas);
  const name = assertDevDatabase();
  console.log(`database: ${name}`);

  switch (plan.kind) {
    case "list":
      for (const p of personas) console.log(`${pad(p.slug, 18)}weight ${p.weight}  ${p.beats.length} beats  ${p.goal}`);
      return 0;
    case "docs":
      for (const f of writeDocSections(personas)) console.log(`wrote ${f}`);
      return 0;
    case "reset": {
      const r = await resetSim();
      console.log(`reset: ${r.stopped} run(s) stopped, ${r.fans} sim fan(s) deleted`);
      return 0;
    }
    case "stop":
      console.log(`stopped ${await stopRuns(plan.runId)} run(s)`);
      return 0;
    case "export": {
      const runs = plan.target === "all" ? await db.select().from(simRuns).orderBy(desc(simRuns.createdAt)) : await db.select().from(simRuns).where(eq(simRuns.id, plan.target));
      if (runs.length === 0) throw new Usage("no such run");
      const done = new Set<string>();
      for (const r of runs) {
        if (done.has(r.personaSlug)) continue;
        const thread = exportThread(personaBySlug(r.personaSlug, personas), beatResults(r.log));
        if (!thread) continue;
        done.add(r.personaSlug);
        console.log(`wrote ${writeThread(thread)}`);
      }
      return 0;
    }
    case "spawn": {
      if (!(await getConfig<boolean>("sim.enabled"))) throw new Usage("the simulator is switched off (sim.enabled)");
      const batchId = randomUUID();
      const spawned: Spawned[] = [];
      for (const slug of plan.personas) spawned.push(await spawnRun(slug, plan.mode, { kind: "cli" }, { batchId, seed: plan.seed, personas, includeShared: plan.includeShared }));
      console.log(`spawned ${spawned.length} run(s) in ${plan.mode} mode, batch ${batchId.slice(0, 8)}${plan.seed ? `, seed ${plan.seed}` : ""}`);
      return (await runAll(spawned, personas)) ? 0 : 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof Usage) console.error(e.message);
      else console.error("sim failed:", (e as { code?: string }).code ?? (e as Error).name);
      process.exit(2);
    },
  );
}
