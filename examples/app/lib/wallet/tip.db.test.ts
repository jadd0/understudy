import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { ledgerEntries, users } from "@/db/schema";
import { CapReached, InsufficientFunds, InvalidAmount, NotAllowed, NotFound } from "@/lib/wallet/errors";
import { tip } from "@/lib/wallet/tip";
import { assertBalanceEqualsLedger, balanceOf, fund, makeConversation, makeCreator, makeFan, setConfig } from "./test-helpers";

beforeAll(() => setConfig());

const tips = async (fanId: string) =>
  (await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fanId))).filter((e) => e.kind === "tip");

describe("tip", () => {
  test("flagged_fan_cannot_tip", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 1000);
    await db.update(users).set({ flaggedAt: new Date() }).where(eq(users.id, fan.id));
    await expect(tip(fan.id, creator.id, 100, randomUUID())).rejects.toBeInstanceOf(NotAllowed);
    expect(await tips(fan.id)).toHaveLength(0);
    expect(await balanceOf(fan.id)).toBe(1000);
  });

  test("unknown_creator_is_NotFound", async () => {
    const fan = await makeFan();
    await fund(fan.id, 1000);
    await expect(tip(fan.id, randomUUID(), 100, randomUUID())).rejects.toBeInstanceOf(NotFound);
    expect(await balanceOf(fan.id)).toBe(1000);
  });

  test("other_fans_conversation_is_NotFound", async () => {
    const fan = await makeFan();
    const other = await makeFan();
    const creator = await makeCreator();
    const otherCreator = await makeCreator();
    await fund(fan.id, 1000);
    const theirs = await makeConversation(creator.id, other.id);
    const wrongCreator = await makeConversation(otherCreator.id, fan.id);
    await expect(tip(fan.id, creator.id, 100, randomUUID(), theirs.id)).rejects.toBeInstanceOf(NotFound);
    await expect(tip(fan.id, creator.id, 100, randomUUID(), wrongCreator.id)).rejects.toBeInstanceOf(NotFound);
    await expect(tip(fan.id, creator.id, 100, randomUUID(), randomUUID())).rejects.toBeInstanceOf(NotFound);
    expect(await tips(fan.id)).toHaveLength(0);
    expect(await balanceOf(fan.id)).toBe(1000);
  });

  test("debits once and a retry with the same key returns the first result", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 1000);
    const key = randomUUID();
    const a = await tip(fan.id, creator.id, 400, key);
    const b = await tip(fan.id, creator.id, 400, key);
    expect(a.replayed).toBe(false);
    expect(b).toMatchObject({ replayed: true, ledgerEntryId: a.ledgerEntryId });
    expect(await tips(fan.id)).toHaveLength(1);
    expect(await balanceOf(fan.id)).toBe(600);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("a tip carries the conversation id when given, null otherwise", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    const conv = await makeConversation(creator.id, fan.id);
    await fund(fan.id, 1000);
    await tip(fan.id, creator.id, 100, randomUUID(), conv.id);
    await tip(fan.id, creator.id, 100, randomUUID());
    expect((await tips(fan.id)).map((t) => t.conversationId).sort()).toEqual([conv.id, null].sort());
  });

  test("different keys are different tips", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 1000);
    await tip(fan.id, creator.id, 100, randomUUID());
    await tip(fan.id, creator.id, 100, randomUUID());
    expect(await tips(fan.id)).toHaveLength(2);
  });

  test("two fans may reuse the same client key", async () => {
    const creator = await makeCreator();
    const key = randomUUID();
    const a = await makeFan();
    const b = await makeFan();
    await fund(a.id, 500);
    await fund(b.id, 500);
    await tip(a.id, creator.id, 100, key);
    await tip(b.id, creator.id, 100, key);
    expect(await balanceOf(a.id)).toBe(400);
    expect(await balanceOf(b.id)).toBe(400);
  });

  test("zero, negative, fractional amounts and an empty key are refused before any write", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 1000);
    for (const amount of [0, -100, 2.5]) {
      await expect(tip(fan.id, creator.id, amount, randomUUID())).rejects.toBeInstanceOf(InvalidAmount);
    }
    await expect(tip(fan.id, creator.id, 100, "")).rejects.toBeInstanceOf(InvalidAmount);
    expect(await tips(fan.id)).toHaveLength(0);
    expect(await balanceOf(fan.id)).toBe(1000);
  });

  test("over the balance is InsufficientFunds; over the cap is CapReached", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 300);
    await expect(tip(fan.id, creator.id, 301, randomUUID())).rejects.toBeInstanceOf(InsufficientFunds);
    await setConfig({ "wallet.daily_cap_cents": 200 });
    try {
      await expect(tip(fan.id, creator.id, 201, randomUUID())).rejects.toBeInstanceOf(CapReached);
    } finally {
      await setConfig();
    }
    expect(await balanceOf(fan.id)).toBe(300);
  });
});
