import { describe, expect, test } from "vitest";
import { dollarsToCents, formatCents } from "@/lib/wallet/money";

describe("dollarsToCents", () => {
  test("whole and fractional dollars become exact cents", () => {
    expect(dollarsToCents("5")).toBe(500);
    expect(dollarsToCents("12.5")).toBe(1250);
    expect(dollarsToCents(" 12.05 ")).toBe(1205);
    expect(dollarsToCents("0.29")).toBe(29);
    expect(dollarsToCents("500")).toBe(50000);
  });

  test("anything not in that shape is refused, not rounded", () => {
    for (const bad of ["", "abc", "-5", "5.001", "1e3", "5,00", "5.", ".5", "$5", "5 0", "99999999"]) {
      expect(dollarsToCents(bad)).toBeNull();
    }
  });

  test("formatCents", () => {
    expect(formatCents(1999)).toBe("$19.99");
    expect(formatCents(5)).toBe("$0.05");
  });
});
