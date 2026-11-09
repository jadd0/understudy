import { describe, expect, test } from "vitest";
import { canPitch } from "./pacing";
import { CFG, facts, PITCHABLE } from "../testing/fixtures";

const can = (f = facts(PITCHABLE), intent: Parameters<typeof canPitch>[2] = "smalltalk") => canPitch(f, CFG, intent);

describe("canPitch", () => {
  test("allowed with a long enough gap and nothing else in the way", () => {
    expect(can()).toEqual({ ok: true });
  });

  test("the gap: fewer than the minimum messages since the last offer", () => {
    expect(can(facts({ roundsSinceOffer: 7 }))).toEqual({ ok: false, why: "gap" });
    expect(can(facts({ roundsSinceOffer: 8 }))).toEqual({ ok: true });
  });

  test("two declines inside the window block a pitch; one does not", () => {
    expect(can(facts({ ...PITCHABLE, declinesInWindow: 1 }))).toEqual({ ok: true });
    expect(can(facts({ ...PITCHABLE, declinesInWindow: 2 }))).toEqual({ ok: false, why: "declines" });
  });

  test("the daily cap", () => {
    expect(can(facts({ ...PITCHABLE, atCap: true }))).toEqual({ ok: false, why: "cap" });
  });

  test("velocity: three unlocks in the window", () => {
    expect(can(facts({ ...PITCHABLE, unlocksInWindow: 2 }))).toEqual({ ok: true });
    expect(can(facts({ ...PITCHABLE, unlocksInWindow: 3 }))).toEqual({ ok: false, why: "velocity" });
  });

  test("no_pitch_until blocks, even a buy_intent several messages after the hardship", () => {
    const f = facts({ noPitchActive: true, roundsSinceOffer: 30 });
    expect(can(f, "smalltalk")).toEqual({ ok: false, why: "no_pitch_until" });
    expect(can(f, "buy_intent")).toEqual({ ok: false, why: "no_pitch_until" });
  });

  test("early_explicit_request_gets_offer: an explicit_request skips only the gap", () => {
    const shortGap = facts({ roundsSinceOffer: 1 });
    expect(can(shortGap, "explicit_request")).toEqual({ ok: true });
    expect(can(shortGap, "flirt")).toEqual({ ok: false, why: "gap" });
    for (const [block, why] of [[{ declinesInWindow: 2 }, "declines"], [{ atCap: true }, "cap"], [{ unlocksInWindow: 3 }, "velocity"], [{ noPitchActive: true }, "no_pitch_until"]] as const) {
      expect(can(facts({ roundsSinceOffer: 1, ...block }), "explicit_request")).toEqual({ ok: false, why });
    }
  });

  test("an explicit buy_intent skips only the gap", () => {
    const shortGap = facts({ roundsSinceOffer: 1 });
    expect(can(shortGap, "buy_intent")).toEqual({ ok: true });
    for (const block of [{ declinesInWindow: 2 }, { atCap: true }, { unlocksInWindow: 3 }, { noPitchActive: true }]) {
      expect(can({ ...shortGap, ...block }, "buy_intent").ok).toBe(false);
    }
  });
});
