ALTER TYPE "public"."treasury_kind" ADD VALUE 'release';--> statement-breakpoint
ALTER TYPE "public"."treasury_kind" ADD VALUE 'bridge';--> statement-breakpoint
ALTER TYPE "public"."wallet_move_kind" ADD VALUE 'to_ai_balance';--> statement-breakpoint
ALTER TYPE "public"."wallet_move_kind" ADD VALUE 'from_ai_balance';--> statement-breakpoint
ALTER TABLE "deposit_addresses" ALTER COLUMN "provider" SET DEFAULT 'aurora';--> statement-breakpoint
ALTER TABLE "compare_votes" ADD COLUMN "winner_request_id" uuid;--> statement-breakpoint
ALTER TABLE "compare_votes" ADD COLUMN "loser_request_id" uuid;--> statement-breakpoint
ALTER TABLE "compare_votes" ADD COLUMN "sig" text;--> statement-breakpoint
ALTER TABLE "compare_votes" ADD COLUMN "ledger_tx" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "sig" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "ledger_tx" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "route_log" jsonb;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "route_hash" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "route_hash" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "ledger_tx" text;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "charged_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "voucher_sig" text;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "voucher_signer" text;