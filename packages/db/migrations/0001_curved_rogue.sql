CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'streaming', 'done', 'failed');--> statement-breakpoint
ALTER TYPE "public"."payment_kind" ADD VALUE 'free';--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"task_type" "task_type" NOT NULL,
	"slider" "slider" DEFAULT 'balanced' NOT NULL,
	"current_model_id" text,
	"summary" text,
	"summary_through_seq" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"spent_micro" bigint DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "free_usage" (
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "free_usage_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"attachments" jsonb,
	"model_id" text,
	"request_id" uuid,
	"result_ref" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"status" "message_status" DEFAULT 'done' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "prompt_hash" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "context_tokens" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "user_message_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "assistant_message_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "is_free" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auto_free_fallback" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_current_model_id_models_id_fk" FOREIGN KEY ("current_model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_usage" ADD CONSTRAINT "free_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chats_user_last_idx" ON "chats" USING btree ("user_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_chat_seq_idx" ON "messages" USING btree ("chat_id","seq");--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requests_chat_idx" ON "requests" USING btree ("chat_id","created_at");