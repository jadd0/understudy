import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { catalogueItems, creators, messages, users } from "@/db/schema";
import { consoleCreatorFor } from "@/lib/conversations/read";
import { convOf, makeAdmin, makeConversation, makeCreator, makeFan } from "@/lib/conversations/test-helpers";
import { makeItem } from "@understudy/engine/testing";

const session = { current: null as { user: { id: string } } | null };
const tasks: (() => Promise<unknown>)[] = [];
vi.mock("@/lib/auth", () => ({ auth: async () => session.current }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => void tasks.push(fn) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// Realtime is not under test: the actions' events go nowhere.
vi.mock("@/lib/conversations/events", () => ({ getEvents: () => ({ async emit() {} }) }));

const actions = await import("./actions");
const as = (u: { id: string }) => void (session.current = { user: { id: u.id } });
const form = (o: Record<string, string>) => Object.entries(o).reduce((f, [k, v]) => (f.set(k, v), f), new FormData());
const digest = async (p: Promise<unknown>) => p.then(() => null, (e: { digest?: string }) => String(e.digest ?? e));
const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/;

beforeEach(() => {
  session.current = null;
  tasks.length = 0;
});

async function world() {
  const creator = await makeCreator();
  const fan = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  return { creator, fan, conv };
}

describe("console actions", () => {
  test("an admin takes over and replies from the console, attributed to the admin", async () => {
    const w = await world();
    const admin = await makeAdmin();
    as(admin);
    expect(await actions.takeoverAction(w.conv.id)).toEqual({ ok: true });
    // An admin's takeover puts the chat on the Trust & Safety side, as from /admin.
    expect((await convOf(w.conv.id)).mode).toBe("human_ts");
    expect(await actions.replyAction(w.conv.id, randomUUID(), "hi from the team")).toEqual({ ok: true });
    const [m] = await db.select().from(messages).where(eq(messages.conversationId, w.conv.id));
    expect(m).toMatchObject({ sender: "admin", senderUserId: admin.id, body: "hi from the team" });
    expect(m.senderUserId).not.toBe(w.creator.userId);
    // Creator-only actions stay refused for an admin; release is its way back to the AI.
    expect((await actions.sendOfferAction(w.conv.id, (await makeItem(w.creator.id)).id)).ok).toBe(false);
    expect((await actions.handBackAction(w.conv.id)).ok).toBe(false);
    expect(await actions.releaseAction(w.conv.id)).toEqual({ ok: true });
    expect((await convOf(w.conv.id)).mode).toBe("ai");
  });

  test("a fan or a signed-out visitor calling a console action is refused and nothing is written", async () => {
    const w = await world();
    as(w.fan);
    expect(await digest(actions.takeoverAction(w.conv.id))).toMatch(NOT_FOUND);
    expect(await digest(actions.replyAction(w.conv.id, randomUUID(), "sneaky"))).toMatch(NOT_FOUND);
    expect(await digest(actions.releaseAction(w.conv.id))).toMatch(NOT_FOUND);
    expect(await digest(actions.saveGlobalAi(form({ ai: "on" })))).toMatch(NOT_FOUND);
    session.current = null;
    expect(await digest(actions.takeoverAction(w.conv.id))).toMatch(/NEXT_REDIRECT.*\/signin/);
    expect((await convOf(w.conv.id)).mode).toBe("ai");
    expect(await db.select().from(messages).where(eq(messages.conversationId, w.conv.id))).toHaveLength(0);
  });

  test("the creator still uses her console; she cannot release, which is admin only", async () => {
    const w = await world();
    as({ id: w.creator.userId });
    expect(await actions.takeoverAction(w.conv.id)).toEqual({ ok: true });
    expect(await actions.replyAction(w.conv.id, randomUUID(), "hey you")).toEqual({ ok: true });
    const [m] = await db.select().from(messages).where(eq(messages.conversationId, w.conv.id));
    expect(m).toMatchObject({ sender: "creator", senderUserId: w.creator.userId });
    expect((await actions.releaseAction(w.conv.id)).ok).toBe(false);
  });

  test("an admin edits the settings of the creator its console resolves to", async () => {
    // A creator whose handle sorts first, so the console creator is one only this file touches.
    const [u] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, role: "creator" }).returning();
    await db.insert(creators).values({ userId: u.id, handle: `0-console-${randomUUID().slice(0, 8)}`, displayName: "Juno" });
    const admin = await makeAdmin();
    const target = (await consoleCreatorFor({ id: admin.id, role: "admin" }))!;
    expect(target.handle.startsWith("0-console-")).toBe(true);
    const item = await makeItem(target.id);
    as(admin);
    expect(await digest(actions.savePrice(form({ itemId: item.id, price: "12.34" })))).toMatch(/NEXT_REDIRECT.*saved=price/);
    const [after] = await db.select().from(catalogueItems).where(eq(catalogueItems.id, item.id));
    expect(after.priceCents).toBe(1234);
    // A fan resolves to no console creator at all.
    expect(await consoleCreatorFor({ id: (await makeFan()).id, role: "fan" })).toBeNull();
  });
});

describe("catalogue actions", () => {
  const itemsOf = (creatorId: string) => db.select().from(catalogueItems).where(eq(catalogueItems.creatorId, creatorId));

  test("add_item_action_parses_dollars_to_cents", async () => {
    const w = await world();
    as({ id: w.creator.userId });
    expect(await digest(actions.addItemAction(form({ kind: "ppv", title: "Sunset set", teaser: "golden", price: "9.99" })))).toMatch(/NEXT_REDIRECT.*saved=item_added/);
    expect(await digest(actions.addItemAction(form({ kind: "bundle", title: "Whole dollars", price: "12" })))).toMatch(/saved=item_added/);
    expect(await digest(actions.addItemAction(form({ kind: "personal", title: "Largest", price: "9999999.99" })))).toMatch(/saved=item_added/);
    const rows = await itemsOf(w.creator.id);
    expect(rows.map((r) => [r.title, r.priceCents]).sort()).toEqual([["Largest", 999_999_999], ["Sunset set", 999], ["Whole dollars", 1200]]);
    // text that is not a price, a sign, an exponent, a third decimal and a blank are refused before anything is written
    for (const price of ["abc", "", "-1", "1e9", "9.999", "$5", "10000000"]) {
      expect(await digest(actions.addItemAction(form({ kind: "ppv", title: "Nope", price })))).toMatch(/error=item_price;/);
    }
    // "0" is a price the parser reads and the control refuses; a good price with a bad kind or title is refused too
    expect(await digest(actions.addItemAction(form({ kind: "ppv", title: "Free", price: "0" })))).toMatch(/error=item;/);
    expect(await digest(actions.addItemAction(form({ kind: "free", title: "Nope", price: "5" })))).toMatch(/error=item;/);
    expect(await digest(actions.addItemAction(form({ kind: "ppv", title: "  ", price: "5" })))).toMatch(/error=item;/);
    expect(await itemsOf(w.creator.id)).toHaveLength(3);
    expect(rows.every((r) => Number.isInteger(r.priceCents))).toBe(true);
  });

  test("retire, restore and move go through the creator's own session and refuse a fan or another creator's item", async () => {
    const w = await world();
    const mine = await makeItem(w.creator.id, { title: "Mine" });
    const other = await world();
    const theirs = await makeItem(other.creator.id, { title: "Theirs" });
    const activeOf = async (id: string) => (await db.select().from(catalogueItems).where(eq(catalogueItems.id, id)))[0].active;

    as({ id: w.creator.userId });
    expect(await digest(actions.retireItemAction(form({ itemId: mine.id })))).toMatch(/saved=item_retired/);
    expect(await activeOf(mine.id)).toBe(false);
    expect(await digest(actions.restoreItemAction(form({ itemId: mine.id })))).toMatch(/saved=item_restored/);
    expect(await activeOf(mine.id)).toBe(true);
    expect(await digest(actions.moveItemAction(form({ itemId: mine.id, direction: "up" })))).toMatch(/saved=item_moved/);
    // someone else's item, and an id that is not an item at all
    expect(await digest(actions.retireItemAction(form({ itemId: theirs.id })))).toMatch(/error=item_edit/);
    expect(await digest(actions.moveItemAction(form({ itemId: theirs.id, direction: "down" })))).toMatch(/error=item_edit/);
    expect(await digest(actions.retireItemAction(form({ itemId: "not-a-uuid" })))).toMatch(/error=item_edit;/);
    expect(await activeOf(theirs.id)).toBe(true);

    as(w.fan);
    expect(await digest(actions.retireItemAction(form({ itemId: mine.id })))).toMatch(NOT_FOUND);
    expect(await digest(actions.addItemAction(form({ kind: "ppv", title: "Sneaky", price: "5" })))).toMatch(NOT_FOUND);
    expect(await activeOf(mine.id)).toBe(true);
  });
});

