import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { conversations, messages, turns, users } from "@/db/schema";
import { makeCreator, makeFan, setEngineConfig, makePersona, rig } from "@jadd0/understudy-engine/testing";
import { sendFanMessage, SendRefused } from "./send";

async function setup() {
  await setEngineConfig();
  const creator = await makeCreator();
  await makePersona(creator.id);
  return { creator, fan: await makeFan() };
}

describe("sendFanMessage", () => {
  test("saves the message and one scheduled run produces exactly one AI reply", async () => {
    const { creator, fan } = await setup();
    const r = rig();
    const tasks: (() => Promise<unknown>)[] = [];
    const out = await sendFanMessage(fan.id, creator.id, "  hi juno  ", "c-1", (t) => tasks.push(t));
    expect(out.duplicate).toBe(false);
    expect(tasks).toHaveLength(1);

    // the scheduled task builds production deps; run the same pipeline on fakes instead
    expect(await r.understudy.processConversation(out.conversationId)).toBe(1);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, out.conversationId));
    expect(rows.filter((m) => m.sender === "fan").map((m) => m.body)).toEqual(["hi juno"]);
    expect(rows.filter((m) => m.sender === "ai" && m.status === "sent")).toHaveLength(1);
    expect(await db.select().from(turns).where(eq(turns.conversationId, out.conversationId))).toHaveLength(1);
  });

  test("the same client message id is saved and scheduled once", async () => {
    const { creator, fan } = await setup();
    const tasks: unknown[] = [];
    const a = await sendFanMessage(fan.id, creator.id, "hello", "c-dup", (t) => tasks.push(t));
    const b = await sendFanMessage(fan.id, creator.id, "hello", "c-dup", (t) => tasks.push(t));
    expect(b).toMatchObject({ messageId: a.messageId, conversationId: a.conversationId, duplicate: true });
    expect(tasks).toHaveLength(1);
    expect(await db.select().from(conversations).where(eq(conversations.fanId, fan.id))).toHaveLength(1);
    // someone else cannot claim or read through another fan's client id
    const other = await makeFan();
    await expect(sendFanMessage(other.id, creator.id, "hello", "c-dup", () => {})).rejects.toBeInstanceOf(SendRefused);
  });

  test("refuses empty or oversize text, flagged or unconfirmed accounts, and unknown creators", async () => {
    const { creator, fan } = await setup();
    const never = () => expect.fail("must not schedule");
    await expect(sendFanMessage(fan.id, creator.id, "   ", "c-e", never)).rejects.toMatchObject({ code: "empty" });
    await expect(sendFanMessage(fan.id, creator.id, "x".repeat(2001), "c-l", never)).rejects.toMatchObject({ code: "too_long" });
    await expect(sendFanMessage(fan.id, crypto.randomUUID(), "hi", "c-n", never)).rejects.toMatchObject({ code: "no_creator" });
    await db.update(users).set({ flaggedAt: new Date(), flagReason: "banned" }).where(eq(users.id, fan.id));
    await expect(sendFanMessage(fan.id, creator.id, "hi", "c-f", never)).rejects.toMatchObject({ code: "not_a_fan" });
    await db.update(users).set({ flagReason: "minor_in_chat" }).where(eq(users.id, fan.id));
    await expect(sendFanMessage(fan.id, creator.id, "hi", "c-f2", never)).rejects.toMatchObject({ code: "restricted" });
    const minor = await makeFan();
    await db.update(users).set({ adultConfirmedAt: null }).where(eq(users.id, minor.id));
    await expect(sendFanMessage(minor.id, creator.id, "hi", "c-m", never)).rejects.toMatchObject({ code: "not_a_fan" });
  });

  test("restricted_fan_send_is_refused", async () => {
    const { creator, fan } = await setup();
    await db.update(users).set({ flaggedAt: new Date(), flagReason: "minor_in_chat" }).where(eq(users.id, fan.id));
    const never = () => expect.fail("must not schedule");
    const err = await sendFanMessage(fan.id, creator.id, "please", "c-r", never).catch((e) => e);
    expect(err).toBeInstanceOf(SendRefused);
    expect(err.code).toBe("restricted");
    expect(await db.select().from(messages).where(eq(messages.senderUserId, fan.id))).toHaveLength(0);
    expect(await db.select().from(conversations).where(eq(conversations.fanId, fan.id))).toHaveLength(0);
  });

  test("empty_client_msg_id_refused", async () => {
    const { creator, fan } = await setup();
    const never = () => expect.fail("must not schedule");
    await expect(sendFanMessage(fan.id, creator.id, "hi", "", never)).rejects.toMatchObject({ code: "bad_id" });
    await expect(sendFanMessage(fan.id, creator.id, "hi", "x".repeat(101), never)).rejects.toMatchObject({ code: "bad_id" });
    await expect(sendFanMessage(fan.id, creator.id, "hi", undefined as unknown as string, never)).rejects.toMatchObject({ code: "bad_id" });
    const ok = await sendFanMessage(fan.id, creator.id, "hi", "x".repeat(100), () => {});
    expect(ok.duplicate).toBe(false);
  });

  test("foreign_client_msg_id_leaves_no_conversation", async () => {
    const { creator, fan } = await setup();
    await sendFanMessage(fan.id, creator.id, "mine", "c-owned", () => {});
    const other = await makeFan();
    await expect(sendFanMessage(other.id, creator.id, "stolen", "c-owned", () => expect.fail("no"))).rejects.toMatchObject({ code: "not_a_fan" });
    expect(await db.select().from(conversations).where(eq(conversations.fanId, other.id))).toHaveLength(0);
  });

  test("a message to a conversation a human owns is stored but gets no AI turn", async () => {
    const { creator, fan } = await setup();
    const r = rig();
    const first = await sendFanMessage(fan.id, creator.id, "hi", "c-h1", () => {});
    await db.update(conversations).set({ mode: "human_creator" }).where(eq(conversations.id, first.conversationId));
    const second = await sendFanMessage(fan.id, creator.id, "still there?", "c-h2", () => {});
    expect(await r.understudy.processConversation(second.conversationId)).toBe(0);
    expect(await db.select().from(turns).where(eq(turns.conversationId, first.conversationId))).toHaveLength(0);
  });
});
