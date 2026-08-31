CREATE TABLE "team_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"repo" text NOT NULL,
	"token" text NOT NULL,
	"comment_on_finish" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_installations" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "attempt_group" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "quota_pct" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "quota_state" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "quota_resets_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "quota_label" text;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD COLUMN "webhook_url" text;--> statement-breakpoint
ALTER TABLE "team_integrations" ADD CONSTRAINT "team_integrations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_integrations" ADD CONSTRAINT "team_integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_integrations_team_provider" ON "team_integrations" USING btree ("team_id","provider");