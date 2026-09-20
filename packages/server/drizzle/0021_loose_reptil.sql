CREATE TABLE "agent_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_prefix" text NOT NULL,
	"name" text NOT NULL,
	"device_label" text NOT NULL,
	"client_type" text DEFAULT 'generic' NOT NULL,
	"role" text,
	"scope" text NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"installation_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_enrollments_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "agent_installations" ADD COLUMN "token_id" uuid;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "scope" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_enrollments" ADD CONSTRAINT "agent_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_enrollments" ADD CONSTRAINT "agent_enrollments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_enrollments" ADD CONSTRAINT "agent_enrollments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_enrollments" ADD CONSTRAINT "agent_enrollments_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_enrollments_user_created" ON "agent_enrollments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_enrollments_expires" ON "agent_enrollments" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_installations_token_unique" ON "agent_installations" USING btree ("token_id") WHERE token_id is not null;