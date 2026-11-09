import { describe, expect, test, vi } from "vitest";
import { resetTurnstileNote, turnstileConfigured, verifyTurnstile } from "@/lib/auth/turnstile";

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

describe("verifyTurnstile without a secret", () => {
  test("outside production the check is skipped, with one note per process and no request", async () => {
    resetTurnstileNote();
    const fetch = vi.fn();
    const note = vi.fn();
    for (const nodeEnv of ["development", "test", undefined]) {
      expect(await verifyTurnstile(null, null, { fetch, secret: "", nodeEnv, note })).toBe(true);
    }
    expect(note).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("in production it refuses, even with a token, and never calls Cloudflare", async () => {
    const fetch = vi.fn();
    expect(await verifyTurnstile("tok", null, { fetch, secret: "", nodeEnv: "production" })).toBe(false);
    expect(await verifyTurnstile(null, null, { fetch, secret: "", nodeEnv: "production" })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("with a secret a missing token still fails outside production", async () => {
    expect(await verifyTurnstile(null, null, { fetch: vi.fn(), secret: SECRET_PASS, nodeEnv: "development" })).toBe(false);
  });

  test("configured needs both keys", () => {
    expect(turnstileConfigured({ TURNSTILE_SECRET_KEY: "s" })).toBe(false);
    expect(turnstileConfigured({ TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" })).toBe(true);
  });
});
