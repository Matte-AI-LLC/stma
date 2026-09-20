CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"offered_by" uuid NOT NULL,
	"target_user_id" uuid,
	"accepted_by" uuid,
	"installation_id" uuid,
	"state" text DEFAULT 'offered' NOT NULL,
	"accepted_at" timestamp with time zone,
	"resumed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoffs_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "launch_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid,
	"intent" text DEFAULT 'my_agents' NOT NULL,
	"session_id" uuid,
	"first_installation_id" uuid,
	"second_installation_id" uuid,
	"first_connected_at" timestamp with time zone,
	"second_connected_at" timestamp with time zone,
	"exchange_confirmed_at" timestamp with time zone,
	"first_real_result_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_session_id_debug_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."debug_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_offered_by_users_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_attempts" ADD CONSTRAINT "launch_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_attempts" ADD CONSTRAINT "launch_attempts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_attempts" ADD CONSTRAINT "launch_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_attempts" ADD CONSTRAINT "launch_attempts_session_id_debug_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."debug_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_attempts" ADD CONSTRAINT "launch_attempts_first_installation_id_agent_installations_id_fk" FOREIGN KEY ("first_installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_attempts" ADD CONSTRAINT "launch_attempts_second_installation_id_agent_installations_id_fk" FOREIGN KEY ("second_installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handoff_state" ON "handoffs" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "launch_owner_scope" ON "launch_attempts" USING btree ("user_id","team_id","project_id");