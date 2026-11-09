import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
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

// The engine's tables. Host rows (users, creators, catalogue items) are known by id only: those columns carry no
// foreign key, so the package creates its tables without any host table existing.

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// Enums
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

// Tables
export const personaCards = pgTable(
  "persona_cards",
  {
    id: id(),
    creatorId: uuid("creator_id")
      .notNull(),
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
      .notNull(),
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
      .notNull(),
    fanId: uuid("fan_id")
      .notNull(),
    mode: conversationModeEnum("mode").notNull().default("ai"),
    version: integer("version").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: ts("lease_until"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    lastPitchAt: ts("last_pitch_at"),
    // Kept for history; declines are now computed from `offers`.
    pitchDeclines: integer("pitch_declines").notNull().default(0),
    noPitchUntil: ts("no_pitch_until"),
    // After the sweep settles a held chat by policy, the same chat's next hold is a deflect until this passes.
    holdSuppressedUntil: ts("hold_suppressed_until"),
    // The fan's composer pings this while keys are pressed; the engine holds a turn while it is in the future.
    fanTypingUntil: ts("fan_typing_until"),
    failedTurns: integer("failed_turns").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique("conversations_creator_fan_unique").on(t.creatorId, t.fanId)],
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
    .notNull(),
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
    senderUserId: uuid("sender_user_id"),
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
    claimedBy: uuid("claimed_by"),
    openedAt: ts("opened_at").notNull().defaultNow(),
    claimedAt: ts("claimed_at"),
    resolvedAt: ts("resolved_at"),
    /** When a creator-queue handoff falls back to policy, or a Trust & Safety one counts as late. */
    dueAt: ts("due_at"),
    /** Who closed it: a person, or the sweep's policy once it was due. */
    resolvedBy: text("resolved_by").$type<"human" | "sla">(),
    /** Set once when a Trust & Safety handoff passes its due time; the sweep alerts and never resolves it. */
    slaBreachedAt: ts("sla_breached_at"),
  },
  (t) => [
    uniqueIndex("handoffs_one_unresolved_per_conversation")
      .on(t.conversationId)
      .where(sql`${t.status} <> 'resolved'`),
    index("handoffs_due_idx").on(t.dueAt).where(sql`${t.status} <> 'resolved'`),
    check("handoffs_resolved_by_check", sql`${t.resolvedBy} in ('human', 'sla')`),
  ],
);

export const fanMemory = pgTable(
  "fan_memory",
  {
    creatorId: uuid("creator_id")
      .notNull(),
    fanId: uuid("fan_id")
      .notNull(),
    profile: jsonb("profile").notNull().default(sql`'{}'::jsonb`),
    version: integer("version").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.creatorId, t.fanId] })],
);

// The per-creator AI switch. A missing row means on. `creator_id` is a host creator id, with no foreign key.
export const creatorSettings = pgTable("creator_settings", {
  creatorId: uuid("creator_id").primaryKey(),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
