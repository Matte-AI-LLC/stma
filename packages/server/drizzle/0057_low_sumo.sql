CREATE TABLE "execution_attempt_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"parent_token_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "execution_attempt_grants_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "execution_attempt_grants_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"state" text DEFAULT 'leased' NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"provider_session_id" uuid NOT NULL,
	"run_id" uuid,
	"process_stopped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_attempts_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "execution_attempts_provider_session_id_unique" UNIQUE("provider_session_id"),
	CONSTRAINT "execution_attempts_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "execution_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid,
	"request_hash" text NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"handoff_id" uuid NOT NULL,
	"work_id" uuid,
	"spec_revision" integer,
	"principal_kind" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_token_id" uuid,
	"actor_security_principal" jsonb NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"grant_version" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"max_runtime_seconds" integer NOT NULL,
	"max_turns" integer NOT NULL,
	"assignment" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"checkout_path" text NOT NULL,
	"checkout_fingerprint" text NOT NULL,
	"runtime" text NOT NULL,
	"runtime_version" text NOT NULL,
	"permission_profile" text NOT NULL,
	"max_runtime_seconds" integer NOT NULL,
	"max_turns" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"grant_version" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_targets_installation_id_unique" UNIQUE("installation_id"),
	CONSTRAINT "execution_target_limits" CHECK ("execution_targets"."max_runtime_seconds" between 60 and 3600 and "execution_targets"."max_turns" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "worker_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_attempt_grants" ADD CONSTRAINT "execution_attempt_grants_attempt_id_execution_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."execution_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempt_grants" ADD CONSTRAINT "execution_attempt_grants_parent_token_id_tokens_id_fk" FOREIGN KEY ("parent_token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_job_id_execution_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."execution_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_worker_id_worker_instances_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."worker_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_job_id_execution_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."execution_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_attempt_id_execution_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."execution_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_target_id_execution_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."execution_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_session_id_debug_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."debug_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_handoff_id_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_actor_token_id_tokens_id_fk" FOREIGN KEY ("actor_token_id") REFERENCES "public"."tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_instances" ADD CONSTRAINT "worker_instances_target_id_execution_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."execution_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_grants_parent_token" ON "execution_attempt_grants" USING btree ("parent_token_id");--> statement-breakpoint
CREATE INDEX "execution_attempts_worker" ON "execution_attempts" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "execution_events_job" ON "execution_events" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "execution_events_attempt" ON "execution_events" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_request_once" ON "execution_jobs" USING btree ("principal_kind","principal_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_assignment_active" ON "execution_jobs" USING btree ("handoff_id") WHERE state in ('queued','leased','starting','running','cancel_requested','dispatch_unknown','lost');--> statement-breakpoint
CREATE INDEX "execution_target_queue" ON "execution_jobs" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "execution_jobs_session" ON "execution_jobs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "execution_jobs_actor_user" ON "execution_jobs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "execution_jobs_actor_token" ON "execution_jobs" USING btree ("actor_token_id");--> statement-breakpoint
CREATE INDEX "execution_jobs_work" ON "execution_jobs" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "execution_jobs_handoff" ON "execution_jobs" USING btree ("handoff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_checkout_owner" ON "execution_targets" USING btree ("owner_id","checkout_fingerprint");--> statement-breakpoint
CREATE INDEX "execution_targets_team" ON "execution_targets" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "execution_targets_project" ON "execution_targets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "worker_instances_target" ON "worker_instances" USING btree ("target_id");