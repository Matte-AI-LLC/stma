ALTER TABLE "tokens" ADD COLUMN "setup_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "activated_at" timestamp with time zone;