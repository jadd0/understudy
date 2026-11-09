import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
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

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// Enums
export const roleEnum = pgEnum("role", ["fan", "creator", "admin"]);
export const chunkSourceEnum = pgEnum("chunk_source", ["caption", "comment_reply", "card"]);
export const conversationModeEnum = pgEnum("conversation_mode", [
  "ai",
  "handoff_creator",
  "human_creator",
  "handoff_ts",
  "human_ts",
  "closed",
]);
export const senderEnum = pgEnum("sender", ["fan", "ai", "creator", "admin", "system"]);
export const messageStatusEnum = pgEnum("message_status", ["sent", "superseded", "blocked"]);
export const handoffQueueEnum = pgEnum("handoff_queue", ["creator", "ts"]);
export const handoffStatusEnum = pgEnum("handoff_status", ["open", "claimed", "resolved"]);
export const catalogueKindEnum = pgEnum("catalogue_kind", ["ppv", "bundle", "personal"]);
export const offerStatusEnum = pgEnum("offer_status", ["open", "accepted", "declined", "expired"]);
export const handoffReasonEnum = pgEnum("handoff_reason", [
  "minor",
  "self_harm",
  "threat",
  "location_offplatform",
  "payment_dispute",
  "hardship_escalation",
  "explicit_live_chat",
  "custom_request",
  "unsure",
  "verify_failed",
  "high_value_alert",
  "engine_error",
]);
export const turnRouteEnum = pgEnum("turn_route", [
  "reply",
  "offer",
  "hold_creator",
  "hard_stop",
  "deflect",
  "ai_disclosure",
]);
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
  aiEnabled: boolean("ai_enabled").notNull().default(true),
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

export const personaCards = pgTable(
  "persona_cards",
  {
    id: id(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    neverList: text("never_list").array().notNull().default(sql`'{}'::text[]`),
    publishedAt: ts("published_at"),
  },
  (t) => [unique("persona_cards_creator_version_unique").on(t.creatorId, t.version)],
);

export const personaChunks = pgTable(
  "persona_chunks",
  {
    id: id(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    source: chunkSourceEnum("source").notNull(),
    sourceUrl: text("source_url"),
    text: text("text").notNull(),
    meta: jsonb("meta"),
    embedding: vector("embedding", { dimensions: 1024 }),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', text)`),
  },
  (t) => [
    index("persona_chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("persona_chunks_tsv_gin").using("gin", t.tsv),
    index("persona_chunks_creator_idx").on(t.creatorId),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    fanId: uuid("fan_id")
      .notNull()
      .references(() => users.id),
    mode: conversationModeEnum("mode").notNull().default("ai"),
    version: integer("version").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: ts("lease_until"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    lastPitchAt: ts("last_pitch_at"),
    // Kept for history; declines are now computed from `offers`.
    pitchDeclines: integer("pitch_declines").notNull().default(0),
    noPitchUntil: ts("no_pitch_until"),
    // The fan's composer pings this while keys are pressed; the engine holds a turn while it is in the future.
    fanTypingUntil: ts("fan_typing_until"),
    failedTurns: integer("failed_turns").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique("conversations_creator_fan_unique").on(t.creatorId, t.fanId)],
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

export const turns = pgTable(
  "turns",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    inboundIds: uuid("inbound_ids").array().notNull().default(sql`'{}'::uuid[]`),
    jevIn: jsonb("jev_in"),
    route: turnRouteEnum("route"),
    offerId: uuid("offer_id").references((): AnyPgColumn => offers.id), // offers and turns reference each other
    attempts: integer("attempts"),
    handoffId: uuid("handoff_id").references((): AnyPgColumn => handoffs.id),
    msTotal: integer("ms_total"),
    draft: text("draft"),
    jevOut: jsonb("jev_out"),
    outcome: text("outcome"),
    personaVersion: integer("persona_version"),
    models: jsonb("models"),
    tokens: jsonb("tokens"),
    costMicros: bigint("cost_micros", { mode: "number" }),
    msJevIn: integer("ms_jev_in"),
    msGen: integer("ms_gen"),
    msJevOut: integer("ms_jev_out"),
    createdAt: createdAt(),
  },
  (t) => [index("turns_conversation_idx").on(t.conversationId), index("turns_created_idx").on(t.createdAt)],
);

export const offers = pgTable("offers", {
  id: id(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  itemId: uuid("item_id")
    .notNull()
    .references(() => catalogueItems.id),
  priceCents: integer("price_cents").notNull(),
  expiresAt: ts("expires_at").notNull(),
  status: offerStatusEnum("status").notNull().default("open"),
  createdAt: createdAt(),
  resolvedAt: ts("resolved_at"),
  turnId: uuid("turn_id").references(() => turns.id),
  // Kept current by the `set_updated_at` trigger on every update, so a change read sees a new offer state.
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  // The change read's "offers in this conversation updated or expired since the cursor".
  index("offers_conversation_idx").on(t.conversationId),
]);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    sender: senderEnum("sender").notNull(),
    senderUserId: uuid("sender_user_id").references(() => users.id),
    body: text("body").notNull(),
    offerId: uuid("offer_id").references(() => offers.id),
    status: messageStatusEnum("status").notNull().default("sent"),
    clientMsgId: text("client_msg_id").unique(),
    // Set only by a committed turn or a hand-back stamp: the turn that answered (or retired) this message.
    turnId: uuid("turn_id").references((): AnyPgColumn => turns.id),
    // A draft held for the creator to edit and send; never shown to the fan.
    suggested: boolean("suggested").notNull().default(false),
    // The fan sees the message once this has passed; null means at once.
    deliverAt: ts("deliver_at"),
    createdAt: createdAt(),
    // When the bubble shows: the thread's sort key and the keyset of its pages. Raw column names, since a
    // generated column cannot reference this table's own column objects.
    sortAt: ts("sort_at").generatedAlwaysAs(sql`coalesce("deliver_at", "created_at")`),
    // Kept current by the `set_updated_at` trigger on every update, so change reads cover every write path.
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    // Newest-first pages and the "became due since the cursor" branch of a change read.
    index("messages_conversation_sort_idx").on(t.conversationId, t.sortAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    // The "updated since the cursor" branch of a change read.
    index("messages_conversation_updated_idx").on(t.conversationId, t.updatedAt),
    // An offer's state change, found from the offer back to the bubble that carries it.
    index("messages_offer_idx").on(t.offerId).where(sql`${t.offerId} is not null`),
    // The sweep's "fan messages nobody has answered" scan.
    index("messages_unanswered_idx")
      .on(t.conversationId, t.createdAt)
      .where(sql`${t.turnId} is null and ${t.sender} = 'fan'`),
  ],
);

export const handoffs = pgTable(
  "handoffs",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    queue: handoffQueueEnum("queue").notNull(),
    reason: handoffReasonEnum("reason").notNull(),
    status: handoffStatusEnum("status").notNull().default("open"),
    claimedBy: uuid("claimed_by").references(() => users.id),
    openedAt: ts("opened_at").notNull().defaultNow(),
    claimedAt: ts("claimed_at"),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [
    uniqueIndex("handoffs_one_unresolved_per_conversation")
      .on(t.conversationId)
      .where(sql`${t.status} <> 'resolved'`),
  ],
);

export const fanMemory = pgTable(
  "fan_memory",
  {
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    fanId: uuid("fan_id")
      .notNull()
      .references(() => users.id),
    profile: jsonb("profile").notNull().default(sql`'{}'::jsonb`),
    version: integer("version").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.creatorId, t.fanId] })],
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

// Fan simulator (docs/FAN-SIM.md). A run is one fresh `is_sim` fan working through one persona's beats.
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
