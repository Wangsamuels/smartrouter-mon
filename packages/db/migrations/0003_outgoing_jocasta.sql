ALTER TABLE "session_store" ALTER COLUMN "value" SET DATA TYPE text USING "value"::text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "max_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "output_text" text;