import { describe, expect, test } from "vitest";
import { BadCursor, decodeOlder, decodeSync, encodeOlder, encodeSync } from "./cursor";

const conv = "0b5f6c1e-2d3a-4f5b-8c9d-0e1f2a3b4c5d";
const msg = "1c6a7d2f-3e4b-4a6c-9d0e-1f2a3b4c5d6e";
const t = "2026-11-04T09:15:30.123456Z";

describe("window cursors", () => {
  test("round-trip keeps the microseconds and the conversation", () => {
    expect(decodeOlder(encodeOlder({ conversationId: conv, sortAt: t, id: msg }), conv)).toEqual({ conversationId: conv, sortAt: t, id: msg });
    expect(decodeSync(encodeSync(t))).toBe(t);
    expect(encodeSync(t)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("a cursor of the wrong kind, conversation or shape is a BadCursor", () => {
    const older = encodeOlder({ conversationId: conv, sortAt: t, id: msg });
    expect(() => decodeOlder(older, msg)).toThrow(BadCursor);
    expect(() => decodeSync(older)).toThrow(BadCursor);
    expect(() => decodeOlder(encodeSync(t), conv)).toThrow(BadCursor);
    for (const bad of [null, 1, {}, "", "%%%", "e30", Buffer.from("[1]").toString("base64url"), encodeSync("2026-13-01T00:00:00.000000Z"), encodeSync("2026-11-04 09:15:30+00")]) {
      expect(() => decodeSync(bad)).toThrow(BadCursor);
    }
  });
});
