import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { makeUser } from "@/db/test-helpers";
import { catalogueItems, creators, ledgerEntries, offers, unlocks } from "@/db/schema";
import { dbHost } from "@/lib/host/engine-host";
import { InvalidAmount } from "@/lib/wallet/errors";
import { unlockOffer } from "@/lib/wallet/unlock";
import { fund } from "@/lib/wallet/test-helpers";
import { makeItem, setEngineConfig } from "@understudy/engine/testing";
import { addItem, Forbidden, InvalidInput, moveItem, sendOfferAsCreator, setItemActive, setItemPrice } from "./controls";
import { offerableItems, primaryCreator } from "./read";
import { asViewer, makeAdmin, makeConversation, makeCreator, makeFan, setMode } from "./test-helpers";

const creatorOf = (c: { userId: string }) => asViewer({ id: c.userId, role: "creator" });
const input = (over: Partial<Parameters<typeof addItem>[1]> = {}) => ({ kind: "ppv", title: "New thing", teaser: "", cents: 999, ...over });

/** The creator's rows in the order the console lists them, with their stored positions. */
async function listed(creatorId: string) {
  return db
    .select({ id: catalogueItems.id, title: catalogueItems.title, position: catalogueItems.position, active: catalogueItems.active })
    .from(catalogueItems)
    .where(eq(catalogueItems.creatorId, creatorId))
    .orderBy(asc(catalogueItems.position), asc(catalogueItems.title), asc(catalogueItems.id));
}
const isPermutation = (positions: number[]) => [...positions].sort((a, b) => a - b).every((p, i) => p === i);

/** A creator with three active items titled A, B, C, all at position 0 as the migration leaves existing rows. */
async function shelf() {
  const creator = await makeCreator();
  const [a, b, c] = [await makeItem(creator.id, { title: "A" }), await makeItem(creator.id, { title: "B" }), await makeItem(creator.id, { title: "C" })];
  return { creator, viewer: creatorOf(creator), a, b, c };
}
const titles = async (creatorId: string) => (await listed(creatorId)).map((r) => r.title);

describe("addItem", () => {
  test("add_item_stores_integer_cents_for_own_creator", async () => {
    const w = await shelf();
    const other = await makeCreator();
    const otherBefore = (await listed(other.id)).length;
    const id = await addItem(w.viewer, input({ kind: "bundle", title: "  Two for one  ", teaser: "  both of them  ", cents: 1234 }));
    const [row] = await db.select().from(catalogueItems).where(eq(catalogueItems.id, id));
    expect(row).toMatchObject({ creatorId: w.creator.id, kind: "bundle", title: "Two for one", teaser: "both of them", priceCents: 1234, active: true });
    expect(Number.isInteger(row.priceCents)).toBe(true);
    // appended after the three that already tie at 0, whatever their titles
    expect((await titles(w.creator.id)).at(-1)).toBe("Two for one");
    expect(row.position).toBeGreaterThan(0);
    // a blank teaser is stored as none, and nothing leaked to the other creator
    const blank = await addItem(w.viewer, input({ title: "Quiet", teaser: "   " }));
    expect((await db.select().from(catalogueItems).where(eq(catalogueItems.id, blank)))[0].teaser).toBeNull();
    expect((await listed(other.id)).length).toBe(otherBefore);
    // a creator with an empty shelf starts at 0
    const fresh = await makeCreator();
    const first = await addItem(creatorOf(fresh), input());
    expect((await db.select().from(catalogueItems).where(eq(catalogueItems.id, first)))[0].position).toBe(0);
  });

  test("add_rejects_zero_negative_and_bad_kind", async () => {
    const w = await shelf();
    const before = (await listed(w.creator.id)).length;
    expect(before).toBe(3);
    for (const cents of [0, -1, 1.5, Number.NaN, 2_147_483_648, 1e12]) {
      await expect(addItem(w.viewer, input({ cents }))).rejects.toBeInstanceOf(InvalidAmount);
    }
    for (const kind of ["", "free", "PPV", "ppv; drop table catalogue_items"]) {
      await expect(addItem(w.viewer, input({ kind }))).rejects.toMatchObject({ name: "InvalidInput", field: "kind" });
    }
    for (const title of ["", "   ", "x".repeat(81)]) {
      await expect(addItem(w.viewer, input({ title }))).rejects.toMatchObject({ name: "InvalidInput", field: "title" });
    }
    await expect(addItem(w.viewer, input({ teaser: "x".repeat(201) }))).rejects.toMatchObject({ name: "InvalidInput", field: "teaser" });
    await expect(addItem(asViewer({ id: (await makeFan()).id, role: "fan" }), input())).rejects.toBeInstanceOf(Forbidden);
    expect((await listed(w.creator.id)).length).toBe(before);
    // the boundaries themselves are accepted: one cent, the largest integer, an 80-character title, a 200-character teaser
    for (const over of [{ cents: 1 }, { cents: 2_147_483_647 }, { title: "x".repeat(80) }, { teaser: "x".repeat(200) }]) {
      await addItem(w.viewer, input(over));
    }
    expect((await listed(w.creator.id)).length).toBe(before + 4);
  });
});

describe("retire and restore", () => {
  test("retire_hides_item_from_shortlist_and_offer_picker", async () => {
    await setEngineConfig();
    const w = await shelf();
    const fan = await makeFan();
    const conv = await makeConversation(w.creator.id, fan.id);
    const query = { creatorId: w.creator.id, fanId: fan.id, conversationId: conv.id };
    const ids = async () => (await dbHost.catalogue.shortlist(query)).map((i) => i.id);
    expect(await ids()).toContain(w.b.id);
    expect((await offerableItems(w.creator.id)).map((i) => i.id)).toContain(w.b.id);

    await setItemActive(w.viewer, w.b.id, false);
    expect(await ids()).not.toContain(w.b.id);
    expect(await ids()).toEqual(expect.arrayContaining([w.a.id, w.c.id]));
    expect((await offerableItems(w.creator.id)).map((i) => i.id)).toEqual([w.a.id, w.c.id]);
    // the retired row is still there, so nothing that points at it breaks
    expect((await listed(w.creator.id)).map((r) => r.title)).toEqual(["A", "B", "C"]);
    // and a creator holding the chat cannot send an offer for it either
    await setMode(conv.id, "human_creator");
    await expect(sendOfferAsCreator(w.viewer, conv.id, w.b.id)).rejects.toBeInstanceOf(Forbidden);

    await setItemActive(w.viewer, w.b.id, true);
    expect(await ids()).toContain(w.b.id);
    expect((await offerableItems(w.creator.id)).map((i) => i.id)).toEqual([w.a.id, w.b.id, w.c.id]);
  });

  test("open_offer_on_retired_item_still_unlocks", async () => {
    await setEngineConfig();
    const w = await shelf();
    const fan = await makeFan();
    const conv = await makeConversation(w.creator.id, fan.id);
    await fund(fan.id, 5000);
    const [offer] = await db
      .insert(offers)
      .values({ conversationId: conv.id, itemId: w.a.id, priceCents: w.a.priceCents, expiresAt: new Date(Date.now() + 3_600_000) })
      .returning();
    await setItemActive(w.viewer, w.a.id, false);

    const res = await unlockOffer(fan.id, offer.id);
    expect(res).toMatchObject({ alreadyUnlocked: false, itemId: w.a.id });
    expect(await db.select().from(unlocks).where(eq(unlocks.itemId, w.a.id))).toHaveLength(1);
    expect((await db.select().from(ledgerEntries).where(eq(ledgerEntries.conversationId, conv.id))).map((e) => e.amountCents)).toEqual([-w.a.priceCents]);
    // once owned and retired, neither shortlist offers it again
    const query = { creatorId: w.creator.id, fanId: fan.id, conversationId: conv.id };
    expect((await dbHost.catalogue.shortlist(query)).map((i) => i.id)).not.toContain(w.a.id);
    expect((await dbHost.catalogue.ownedShortlist(query)).map((i) => i.id)).not.toContain(w.a.id);
  });
});

describe("moveItem", () => {
  test("move_up_down_renumbers_and_stops_at_ends", async () => {
    const w = await shelf();
    const order = () => titles(w.creator.id);
    const positions = async () => (await listed(w.creator.id)).map((r) => r.position);
    expect(await order()).toEqual(["A", "B", "C"]);

    await moveItem(w.viewer, w.c.id, "up");
    expect(await order()).toEqual(["A", "C", "B"]);
    expect(await positions()).toEqual([0, 1, 2]);
    await moveItem(w.viewer, w.a.id, "down");
    expect(await order()).toEqual(["C", "A", "B"]);
    // the ends do not wrap and do not fail
    await moveItem(w.viewer, w.c.id, "up");
    await moveItem(w.viewer, w.b.id, "down");
    expect(await order()).toEqual(["C", "A", "B"]);
    expect(await positions()).toEqual([0, 1, 2]);
    // the offer picker follows the same order
    expect((await offerableItems(w.creator.id)).map((i) => i.title)).toEqual(["C", "A", "B"]);
    // an item added later lands last
    await addItem(w.viewer, input({ title: "Aardvark" }));
    expect(await order()).toEqual(["C", "A", "B", "Aardvark"]);
  });

  test("a move steps over a retired item and keeps every position a permutation", async () => {
    const w = await shelf();
    await setItemActive(w.viewer, w.b.id, false);
    await moveItem(w.viewer, w.c.id, "up");
    expect((await offerableItems(w.creator.id)).map((i) => i.title)).toEqual(["C", "A"]);
    expect(isPermutation((await listed(w.creator.id)).map((r) => r.position))).toBe(true);
    // a retired item has no place in the live list: moving it changes nothing but is not refused
    const before = await listed(w.creator.id);
    await moveItem(w.viewer, w.b.id, "up");
    expect((await listed(w.creator.id)).map((r) => r.id)).toEqual(before.map((r) => r.id));
  });

  test("two moves at once never lose one or duplicate a position", async () => {
    const w = await shelf();
    // two live transactions moving the same item: serialised, so it climbs two places and ends first
    await Promise.all([moveItem(w.viewer, w.c.id, "up"), moveItem(w.viewer, w.c.id, "up")]);
    expect(await titles(w.creator.id)).toEqual(["C", "A", "B"]);
    expect(isPermutation((await listed(w.creator.id)).map((r) => r.position))).toBe(true);

    // many at once, in both directions on different items: whatever the interleaving, the result is a permutation
    const v = await shelf();
    const calls = [v.a, v.b, v.c, v.a, v.b, v.c, v.c, v.a].map((item, i) => moveItem(v.viewer, item.id, i % 2 === 0 ? "down" : "up"));
    await Promise.all(calls);
    const rows = await listed(v.creator.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });
});

describe("other creators and admins", () => {
  test("other_creators_item_is_forbidden_for_every_write", async () => {
    const mine = await shelf();
    const theirs = await shelf();
    const snapshot = async () => (await db.select().from(catalogueItems).where(eq(catalogueItems.creatorId, theirs.creator.id))).sort((x, y) => x.title.localeCompare(y.title));
    const before = await snapshot();
    expect(before).toHaveLength(3);

    await expect(setItemPrice(mine.viewer, theirs.a.id, 500)).rejects.toBeInstanceOf(Forbidden);
    await expect(setItemActive(mine.viewer, theirs.a.id, false)).rejects.toBeInstanceOf(Forbidden);
    await expect(setItemActive(mine.viewer, theirs.a.id, true)).rejects.toBeInstanceOf(Forbidden);
    await expect(moveItem(mine.viewer, theirs.a.id, "down")).rejects.toBeInstanceOf(Forbidden);
    await expect(moveItem(mine.viewer, randomUUID(), "up")).rejects.toBeInstanceOf(Forbidden);
    await expect(moveItem(mine.viewer, theirs.a.id, "sideways" as "up")).rejects.toBeInstanceOf(InvalidInput);
    expect(await snapshot()).toEqual(before);

    // the same calls succeed from the owner's side, so the refusals above are the scoping and not a broken write
    await setItemPrice(theirs.viewer, theirs.a.id, 500);
    await setItemActive(theirs.viewer, theirs.a.id, false);
    await moveItem(theirs.viewer, theirs.c.id, "up");
    const after = await snapshot();
    expect(after.find((r) => r.id === theirs.a.id)).toMatchObject({ priceCents: 500, active: false });
    // and nothing of it touched the first creator's shelf
    expect((await listed(mine.creator.id)).every((r) => r.active)).toBe(true);
  });

  test("admin_cannot_edit_a_creators_catalogue", async () => {
    // An admin's console creator is the default one (the first by handle), so edits reach only that shelf. A creator
    // whose handle sorts after every other cannot be the default while another creator exists.
    await makeCreator();
    const user = await makeUser({ role: "creator" });
    const [late] = await db.insert(creators).values({ userId: user.id, handle: `zzz-${randomUUID().slice(0, 8)}`, displayName: "Late" }).returning();
    const item = await makeItem(late.id, { title: "Late item", priceCents: 700 });
    const admin = asViewer(await makeAdmin());
    const primary = await primaryCreator();
    expect(primary).not.toBeNull();
    expect(primary!.id).not.toBe(late.id);

    await expect(setItemPrice(admin, item.id, 100)).rejects.toBeInstanceOf(Forbidden);
    await expect(setItemActive(admin, item.id, false)).rejects.toBeInstanceOf(Forbidden);
    await expect(moveItem(admin, item.id, "up")).rejects.toBeInstanceOf(Forbidden);
    const [row] = await db.select().from(catalogueItems).where(eq(catalogueItems.id, item.id));
    expect(row).toMatchObject({ priceCents: 700, active: true, position: 0 });

    // what an admin can do today is add to the default creator's shelf, never to another's
    const added = await addItem(admin, input({ title: "From admin" }));
    expect((await db.select().from(catalogueItems).where(eq(catalogueItems.id, added)))[0].creatorId).toBe(primary!.id);
    expect(await listed(late.id)).toHaveLength(1);
  });
});
