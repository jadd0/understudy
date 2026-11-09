import { expect, test } from "vitest";
import { emptyCreator } from "./fixtures";
import { getCost } from "./cost";
import { getHandoffs } from "./handoffs";
import { getLatency } from "./latency";
import { getOfferFunnel } from "./offers";
import { getResponsible } from "./responsible";
import { getRevenue, getTopFans } from "./revenue";
import { getRoutes } from "./routes";
import { listTurns } from "./turns";
import { getVolume } from "./volume";

test("empty_range_all_null_rates", async () => {
  const { q } = await emptyCreator();
  const [cost, handoffs, latency, offers, responsible, revenue, top, routes, turns, volume] = await Promise.all([
    getCost(q), getHandoffs(q), getLatency(q), getOfferFunnel(q), getResponsible(q), getRevenue(q), getTopFans(q), getRoutes(q), listTurns(q), getVolume(q),
  ]);
  expect(cost).toMatchObject({ totalMicros: 0, replies: 0, perReplyMicros: null, byModel: [] });
  expect(handoffs).toMatchObject({ opened: 0, rate: null, openNow: 0, claimSeconds: { p50: null, p95: null }, groups: [] });
  expect(Object.values(latency).every((s) => s.p50 === null && s.p95 === null && s.samples === 0)).toBe(true);
  expect(offers).toMatchObject({ made: 0, acceptanceRate: null, offerRate: null });
  expect(responsible).toEqual({ hardshipTurns: 0, pitchedDespiteHardship: 0, hardshipCooldownsActive: 0, fansAtCapToday: 0 });
  expect(revenue).toMatchObject({ totalCents: 0, perConversation: { conversations: 0, meanCents: null, p50Cents: null } });
  expect(top).toEqual([]);
  expect(routes).toMatchObject({ total: 0, byRoute: [], byOutcome: [] });
  expect(turns).toMatchObject({ total: 0, rows: [], page: 1, pages: 1 });
  expect(volume.totals.fanMessages).toBe(0);
  expect(JSON.stringify([cost, handoffs, latency, offers, revenue, routes, volume])).not.toMatch(/NaN|Infinity/);
});

test("a_scope_with_no_creators_reads_nothing", async () => {
  const { q } = await emptyCreator();
  const none = { ...q, creatorIds: [] };
  expect((await getRevenue(none)).totalCents).toBe(0);
  expect(await getTopFans(none)).toEqual([]);
  expect((await getVolume(none)).totals.fanMessages).toBe(0);
});
