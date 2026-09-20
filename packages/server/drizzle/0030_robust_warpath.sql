ALTER TABLE "agent_runs" ADD COLUMN "start_request_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "start_request_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_installation_start_request" ON "agent_runs" USING btree ("installation_id","start_request_id") WHERE start_request_id is not null;