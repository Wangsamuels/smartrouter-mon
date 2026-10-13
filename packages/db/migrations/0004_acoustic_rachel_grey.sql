ALTER TABLE "users" ADD COLUMN "privy_did" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "login_method" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_privy_did_unique" UNIQUE("privy_did");