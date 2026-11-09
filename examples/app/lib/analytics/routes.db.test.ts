import { beforeAll, describe, expect, test } from "vitest";
import { buildWorld } from "./fixtures";
import { getRoutes } from "./routes";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

describe("getRoutes", () => {
  test("routes_counts_by_route_and_outcome", async () => {
    const r = await getRoutes(w.q);
    expect(r.total).toBe(7);
    expect(r.byRoute).toEqual([
      { route: "reply", count: 3 },
      { route: "offer", count: 2 },
      { route: "hold_creator", count: 1 },
      { route: "none", count: 1 },
    ]);
    expect(r.byOutcome).toEqual([
      { outcome: "replied", count: 4 },
      { outcome: "error", count: 1 },
      { outcome: "handoff", count: 1 },
      { outcome: "superseded", count: 1 },
    ]);
    expect(r.series.reduce((s, p) => s + p.turns, 0)).toBe(7);
    expect(r.series.reduce((s, p) => s + p.committed, 0)).toBe(5);
  });

  test("eval_fans_are_excluded_unless_asked_for", async () => {
    expect((await getRoutes(w.q)).total).toBe(7);
    expect((await getRoutes(w.withEval)).total).toBe(8);
  });

  test("a_creator_never_sees_ts_routes_but_an_admin_does", async () => {
    expect((await getRoutes(w.q)).byRoute.some((x) => x.route === "hard_stop")).toBe(false);
    const admin = await getRoutes(w.adminQ);
    expect(admin.byRoute.find((x) => x.route === "hard_stop")).toEqual({ route: "hard_stop", count: 1 });
    expect(admin.total).toBe(9);
  });
});
