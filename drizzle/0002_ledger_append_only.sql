CREATE FUNCTION "public"."ledger_entries_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % refused', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "public"."ledger_entries" FOR EACH ROW EXECUTE FUNCTION "public"."ledger_entries_append_only"();
