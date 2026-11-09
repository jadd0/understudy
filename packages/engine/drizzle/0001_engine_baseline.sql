CREATE TYPE "public"."chunk_source" AS ENUM('caption', 'comment_reply', 'card');--> statement-breakpoint
CREATE TYPE "public"."conversation_mode" AS ENUM('ai', 'handoff_creator', 'human_creator', 'handoff_ts', 'human_ts', 'closed');--> statement-breakpoint
CREATE TYPE "public"."handoff_queue" AS ENUM('creator', 'ts');--> statement-breakpoint
CREATE TYPE "public"."handoff_reason" AS ENUM('minor', 'self_harm', 'threat', 'location_offplatform', 'payment_dispute', 'hardship_escalation', 'explicit_live_chat', 'custom_request', 'unsure', 'verify_failed', 'high_value_alert', 'engine_error');--> statement-breakpoint
CREATE TYPE "public"."handoff_status" AS ENUM('open', 'claimed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('sent', 'superseded', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('open', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."sender" AS ENUM('fan', 'ai', 'creator', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."turn_route" AS ENUM('reply', 'offer', 'hold_creator', 'hard_stop', 'deflect', 'ai_disclosure');--> statement-breakpoint
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
	"no_pitch_until" timestamp with time zone,
	"fan_typing_until" timestamp with time zone,
	"failed_turns" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_creator_fan_unique" UNIQUE("creator_id","fan_id")
);
--> statement-breakpoint
CREATE TABLE "creator_settings" (
	"creator_id" uuid PRIMARY KEY NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"reason" "handoff_reason" NOT NULL,
	"status" "handoff_status" DEFAULT 'open' NOT NULL,
	"claimed_by" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
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
	"turn_id" uuid,
	"suggested" boolean DEFAULT false NOT NULL,
	"deliver_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sort_at" timestamp with time zone GENERATED ALWAYS AS (coalesce("deliver_at", "created_at")) STORED,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"turn_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"inbound_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"jev_in" jsonb,
	"route" "turn_route",
	"offer_id" uuid,
	"attempts" integer,
	"handoff_id" uuid,
	"ms_total" integer,
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
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_handoff_id_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_one_unresolved_per_conversation" ON "handoffs" USING btree ("conversation_id") WHERE "handoffs"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_sort_idx" ON "messages" USING btree ("conversation_id","sort_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "messages_conversation_updated_idx" ON "messages" USING btree ("conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "messages_offer_idx" ON "messages" USING btree ("offer_id") WHERE "messages"."offer_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_unanswered_idx" ON "messages" USING btree ("conversation_id","created_at") WHERE "messages"."turn_id" is null and "messages"."sender" = 'fan';--> statement-breakpoint
CREATE INDEX "offers_conversation_idx" ON "offers" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "persona_chunks_embedding_hnsw" ON "persona_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "persona_chunks_tsv_gin" ON "persona_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "persona_chunks_creator_idx" ON "persona_chunks" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "turns_conversation_idx" ON "turns" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "turns_created_idx" ON "turns" USING btree ("created_at");