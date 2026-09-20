DROP INDEX "work_claims_run_resource";--> statement-breakpoint
ALTER TABLE "work_claims" ADD COLUMN "source" text DEFAULT 'planned' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "work_claims_run_resource" ON "work_claims" USING btree ("run_id","resource_type","resource_key","access","source");