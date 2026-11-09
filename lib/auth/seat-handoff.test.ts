import { describe, expect, test } from "vitest";
import { safeCallbackPath, seatHandoffPath } from "./seat-handoff";

const link = "http://localhost:3000/api/auth/callback/resend?callbackUrl=http%3A%2F%2Flocalhost%3A3000%2F&token=t1&email=juno%40understudy.example";

describe("seat handoff", () => {
  test("the handoff path carries the callback as a relative path, and reads back to the same path", () => {
    const handoff = seatHandoffPath(link);
    expect(handoff.startsWith("/signin/continue?to=")).toBe(true);
    const to = new URL(handoff, "http://x").searchParams.get("to");
    expect(safeCallbackPath(to)).toBe("/api/auth/callback/resend?callbackUrl=http%3A%2F%2Flocalhost%3A3000%2F&token=t1&email=juno%40understudy.example");
  });

  test("anything but this site's Resend callback is refused, so the page is no open redirect", () => {
    for (const bad of [
      null,
      "",
      "https://evil.example/api/auth/callback/resend?token=t",
      "//evil.example/api/auth/callback/resend?token=t",
      "/api/auth/callback/resend/../../../admin?x",
      "/api/auth/callback/github?token=t",
      "/api/auth/callback/resend?token=t#//evil",
      "/api/auth/callback/resend?\\evil",
      "/chat",
    ]) {
      expect(safeCallbackPath(bad)).toBeNull();
    }
  });
});
