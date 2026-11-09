ALTER TABLE "messages" ADD COLUMN "sort_at" timestamp with time zone GENERATED ALWAYS AS (coalesce("deliver_at", "created_at")) STORED;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "messages" SET "updated_at" = "created_at";--> statement-breakpoint
UPDATE "offers" SET "updated_at" = coalesce("resolved_at", "created_at");--> statement-breakpoint
CREATE FUNCTION "public"."set_updated_at"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- clock_timestamp(), not now(): the row is stamped when it is written, not when its transaction began, which
  -- narrows (but cannot close) the commit-order gap that the change read's overlap covers.
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_set_updated_at" BEFORE UPDATE ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "offers_set_updated_at" BEFORE UPDATE ON "public"."offers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();--> statement-breakpoint
CREATE INDEX "messages_conversation_sort_idx" ON "messages" USING btree ("conversation_id","sort_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "messages_conversation_updated_idx" ON "messages" USING btree ("conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "messages_offer_idx" ON "messages" USING btree ("offer_id") WHERE "messages"."offer_id" is not null;--> statement-breakpoint
CREATE INDEX "offers_conversation_idx" ON "offers" USING btree ("conversation_id");