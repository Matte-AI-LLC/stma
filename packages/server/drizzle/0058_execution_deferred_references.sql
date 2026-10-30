-- Drizzle's schema API cannot express DEFERRABLE. Preserve pinned execution
-- history while letting a parent project/workspace/account cascade remove the
-- complete graph before PostgreSQL checks these three references at commit.
-- Direct deletion of a referenced work/run/worker still fails at commit.
-- Rollback requires a new forward migration setting NOT DEFERRABLE; it may
-- restore parent-cascade failures. Never modify an already-applied SQL hash.
ALTER TABLE "execution_jobs" ALTER CONSTRAINT "execution_jobs_work_id_work_items_id_fk" DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "execution_attempts" ALTER CONSTRAINT "execution_attempts_run_id_agent_runs_id_fk" DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "execution_attempts" ALTER CONSTRAINT "execution_attempts_worker_id_worker_instances_id_fk" DEFERRABLE INITIALLY DEFERRED;
