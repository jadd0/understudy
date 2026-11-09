import { describe, expect, test, vi } from "vitest";
import { DevLinkRefused, sendDevLink } from "@/lib/auth/dev-link";

const params = { identifier: "fan@example.com", url: "http://localhost:3000/api/auth/callback/resend?token=abc" };

describe("console sign-in link", () => {
  test("prints the address and the link, and nothing else", async () => {
    const log = vi.fn();
    await sendDevLink(params, { NODE_ENV: "development", AUTH_SECRET: "s3cret-marker", CLAUDE_SECRET_KEY: "k-marker" }, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(`sign-in link for fan@example.com: ${params.url}`);
    expect(String(log.mock.calls[0][0])).not.toMatch(/s3cret-marker|k-marker/);
  });

  test("refuses in production and prints nothing", async () => {
    const log = vi.fn();
    await expect(sendDevLink(params, { NODE_ENV: "production" }, log)).rejects.toBeInstanceOf(DevLinkRefused);
    expect(log).not.toHaveBeenCalled();
  });
});
