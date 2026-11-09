import { z } from "zod";

const optional = z.string().min(1).optional();

const schema = z.object({
  // Used by this build.
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  AUTH_URL: optional,
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(1),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  SEED_CREATOR_EMAIL: optional,
  SEED_ADMIN_EMAILS: optional,
  DEMO_SEAT_PASSWORD: optional,
  // Reached through providers/ adapters in later builds; optional until then.
  CLAUDE_SECRET_KEY: optional,
  TYPESAFE_SECRET_KEY: optional,
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
