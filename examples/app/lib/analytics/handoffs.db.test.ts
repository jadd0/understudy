import { beforeAll, describe, expect, test } from "vitest";
import { buildWorld } from "./fixtures";
import { getHandoffs } from "./handoffs";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

describe("getHandoffs", () => {
  test("handoff_rate_and_claim_p50", async () => {
    const h = await getHandoffs(w.q);
    expect(h.opened).toBe(3);
    expect(h.turns).toBe(7);
    expect(h.rate).toBeCloseTo(3 / 7, 10);
    expect(h.openNow).toBe(1);
    // claimed after 60s and 180s
    expect(h.claimSeconds).toEqual({ p50: 120, p95: 174 });
    expect(h.resolveSeconds).toEqual({ p50: 600, p95: 600 });
    expect(h.groups).toEqual([
      { queue: "creator", reason: "custom_request", count: 2, p50: 60, p95: 60 },
      { queue: "creator", reason: "unsure", count: 1, p50: 180, p95: 180 },
    ]);
  });

  test("admin_sees_the_ts_queue", async () => {
    const h = await getHandoffs(w.adminQ);
    expect(h.groups.find((g) => g.queue === "ts")).toMatchObject({ reason: "minor", count: 1, p50: null });
  });
});
