import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { conversations, ledgerEntries, messages, users } from "@/db/schema";
import { makeConversation, makeCreator as makeBareCreator, makeFan } from "@/lib/conversations/test-helpers";
import { makePersona, setEngineConfig } from "@understudy/engine/testing";
import { fund } from "@/lib/wallet/test-helpers";

const session = { current: null as { user: { id: string } } | null };
vi.mock("@/lib/auth", () => ({ auth: async () => session.current }));
vi.mock("@/lib/conversations/events", () => ({ getEvents: () => ({ emit: async () => {} }) }));
// The engine turn a tip schedules is captured, not run: its reaction is tested in packages/engine/src/conversation/events.db.test.ts.
const scheduled: unknown[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (task: unknown) => void scheduled.push(task) }));

const { tipAction, sendMessage, refreshChat } = await import("./actions");
const { fanCreator } = await import("@/lib/conversations/read");

// Only a creator with a published persona card can be reached.
async function makeCreator() {
  const creator = await makeBareCreator();
  await makePersona(creator.id);
  return creator;
}

const as = (u: { id: string }) => void (session.current = { user: { id: u.id } });
beforeEach(() => {
  session.current = null;
  scheduled.length = 0;
});

async function scene() {
  await setEngineConfig();
  const creator = await makeCreator();
  const fan = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  await fund(fan.id, 5000);
  return { creator, fan, conv };
}

const tipsOf = async (fanId: string) => (await db.select().from(ledgerEntries).where(and(eq(ledgerEntries.fanId, fanId), eq(ledgerEntries.kind, "tip"))));

describe("tip action", () => {
  test("a tip debits the ledger once, carries the conversation, and posts one system row, even when retried", async () => {
    const w = await scene();
    as(w.fan);
    const key = crypto.randomUUID();
    expect(await tipAction(w.creator.handle, key, 500)).toEqual({ ok: true });
    expect(await tipAction(w.creator.handle, key, 500)).toEqual({ ok: true });
    const tips = await tipsOf(w.fan.id);
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({ amountCents: -500, conversationId: w.conv.id });
    const rows = await db.select().from(messages).where(and(eq(messages.conversationId, w.conv.id), eq(messages.sender, "system")));
    expect(rows.map((r) => r.body)).toEqual(["You tipped $5.00"]);
    // one thanks turn for the tip, none for the retry
    expect(scheduled).toHaveLength(1);
  });

  test("below the minimum, insufficient balance and no conversation are refused without a charge", async () => {
    const w = await scene();
    as(w.fan);
    expect(await tipAction(w.creator.handle, crypto.randomUUID(), 50)).toMatchObject({ ok: false });
    expect(await tipAction(w.creator.handle, crypto.randomUUID(), 99_999)).toMatchObject({ ok: false });
    expect(await tipAction(w.creator.handle, "short", 500)).toMatchObject({ ok: false });
    const lone = await makeFan();
    await fund(lone.id, 5000);
    as(lone);
    expect(await tipAction(w.creator.handle, crypto.randomUUID(), 500)).toMatchObject({ ok: false });
    expect(await tipsOf(w.fan.id)).toHaveLength(0);
    expect(await tipsOf(lone.id)).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  test("a flagged or restricted fan and a signed-out caller are refused", async () => {
    const w = await scene();
    for (const reason of ["minor_in_chat", "under_18_declared"]) {
      await db.update(users).set({ flaggedAt: new Date(), flagReason: reason }).where(eq(users.id, w.fan.id));
      as(w.fan);
      await expect(tipAction(w.creator.handle, crypto.randomUUID(), 500)).rejects.toMatchObject({ digest: expect.stringContaining("/blocked") });
    }
    session.current = null;
    await expect(tipAction(w.creator.handle, crypto.randomUUID(), 500)).rejects.toMatchObject({ digest: expect.stringContaining("/signin") });
    expect(await tipsOf(w.fan.id)).toHaveLength(0);
  });
});

describe("which creator a fan reaches", () => {
  const convsOf = (fanId: string) => db.select().from(conversations).where(eq(conversations.fanId, fanId));

  test("fan_reaches_second_creator_by_handle", async () => {
    await setEngineConfig();
    const first = await makeCreator();
    const second = await makeCreator();
    const fan = await makeFan();
    as(fan);
    expect(await sendMessage(second.handle, crypto.randomUUID(), "hello you")).toEqual({ ok: true });
    const convs = await convsOf(fan.id);
    expect(convs.map((c) => c.creatorId)).toEqual([second.id]);
    expect(convs[0].creatorId).not.toBe(first.id);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, convs[0].id));
    expect(rows.map((r) => r.body)).toEqual(["hello you"]);
    // the thread read through the same handle is that conversation, not an empty one
    const snap = await refreshChat(second.handle);
    expect(snap.thread.conversation).toMatchObject({ id: convs[0].id, creatorId: second.id });
  });

  test("unknown_handle_is_refused", async () => {
    await setEngineConfig();
    const creator = await makeCreator();
    const fan = await makeFan();
    await fund(fan.id, 5000);
    await makeConversation(creator.id, fan.id);
    as(fan);
    // a real handle is read back first, so a refusal below is the handle's doing and not an empty population
    expect((await refreshChat(creator.handle)).thread.conversation.creatorId).toBe(creator.id);
    for (const bad of ["no-such-handle", "", "'; drop table creators; --", "<script>alert(1)</script>"]) {
      expect(await sendMessage(bad, crypto.randomUUID(), "hi")).toEqual({ ok: false, error: "Nobody is here to message yet." });
      expect(await tipAction(bad, crypto.randomUUID(), 500)).toEqual({ ok: false, error: "Nobody is here to message yet." });
      await expect(refreshChat(bad)).rejects.toThrow("no creator");
    }
    expect(await tipsOf(fan.id)).toHaveLength(0);
    expect((await convsOf(fan.id)).map((c) => c.creatorId)).toEqual([creator.id]);
    expect(await db.select().from(messages).where(eq(messages.conversationId, (await convsOf(fan.id))[0].id))).toHaveLength(0);
    // a handle in another letter case is the same creator, not a new one
    expect(await sendMessage(creator.handle.toUpperCase(), crypto.randomUUID(), "hi again")).toEqual({ ok: true });
    expect((await convsOf(fan.id)).map((c) => c.creatorId)).toEqual([creator.id]);
  });

  test("a creator with no published card is refused like an unknown handle", async () => {
    await setEngineConfig();
    const bare = await makeBareCreator();
    const fan = await makeFan();
    await fund(fan.id, 5000);
    await makeConversation(bare.id, fan.id);
    as(fan);
    expect(await sendMessage(bare.handle, crypto.randomUUID(), "hi")).toEqual({ ok: false, error: "Nobody is here to message yet." });
    expect(await tipAction(bare.handle, crypto.randomUUID(), 500)).toEqual({ ok: false, error: "Nobody is here to message yet." });
    await expect(refreshChat(bare.handle)).rejects.toThrow("no creator");
    expect(await tipsOf(fan.id)).toHaveLength(0);
  });

  test("no_handle_is_the_creator_of_the_latest_conversation, else the first published by handle", async () => {
    await setEngineConfig();
    const [x, y] = [await makeCreator(), await makeCreator()];
    const [early, late] = x.handle < y.handle ? [x, y] : [y, x];
    const fan = await makeFan();
    as(fan);
    // no conversation yet: the first published creator by handle, asked of the database directly
    const first = (await db.execute(sql`select c.id from creators c where exists (select 1 from persona_cards p where p.creator_id = c.id and p.published_at is not null) order by c.handle limit 1`)).rows[0] as { id: string };
    expect(await sendMessage(null, crypto.randomUUID(), "hello")).toEqual({ ok: true });
    expect((await convsOf(fan.id)).map((c) => c.creatorId)).toEqual([first.id]);
    // a fan talking to the later-sorting creator is kept with her when the URL names nobody
    const fan2 = await makeFan();
    as(fan2);
    expect(await sendMessage(late.handle, crypto.randomUUID(), "hello you")).toEqual({ ok: true });
    expect(await sendMessage(null, crypto.randomUUID(), "and again")).toEqual({ ok: true });
    expect((await convsOf(fan2.id)).map((c) => c.creatorId)).toEqual([late.id]);
    expect((await fanCreator(fan2.id, null))?.id).toBe(late.id);
    expect(early.id).not.toBe(late.id);
  });
});
