import { z } from "zod";

const optional = z.string().min(1).optional();

const schema = z.object({
  // Required everywhere.
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  CLAUDE_SECRET_KEY: z.string().min(1),
  AUTH_URL: optional,
  // Optional; each has a stated fallback (see `providerStatus`). Production needs the sign-in pair and Turnstile.
  RESEND_API_KEY: optional,
  EMAIL_FROM: optional,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optional,
  TURNSTILE_SECRET_KEY: optional,
  SEED_CREATOR_EMAIL: optional,
  SEED_ADMIN_EMAILS: optional,
  DEMO_SEAT_PASSWORD: optional,
  TYPESAFE_SECRET_KEY: optional,
  // llm-gateway: the origin without /v1, and the default key (the `gateway.key_env` row can name another variable per creator).
  GATEWAY_URL: optional,
  GATEWAY_KEY: optional,
  VOYAGE_API_KEY: optional,
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  PUSHER_APP_ID: optional,
  PUSHER_KEY: optional,
  PUSHER_SECRET: optional,
  PUSHER_CLUSTER: optional,
  NEXT_PUBLIC_PUSHER_KEY: optional,
  NEXT_PUBLIC_PUSHER_CLUSTER: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated environment, read on first use so that importing a module never needs every key. */
export function getEnv(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment, missing or empty: ${names}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export type ProviderStatus = { name: string; on: boolean; fallback: string };

const set = (v: string | undefined) => Boolean(v && v.trim() !== "");

/**
 * One entry per optional service: whether its key is set and what the app does when it is not. Pure over the given
 * environment, so the install status, the env checker and the docs all read the same text.
 */
export function providerStatus(source: Record<string, string | undefined> = process.env): ProviderStatus[] {
  return [
    { name: "Jev (TypeSafe)", on: set(source.TYPESAFE_SECRET_KEY), fallback: "Claude makes the reply decisions alone" },
    { name: "Voyage", on: set(source.VOYAGE_API_KEY), fallback: "retrieval uses full-text search whatever retrieval.strategy says" },
    {
      name: "Stripe",
      on: set(source.STRIPE_SECRET_KEY) && set(source.STRIPE_WEBHOOK_SECRET),
      fallback: "demo wallet on the welcome credit, top-ups are off",
    },
    {
      name: "Pusher",
      on: set(source.PUSHER_APP_ID) && set(source.PUSHER_KEY) && set(source.PUSHER_SECRET) && set(source.PUSHER_CLUSTER),
      fallback: "no realtime events, the browser polls",
    },
    {
      name: "Resend",
      on: set(source.RESEND_API_KEY) && set(source.EMAIL_FROM),
      fallback: "the sign-in link is printed to the server console (refused in production)",
    },
    {
      name: "Turnstile",
      on: set(source.NEXT_PUBLIC_TURNSTILE_SITE_KEY) && set(source.TURNSTILE_SECRET_KEY),
      fallback: "no human check outside production (refused in production)",
    },
  ];
}

/** True when sign-in mail can be sent. */
export function emailConfigured(source: Record<string, string | undefined> = process.env): boolean {
  return set(source.RESEND_API_KEY) && set(source.EMAIL_FROM);
}

/** True when top-ups can reach Stripe. */
export function stripeConfigured(source: Record<string, string | undefined> = process.env): boolean {
  return set(source.STRIPE_SECRET_KEY) && set(source.STRIPE_WEBHOOK_SECRET);
}
