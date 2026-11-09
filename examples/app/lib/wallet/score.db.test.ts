import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { ledgerEntries } from "@/db/schema";
import { ConfigInvalid } from "@/lib/wallet/errors";
import { highValueScore, isHighValue } from "@/lib/wallet/score";
import { makeCreator, makeFan, setConfig } from "./test-helpers";

beforeAll(() => setConfig({ "fan.high_value_threshold_cents": 10000, "fan.high_value_half_life_days": 7 }));

async function debitAged(fanId: string, creatorId: string, cents: number, ageDays: number) {
  await db.insert(ledgerEntries).values({
    fanId,
    creatorId,
    kind: "tip",
    amountCents: -cents,
    createdAt: sql`now() - make_interval(secs => ${ageDays * 86400})`,
  });
}

describe("high-value score", () => {
  test("zero_half_life_is_ConfigInvalid", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    try {
      for (const bad of [0, -3, "x"]) {
        await setConfig({ "fan.high_value_half_life_days": bad });
        await expect(highValueScore(fan.id, creator.id)).rejects.toBeInstanceOf(ConfigInvalid);
      }
    } finally {
      await setConfig();
    }
  });

  test("a debit one half-life old counts half, within a cent", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await debitAged(fan.id, creator.id, 10000, 7);
    expect(Math.abs((await highValueScore(fan.id, creator.id)) - 5000)).toBeLessThanOrEqual(1);
  });

  test("two half-lives count a quarter; recent debits count in full; sums add up", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await debitAged(fan.id, creator.id, 8000, 14);
    await debitAged(fan.id, creator.id, 3000, 0);
    expect(Math.abs((await highValueScore(fan.id, creator.id)) - 5000)).toBeLessThanOrEqual(1);
  });

  test("only this fan's debits to this creator count; topups never do", async () => {
    const fan = await makeFan();
    const other = await makeFan();
    const creator = await makeCreator();
    const otherCreator = await makeCreator();
    await debitAged(other.id, creator.id, 9999, 0);
    await debitAged(fan.id, otherCreator.id, 9999, 0);
    await db.insert(ledgerEntries).values({ fanId: fan.id, kind: "topup", amountCents: 9999 });
    expect(await highValueScore(fan.id, creator.id)).toBe(0);
  });

  test("a score just above the threshold is high value, just below is not", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await debitAged(fan.id, creator.id, 10000, 7);
    await debitAged(fan.id, creator.id, 5000, 0); // score ~ 10000 (5000 + 5000), within a cent
    const score = await highValueScore(fan.id, creator.id);
    expect(Math.abs(score - 10000)).toBeLessThanOrEqual(1);
    // Decay between calls is far below a cent, so a one-cent margin keeps the boundary checks stable.
    await setConfig({ "fan.high_value_threshold_cents": score - 1 });
    expect(await isHighValue(fan.id, creator.id)).toBe(true);
    await setConfig({ "fan.high_value_threshold_cents": score + 2 });
    expect(await isHighValue(fan.id, creator.id)).toBe(false);
    await setConfig();
  });
});
