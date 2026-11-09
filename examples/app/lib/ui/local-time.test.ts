import { describe, expect, test } from "vitest";
import { dayAndTime } from "@/lib/ui/local-time";

describe("dayAndTime", () => {
  const at = new Date("2026-11-04T15:24:00Z");

  test("reads in the zone it is given, with no zone suffix", () => {
    expect(dayAndTime(at, "UTC")).toBe("4 Nov, 15:24");
    expect(dayAndTime(at, "Europe/Istanbul")).toBe("4 Nov, 18:24");
  });

  test("a time past midnight in the viewer's zone moves to their next day", () => {
    expect(dayAndTime(new Date("2026-11-04T22:30:00Z"), "Asia/Tokyo")).toBe("5 Nov, 07:30");
  });
});
