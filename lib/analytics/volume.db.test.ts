import { beforeAll, describe, expect, test } from "vitest";
import { buildWorld, emptyCreator } from "./fixtures";
import { getVolume } from "./volume";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

describe("getVolume", () => {
  test("counts_sent_messages_in_scope_and_window", async () => {
    const v = await getVolume(w.q);
    // c1 (3 in window), c2 (2), c5 (1); the 10d-old, T&S and other-creator messages stay out.
    expect(v.totals).toEqual({ fanMessages: 6, aiReplies: 3, humanReplies: 1, activeConversations: 3 });
    expect(v.series).toHaveLength(8);
    expect(v.series.reduce((s, p) => s + p.fanMessages, 0)).toBe(6);
    expect(v.series.every((p) => Number.isFinite(p.t))).toBe(true);
  });

  test("admin_sees_ts_and_other_creators", async () => {
    const v = await getVolume(w.adminQ);
    expect(v.totals.fanMessages).toBe(8);
    expect(v.totals.activeConversations).toBe(5);
  });

  test("empty_range_all_zero", async () => {
    const e = await emptyCreator();
    const v = await getVolume(e.q);
    expect(v.totals).toEqual({ fanMessages: 0, aiReplies: 0, humanReplies: 0, activeConversations: 0 });
    expect(v.series.length).toBe(31);
  });
});
