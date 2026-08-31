ALTER TABLE "agent_runs" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "pr_state" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "ci_state" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cost_cents" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cost_source" text;