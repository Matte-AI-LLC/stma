ALTER TABLE "tokens" ADD COLUMN "access_mode" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_access_mode" CHECK ("access_mode" = 'standard' OR ("access_mode" = 'analyst' AND "scope" = 'project'));
