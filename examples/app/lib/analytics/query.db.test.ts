import { beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { turns } from "@/db/schema";
import { NOW, ago, buildWorld } from "./fixtures";
import { makeQuery } from "./query";
import { parseRange } from "./range";
import { getTopFans } from "./revenue";
import { listTurns } from "./turns";
import { getVolume } from "./volume";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
  // the fixture's sim fan has messages but no turn; give it one so the turn filters have something to keep and drop
  await db.insert(turns).values({ conversationId: w.convs.c5.id, createdAt: ago(2), route: "reply", outcome: "replied", costMicros: 10 });
});

const withSim = (sim: "all" | "exclude" | "only") => makeQuery({ ...w.scope, sim }, parseRange("7d", NOW), NOW);

describe("sim filter on the shared scope", () => {
  test("exclude_sim_drops_sim_turns", async () => {
    // c5 belongs to the sim fan f5: one fan message in the window and the turns around it
    const all = await getVolume(withSim("all"));
    expect(all.totals.fanMessages).toBe(6);
    const none = await getVolume(withSim("exclude"));
    expect(none.totals.fanMessages).toBe(5);
    expect(none.totals.activeConversations).toBe(all.totals.activeConversations - 1);
    const turnsAll = await listTurns(withSim("all"));
    const turnsNone = await listTurns(withSim("exclude"));
    expect(turnsAll.rows.some((t) => t.conversationId === w.convs.c5.id)).toBe(true);
    expect(turnsNone.rows.some((t) => t.conversationId === w.convs.c5.id)).toBe(false);
    expect(turnsNone.rows.every((t) => !t.isSim)).toBe(true);
    expect(turnsNone.total).toBe(turnsAll.total - 1);
    // a default scope with no sim key is the same as "all"
    expect((await getVolume(w.q)).totals).toEqual(all.totals);
  });

  test("only_sim_keeps_sim_turns", async () => {
    const only = await getVolume(withSim("only"));
    expect(only.totals).toMatchObject({ fanMessages: 1, activeConversations: 1 });
    const page = await listTurns(withSim("only"));
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((t) => t.conversationId === w.convs.c5.id && t.isSim)).toBe(true);
    expect(page.total + (await listTurns(withSim("exclude"))).total).toBe((await listTurns(withSim("all"))).total);
    // together the two halves are the whole
    expect(only.totals.fanMessages + (await getVolume(withSim("exclude"))).totals.fanMessages).toBe((await getVolume(withSim("all"))).totals.fanMessages);
  });

  test("the filter reaches revenue and top fans too", async () => {
    const q = makeQuery({ ...w.adminScope, sim: "exclude" }, parseRange("7d", NOW), NOW);
    expect((await getTopFans(q, 20)).every((f) => !f.isSim)).toBe(true);
    const onlyQ = makeQuery({ ...w.adminScope, sim: "only" }, parseRange("7d", NOW), NOW);
    expect((await getTopFans(onlyQ, 20)).every((f) => f.isSim)).toBe(true);
  });
});
