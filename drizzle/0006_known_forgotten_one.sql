CREATE TYPE "public"."sim_mode" AS ENUM('demo', 'auto');--> statement-breakpoint
CREATE TYPE "public"."sim_status" AS ENUM('queued', 'running', 'waiting_human', 'done', 'stopped', 'failed');--> statement-breakpoint
CREATE TABLE "sim_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona" text NOT NULL,
	"intent" text NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024),
	CONSTRAINT "sim_lines_persona_text_unique" UNIQUE("persona","text")
);
--> statement-breakpoint
CREATE TABLE "sim_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_slug" text NOT NULL,
	"mode" "sim_mode" NOT NULL,
	"status" "sim_status" DEFAULT 'queued' NOT NULL,
	"creator_id" uuid NOT NULL,
	"fan_id" uuid NOT NULL,
	"conversation_id" uuid,
	"batch_id" uuid,
	"seed" text,
	"variant" jsonb,
	"next_beat" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sim_runs" ADD CONSTRAINT "sim_runs_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_runs" ADD CONSTRAINT "sim_runs_fan_id_users_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_runs" ADD CONSTRAINT "sim_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_lines_embedding_hnsw" ON "sim_lines" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "sim_lines_persona_idx" ON "sim_lines" USING btree ("persona");--> statement-breakpoint
CREATE INDEX "sim_runs_status_idx" ON "sim_runs" USING btree ("status");