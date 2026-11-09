import { beforeAll, describe, expect, test } from "vitest";
import { buildWorld } from "./fixtures";
import { getTurn, listTurns } from "./turns";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

describe("turn explorer", () => {
  test("explorer_filters_by_route", async () => {
    const all = await listTurns(w.q);
    expect(all.total).toBe(7);
    const offers = await listTurns(w.q, { route: "offer" });
    expect(offers.rows.map((r) => r.id).sort()).toEqual([w.t.t2.id, w.t.t10.id].sort());
    expect(offers.rows.every((r) => r.route === "offer")).toBe(true);
    expect((await listTurns(w.q, { route: "none" })).rows.map((r) => r.id)).toEqual([w.t.t6.id]);
    expect((await listTurns(w.q, { outcome: "superseded" })).rows.map((r) => r.id)).toEqual([w.t.t3.id]);
    expect((await listTurns(w.q, { route: "offer", outcome: "error" })).total).toBe(0);
  });

  test("explorer_tags_sim_fans", async () => {
    const all = await listTurns(w.q);
    expect(all.rows.every((r) => !r.isSim)).toBe(true);
  });

  test("creator_cannot_open_other_creator_turn", async () => {
    const own = await getTurn(w.scope, w.t.t2.id);
    expect(own?.id).toBe(w.t.t2.id);
    expect(await getTurn(w.scope, w.t.t9.id)).toBeNull();
  });

  test("creator_cannot_see_ts_turns", async () => {
    expect(await getTurn(w.adminScope, w.t.t5.id)).not.toBeNull();
    expect(await getTurn(w.scope, w.t.t5.id)).toBeNull();
    expect((await listTurns(w.q)).rows.some((r) => r.id === w.t.t5.id)).toBe(false);
  });

  test("turn_record_carries_jev_timings_offer_and_handoff", async () => {
    const t2 = await getTurn(w.scope, w.t.t2.id);
    expect(t2).toMatchObject({ route: "offer", timings: { msJevIn: 200, msGen: 1600, msJevOut: 200, msTotal: 2000 }, offer: { id: w.o.o1.id, priceCents: 999 } });
    expect(t2!.jevIn).toMatchObject({ parsed: { intent: "smalltalk" } });
    const t4 = await getTurn(w.scope, w.t.t4.id);
    expect(t4?.handoff).toMatchObject({ reason: "custom_request", queue: "creator" });
    expect(await getTurn(w.scope, "not-a-uuid")).toBeNull();
  });
});
