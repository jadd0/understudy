import { describe, expect, test } from "vitest";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebarWidth,
  parseStoredSidebarWidth,
  stepSidebarWidth,
} from "@/lib/ui/sidebar-width";

describe("sidebar width", () => {
  test("the limits are 260, 320 and 480", () => {
    expect([SIDEBAR_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX]).toEqual([260, 320, 480]);
  });

  test("clamps to 260..480", () => {
    expect(clampSidebarWidth(100)).toBe(260);
    expect(clampSidebarWidth(260)).toBe(260);
    expect(clampSidebarWidth(400)).toBe(400);
    expect(clampSidebarWidth(480)).toBe(480);
    expect(clampSidebarWidth(99999)).toBe(480);
  });

  test("a non-finite number is the default", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(320);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(320);
  });

  test("a stored value that is garbage is the default; a stored number is clamped", () => {
    expect(parseStoredSidebarWidth(null)).toBe(320);
    expect(parseStoredSidebarWidth(undefined)).toBe(320);
    expect(parseStoredSidebarWidth("")).toBe(320);
    expect(parseStoredSidebarWidth("abc")).toBe(320);
    expect(parseStoredSidebarWidth("NaN")).toBe(320);
    expect(parseStoredSidebarWidth("12px")).toBe(320);
    expect(parseStoredSidebarWidth("99999")).toBe(480);
    expect(parseStoredSidebarWidth("-5")).toBe(260);
    expect(parseStoredSidebarWidth("372")).toBe(372);
  });

  test("arrow keys step by 16 and stop at the limits", () => {
    expect(stepSidebarWidth(320, 1)).toBe(336);
    expect(stepSidebarWidth(320, -1)).toBe(304);
    expect(stepSidebarWidth(480, 1)).toBe(480);
    expect(stepSidebarWidth(262, -1)).toBe(260);
  });
});
