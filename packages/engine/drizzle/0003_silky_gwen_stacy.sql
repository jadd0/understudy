ALTER TABLE "conversations" ADD COLUMN "hold_suppressed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "sla_breached_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "handoffs_due_idx" ON "handoffs" USING btree ("due_at") WHERE "handoffs"."status" <> 'resolved';--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_resolved_by_check" CHECK ("handoffs"."resolved_by" in ('human', 'sla'));