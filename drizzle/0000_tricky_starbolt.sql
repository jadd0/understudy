CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."catalogue_kind" AS ENUM('ppv', 'bundle', 'personal');--> statement-breakpoint
CREATE TYPE "public"."chunk_source" AS ENUM('caption', 'comment_reply', 'card');--> statement-breakpoint
CREATE TYPE "public"."conversation_mode" AS ENUM('ai', 'handoff_creator', 'human_creator', 'handoff_ts', 'human_ts', 'closed');--> statement-breakpoint
CREATE TYPE "public"."handoff_queue" AS ENUM('creator', 'ts');--> statement-breakpoint
CREATE TYPE "public"."handoff_status" AS ENUM('open', 'claimed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('topup', 'unlock', 'tip', 'refund');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('sent', 'superseded', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('open', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('fan', 'creator', 'admin');--> statement-breakpoint
CREATE TYPE "public"."sender" AS ENUM('fan', 'ai', 'creator', 'admin', 'system');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "catalogue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"kind" "catalogue_kind" NOT NULL,
	"title" text NOT NULL,
	"teaser" text,
	"price_cents" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "catalogue_items_price_positive" CHECK ("catalogue_items"."price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"creator_id" uuid,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_key_creator_unique" UNIQUE NULLS NOT DISTINCT("key","creator_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"fan_id" uuid NOT NULL,
	"mode" "conversation_mode" DEFAULT 'ai' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"last_pitch_at" timestamp with time zone,
	"pitch_declines" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_creator_fan_unique" UNIQUE("creator_id","fan_id")
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "creators_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "creators_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "fan_memory" (
	"creator_id" uuid NOT NULL,
	"fan_id" uuid NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fan_memory_creator_id_fan_id_pk" PRIMARY KEY("creator_id","fan_id")
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"queue" "handoff_queue" NOT NULL,
	"reason" text NOT NULL,
	"status" "handoff_status" DEFAULT 'open' NOT NULL,
	"claimed_by" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fan_id" uuid NOT NULL,
	"creator_id" uuid,
	"kind" "ledger_kind" NOT NULL,
	"amount_cents" integer NOT NULL,
	"stripe_event_id" text,
	"offer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender" "sender" NOT NULL,
	"sender_user_id" uuid,
	"body" text NOT NULL,
	"offer_id" uuid,
	"status" "message_status" DEFAULT 'sent' NOT NULL,
	"client_msg_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_client_msg_id_unique" UNIQUE("client_msg_id")
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"price_cents" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "offer_status" DEFAULT 'open' NOT NULL,
	"turn_id" uuid
);
--> statement-breakpoint
CREATE TABLE "persona_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"never_list" text[] DEFAULT '{}'::text[] NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "persona_cards_creator_version_unique" UNIQUE("creator_id","version")
);
--> statement-breakpoint
CREATE TABLE "persona_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"source" "chunk_source" NOT NULL,
	"source_url" text,
	"text" text NOT NULL,
	"meta" jsonb,
	"embedding" vector(1024),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"inbound_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"jev_in" jsonb,
	"route" text,
	"offer_id" uuid,
	"draft" text,
	"jev_out" jsonb,
	"outcome" text,
	"persona_version" integer,
	"models" jsonb,
	"tokens" jsonb,
	"cost_micros" bigint,
	"ms_jev_in" integer,
	"ms_gen" integer,
	"ms_jev_out" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unlocks" (
	"fan_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unlocks_fan_id_item_id_pk" PRIMARY KEY("fan_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"email_verified" timestamp with time zone,
	"image" text,
	"role" "role" DEFAULT 'fan' NOT NULL,
	"dob" date,
	"adult_confirmed_at" timestamp with time zone,
	"is_sim" boolean DEFAULT false NOT NULL,
	"flagged_at" timestamp with time zone,
	"flag_reason" text,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"fan_id" uuid PRIMARY KEY NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_balance_non_negative" CHECK ("wallets"."balance_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_items_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config" ADD CONSTRAINT "config_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_fan_id_users_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fan_memory" ADD CONSTRAINT "fan_memory_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fan_memory" ADD CONSTRAINT "fan_memory_fan_id_users_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_fan_id_users_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_item_id_catalogue_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalogue_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_cards" ADD CONSTRAINT "persona_cards_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_chunks" ADD CONSTRAINT "persona_chunks_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlocks" ADD CONSTRAINT "unlocks_fan_id_users_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlocks" ADD CONSTRAINT "unlocks_item_id_catalogue_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalogue_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlocks" ADD CONSTRAINT "unlocks_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_fan_id_users_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_one_unresolved_per_conversation" ON "handoffs" USING btree ("conversation_id") WHERE "handoffs"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "ledger_entries_fan_created_idx" ON "ledger_entries" USING btree ("fan_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "persona_chunks_embedding_hnsw" ON "persona_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "persona_chunks_tsv_gin" ON "persona_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "persona_chunks_creator_idx" ON "persona_chunks" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "turns_conversation_idx" ON "turns" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "turns_created_idx" ON "turns" USING btree ("created_at");