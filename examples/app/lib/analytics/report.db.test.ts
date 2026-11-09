import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { buildWorld } from "./fixtures";
import { KPIS } from "./kpis";
import { writeMetrics } from "./report";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

describe("metrics report", () => {
  test("writes_every_kpi_heading", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "metrics-"));
    const file = path.join(dir, "METRICS.md");
    await writeMetrics(file, w.q30, "test creator", dir);
    const text = await readFile(file, "utf8");
    expect(KPIS.length).toBeGreaterThan(10);
    for (const k of KPIS) {
      expect(text).toContain(`\n## ${k.title}\n`);
      expect(text).toContain(`**Source:** ${k.source}`);
    }
    expect(text).toContain(`Generated at: ${w.q30.now.toISOString()}`);
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
    // the 30d world has 8 turns in scope and the report states the real tip total, including the 10-day-old tip.
    expect(text).toContain("| Tips | $48.00 |");
  });

  test("every_kpi_documents_all_five_parts", () => {
    for (const k of KPIS) {
      for (const f of [k.definition, k.formula, k.source, k.counts, k.excludes, k.read]) expect(f.length).toBeGreaterThan(10);
      expect(k.source).toMatch(/^lib\/analytics\/\w+\.ts `\w+`/);
    }
    expect(new Set(KPIS.map((k) => k.id)).size).toBe(KPIS.length);
  });
});
