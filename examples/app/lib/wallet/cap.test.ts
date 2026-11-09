import { describe, expect, test } from "vitest";
import { capAllows } from "./cap";

describe("capAllows", () => {
  test("a charge fits while today's spend plus it stays within the cap, the boundary included", () => {
    expect(capAllows(0, 2000, 2000)).toBe(true);
    expect(capAllows(500, 1500, 2000)).toBe(true);
    expect(capAllows(500, 1501, 2000)).toBe(false);
    expect(capAllows(500, 1777, 2000)).toBe(false);
  });

  test("below the cap is not enough: the item's own price must fit", () => {
    expect(capAllows(1999, 1, 2000)).toBe(true);
    expect(capAllows(1999, 2, 2000)).toBe(false);
    expect(capAllows(2000, 1, 2000)).toBe(false);
  });
});
