ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD COLUMN "last_ip" text;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD COLUMN "last_seen_at" timestamp with time zone;