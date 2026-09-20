ALTER TABLE "provider_observations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_observations" ADD CONSTRAINT "provider_observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "provider_observations" AS o SET "project_id" = b."project_id" FROM "repository_bindings" AS b WHERE o."binding_id" = b."id";
