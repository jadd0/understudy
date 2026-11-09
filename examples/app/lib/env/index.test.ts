import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { emailConfigured, providerStatus, stripeConfigured } from "@/lib/env";

const MINIMAL = { DATABASE_URL: "postgres://x", AUTH_SECRET: "a", CLAUDE_SECRET_KEY: "c" };

afterEach(() => vi.unstubAllEnvs());

describe("env schema", () => {
  test("the minimal set is enough", () => {
    for (const [k, v] of Object.entries(MINIMAL)) vi.stubEnv(k, v);
    // An empty value is rejected by the schema, so the optional keys are unset rather than empty.
    for (const k of ["RESEND_API_KEY", "EMAIL_FROM", "TURNSTILE_SECRET_KEY", "NEXT_PUBLIC_TURNSTILE_SITE_KEY", "STRIPE_SECRET_KEY"]) delete process.env[k];
    vi.resetModules();
    return import("@/lib/env").then((m) => expect(m.getEnv().DATABASE_URL).toBe("postgres://x"));
  });

  test("the Claude key is required", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("AUTH_SECRET", "a");
    delete process.env.CLAUDE_SECRET_KEY;
    vi.resetModules();
    const m = await import("@/lib/env");
    expect(() => m.getEnv()).toThrow(/CLAUDE_SECRET_KEY/);
  });
});

describe("providerStatus", () => {
  test("a minimal environment has every optional service off with its fallback", () => {
    const status = providerStatus(MINIMAL);
    expect(status.map((s) => s.name)).toEqual(["Jev (TypeSafe)", "Voyage", "Stripe", "Pusher", "Resend", "Turnstile"]);
    expect(status.every((s) => !s.on && s.fallback.length > 0)).toBe(true);
  });

  test("each service turns on from its own keys, and a half-set group stays off", () => {
    const on = (env: Record<string, string>) => Object.fromEntries(providerStatus({ ...MINIMAL, ...env }).map((s) => [s.name, s.on]));
    expect(on({ TYPESAFE_SECRET_KEY: "k" })["Jev (TypeSafe)"]).toBe(true);
    expect(on({ VOYAGE_API_KEY: "k" }).Voyage).toBe(true);
    expect(on({ STRIPE_SECRET_KEY: "sk_test_1" }).Stripe).toBe(false);
    expect(on({ STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_1" }).Stripe).toBe(true);
    expect(on({ PUSHER_APP_ID: "1", PUSHER_KEY: "k", PUSHER_SECRET: "s" }).Pusher).toBe(false);
    expect(on({ PUSHER_APP_ID: "1", PUSHER_KEY: "k", PUSHER_SECRET: "s", PUSHER_CLUSTER: "eu" }).Pusher).toBe(true);
    expect(on({ RESEND_API_KEY: "re_1" }).Resend).toBe(false);
    expect(on({ RESEND_API_KEY: "re_1", EMAIL_FROM: "a@b.co" }).Resend).toBe(true);
    expect(on({ TURNSTILE_SECRET_KEY: "s" }).Turnstile).toBe(false);
    expect(on({ TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" }).Turnstile).toBe(true);
  });

  test("helpers agree with the table", () => {
    expect(stripeConfigured(MINIMAL)).toBe(false);
    expect(stripeConfigured({ STRIPE_SECRET_KEY: "a", STRIPE_WEBHOOK_SECRET: "b" })).toBe(true);
    expect(emailConfigured(MINIMAL)).toBe(false);
    expect(emailConfigured({ RESEND_API_KEY: "a", EMAIL_FROM: "b" })).toBe(true);
  });
});

describe("docs", () => {
  test("the README and DEVELOPMENT fallback tables carry the exact fallback text", () => {
    const root = new URL("../../../../", import.meta.url);
    for (const file of ["README.md", "docs/operations/DEVELOPMENT.md"]) {
      const text = readFileSync(new URL(file, root), "utf8");
      for (const s of providerStatus({})) expect(text, `${file}: ${s.name}`).toContain(s.fallback);
    }
  });
});
