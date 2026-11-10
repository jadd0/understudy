import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { handoffs, messages } from "@/db/schema";
import { humanReply, takeOver, TakeoverRefused, type HumanActor } from "./takeover.js";
import { getConversation, makeConversation, makeCreator, makeFan } from "../testing/db.js";
import { rig } from "../testing/harness.js";

const creatorActor = (creatorId: string): HumanActor => ({ id: crypto.randomUUID(), side: "creator", creatorId });
const tsActor = (): HumanActor => ({ id: crypto.randomUUID(), side: "ts" });
const setMode = (id: string, mode: string) => db.execute(sql`update conversations set mode = ${mode}::conversation_mode where id = ${id}`);

describe("takeOver permissions", () => {
  test("a creator takes her own chat; another creator's actor and an unknown conversation are refused", async () => {
    const creator = await makeCreator();
    const other = await makeCreator();
    const conv = await makeConversation(creator.id, (await makeFan()).id);
    await expect(takeOver({ db }, conv.id, creatorActor(other.id))).rejects.toMatchObject({ code: "not_allowed" });
    await expect(takeOver({ db }, crypto.randomUUID(), creatorActor(creator.id))).rejects.toMatchObject({ code: "not_found" });
    expect((await getConversation(conv.id)).mode).toBe("ai");
    const before = await getConversation(conv.id);
    await takeOver({ db }, conv.id, creatorActor(creator.id));
    const after = await getConversation(conv.id);
    expect(after).toMatchObject({ mode: "human_creator", leaseToken: null });
    expect(after.version).toBe(before.version + 1);
  });

  test("a creator actor is refused on the T&S side, in both T&S modes", async () => {
    const creator = await makeCreator();
    const modes = ["handoff_ts", "human_ts"] as const;
    for (const mode of modes) {
      const conv = await makeConversation(creator.id, (await makeFan()).id);
      await setMode(conv.id, mode);
      await expect(takeOver({ db }, conv.id, creatorActor(creator.id))).rejects.toBeInstanceOf(TakeoverRefused);
      expect((await getConversation(conv.id)).mode).toBe(mode);
    }
  });

  test("a T&S actor takes a conversation in any mode, and it moves to human_ts", async () => {
    const creator = await makeCreator();
    const modes = ["ai", "handoff_creator", "human_creator", "handoff_ts", "human_ts"] as const;
    for (const mode of modes) {
      const conv = await makeConversation(creator.id, (await makeFan()).id);
      await setMode(conv.id, mode);
      await takeOver({ db }, conv.id, tsActor());
      expect((await getConversation(conv.id)).mode).toBe("human_ts");
    }
  });

  test("the claim: a creator claims an open handoff, a T&S actor moves a claim", async () => {
    const creator = await makeCreator();
    const conv = await makeConversation(creator.id, (await makeFan()).id);
    await db.insert(handoffs).values({ conversationId: conv.id, queue: "creator", reason: "custom_request" });
    const c = creatorActor(creator.id);
    await takeOver({ db }, conv.id, c);
    const [h] = await db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id));
    expect(h).toMatchObject({ status: "claimed", claimedBy: c.id });
    const t = tsActor();
    await takeOver({ db }, conv.id, t);
    expect((await db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id)))[0]).toMatchObject({ status: "claimed", claimedBy: t.id });
  });
});

describe("humanReply", () => {
  test("stores the human's message with the actor as sender and emits message.created", async () => {
    const r = rig();
    const creator = await makeCreator();
    const conv = await makeConversation(creator.id, (await makeFan()).id);
    const actor = creatorActor(creator.id);
    await r.understudy.takeOver(conv.id, actor);
    const id = await r.understudy.humanReply(conv.id, actor, "  hi there  ", { clientMsgId: "cm-1" });
    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    expect(m).toMatchObject({ sender: "creator", senderUserId: actor.id, body: "hi there", clientMsgId: "cm-1" });
    expect(r.emitted).toContainEqual({ channel: `conversation:${conv.id}`, event: "message.created", payload: { messageId: id, deliverInMs: 0 } });
    // A retry with the same client id returns the saved row and writes nothing new.
    expect(await r.understudy.humanReply(conv.id, actor, "hi there", { clientMsgId: "cm-1" })).toBe(id);
    expect((await db.select().from(messages).where(eq(messages.conversationId, conv.id))).filter((x) => x.sender === "creator")).toHaveLength(1);
  });

  test("a client id reused in another conversation is refused, not answered with the first one's message", async () => {
    const r = rig();
    const creator = await makeCreator();
    const a = await makeConversation(creator.id, (await makeFan()).id);
    const b = await makeConversation(creator.id, (await makeFan()).id);
    const actor = creatorActor(creator.id);
    await r.understudy.takeOver(a.id, actor);
    await r.understudy.takeOver(b.id, actor);
    const first = await r.understudy.humanReply(a.id, actor, "in a", { clientMsgId: "shared-id" });
    r.emitted.length = 0;
    await expect(r.understudy.humanReply(b.id, actor, "in b", { clientMsgId: "shared-id" })).rejects.toMatchObject({ code: "not_allowed" });
    expect(r.emitted).toEqual([]);
    expect(await db.select().from(messages).where(eq(messages.conversationId, b.id))).toHaveLength(0);
    expect(first).toEqual(expect.any(String));
  });

  test("refused when the actor does not hold the chat", async () => {
    const r = rig();
    const creator = await makeCreator();
    const other = await makeCreator();
    const conv = await makeConversation(creator.id, (await makeFan()).id);
    const mine = creatorActor(creator.id);
    // Not taken over yet: the AI holds it.
    await expect(r.understudy.humanReply(conv.id, mine, "hello")).rejects.toMatchObject({ code: "not_allowed" });
    await r.understudy.takeOver(conv.id, mine);
    await expect(r.understudy.humanReply(conv.id, creatorActor(other.id), "hello")).rejects.toMatchObject({ code: "not_allowed" });
    await expect(r.understudy.humanReply(conv.id, tsActor(), "hello")).rejects.toMatchObject({ code: "not_allowed" });
    await expect(r.understudy.humanReply(crypto.randomUUID(), mine, "hello")).rejects.toMatchObject({ code: "not_found" });
    // A T&S take-over moves the chat off the creator's side: her actor no longer holds it.
    const ts = tsActor();
    await r.understudy.takeOver(conv.id, ts);
    await expect(r.understudy.humanReply(conv.id, mine, "hello")).rejects.toBeInstanceOf(TakeoverRefused);
    expect(await r.understudy.humanReply(conv.id, ts, "support here")).toEqual(expect.any(String));
    expect((await db.select().from(messages).where(eq(messages.conversationId, conv.id))).map((m) => m.sender)).toEqual(["admin"]);
  });

  test("an empty or oversized body is refused before anything is stored", async () => {
    const r = rig();
    const creator = await makeCreator();
    const conv = await makeConversation(creator.id, (await makeFan()).id);
    const actor = creatorActor(creator.id);
    await r.understudy.takeOver(conv.id, actor);
    await expect(r.understudy.humanReply(conv.id, actor, "   ")).rejects.toBeInstanceOf(RangeError);
    await expect(humanReply(r.ctx, conv.id, actor, "x".repeat(2001))).rejects.toBeInstanceOf(RangeError);
    expect(await db.select().from(messages).where(eq(messages.conversationId, conv.id))).toHaveLength(0);
  });
});
