CREATE TABLE "provider_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid,
	"provider" text NOT NULL,
	"repository_id" text NOT NULL,
	"full_name" text NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "team_integrations_team_provider";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "provider_observations" ADD CONSTRAINT "provider_observations_binding_id_repository_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."repository_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_bindings" ADD CONSTRAINT "repository_bindings_connection_id_team_integrations_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."team_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_bindings" ADD CONSTRAINT "repository_bindings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_bindings" ADD CONSTRAINT "repository_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_delivery_once" ON "provider_observations" USING btree ("binding_id","delivery_id");--> statement-breakpoint
CREATE INDEX "provider_subject" ON "provider_observations" USING btree ("binding_id","subject_id","commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_binding_identity" ON "repository_bindings" USING btree ("team_id","provider","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_integrations_team_provider_repo" ON "team_integrations" USING btree ("team_id","provider","repo");