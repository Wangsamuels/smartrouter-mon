ALTER TABLE "models" ADD COLUMN "label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "speed_class" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "web" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;