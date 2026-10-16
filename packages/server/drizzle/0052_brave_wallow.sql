ALTER TABLE "users" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "test_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_test_workspace_id_teams_id_fk" FOREIGN KEY ("test_workspace_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;