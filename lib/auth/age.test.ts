import { describe, expect, test } from "vitest";
import { ageOn, isAdult, parseDob } from "@/lib/auth/age";

const at = (iso: string) => new Date(iso);

describe("isAdult (UTC)", () => {
  test("on the 18th birthday", () => {
    expect(isAdult("2008-11-03", at("2026-11-03T00:00:00Z"))).toBe(true);
    expect(isAdult("2008-11-03", at("2026-11-03T23:59:59Z"))).toBe(true);
  });
  test("the day before the 18th birthday", () => {
    expect(isAdult("2008-11-03", at("2026-11-02T23:59:59Z"))).toBe(false);
    expect(ageOn("2008-11-03", at("2026-11-02T23:59:59Z"))).toBe(17);
  });
  test("leap-day birthday is reached on 1 March in a common year", () => {
    expect(isAdult("2008-02-29", at("2026-02-28T12:00:00Z"))).toBe(false);
    expect(isAdult("2008-02-29", at("2026-03-01T00:00:00Z"))).toBe(true);
  });
  test("leap-day birthday: 18th anniversary falls in a common year", () => {
    expect(isAdult("2012-02-29", at("2030-02-28T00:00:00Z"))).toBe(false);
    expect(isAdult("2012-02-29", at("2030-03-01T00:00:00Z"))).toBe(true);
  });
});

describe("parseDob", () => {
  const now = at("2026-11-03T12:00:00Z");
  test("accepts a real past date", () => expect(parseDob("1990-05-17", now)).toBe("1990-05-17"));
  test.each(["", "17/05/1990", "1990-02-30", "2026-11-04", "1899-12-31", "1990-5-7"])("rejects %s", (v) => {
    expect(parseDob(v, now)).toBeNull();
  });
  test("rejects a non-string", () => expect(parseDob(null, now)).toBeNull());
});
