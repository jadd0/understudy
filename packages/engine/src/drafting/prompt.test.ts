import { describe, expect, test } from "vitest";
import { EMPTY_PROFILE } from "./memory.js";
import { ANSWER_FIRST_LINE, buildPrompt, type PromptInput } from "./prompt.js";
import type { StyleDraw } from "./style-draw.js";

const base: PromptInput = {
  cardBody: "card",
  neverList: [],
  chunks: [],
  profile: EMPTY_PROFILE,
  route: { name: "reply", hardship: false, alert: false },
  offer: null,
  history: [{ id: "1", sender: "fan", body: "hi", createdAt: new Date(0) }],
  thread: "unknown",
  sessionGapMs: null,
  historyRounds: 10,
  gapMarkerMinutes: 30,
};

describe("style draw in the prompt", () => {
  const draw: StyleDraw = { signoff: false, address: null, petName: false, emoji: false };

  test("the constraint block carries the draw's wording and the answer-first line", () => {
    const turn = buildPrompt({ ...base, styleDraw: { draw, pet: "biscuit" } }).system.turn;
    expect(turn).toContain("## Voice for this reply");
    expect(turn).toContain("No sign-off");
    expect(turn).toContain("Do not mention Biscuit");
    expect(turn).toContain("No emoji");
    expect(turn).toContain(ANSWER_FIRST_LINE);
  });

  test("a positive draw is only ever a may", () => {
    const turn = buildPrompt({ ...base, styleDraw: { draw: { signoff: true, address: "mate", petName: true, emoji: true }, pet: "biscuit" } }).system.turn;
    expect(turn).toContain("You may end with a casual x");
    expect(turn).toContain('You may call him "mate"');
    expect(turn).not.toMatch(/must/i);
  });

  test("with no draw the prompt is the same as before", () => {
    const turn = buildPrompt(base).system.turn;
    expect(turn).not.toContain("Voice for this reply");
    expect(turn).not.toContain(ANSWER_FIRST_LINE);
  });
});
