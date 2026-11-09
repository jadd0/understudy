CREATE TYPE "public"."handoff_reason" AS ENUM('minor', 'self_harm', 'threat', 'location_offplatform', 'payment_dispute', 'hardship_escalation', 'explicit_live_chat', 'custom_request', 'unsure', 'verify_failed', 'high_value_alert', 'engine_error');--> statement-breakpoint
CREATE TYPE "public"."turn_route" AS ENUM('reply', 'offer', 'hold_creator', 'hard_stop', 'deflect', 'ai_disclosure');--> statement-breakpoint
ALTER TABLE "handoffs" ALTER COLUMN "reason" SET DATA TYPE "public"."handoff_reason" USING "reason"::"public"."handoff_reason";--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "route" SET DATA TYPE "public"."turn_route" USING "route"::"public"."turn_route";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "no_pitch_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "failed_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "turn_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "suggested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deliver_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "attempts" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "handoff_id" uuid;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "ms_total" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_handoff_id_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_unanswered_idx" ON "messages" USING btree ("conversation_id","created_at") WHERE "messages"."turn_id" is null and "messages"."sender" = 'fan';