ALTER TABLE "ledger_entries" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "daily_cap_cents" integer;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "pending_cap_cents" integer;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "pending_cap_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_idempotency_key_unique" UNIQUE("idempotency_key");--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_caps_positive" CHECK ("wallets"."daily_cap_cents" > 0 and "wallets"."pending_cap_cents" > 0);