import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { messages, strikes } from "@/db/schema";
import { countStrikes, recordStrike } from "./strikes.js";
import { addMessage, makeConversation, makeCreator, makePersona } from "../testing/db.js";
import { deferred, rig, world, YES } from "../testing/harness.js";
import { runTurn } from "../turn/run.js";

const scope = (w: Awaited<ReturnType<typeof world>>) => ({ creatorId: w.creator.id, fanId: w.fan.id, windowDays: 90 });
const one = (w: Awaited<ReturnType<typeof world>>) => ({ ...scope(w), conversationId: w.conv.id, turnId: null, reason: "location_offplatform" });

describe("strikes", () => {
  test("two concurrent asks in one conversation record strikes 1 and 2, not 1 and 1", async () => {
    const w = await world();
    const firstDone = deferred();
    const release = deferred();
    const a = withTx(async (tx) => {
      const n = await recordStrike(tx, one(w));
      firstDone.resolve();
      await release.promise; // still open: its row is not visible to anyone else yet
      return n;
    });
    await firstDone.promise;
    const b = withTx((tx) => recordStrike(tx, one(w)));
    // let the second transaction reach the conversation lock the first holds
    await new Promise((r) => setTimeout(r, 300));
    release.resolve();
    const numbers = (await Promise.all([a, b])).sort();
    expect(numbers).toEqual([1, 2]);
    expect(await db.select().from(strikes).where(eq(strikes.conversationId, w.conv.id))).toHaveLength(2);
  });

  test("strikes are per creator: a strike with A does not count with B", async () => {
    const a = await world();
    await withTx((tx) => recordStrike(tx, one(a)));
    await withTx((tx) => recordStrike(tx, one(a)));
    // the same fan, a second creator
    const creatorB = await makeCreator();
    const convB = await makeConversation(creatorB.id, a.fan.id);
    expect(await withTx((tx) => countStrikes(tx, scope(a)))).toBe(2);
    expect(await withTx((tx) => countStrikes(tx, { creatorId: creatorB.id, fanId: a.fan.id, windowDays: 90 }))).toBe(0);
    expect(await withTx((tx) => recordStrike(tx, { creatorId: creatorB.id, fanId: a.fan.id, windowDays: 90, conversationId: convB.id, turnId: null, reason: "location_offplatform" }))).toBe(1);

    // through the engine: creator B's chat with the same fan starts at Warning 1 of 3
    await makePersona(creatorB.id);
    await addMessage(convB.id, "fan", "wanna meet", { ageSeconds: 5 });
    await runTurn(rig({ script: { location_offplatform: YES }, replies: ["i keep my chats right here"] }).ctx, convB.id);
    const notices = (await db.select().from(messages).where(eq(messages.conversationId, convB.id))).filter((m) => m.sender === "system");
    expect(notices.map((m) => m.body)).toHaveLength(1);
    expect(notices[0].body).toMatch(/^Warning 2 of 3/); // B already had one recorded above; A's two did not count
  });

  test("the window is measured on the database clock, per fan", async () => {
    const w = await world();
    await db.insert(strikes).values({ ...one(w), createdAt: sql`now() - interval '91 days'` });
    await db.insert(strikes).values({ ...one(w), createdAt: sql`now() - interval '89 days'` });
    expect(await withTx((tx) => countStrikes(tx, scope(w)))).toBe(1);
    expect(await withTx((tx) => countStrikes(tx, { ...scope(w), windowDays: 100 }))).toBe(2);
    expect(await withTx((tx) => countStrikes(tx, { ...scope(w), fanId: w.creator.id }))).toBe(0);
  });
});
