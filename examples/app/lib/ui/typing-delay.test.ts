import { describe, expect, test } from "vitest";
import { TYPING_AFTER_SEND_MS, typingHoldMs } from "@/lib/ui/typing-delay";

describe("typingHoldMs", () => {
  test("holds for the full delay right after a send, then counts down to zero", () => {
    expect(TYPING_AFTER_SEND_MS).toBeGreaterThanOrEqual(500);
    expect(typingHoldMs(1_000, 1_000)).toBe(TYPING_AFTER_SEND_MS);
    expect(typingHoldMs(1_000, 1_200)).toBe(TYPING_AFTER_SEND_MS - 200);
    expect(typingHoldMs(1_000, 1_000 + TYPING_AFTER_SEND_MS)).toBe(0);
    expect(typingHoldMs(1_000, 9_000)).toBe(0);
  });

  test("no send means no hold", () => {
    expect(typingHoldMs(null, 1_000)).toBe(0);
  });

  test("a second send restarts the hold from its own time", () => {
    // First send at 1000, second at 1400: at 1600 the first would be past its hold, the second is not.
    expect(typingHoldMs(1_400, 1_600)).toBe(TYPING_AFTER_SEND_MS - 200);
  });
});
