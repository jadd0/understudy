import { describe, expect, test } from "vitest";
import { parseTipMessage, tipLabel } from "@/lib/ui/tip-message";

describe("parseTipMessage", () => {
  test("reads the amount from the tip action's system row", () => {
    expect(parseTipMessage("system", "You tipped $5.00")).toEqual({ amount: "$5.00" });
    expect(parseTipMessage("system", "You tipped $1,250")).toEqual({ amount: "$1,250" });
  });

  test("a fan or AI message with the same words is not a tip", () => {
    expect(parseTipMessage("fan", "You tipped $5.00")).toBeNull();
    expect(parseTipMessage("ai", "You tipped $5.00")).toBeNull();
  });

  test("other system notices are left alone", () => {
    expect(parseTipMessage("system", "You tipped $5.00 and more")).toBeNull();
    expect(parseTipMessage("system", "Chat paused")).toBeNull();
  });
});

describe("tipLabel", () => {
  test("whole dollars drop the cents, others keep two places", () => {
    expect([200, 1000, 250, 5050].map(tipLabel)).toEqual(["$2", "$10", "$2.50", "$50.50"]);
  });
});
