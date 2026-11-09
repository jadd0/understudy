import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { conversations, offers } from "@understudy/engine/schema";

// The host's tables. The conversation engine owns its own (`@understudy/engine/schema`, with its own migrations);
// the two columns below that point at an engine table keep their foreign keys, so the engine's migrations run first.

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

// Enums
export const roleEnum = pgEnum("role", ["fan", "creator", "admin"]);
export const catalogueKindEnum = pgEnum("catalogue_kind", ["ppv", "bundle", "personal"]);
export const simModeEnum = pgEnum("sim_mode", ["demo", "auto"]);
export const simStatusEnum = pgEnum("sim_status", ["queued", "running", "waiting_human", "done", "stopped", "failed"]);
export const ledgerKindEnum = pgEnum("ledger_kind", ["topup", "unlock", "tip", "refund", "grant"]);

// Auth.js tables (Drizzle adapter shape) with the product columns on users
export const users = pgTable("users", {
  id: id(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: ts("email_verified"),
  image: text("image"),
  role: roleEnum("role").notNull().default("fan"),
  dob: date("dob"),
  adultConfirmedAt: ts("adult_confirmed_at"),
  isSim: boolean("is_sim").notNull().default(false),
  flaggedAt: ts("flagged_at"),
  flagReason: text("flag_reason"),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: ts("expires").notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: ts("expires").notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// Product tables
export const creators = pgTable("creators", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
});

export const config = pgTable(
  "config",
  {
    id: id(),
    key: text("key").notNull(),
    creatorId: uuid("creator_id").references(() => creators.id),
    value: jsonb("value").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("config_key_creator_unique").on(t.key, t.creatorId).nullsNotDistinct()],
);

export const catalogueItems = pgTable(
  "catalogue_items",
  {
    id: id(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    kind: catalogueKindEnum("kind").notNull(),
    title: text("title").notNull(),
    teaser: text("teaser"),
    priceCents: integer("price_cents").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [check("catalogue_items_price_positive", sql`${t.priceCents} > 0`)],
);


export const wallets = pgTable(
  "wallets",
  {
    fanId: uuid("fan_id")
      .primaryKey()
      .references(() => users.id),
    balanceCents: integer("balance_cents").notNull().default(0),
    // Fan-chosen daily cap; null means the platform default. A raise waits in pending_* until pending_cap_at.
    dailyCapCents: integer("daily_cap_cents"),
    pendingCapCents: integer("pending_cap_cents"),
    pendingCapAt: ts("pending_cap_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("wallets_balance_non_negative", sql`${t.balanceCents} >= 0`),
    check("wallets_caps_positive", sql`${t.dailyCapCents} > 0 and ${t.pendingCapCents} > 0`),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    fanId: uuid("fan_id")
      .notNull()
      .references(() => users.id),
    creatorId: uuid("creator_id").references(() => creators.id),
    kind: ledgerKindEnum("kind").notNull(),
    amountCents: integer("amount_cents").notNull(),
    stripeEventId: text("stripe_event_id").unique(),
    // The Checkout session a top-up paid for; unique, so two event ids for one session credit once.
    stripeSessionId: text("stripe_session_id"),
    // Unique per ledger side effect: debits store it prefixed with the fan id, the welcome grant stores welcome:<fanId>.
    idempotencyKey: text("idempotency_key").unique(),
    offerId: uuid("offer_id").references(() => offers.id),
    // Set on unlocks and on tips made in a conversation, so revenue per conversation counts both.
    conversationId: uuid("conversation_id").references(() => conversations.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_entries_fan_created_idx").on(t.fanId, t.createdAt),
    uniqueIndex("ledger_entries_stripe_session_uq").on(t.stripeSessionId).where(sql`${t.stripeSessionId} is not null`),
    // Money in (top-up, refund, grant) is positive, money out (unlock, tip) is negative; a trigger in the same
    // migration refuses UPDATE and DELETE, so the table only ever grows.
    check(
      "ledger_entries_sign_by_kind",
      sql`(${t.kind} in ('topup', 'refund', 'grant') and ${t.amountCents} > 0) or (${t.kind} in ('unlock', 'tip') and ${t.amountCents} < 0)`,
    ),
  ],
);

export const uncreditedPaymentReasonEnum = pgEnum("uncredited_payment_reason", [
  "missing_fan",
  "unknown_fan",
  "flagged_fan",
  "non_usd",
  "unpaid",
  "bad_amount",
  "async_failed",
]);

// A Stripe Checkout event that did not credit a wallet. A person reviews it and refunds in Stripe; there is no
// automatic refund. No foreign key on fan_id: the fan may not exist.
export const uncreditedPayments = pgTable(
  "uncredited_payments",
  {
    id: id(),
    stripeEventId: text("stripe_event_id").notNull().unique(),
    stripeSessionId: text("stripe_session_id"),
    fanId: uuid("fan_id"),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    reason: uncreditedPaymentReasonEnum("reason").notNull(),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("uncredited_payments_open_idx").on(t.createdAt).where(sql`${t.resolvedAt} is null`)],
);

export const unlocks = pgTable(
  "unlocks",
  {
    fanId: uuid("fan_id")
      .notNull()
      .references(() => users.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => catalogueItems.id),
    ledgerEntryId: uuid("ledger_entry_id")
      .notNull()
      .references(() => ledgerEntries.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.fanId, t.itemId] })],
);

// Fan simulator (docs/quality/FAN-SIM.md). A run is one fresh `is_sim` fan working through one persona's beats.
export const simRuns = pgTable(
  "sim_runs",
  {
    id: id(),
    personaSlug: text("persona_slug").notNull(),
    mode: simModeEnum("mode").notNull(),
    status: simStatusEnum("status").notNull().default("queued"),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    fanId: uuid("fan_id")
      .notNull()
      .references(() => users.id),
    conversationId: uuid("conversation_id").references(() => conversations.id),
    batchId: uuid("batch_id"),
    seed: text("seed"),
    variant: jsonb("variant"),
    nextBeat: integer("next_beat").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: ts("lease_until"),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    log: jsonb("log").notNull().default(sql`'[]'::jsonb`),
    stopReason: text("stop_reason"),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("sim_runs_status_idx").on(t.status)],
);

// The sim agent's own line library: example fan lines per persona, embedded for tone and intent retrieval.
export const simLines = pgTable(
  "sim_lines",
  {
    id: id(),
    persona: text("persona").notNull(),
    intent: text("intent").notNull(),
    lang: text("lang").notNull().default("en"),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
  },
  (t) => [
    unique("sim_lines_persona_text_unique").on(t.persona, t.text),
    index("sim_lines_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("sim_lines_persona_idx").on(t.persona),
  ],
);
