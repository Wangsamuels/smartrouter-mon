ALTER TABLE "users" ADD COLUMN "daily_limit_micro" bigint DEFAULT 2000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "spending_key_address" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "spending_key_expires_at" timestamp with time zone;