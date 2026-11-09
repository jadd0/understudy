import { pathToFileURL } from "node:url";
import { and, eq, inArray, isNotNull, isNull, notLike } from "drizzle-orm";
import { db } from "./client";
import { EVAL_FAN_EMAIL } from "@/lib/analytics/query";
import { grantWelcomeCreditOnce } from "@/lib/wallet/grant";
import { catalogueItems, config, creators, users } from "./schema";

export type SeedInput = {
  creatorEmail?: string;
  adminEmails?: string;
  /** Grant the welcome credit to fans confirmed before it existed. The CLI sets it; tests leave it off so a seed never moves another test's balances. */
  backfillWelcomeCredit?: boolean;
};

// Platform config rows for the wallet -- demo placeholder values, edit in the config table.
export const WALLET_CONFIG: Record<string, unknown> = {
  "wallet.topup_options_cents": [1000, 2500, 5000],
  "wallet.topup_min_cents": 500,
  "wallet.topup_max_cents": 50000,
  "wallet.welcome_credit_cents": 5000,
  "wallet.tip_options_cents": [200, 500, 1000],
  "wallet.tip_min_cents": 100,
  "wallet.daily_cap_cents": 20000,
  "wallet.cap_min_cents": 500,
  "cap.max_daily_cents": 100000,
  "wallet.cap_raise_delay_hours": 24,
  "fan.high_value_threshold_cents": 10000,
  "fan.high_value_half_life_days": 7,
  "offer.ttl_minutes": 1440,
};

// Platform config rows for the message engine -- loop defaults to tune on the eval bank.
// Price rows are whole micro-dollars per million tokens ($ per Mtok x 1,000,000), so a token costs
// `price / 1e6` micro-dollars and every cost stays an integer. Sources, read 2026-11-03:
//   Claude Haiku 5.5 (prompts up to 100K tokens): input $0.10, output $0.50, 5m cache write $0.125, cache read $0.01
//     per Mtok, https://platform.claude.com/docs/en/about-claude/pricing
//   Claude Sonnet 5.5: input $2, output $10, 5m cache write $2.50, cache read $0.20 per Mtok (Anthropic's published
//     model pricing table)
//   jev-1.14.0: input $0.042 per Mtok, output tokens free, https://docs.typesafe.ai/models.md
export const ENGINE_CONFIG: Record<string, unknown> = {
  "jev.model": "jev-1.14.0",
  "model.generate": "claude-haiku-5-5",
  "model.memory": "claude-haiku-5-5",
  "model.decide_fallback": "claude-haiku-5-5",
  "model.generate_fallback": "claude-sonnet-5-5",
  "breaker.failures": 3,
  "breaker.window_ms": 60000,
  "breaker.cooldown_ms": 30000,
  "engine.debounce_ms": 250,
  "engine.debounce_max_ms": 8000,
  "engine.turn_budget_ms": 12000,
  "engine.gap_marker_minutes": 30,
  "engine.fold_in_max": 1,
  "engine.lease_ms": 30000,
  "engine.max_attempts": 3,
  "engine.gen_attempts": 2,
  "engine.history_rounds": 20,
  "engine.jev_context_rounds": 6,
  "engine.max_tokens": 300,
  "engine.typing_cps": 12,
  "engine.typing_max_ms": 10000,
  "engine.event_window_minutes": 60,
  "engine.offer_history_count": 5,
  "delivery.bubble_gap_ms_min": 1500,
  "delivery.bubble_gap_ms_max": 4000,
  "platform.support_email": "support@understudy.example",
  "escalation.creator_sla_minutes": 30,
  "escalation.ts_sla_minutes": 15,
  "escalation.auto_resolve_reasons": ["unsure", "verify_failed", "custom_request", "explicit_live_chat", "high_value_alert"],
  "escalation.hold_suppress_minutes": 1440,
  "floor.safety.minor": 0.3,
  "floor.safety.self_harm": 0.3,
  "floor.safety.threat": 0.5,
  "floor.safety.location_offplatform": 0.5,
  "floor.safety.payment_dispute": 0.6,
  "floor.safety.hardship": 0.5,
  "floor.intent": 0.5,
  "floor.buy_intent_runner_up": 1, // off: no probability reaches 1, so nothing is promoted
  "pitch.min_gap_rounds": 5,
  "pitch.fit_floor": 0.58,
  "pitch.decline_window_minutes": 20,
  "pitch.max_declines": 2,
  "pitch.hardship_cooldown_hours": 72,
  "pitch.velocity_max_unlocks": 3,
  "pitch.velocity_window_minutes": 30,
  "ts.max_strikes": 3,
  "ts.strike_window_days": 90,
  "price.claude-haiku-5-5.input_per_mtok": 100000,
  "price.claude-haiku-5-5.output_per_mtok": 500000,
  "price.claude-haiku-5-5.cache_read_per_mtok": 10000,
  "price.claude-haiku-5-5.cache_write_per_mtok": 125000,
  "price.claude-sonnet-5-5.input_per_mtok": 2000000,
  "price.claude-sonnet-5-5.output_per_mtok": 10000000,
  "price.claude-sonnet-5-5.cache_read_per_mtok": 200000,
  "price.claude-sonnet-5-5.cache_write_per_mtok": 2500000,
  "price.jev-1.14.0.input_per_mtok": 42000,
  "price.jev-1.14.0.output_per_mtok": 0,
};

// Fan simulator config (docs/quality/FAN-SIM.md). The voice model is a config update away if a persona drifts.
export const SIM_CONFIG: Record<string, unknown> = {
  // Off until an admin switches it on from /admin/sim: a freshly seeded database must not start sim runs from the cron tick.
  "sim.enabled": false,
  // Sim fans get the welcome credit like adult fans, so unlock and tip beats work without a Stripe listener.
  "sim.welcome_credit": true,
  "sim.model": "claude-haiku-5-5",
  "sim.max_tokens": 120,
  "sim.max_concurrent_runs": 5,
  "sim.max_cost_micros_per_run": 1000000,
  "sim.max_cost_micros_per_batch": 10000000,
  "sim.lease_ms": 120000,
  "sim.tick_budget_ms": 45000,
  "sim.burst_gap_ms": 100,
  "sim.demo_gap_ms": 8000,
  "sim.human_wait_ms": 600000,
  "sim.webhook_wait_ms": 20000,
  "sim.topup_payment_method": "pm_card_visa",
};

// Retrieval config. The model is a Voyage general-purpose model (1024-dim); strategy stays "fts"
// until npm run eval:retrieval measures a winner.
export const RETRIEVAL_CONFIG: Record<string, unknown> = {
  "retrieval.voyage_model": "voyage-4",
  "retrieval.k": 5,
  "retrieval.strategy": "vector",
};

// Juno's catalogue -- demo placeholder titles and prices, playful and non-explicit.
const CATALOGUE: { kind: "ppv" | "bundle" | "personal"; title: string; teaser: string; priceCents: number }[] = [
  { kind: "ppv", title: "Golden hour", teaser: "A little something from the rooftop", priceCents: 999 },
  { kind: "ppv", title: "Lazy Sunday", teaser: "Coffee, sunlight, no plans", priceCents: 1499 },
  { kind: "ppv", title: "Night out", teaser: "Before the night got interesting", priceCents: 1999 },
  { kind: "bundle", title: "The full set", teaser: "Her bonus shoot, shots that are not anywhere else", priceCents: 3499 },
  { kind: "personal", title: "Personal chat with Juno", teaser: "Juno herself, just for you", priceCents: 4999 },
];

/**
 * Gives every confirmed, unflagged adult fan the welcome credit once; the ledger key makes a re-run a no-op.
 * Eval fans are fixtures, not customers, and never receive it. `only` narrows the run to those fans.
 */
export async function backfillWelcomeCredit(only?: string[]): Promise<number> {
  if (only && only.length === 0) return 0;
  const adults = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "fan"),
        isNotNull(users.adultConfirmedAt),
        isNull(users.flaggedAt),
        notLike(users.email, EVAL_FAN_EMAIL),
        only ? inArray(users.id, only) : undefined,
      ),
    );
  let granted = 0;
  for (const { id } of adults) if ((await grantWelcomeCreditOnce(id)) === "granted") granted++;
  return granted;
}

const norm = (e: string) => e.trim().toLowerCase();

/** Her profile photo, served from public/ (cropped from her public Instagram). */
const CREATOR_IMAGE = "/creators/juno.svg";

/** Idempotent: re-running leaves one creator, one row per admin address, one config row per key and one catalogue row per title. */
export async function seed(input: SeedInput, log: (m: string) => void = console.log) {
  // Existing values win, so a number the founder edited survives a re-seed.
  for (const [key, value] of Object.entries({ ...WALLET_CONFIG, ...RETRIEVAL_CONFIG, ...ENGINE_CONFIG, ...SIM_CONFIG })) {
    await db.insert(config).values({ key, value }).onConflictDoNothing();
  }

  if (input.backfillWelcomeCredit) log(`seed: welcome credit granted to ${await backfillWelcomeCredit()} existing fan(s)`);

  if (input.creatorEmail) {
    const email = norm(input.creatorEmail);
    const [user] = await db
      .insert(users)
      .values({ email, name: "Juno", role: "creator", image: CREATOR_IMAGE })
      .onConflictDoUpdate({ target: users.email, set: { role: "creator", image: CREATOR_IMAGE } })
      .returning({ id: users.id });
    await db
      .insert(creators)
      .values({ userId: user.id, handle: "junovale", displayName: "Juno" })
      .onConflictDoUpdate({ target: creators.userId, set: { handle: "junovale", displayName: "Juno" } });
    const [creator] = await db.select({ id: creators.id }).from(creators).where(eq(creators.userId, user.id));
    for (const item of CATALOGUE) {
      const [have] = await db
        .select({ id: catalogueItems.id })
        .from(catalogueItems)
        .where(and(eq(catalogueItems.creatorId, creator.id), eq(catalogueItems.title, item.title)));
      if (!have) await db.insert(catalogueItems).values({ creatorId: creator.id, ...item });
    }
    log("seed: creator junovale ready");
  } else {
    log("seed: SEED_CREATOR_EMAIL not set, creator skipped");
  }

  const admins = (input.adminEmails ?? "").split(",").map(norm).filter(Boolean);
  if (admins.length > 0) {
    for (const email of admins) {
      await db
        .insert(users)
        .values({ email, role: "admin" })
        .onConflictDoUpdate({ target: users.email, set: { role: "admin" } });
    }
    log(`seed: ${admins.length} admin(s) ready`);
  } else {
    log("seed: SEED_ADMIN_EMAILS not set, admins skipped");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed({ creatorEmail: process.env.SEED_CREATOR_EMAIL, adminEmails: process.env.SEED_ADMIN_EMAILS, backfillWelcomeCredit: true })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("seed failed:", (e as { code?: string; name?: string }).code ?? (e as Error).name);
      process.exit(1);
    });
}

