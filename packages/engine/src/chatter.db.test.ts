import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { conversations, messages, turns } from "@/db/schema";
import { createChatter, MessageRefused } from "./chatter";
import type { ConfigPort } from "./ports/config";
import { FakeHost } from "./fake-host";
import { makeCreator, makeFan, makePersona, setEngineConfig } from "./test-db";
import { rig } from "./test-harness";

async function setup() {
  await setEngineConfig();
  const creator = await makeCreator();
  await makePersona(creator.id);
  return { creator, fan: await makeFan() };
}

const send = (r: ReturnType<typeof rig>, creatorId: string, fanId: string, body: string, clientMsgId: string) =>
  r.chatter.handleMessage({ creatorId, fanId, body, clientMsgId });

describe("createChatter", () => {
  test("handleMessage stores the message and returns a process that answers it", async () => {
    const { creator, fan } = await setup();
    const r = rig();
    const out = await send(r, creator.id, fan.id, "  hi juno  ", "chatter-1");
    expect(out.duplicate).toBe(false);
    const stored = await db.select().from(messages).where(eq(messages.id, out.messageId));
    expect(stored.map((m) => [m.sender, m.body, m.senderUserId])).toEqual([["fan", "hi juno", fan.id]]);
    expect(await db.select().from(turns).where(eq(turns.conversationId, out.conversationId))).toHaveLength(0);

    await out.process();
    const rows = await db.select().from(messages).where(eq(messages.conversationId, out.conversationId));
    expect(rows.filter((m) => m.sender === "ai" && m.status === "sent")).toHaveLength(1);
    expect(await db.select().from(turns).where(eq(turns.conversationId, out.conversationId))).toHaveLength(1);
  });

  test("the same client message id returns the saved message and a no-op process", async () => {
    const { creator, fan } = await setup();
    const r = rig();
    const first = await send(r, creator.id, fan.id, "hello", "chatter-dup");
    const again = await send(r, creator.id, fan.id, "hello again", "chatter-dup");
    expect(again).toMatchObject({ conversationId: first.conversationId, messageId: first.messageId, duplicate: true });
    await again.process();
    expect(await db.select().from(turns).where(eq(turns.conversationId, first.conversationId))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.conversationId, first.conversationId))).toHaveLength(1);
  });

  test("an empty, too long or bad id message is MessageRefused and stores nothing", async () => {
    const { creator, fan } = await setup();
    const r = rig();
    const code = async (body: string, id: string) => ((await send(r, creator.id, fan.id, body, id).catch((e) => e)) as MessageRefused);
    expect(await code("   ", "chatter-e")).toMatchObject({ name: "MessageRefused", code: "empty" });
    expect(await code("x".repeat(2001), "chatter-l")).toMatchObject({ code: "too_long" });
    expect(await code("hi", "")).toMatchObject({ code: "bad_id" });
    expect(await code("hi", "i".repeat(101))).toMatchObject({ code: "bad_id" });
    expect(await db.select().from(conversations).where(eq(conversations.fanId, fan.id))).toHaveLength(0);
  });

  test("another fan's client message id is not_owner", async () => {
    const { creator, fan } = await setup();
    const r = rig();
    const first = await send(r, creator.id, fan.id, "mine", "chatter-owned");
    const other = await makeFan();
    const err = await send(r, creator.id, other.id, "stolen", "chatter-owned").catch((e) => e);
    expect(err).toBeInstanceOf(MessageRefused);
    expect(err.code).toBe("not_owner");
    expect(await db.select().from(messages).where(eq(messages.conversationId, first.conversationId))).toHaveLength(1);
    expect(await db.select().from(conversations).where(eq(conversations.fanId, other.id))).toHaveLength(0);
  });

  test("two concurrent sends with one client message id store one row and both return it", async () => {
    const { creator, fan } = await setup();
    const r = rig();
    const [a, b] = await Promise.all([send(r, creator.id, fan.id, "race", "chatter-race"), send(r, creator.id, fan.id, "race", "chatter-race")]);
    expect(a.messageId).toBe(b.messageId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    await Promise.all([a.process(), b.process()]);
    expect(await db.select().from(messages).where(eq(messages.conversationId, a.conversationId))).toHaveLength(2);
    expect(await db.select().from(turns).where(eq(turns.conversationId, a.conversationId))).toHaveLength(1);
  });

  test("createChatter uses the db, config and host it is given", async () => {
    const { creator, fan } = await setup();
    const base = rig();
    const host = new FakeHost({ items: [] });
    const asked: string[][] = [];
    // Every platform row but one: the turn must read through this port and fail closed on the gap.
    const config: ConfigPort = {
      async rows(q) {
        asked.push(q.keys);
        const rows = await (await import("@/lib/config")).dbConfigPort.rows(q);
        return rows.filter((row) => row.key !== "engine.typing_cps");
      },
    };
    const chatter = createChatter({ db, config, host, deps: base.deps });
    const out = await chatter.handleMessage({ creatorId: creator.id, fanId: fan.id, body: "hey", clientMsgId: "chatter-cfg" });
    await out.process();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.flat()).toContain("engine.typing_cps");
    const [turn] = await db.select().from(turns).where(eq(turns.conversationId, out.conversationId));
    expect(turn.outcome).toBe("error");
    expect(base.emitted.filter((e) => e.event === "message.created")).toEqual([]);

    // No reply went out. The same conversation on a complete port answers.
    expect(await db.select().from(messages).where(eq(messages.conversationId, out.conversationId))).toHaveLength(1);
    const okChatter = createChatter({ db, config: base.ctx.config, host, deps: base.deps });
    expect(await okChatter.processConversation(out.conversationId)).toBe(1);
    expect(await db.select().from(messages).where(eq(messages.conversationId, out.conversationId))).toHaveLength(2);
  });
});
