ALTER TABLE "execution_attempt_grants" DROP CONSTRAINT "execution_attempt_grants_attempt_id_unique";--> statement-breakpoint
ALTER TABLE "execution_attempt_grants" ADD COLUMN "purpose" text DEFAULT 'supervisor' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_attempt_grants" ADD CONSTRAINT "execution_grants_purpose" CHECK ("purpose" IN ('supervisor', 'readonly_child'));--> statement-breakpoint
ALTER TABLE "execution_attempt_grants" ADD CONSTRAINT "execution_grants_attempt_purpose" UNIQUE ("attempt_id", "purpose");
