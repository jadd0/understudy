import { dbHost } from "@/lib/host/engine-host";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { messages, offers } from "@/db/schema";
import { FakeDecider } from "../testing/fakes/decider.js";
import { DeciderUnavailable } from "../ports/decider.js";
import { buildShortlist, declineOffer, expireOffers, openOfferId, pickOffer } from "./offer.js";
import { loadFacts } from "../turn/facts.js";
import { canPitch } from "../routing/pacing.js";
import { rig } from "../testing/harness.js";
import { CFG } from "../testing/fixtures.js";
import { makeConversation, makeCreator, makeFan, makeItem, setEngineConfig } from "../testing/db.js";
import { sql } from "drizzle-orm";
import { unlocks, ledgerEntries } from "@/db/schema";

beforeAll(async () => {
  await setEngineConfig();
});

async function world() {
  const creator = await makeCreator();
  const fan = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  const a = await makeItem(creator.id, { title: "A", priceCents: 500 });
  const b = await makeItem(creator.id, { title: "B", priceCents: 700 });
  const c = await makeItem(creator.id, { title: "C", priceCents: 900, kind: "bundle" });
  return { creator, fan, conv, a, b, c };
}
const open = (conversationId: string, itemId: string, over: { seconds?: number; status?: "open" | "declined" } = {}) =>
  db
    .insert(offers)
    .values({
      conversationId,
      itemId,
      priceCents: 100,
      status: over.status ?? "open",
      expiresAt: sql`now() + make_interval(secs => ${over.seconds ?? 3600})`,
      resolvedAt: over.status === "declined" ? sql`now()` : undefined,
    })
    .returning();

describe("shortlist", () => {
  test("active items in a fixed order; an open offer, an unlock or an inactive item removes one", async () => {
    const w = await world();
    expect((await buildShortlist(dbHost, w.creator.id, w.fan.id, w.conv.id)).map((i) => i.title)).toEqual(["A", "B", "C"]);
    expect((await buildShortlist(dbHost, w.creator.id, w.fan.id, w.conv.id, ["ppv"])).map((i) => i.title)).toEqual(["A", "B"]);

    await open(w.conv.id, w.a.id);
    expect((await buildShortlist(dbHost, w.creator.id, w.fan.id, w.conv.id)).map((i) => i.title)).toEqual(["B", "C"]);

    // An expired open offer no longer excludes its item.
    await open(w.conv.id, w.b.id, { seconds: -5 });
    expect((await buildShortlist(dbHost, w.creator.id, w.fan.id, w.conv.id)).map((i) => i.title)).toEqual(["B", "C"]);

    const [entry] = await db.insert(ledgerEntries).values({ fanId: w.fan.id, kind: "unlock", amountCents: -900, creatorId: w.creator.id }).returning();
    await db.insert(unlocks).values({ fanId: w.fan.id, itemId: w.c.id, ledgerEntryId: entry.id });
    expect((await buildShortlist(dbHost, w.creator.id, w.fan.id, w.conv.id)).map((i) => i.title)).toEqual(["B"]);
  });
});

describe("pickOffer", () => {
  test("Jev picks by key; a key outside the shortlist is malformed; one candidate needs no call", async () => {
    const w = await world();
    const list = await buildShortlist(dbHost, w.creator.id, w.fan.id, w.conv.id);
    const decider = new FakeDecider({ script: { offer_pick: "o2" } });
    expect((await pickOffer(decider, list, "s")).item.title).toBe("B");
    const single = new FakeDecider();
    expect((await pickOffer(single, list.slice(0, 1), "s")).item.title).toBe("A");
    expect(single.calls).toHaveLength(0);
    const bad = new FakeDecider({ script: { offer_pick: () => "o9" } });
    await expect(pickOffer(bad, list, "s")).rejects.toBeInstanceOf(DeciderUnavailable);
  });
});

describe("decline and expiry", () => {
  test("a declined offer counts against pacing until the cooldown passes; two decline the pitch", async () => {
    const w = await world();
    const [o1] = await open(w.conv.id, w.a.id);
    const [o2] = await open(w.conv.id, w.b.id);
    expect(await openOfferId(rig().ctx, w.conv.id)).toBe(o2.id);
    await withTx((tx) => declineOffer(tx, o1.id));
    const f1 = await loadFacts(rig().ctx, w.conv.id, w.fan.id, w.creator.id, { declineWindowMinutes: 1440, velocityWindowMinutes: 30, strikeWindowDays: 90 });
    expect(f1.declinesInWindow).toBe(1);
    expect(canPitch({ ...f1, roundsSinceOffer: 20 }, CFG, "smalltalk").ok).toBe(true);
    await withTx((tx) => declineOffer(tx, o2.id));
    const f2 = await loadFacts(rig().ctx, w.conv.id, w.fan.id, w.creator.id, { declineWindowMinutes: 1440, velocityWindowMinutes: 30, strikeWindowDays: 90 });
    expect(f2.declinesInWindow).toBe(2);
    expect(canPitch({ ...f2, roundsSinceOffer: 20 }, CFG, "smalltalk")).toEqual({ ok: false, why: "declines" });

    // Declines older than the window stop counting.
    await db.update(offers).set({ resolvedAt: sql`now() - interval '25 hours'` }).where(eq(offers.id, o1.id));
    const f3 = await loadFacts(rig().ctx, w.conv.id, w.fan.id, w.creator.id, { declineWindowMinutes: 1440, velocityWindowMinutes: 30, strikeWindowDays: 90 });
    expect(f3.declinesInWindow).toBe(1);
  });

  test("the sweep marks expired open offers and leaves live and resolved ones", async () => {
    const w = await world();
    const [live] = await open(w.conv.id, w.a.id, { seconds: 3600 });
    const [stale] = await open(w.conv.id, w.b.id, { seconds: -10 });
    expect(await openOfferId(rig().ctx, w.conv.id)).toBe(live.id);
    expect(await expireOffers(rig().ctx)).toBeGreaterThanOrEqual(1);
    const status = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0];
    expect(await status(stale.id)).toMatchObject({ status: "expired" });
    expect((await status(stale.id)).resolvedAt).not.toBeNull();
    expect(await status(live.id)).toMatchObject({ status: "open" });
  });

  test("facts: an open unexpired offer is reported, an expired one is not", async () => {
    const w = await world();
    await open(w.conv.id, w.a.id, { seconds: -5 });
    const cfg = { declineWindowMinutes: 1440, velocityWindowMinutes: 30, strikeWindowDays: 90 };
    expect((await loadFacts(rig().ctx, w.conv.id, w.fan.id, w.creator.id, cfg)).hasOpenOffer).toBe(false);
    await open(w.conv.id, w.b.id);
    expect((await loadFacts(rig().ctx, w.conv.id, w.fan.id, w.creator.id, cfg)).hasOpenOffer).toBe(true);
  });

  test("facts: justUnlocked is true after he accepts her offer and false once she has replied", async () => {
    const w = await world();
    const cfg = { declineWindowMinutes: 1440, velocityWindowMinutes: 30, strikeWindowDays: 90 };
    await db.insert(messages).values({ conversationId: w.conv.id, sender: "ai", body: "wanna see?", status: "sent", createdAt: sql`now() - interval '1 minute'` });
    await db.insert(offers).values({ conversationId: w.conv.id, itemId: w.a.id, priceCents: 999, status: "accepted", expiresAt: sql`now() + interval '1 hour'`, resolvedAt: sql`now() - interval '30 seconds'` });
    expect((await loadFacts(rig().ctx, w.conv.id, w.fan.id, w.creator.id, cfg)).justUnlocked).toBe(true);
    await db.insert(messages).values({ conversationId: w.conv.id, sender: "ai", body: "enjoy 🙈", status: "sent" });
    const after = await loadFacts(rig().ctx, w.conv.id, w.fan.id, w.creator.id, cfg);
    expect(after.justUnlocked).toBe(false);
    expect(after.hasUnlocked).toBe(true);
  });
});
