CREATE TABLE "plan_grants" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"ends_at" timestamp with time zone,
	"note" text,
	"granted_by" uuid,
	"granted_by_label" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_grants_plan" CHECK ("plan_grants"."plan" in ('solo', 'team', 'enterprise'))
);
--> statement-breakpoint
ALTER TABLE "plan_grants" ADD CONSTRAINT "plan_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_grants" ADD CONSTRAINT "plan_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;