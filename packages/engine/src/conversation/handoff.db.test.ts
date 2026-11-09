import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { handoffs } from "@/db/schema";
import { openHandoff } from "./handoff";
import { makeConversation, makeCreator, makeFan } from "../testing/db";

async function setup() {
  const creator = await makeCreator();
  const fan = await makeFan();
  return makeConversation(creator.id, fan.id);
}
const rows = (conversationId: string) => db.select().from(handoffs).where(eq(handoffs.conversationId, conversationId));

describe("openHandoff", () => {
  test("alert, then a creator request, then a hard stop: one row escalated in place", async () => {
    const conv = await setup();
    const alertId = await withTx((tx) => openHandoff(tx, conv.id, "creator", "high_value_alert"));
    expect(await rows(conv.id)).toMatchObject([{ id: alertId, queue: "creator", reason: "high_value_alert", status: "open" }]);

    const customId = await withTx((tx) => openHandoff(tx, conv.id, "creator", "custom_request"));
    expect(customId).toBe(alertId);
    expect(await rows(conv.id)).toMatchObject([{ queue: "creator", reason: "custom_request" }]);

    // The creator claimed it; a ts request takes it back to the ts queue, unclaimed and open.
    await db.update(handoffs).set({ status: "claimed", claimedAt: new Date() }).where(eq(handoffs.id, alertId));
    const stopId = await withTx((tx) => openHandoff(tx, conv.id, "ts", "minor"));
    expect(stopId).toBe(alertId);
    const final = await rows(conv.id);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ queue: "ts", reason: "minor", status: "open", claimedBy: null, claimedAt: null });
  });

  test("a later creator request does not downgrade a ts row, and an alert never rewrites a real reason", async () => {
    const conv = await setup();
    await withTx((tx) => openHandoff(tx, conv.id, "ts", "threat"));
    await withTx((tx) => openHandoff(tx, conv.id, "creator", "custom_request"));
    await withTx((tx) => openHandoff(tx, conv.id, "creator", "high_value_alert"));
    expect(await rows(conv.id)).toMatchObject([{ queue: "ts", reason: "threat" }]);
  });

  test("a resolved handoff does not block a new one", async () => {
    const conv = await setup();
    const first = await withTx((tx) => openHandoff(tx, conv.id, "creator", "unsure"));
    await db.update(handoffs).set({ status: "resolved", resolvedAt: new Date() }).where(eq(handoffs.id, first));
    const second = await withTx((tx) => openHandoff(tx, conv.id, "ts", "self_harm"));
    expect(second).not.toBe(first);
    expect(await rows(conv.id)).toHaveLength(2);
  });

  test("two concurrent opens leave one row and no unique violation", async () => {
    const conv = await setup();
    const ids = await Promise.all([
      withTx((tx) => openHandoff(tx, conv.id, "creator", "unsure")),
      withTx((tx) => openHandoff(tx, conv.id, "ts", "threat")),
      withTx((tx) => openHandoff(tx, conv.id, "creator", "high_value_alert")),
    ]);
    expect(new Set(ids).size).toBe(1);
    const final = await rows(conv.id);
    expect(final).toHaveLength(1);
    expect(final[0].queue).toBe("ts");
  });
});
