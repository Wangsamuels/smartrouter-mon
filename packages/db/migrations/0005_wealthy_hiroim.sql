CREATE TYPE "public"."wallet_move_kind" AS ENUM('deposit', 'send', 'send_cross_chain');--> statement-breakpoint
CREATE TYPE "public"."wallet_move_status" AS ENUM('pending', 'completed', 'failed', 'refunding', 'refunded', 'action_required');--> statement-breakpoint
ALTER TYPE "public"."treasury_kind" ADD VALUE 'sweep';--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposit_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'relay' NOT NULL,
	"source_chain" text NOT NULL,
	"source_chain_id" integer NOT NULL,
	"source_token" text NOT NULL,
	"source_token_address" text NOT NULL,
	"source_token_decimals" integer NOT NULL,
	"address" text NOT NULL,
	"refund_address" text,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsored_txs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"sign_payload" text NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sponsored_txs_sign_payload_unique" UNIQUE("sign_payload")
);
--> statement-breakpoint
CREATE TABLE "wallet_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "wallet_move_kind" NOT NULL,
	"status" "wallet_move_status" DEFAULT 'pending' NOT NULL,
	"amount_micro" bigint NOT NULL,
	"delivered_micro" bigint,
	"chain" text NOT NULL,
	"token" text NOT NULL,
	"counterparty" text,
	"tx_hash" text,
	"external_id" text,
	"allowed_targets" jsonb,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_moves_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsored_txs" ADD CONSTRAINT "sponsored_txs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_moves" ADD CONSTRAINT "wallet_moves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_user_route_idx" ON "deposit_addresses" USING btree ("user_id","source_chain","source_token");--> statement-breakpoint
CREATE INDEX "sponsored_txs_user_created_idx" ON "sponsored_txs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_moves_user_created_idx" ON "wallet_moves" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_moves_status_idx" ON "wallet_moves" USING btree ("status");