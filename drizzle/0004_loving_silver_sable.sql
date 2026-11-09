CREATE TYPE "public"."uncredited_payment_reason" AS ENUM('missing_fan', 'unknown_fan', 'flagged_fan', 'non_usd', 'unpaid', 'bad_amount', 'async_failed');--> statement-breakpoint
CREATE TABLE "uncredited_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_event_id" text NOT NULL,
	"stripe_session_id" text,
	"fan_id" uuid,
	"amount_cents" integer,
	"currency" text,
	"reason" "uncredited_payment_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "uncredited_payments_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "stripe_session_id" text;--> statement-breakpoint
CREATE INDEX "uncredited_payments_open_idx" ON "uncredited_payments" USING btree ("created_at") WHERE "uncredited_payments"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_stripe_session_uq" ON "ledger_entries" USING btree ("stripe_session_id") WHERE "ledger_entries"."stripe_session_id" is not null;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_sign_by_kind" CHECK (("ledger_entries"."kind" in ('topup', 'refund', 'grant') and "ledger_entries"."amount_cents" > 0) or ("ledger_entries"."kind" in ('unlock', 'tip') and "ledger_entries"."amount_cents" < 0));--> statement-breakpoint
CREATE FUNCTION "public"."ledger_entries_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % refused', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "public"."ledger_entries" FOR EACH ROW EXECUTE FUNCTION "public"."ledger_entries_append_only"();
