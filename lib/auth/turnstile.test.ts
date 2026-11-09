import { describe, expect, test, vi } from "vitest";
import { verifyTurnstile } from "@/lib/auth/turnstile";

// Cloudflare's documented dummy secrets: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
// 1x...AA always passes, 2x...AA always fails.
const SECRET_PASS = "1x0000000000000000000000000000000AA";
const SECRET_FAIL = "2x0000000000000000000000000000000AA";

const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

describe("verifyTurnstile", () => {
  test("success", async () => {
    const fetch = reply({ success: true });
    expect(await verifyTurnstile("tok", "1.2.3.4", { fetch, secret: SECRET_PASS })).toBe(true);
  });

  test("failure", async () => {
    const fetch = reply({ success: false, "error-codes": ["invalid-input-response"] });
    expect(await verifyTurnstile("tok", "1.2.3.4", { fetch, secret: SECRET_FAIL })).toBe(false);
  });

  test("network error fails closed", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("network down");
    });
    expect(await verifyTurnstile("tok", "1.2.3.4", { fetch, secret: SECRET_PASS })).toBe(false);
  });

  test("non-2xx fails closed", async () => {
    expect(await verifyTurnstile("tok", null, { fetch: reply({ success: true }, false), secret: SECRET_PASS })).toBe(false);
  });

  test("missing token never calls Cloudflare", async () => {
    const fetch = reply({ success: true });
    expect(await verifyTurnstile("", "1.2.3.4", { fetch, secret: SECRET_PASS })).toBe(false);
    expect(await verifyTurnstile(null, "1.2.3.4", { fetch, secret: SECRET_PASS })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("request body carries secret, response and remoteip", async () => {
    const fetch = reply({ success: true });
    await verifyTurnstile("tok-123", "9.9.9.9", { fetch, secret: SECRET_PASS });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({ secret: SECRET_PASS, response: "tok-123", remoteip: "9.9.9.9" });
  });
});
