CREATE TABLE "run_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid,
	"installation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"repository_identity" text NOT NULL,
	"commit_sha" text NOT NULL,
	"worktree_clean" boolean NOT NULL,
	"tests" jsonb NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_checkpoints_kind" CHECK ("run_checkpoints"."kind" in ('start', 'delivery', 'tested'))
);
--> statement-breakpoint
DROP INDEX "notification_queue_pending";--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "checkpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "knowledge_context_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_contexts" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_contexts" ADD COLUMN "checkpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD COLUMN "critical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repository_identity" text;--> statement-breakpoint
ALTER TABLE "run_checkpoints" ADD CONSTRAINT "run_checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_checkpoints" ADD CONSTRAINT "run_checkpoints_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_checkpoints" ADD CONSTRAINT "run_checkpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_checkpoints" ADD CONSTRAINT "run_checkpoints_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_checkpoints_run_request" ON "run_checkpoints" USING btree ("run_id","request_id");--> statement-breakpoint
CREATE INDEX "run_checkpoints_run_created" ON "run_checkpoints" USING btree ("run_id","created_at");--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_checkpoint_id_run_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."run_checkpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_knowledge_context_id_knowledge_contexts_id_fk" FOREIGN KEY ("knowledge_context_id") REFERENCES "public"."knowledge_contexts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_contexts" ADD CONSTRAINT "knowledge_contexts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_contexts" ADD CONSTRAINT "knowledge_contexts_checkpoint_id_run_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."run_checkpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_team_repository_identity" ON "projects" USING btree ("team_id","repository_identity") WHERE repository_identity is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_queue_pending" ON "notification_queue" USING btree ("user_id","coalesce_key") WHERE status in ('pending', 'sending');