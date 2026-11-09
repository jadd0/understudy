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
CREATE TRIGGER "offers_set_updated_at" BEFORE UPDATE ON "public"."offers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
