import { describe, expect, test } from "vitest";
import { bubbleGap, deliverOffsets, splitBubbles } from "./bubbles.js";

describe("splitBubbles", () => {
  test("one line is one bubble; up to three lines are three; more are folded into the third", () => {
    expect(splitBubbles("hey you")).toEqual(["hey you"]);
    expect(splitBubbles("hey you\nmissed you")).toEqual(["hey you", "missed you"]);
    expect(splitBubbles("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(splitBubbles("a\n\nb\nc\nd")).toEqual(["a", "b", "c. d"]);
    expect(splitBubbles("  \n a \n")).toEqual(["a"]);
  });

  test("a line folded into the last bubble keeps a sentence break", () => {
    expect(splitBubbles("hey\nok\nu still down\nlets go")).toEqual(["hey", "ok", "u still down. lets go"]);
    expect(splitBubbles("hey\nok\nu still down?\nlets go")).toEqual(["hey", "ok", "u still down? lets go"]);
    expect(splitBubbles("hey\nok\nmissed u 🙈\nlets go\nnow")).toEqual(["hey", "ok", "missed u 🙈 lets go. now"]);
  });
});

describe("bubbleGap", () => {
  test("stays inside the bounds for the extremes of random()", () => {
    expect(bubbleGap(800, 2500, () => 0)).toBe(800);
    expect(bubbleGap(800, 2500, () => 0.999999)).toBe(2500);
    expect(bubbleGap(5, 5, () => 0.5)).toBe(5);
  });
});

describe("deliverOffsets", () => {
  test("the first bubble types out, the next follows by the gap, a template is immediate", () => {
    const o = { elapsedMs: 1000, cps: 10, maxMs: 6000, gapMs: 1500, immediate: false };
    expect(deliverOffsets(["x".repeat(30), "y"], o)).toEqual([2000, 3500]);
    expect(deliverOffsets(["x".repeat(30)], { ...o, elapsedMs: 9000 })).toEqual([0]);
    expect(deliverOffsets(["x".repeat(500)], o)).toEqual([6000]);
    expect(deliverOffsets(["a", "b"], { ...o, immediate: true })).toEqual([0, 0]);
  });
});
