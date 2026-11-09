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
