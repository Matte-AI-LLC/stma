ALTER TABLE "execution_jobs" ADD COLUMN "actor_session_proof" text;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD COLUMN "dispatcher_user_ids" uuid[];--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "execution_job_cap" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_execution_job_cap" CHECK ("teams"."execution_job_cap" between 1 and 1000);--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD COLUMN "capacity_reconciliation" jsonb;--> statement-breakpoint
CREATE INDEX "execution_jobs_target_state" ON "execution_jobs" USING btree ("target_id","state");--> statement-breakpoint
CREATE INDEX "web_sessions_user" ON "web_sessions" USING btree ("user_id");
