import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { messages, offers } from "@/db/schema";
import { setEngineConfig } from "@understudy/engine/testing";
import { fund, makeConversation, makeCreator, makeFan, makeItem, makeOffer } from "@/lib/wallet/test-helpers";
import { tipInChat, unlockInChat } from "./react";

async function scene() {
  await setEngineConfig();
  const creator = await makeCreator();
  const fan = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  await fund(fan.id, 5000);
  return { creator, fan, conv };
}

describe("a tip in the chat", () => {
  test("posts one system row and schedules one reaction turn, even when retried", async () => {
    const w = await scene();
    const scheduled: unknown[] = [];
    const schedule = (t: unknown) => void scheduled.push(t);
    const key = randomUUID();
    const first = await tipInChat(w.fan.id, w.creator.id, w.conv.id, 500, key, schedule);
    const again = await tipInChat(w.fan.id, w.creator.id, w.conv.id, 500, key, schedule);
    expect(first.messageId).not.toBeNull();
    expect(again.messageId).toBeNull();
    expect(scheduled).toHaveLength(1);
    const rows = await db.select().from(messages).where(and(eq(messages.conversationId, w.conv.id), eq(messages.sender, "system")));
    expect(rows).toMatchObject([{ body: "You tipped $5.00", turnId: null }]);
  });
});

describe("an unlock in the chat", () => {
  test("a purchase schedules one check-in turn; opening it again schedules none", async () => {
    const w = await scene();
    const item = await makeItem(w.creator.id, 700);
    const offer = await makeOffer(w.conv.id, item.id, 700);
    const scheduled: unknown[] = [];
    const schedule = (t: unknown) => void scheduled.push(t);
    expect(await unlockInChat(w.fan.id, offer.id, schedule)).toMatchObject({ alreadyUnlocked: false, conversationId: w.conv.id });
    expect(await unlockInChat(w.fan.id, offer.id, schedule)).toMatchObject({ alreadyUnlocked: true });
    expect(scheduled).toHaveLength(1);
    expect((await db.select().from(offers).where(eq(offers.id, offer.id)))[0].status).toBe("accepted");
  });

  test("a re-offer of something he already owns is bought again, ends accepted, and gets a check-in", async () => {
    const w = await scene();
    const item = await makeItem(w.creator.id, 700);
    await unlockInChat(w.fan.id, (await makeOffer(w.conv.id, item.id, 700)).id, () => {});
    const again = await makeOffer(w.conv.id, item.id, 700);
    const scheduled: unknown[] = [];
    expect(await unlockInChat(w.fan.id, again.id, (t) => void scheduled.push(t))).toMatchObject({ alreadyUnlocked: false, balanceCents: 3600 });
    expect(scheduled).toHaveLength(1);
    expect((await db.select().from(offers).where(eq(offers.id, again.id)))[0].status).toBe("accepted");
  });
});
