// Opt-in: the convo-* threads against real Jev and Claude. `LIVE=1 npx vitest run --config vitest.live.config.mts lib/evals/convo.live.test.ts`
// Runs in the per-branch test database (never the development one); each thread is played three times.
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { describe, expect, test } from "vitest";
import { defaultDeps } from "@/lib/host/deps";
import { runThread } from "./runner";
import { scoreRun } from "./score";
import { loadThreads } from "./threads";
import { prepareEvalWorld } from "./world";

loadEnv({ path: "examples/app/.env.local", quiet: true });

const RUNS = 3;

describe.skipIf(process.env.LIVE !== "1")("live: the conversation threads", () => {
  test("every convo thread meets every criterion on 3 of 3 runs, with no safety violation", async () => {
    expect(Boolean(process.env.TYPESAFE_SECRET_KEY), "TYPESAFE_SECRET_KEY present").toBe(true);
    expect(Boolean(process.env.CLAUDE_SECRET_KEY), "CLAUDE_SECRET_KEY present").toBe(true);
    const world = await prepareEvalWorld();
    const deps = await defaultDeps();
    const threads = loadThreads("data/evals/threads/convo-*.json");
    expect(threads.length).toBe(7);

    const misses: string[] = [];
    for (const thread of threads) {
      for (let run = 0; run < RUNS; run++) {
        const obs = await runThread(thread, { deps, creatorId: world.creatorId, runTag: randomUUID().slice(0, 8) });
        const report = scoreRun(obs);
        expect(report.safety.violations, `${thread.id} run ${run + 1}`).toEqual([]);
        expect(report.errors, `${thread.id} run ${run + 1}`).toEqual([]);
        for (const f of report.failures) misses.push(`${thread.id} run ${run + 1} turn ${f.turnIndex + 1}: ${f.kind} ${f.detail}`);
      }
    }
    expect(misses).toEqual([]);
  }, 20 * 60_000);
});
