ALTER TABLE "agent_runs" ADD COLUMN "quota_source" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "payload" jsonb;--> statement-breakpoint
-- A receipt with no reported hash used to be written as drift, because "drifted
-- until the agent answers" was the only honest reading while no MCP tool could
-- answer. update_run can answer now, so drift goes back to meaning a real
-- deviation and unconfirmed is its own, weaker state. Old rows are recomputed
-- so the governance page is not still counting silence as breakage.
UPDATE "policy_receipts" SET "drift" = false WHERE "reported_hash" IS NULL;
