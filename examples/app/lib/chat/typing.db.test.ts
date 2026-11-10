import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { conversations } from "@/db/schema";
import { sendFanMessage } from "./send";
import { markFanTyping } from "./typing";
import { TYPING_WINDOW_SECONDS } from "./typing-window";
import { makeConversation, makeCreator, makeFan } from "@jadd0/understudy-engine/testing";

const typingOf = async (id: string) => (await db.select().from(conversations).where(eq(conversations.id, id)))[0].fanTypingUntil;

describe("markFanTyping", () => {
  test("pings the fan's own conversation for a few seconds", async () => {
    const creator = await makeCreator();
    const fan = await makeFan();
    const conv = await makeConversation(creator.id, fan.id);
    expect(await typingOf(conv.id)).toBeNull();
    expect(await markFanTyping(fan.id, creator.id)).toBe(true);
    // a second ping within a second is skipped: no write
    expect(await markFanTyping(fan.id, creator.id)).toBe(false);
    const until = (await typingOf(conv.id))!;
    const ahead = (until.getTime() - Date.now()) / 1000;
    expect(ahead).toBeGreaterThan(TYPING_WINDOW_SECONDS - 3);
    expect(ahead).toBeLessThanOrEqual(TYPING_WINDOW_SECONDS + 1);
  });

  test("typing_ping_for_another_fans_conversation_is_ignored", async () => {
    const creator = await makeCreator();
    const mine = await makeFan();
    const other = await makeFan();
    const myConv = await makeConversation(creator.id, mine.id);
    const otherConv = await makeConversation(creator.id, other.id);
    expect(await markFanTyping(mine.id, creator.id)).toBe(true);
    expect(await typingOf(myConv.id)).not.toBeNull();
    expect(await typingOf(otherConv.id)).toBeNull();
    // a fan with no conversation changes nothing and creates nothing
    const stranger = await makeFan();
    expect(await markFanTyping(stranger.id, creator.id)).toBe(false);
  });

  test("sending a message ends the typing hold", async () => {
    const creator = await makeCreator();
    const fan = await makeFan();
    const conv = await makeConversation(creator.id, fan.id);
    await markFanTyping(fan.id, creator.id);
    expect(await typingOf(conv.id)).not.toBeNull();
    await sendFanMessage(fan.id, creator.id, "hey", `typing-${conv.id}`, () => undefined);
    expect(await typingOf(conv.id)).toBeNull();
  });
});
