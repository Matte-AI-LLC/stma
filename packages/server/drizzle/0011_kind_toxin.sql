CREATE TABLE "environment_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"run_id" uuid,
	"status" text NOT NULL,
	"fingerprint" text NOT NULL,
	"baseline_fingerprint" text,
	"summary" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_checks" ADD CONSTRAINT "environment_checks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_checks" ADD CONSTRAINT "environment_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_checks" ADD CONSTRAINT "environment_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_checks" ADD CONSTRAINT "environment_checks_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_checks_team_created" ON "environment_checks" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "environment_checks_project_created" ON "environment_checks" USING btree ("project_id","created_at");