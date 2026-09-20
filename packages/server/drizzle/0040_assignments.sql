ALTER TABLE "handoffs" ADD COLUMN "target_installation_id" uuid;--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "kind" text DEFAULT 'handoff' NOT NULL;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_target_installation_id_agent_installations_id_fk" FOREIGN KEY ("target_installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_kind" CHECK ("handoffs"."kind" in ('handoff', 'assignment'));