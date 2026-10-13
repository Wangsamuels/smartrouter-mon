CREATE TYPE "public"."alias_source" AS ENUM('lmarena', 'aa', 'openrouter');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('session', 'charge');--> statement-breakpoint
CREATE TYPE "public"."provider_session_status" AS ENUM('open', 'closing', 'closed');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('open', 'closing', 'closed');--> statement-breakpoint
CREATE TYPE "public"."slider" AS ENUM('cheapest', 'balanced', 'best');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('chat', 'writing', 'coding', 'research', 'translation', 'image', 'music');--> statement-breakpoint
CREATE TYPE "public"."treasury_kind" AS ENUM('settle', 'close', 'provider_topup', 'charge', 'swap', 'refill');--> statement-breakpoint
CREATE TYPE "public"."tx_status" AS ENUM('pending', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."waitlist_interest" AS ENUM('naira', 'credits');--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compare_votes" (
	"compare_group" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"task_type" "task_type" NOT NULL,
	"winner_model_id" text NOT NULL,
	"loser_model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_request_id_user_id_pk" PRIMARY KEY("request_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "model_aliases" (
	"leaderboard_name" text NOT NULL,
	"source" "alias_source" NOT NULL,
	"model_id" text NOT NULL,
	CONSTRAINT "model_aliases_source_leaderboard_name_pk" PRIMARY KEY("source","leaderboard_name")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"mpp_url" text NOT NULL,
	"model_name" text NOT NULL,
	"adapter" text NOT NULL,
	"payment" "payment_kind" NOT NULL,
	"task_types" "task_type"[] NOT NULL,
	"quality_by_task" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_est_micro" bigint NOT NULL,
	"median_latency_ms" integer,
	"error_rate" real DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "provider_health_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "provider_sessions" (
	"provider" text NOT NULL,
	"channel_id" text PRIMARY KEY NOT NULL,
	"deposit_micro" bigint DEFAULT 0 NOT NULL,
	"spent_micro" bigint DEFAULT 0 NOT NULL,
	"last_topup_at" timestamp with time zone,
	"status" "provider_session_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_type" "task_type" NOT NULL,
	"model_id" text NOT NULL,
	"price_micro" bigint NOT NULL,
	"est_cost_micro" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"channel_id" text,
	"model_id" text NOT NULL,
	"task_type" "task_type" NOT NULL,
	"compare_group" uuid,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"price_micro" bigint NOT NULL,
	"provider_cost_micro" bigint,
	"latency_ms" integer,
	"provider_receipt" jsonb,
	"result_ref" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "requests_quote_id_unique" UNIQUE("quote_id")
);
--> statement-breakpoint
CREATE TABLE "session_store" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "treasury_kind" NOT NULL,
	"amount_micro" bigint NOT NULL,
	"token" text NOT NULL,
	"tx_hash" text,
	"ref_id" text,
	"status" "tx_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"payer" text NOT NULL,
	"authorized_signer" text,
	"deposit_micro" bigint DEFAULT 0 NOT NULL,
	"highest_voucher_micro" bigint DEFAULT 0 NOT NULL,
	"counted_micro" bigint DEFAULT 0 NOT NULL,
	"settled_micro" bigint DEFAULT 0 NOT NULL,
	"last_settle_tx" text,
	"last_settled_at" timestamp with time zone,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "session_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_taste" (
	"user_id" uuid NOT NULL,
	"task_type" "task_type" NOT NULL,
	"model_id" text NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_taste_user_id_task_type_model_id_pk" PRIMARY KEY("user_id","task_type","model_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tempo_address" text NOT NULL,
	"country" text,
	"slider" "slider" DEFAULT 'balanced' NOT NULL,
	"allocation_micro" bigint DEFAULT 2000000 NOT NULL,
	"weekly_limit_micro" bigint DEFAULT 10000000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tempo_address_unique" UNIQUE("tempo_address")
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"country" text,
	"interest" "waitlist_interest" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compare_votes" ADD CONSTRAINT "compare_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compare_votes" ADD CONSTRAINT "compare_votes_winner_model_id_models_id_fk" FOREIGN KEY ("winner_model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compare_votes" ADD CONSTRAINT "compare_votes_loser_model_id_models_id_fk" FOREIGN KEY ("loser_model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_channel_id_user_sessions_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."user_sessions"("channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_taste" ADD CONSTRAINT "user_taste_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_taste" ADD CONSTRAINT "user_taste_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_nonces_expires_idx" ON "auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "compare_votes_task_idx" ON "compare_votes" USING btree ("task_type");--> statement-breakpoint
CREATE INDEX "provider_health_provider_checked_idx" ON "provider_health" USING btree ("provider","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "quotes_expires_idx" ON "quotes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "requests_user_created_idx" ON "requests" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "requests_compare_group_idx" ON "requests" USING btree ("compare_group");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_moves_tx_hash_idx" ON "treasury_moves" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "treasury_moves_kind_created_idx" ON "treasury_moves" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "user_sessions_user_status_idx" ON "user_sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "user_sessions_status_last_used_idx" ON "user_sessions" USING btree ("status","last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_email_interest_idx" ON "waitlist" USING btree ("email","interest");