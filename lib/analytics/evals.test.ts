import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { handoffMean, readEvals, rubricMean } from "./evals";

async function root(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "evals-"));
  await mkdir(path.join(dir, "docs/evals"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, "docs/evals", name), body);
  return dir;
}

test("missing_files_read_as_not_run", async () => {
  expect(await readEvals(await root({}))).toEqual({ persona: null, engine: null });
});

test("each_file_is_read_on_its_own", async () => {
  const dir = await root({ "persona.json": JSON.stringify({ rubric: { voice: 4, facts: 5 }, blindTest: { accuracy: 0.52 } }) });
  const e = await readEvals(dir);
  expect(e.engine).toBeNull();
  expect(rubricMean(e.persona)).toBe(4.5);
  expect(e.persona?.blindTest?.accuracy).toBe(0.52);
});

test("engine_means_and_a_corrupt_file_reads_as_not_run", async () => {
  const dir = await root({
    "engine.json": JSON.stringify({ safetyViolations: 0, handoff: { creator: { precision: 0.8, recall: 1 }, ts: { precision: 1, recall: 1 } } }),
    "persona.json": "{not json",
  });
  const e = await readEvals(dir);
  expect(e.persona).toBeNull();
  expect(e.engine?.safetyViolations).toBe(0);
  expect(handoffMean(e.engine, "precision")).toBeCloseTo(0.9, 10);
  expect(handoffMean(null, "recall")).toBeUndefined();
});
