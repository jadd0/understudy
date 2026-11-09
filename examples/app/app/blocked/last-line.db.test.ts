import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { messages, users } from "@/db/schema";
import { addMessage, makeConversation, makeCreator, makeFan } from "@/lib/conversations/test-helpers";
import { threatLine } from "./last-line";

async function flagged(reason: string | null) {
  const creator = await makeCreator();
  const fan = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  if (reason) await db.update(users).set({ flaggedAt: sql`now()`, flagReason: reason }).where(eq(users.id, fan.id));
  return { fan, conv };
}

describe("threatLine", () => {
  test("a flagged threat shows the line written with the flag, not an earlier reply", async () => {
    const { fan, conv } = await flagged(null);
    await addMessage(conv.id, "ai", "an ordinary earlier reply", { ageSeconds: 60 });
    await db.update(users).set({ flaggedAt: sql`now()`, flagReason: "threat" }).where(eq(users.id, fan.id));
    const line = await addMessage(conv.id, "ai", "not okay. this chat ends here");
    await db.update(messages).set({ createdAt: sql`(select flagged_at from users where id = ${fan.id})` }).where(eq(messages.id, line.id));
    expect(await threatLine(fan.id)).toBe("not okay. this chat ends here");
  });

  test("none when the line never passed a check, when the flag is for another reason, or when not flagged", async () => {
    const silent = await flagged(null);
    await addMessage(silent.conv.id, "ai", "an ordinary earlier reply", { ageSeconds: 60 });
    await db.update(users).set({ flaggedAt: sql`now()`, flagReason: "threat" }).where(eq(users.id, silent.fan.id));
    expect(await threatLine(silent.fan.id)).toBeNull();

    const minor = await flagged("minor_in_chat");
    await addMessage(minor.conv.id, "ai", "a line after the flag");
    expect(await threatLine(minor.fan.id)).toBeNull();

    const clean = await flagged(null);
    await addMessage(clean.conv.id, "ai", "hi");
    expect(await threatLine(clean.fan.id)).toBeNull();
  });
});
