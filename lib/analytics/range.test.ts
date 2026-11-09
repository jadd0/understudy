import { describe, expect, test } from "vitest";
import { BadRange, bucketStarts, parseRange } from "./range";

const NOW = new Date("2026-11-03T12:30:00.000Z");

describe("parseRange", () => {
  test("24h_buckets_hourly", () => {
    const r = parseRange("24h", NOW);
    expect(r.bucket).toBe("hour");
    expect(r.to).toEqual(NOW);
    expect(r.from).toEqual(new Date("2026-11-02T12:30:00.000Z"));
    expect(bucketStarts(r.from, r.to, r.bucket)).toHaveLength(25);
  });

  test("30d_buckets_daily", () => {
    const r = parseRange("30d", NOW);
    expect(r.bucket).toBe("day");
    expect(r.from).toEqual(new Date("2026-10-04T12:30:00.000Z"));
    const starts = bucketStarts(r.from, r.to, r.bucket);
    expect(starts).toHaveLength(31);
    expect(new Date(starts[0]).toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(new Date(starts[30]).toISOString()).toBe("2026-11-03T00:00:00.000Z");
  });

  test("7d_is_daily", () => {
    expect(parseRange("7d", NOW).bucket).toBe("day");
  });

  test("bad_range_throws", () => {
    for (const bad of ["1y", "", undefined, null, 7, "7D"]) expect(() => parseRange(bad, NOW)).toThrow(BadRange);
  });
});
