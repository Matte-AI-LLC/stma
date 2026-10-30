ALTER TABLE "work_commands" ADD COLUMN "unchanged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_runs_rotated_to" ON "agent_runs" USING btree ("rotated_to_run_id") WHERE rotated_to_run_id is not null;--> statement-breakpoint
CREATE INDEX "work_deliveries_run" ON "work_deliveries" USING btree ("run_id") WHERE run_id is not null;--> statement-breakpoint
CREATE INDEX "work_links_run" ON "work_links" USING btree ("run_id") WHERE run_id is not null;--> statement-breakpoint
CREATE INDEX "work_links_handoff" ON "work_links" USING btree ("handoff_id") WHERE handoff_id is not null;