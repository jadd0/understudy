import { beforeAll, expect, test } from "vitest";
import { buildWorld } from "./fixtures";
import { getLatency } from "./latency";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

test("latency_p95_matches_known_set", async () => {
  const l = await getLatency(w.q);
  // linear interpolation over the stored values: total 500,1000,2000,4000; gen 800,1600,2800,3000
  const expected = { ms_total: [1500, 3700, 4], ms_gen: [2200, 2970, 4], ms_jev_in: [300, 480, 5], ms_jev_out: [250, 470, 4] } as const;
  for (const [stage, [p50, p95, samples]] of Object.entries(expected)) {
    const got = l[stage as keyof typeof l];
    expect(got.samples).toBe(samples);
    expect(got.p50).toBeCloseTo(p50, 6);
    expect(got.p95).toBeCloseTo(p95, 6);
  }
});

test("the_ten_day_old_turn_and_other_creators_are_excluded", async () => {
  const l = await getLatency(w.q);
  expect(l.ms_total.p95).toBeLessThan(9999);
});
