import { describe, expect, test } from "vitest";
import { CFG, facts, jev, PITCHABLE } from "../testing/fixtures.js";
import type { PendingEvent } from "../conversation/events.js";
import { adjustRoute } from "./route.js";

const TIP: PendingEvent = { kind: "tip", id: "t1" };
const opts = (over: Partial<Parameters<typeof adjustRoute>[3]> = {}) => ({ eventOnly: false, openOffer: null, reacting: [TIP], ...over });

describe("adjustRoute", () => {
  test("a fan in hardship is not thanked: the events he reacts to are dropped", () => {
    const out = adjustRoute(jev({ p: { hardship: 0.8 } }), facts(PITCHABLE), CFG, opts());
    expect(out.route).toMatchObject({ name: "reply", hardship: true });
    expect(out.reacting).toEqual([]);
  });

  test("a reaction to a tip never carries a new offer: the offer route falls back to words", () => {
    const buy = jev({ intent: "buy_intent" });
    expect(adjustRoute(buy, facts(PITCHABLE), CFG, opts({ reacting: [] })).route.name).toBe("offer");
    const out = adjustRoute(buy, facts(PITCHABLE), CFG, opts());
    expect(out.route.name).toBe("reply");
    expect(out.reacting).toEqual([TIP]);
  });

  test("a turn with no fan text is a plain reply whatever Jev would have said", () => {
    const out = adjustRoute(jev({ intent: "buy_intent" }), facts(PITCHABLE), CFG, opts({ eventOnly: true }));
    expect(out.route).toEqual({ name: "reply", hardship: false, alert: false });
  });

  test("a decline in this message counts toward the pitch limit and names the declined offer", () => {
    const out = adjustRoute(jev({ offerResponse: "declines" }), facts(), CFG, opts({ openOffer: "o1", reacting: [] }));
    expect(out.declineOfferId).toBe("o1");
    expect(adjustRoute(jev(), facts(), CFG, opts({ openOffer: "o1", reacting: [] })).declineOfferId).toBeNull();
  });
});
