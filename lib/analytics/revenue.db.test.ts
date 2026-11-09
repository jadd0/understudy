import { beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { ledgerEntries } from "@/db/schema";
import { buildWorld, NOW } from "./fixtures";
import { getRevenue, getTopFans } from "./revenue";
import { makeQuery } from "./query";
import { parseRange } from "./range";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

describe("revenue", () => {
  test("revenue_splits_unlock_and_tip_in_cents", async () => {
    const r = await getRevenue(w.q);
    expect(r.unlockCents).toBe(999 + 1999);
    expect(r.tipCents).toBe(500 + 300);
    expect(r.totalCents).toBe(3798);
    expect(r.series.reduce((s, p) => s + p.unlockCents + p.tipCents, 0)).toBe(3798);
    // c1 3498, c2 300, c5 0
    expect(r.perConversation).toEqual({ conversations: 3, meanCents: 1266, p50Cents: 300, paying: 2 });
  });

  test("thirty_days_adds_the_old_tip_and_admin_adds_ts", async () => {
    expect((await getRevenue(w.q30)).tipCents).toBe(500 + 300 + 4000);
    expect((await getRevenue(w.adminQ)).tipCents).toBe(500 + 300 + 700);
  });

  test("top_fans_by_d034_score", async () => {
    const top = await getTopFans(w.q, 10);
    expect(top.map((t) => t.fanId)).toEqual([w.fans.f1.id, w.fans.f2.id]);
    // f2: 300 exactly one 7-day half-life old -> 150.
    expect(top[1]).toMatchObject({ scoreCents: 150, spentCents: 300 });
    const hl = (h: number) => 0.5 ** (h / 24 / 7);
    const f1 = 999 * hl(25 - 1 / 6) + 1999 * hl(120) + 500 * hl(6) + 4000 * hl(240);
    expect(top[0]).toMatchObject({ scoreCents: Math.round(f1), spentCents: 999 + 1999 + 500 + 4000 });
    expect(top.every((t) => t.creatorId === w.A.id)).toBe(true);
  });

  test("eval_fan_spend_is_excluded_from_revenue_and_top_fans", async () => {
    expect((await getRevenue(w.q)).tipCents).toBe(800);
    expect((await getRevenue(w.withEval)).tipCents).toBe(9800);
    expect((await getTopFans(w.q)).some((t) => t.fanId === w.fans.fe.id)).toBe(false);
    expect((await getTopFans(w.withEval))[0].fanId).toBe(w.fans.fe.id);
  });

  test("top_fans_limit_and_sim_tag", async () => {
    const q = makeQuery(w.adminScope, parseRange("7d", NOW), NOW);
    const top = await getTopFans(q, 1);
    expect(top).toHaveLength(1);
    expect(top[0].isSim).toBe(false);
  });

  test("a_welcome_grant_is_not_revenue_and_does_not_move_top_fans", async () => {
    const before = { revenue: await getRevenue(w.q), top: await getTopFans(w.q, 10) };
    await db.insert(ledgerEntries).values([
      { fanId: w.fans.f1.id, kind: "grant", amountCents: 5000, idempotencyKey: `welcome:${w.fans.f1.id}` },
      { fanId: w.fans.f2.id, kind: "grant", amountCents: 5000, idempotencyKey: `welcome:${w.fans.f2.id}` },
    ]);
    expect(before.revenue.totalCents).toBe(3798);
    expect(await getRevenue(w.q)).toEqual(before.revenue);
    expect(await getTopFans(w.q, 10)).toEqual(before.top);
  });
});
