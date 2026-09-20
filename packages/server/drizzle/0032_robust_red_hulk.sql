CREATE TABLE "knowledge_audience_projects" (
	"version_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "knowledge_audience_projects_version_id_project_id_pk" PRIMARY KEY("version_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid,
	"requested_by" uuid,
	"token_id" uuid,
	"query" text,
	"resolver_version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"byte_size" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"omitted_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"stable_key" text NOT NULL,
	"owner_id" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"current_version_id" uuid,
	"draft_version_id" uuid,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_items_state" CHECK ("knowledge_items"."state" in ('active', 'archived', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"token_id" uuid,
	"installation_id" uuid,
	"run_id" uuid,
	"served_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_at" timestamp with time zone,
	"reported_manifest_hash" text
);
--> statement-breakpoint
CREATE TABLE "knowledge_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"publication" integer,
	"status" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"author_id" uuid,
	"publisher_id" uuid,
	"audience_type" text NOT NULL,
	"source_type" text NOT NULL,
	"source_uri" text,
	"source_repository" text,
	"source_commit" text,
	"source_path" text,
	"valid_until" timestamp with time zone,
	"review_after" timestamp with time zone,
	"supersedes_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "knowledge_versions_status" CHECK ("knowledge_versions"."status" in ('draft', 'published')),
	CONSTRAINT "knowledge_versions_publication_shape" CHECK (("knowledge_versions"."status" = 'draft' and "knowledge_versions"."publication" is null and "knowledge_versions"."publisher_id" is null and "knowledge_versions"."published_at" is null)
          or ("knowledge_versions"."status" = 'published' and "knowledge_versions"."publication" is not null and "knowledge_versions"."publisher_id" is not null and "knowledge_versions"."published_at" is not null)),
	CONSTRAINT "knowledge_versions_audience" CHECK ("knowledge_versions"."audience_type" in ('workspace_members', 'selected_projects')),
	CONSTRAINT "knowledge_versions_source" CHECK ("knowledge_versions"."source_type" in ('native', 'import'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_audience_projects" ADD CONSTRAINT "knowledge_audience_projects_version_id_knowledge_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."knowledge_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_audience_projects" ADD CONSTRAINT "knowledge_audience_projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_audience_projects" ADD CONSTRAINT "knowledge_audience_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_contexts" ADD CONSTRAINT "knowledge_contexts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_contexts" ADD CONSTRAINT "knowledge_contexts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_contexts" ADD CONSTRAINT "knowledge_contexts_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_contexts" ADD CONSTRAINT "knowledge_contexts_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_current_version_id_knowledge_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."knowledge_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_draft_version_id_knowledge_versions_id_fk" FOREIGN KEY ("draft_version_id") REFERENCES "public"."knowledge_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_receipts" ADD CONSTRAINT "knowledge_receipts_context_id_knowledge_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."knowledge_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_receipts" ADD CONSTRAINT "knowledge_receipts_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_receipts" ADD CONSTRAINT "knowledge_receipts_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_receipts" ADD CONSTRAINT "knowledge_receipts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_publisher_id_users_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_supersedes_version_id_knowledge_versions_id_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."knowledge_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_audience_team_project" ON "knowledge_audience_projects" USING btree ("team_id","project_id","version_id");--> statement-breakpoint
CREATE INDEX "knowledge_contexts_team_created" ON "knowledge_contexts" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_items_team_key" ON "knowledge_items" USING btree ("team_id","stable_key");--> statement-breakpoint
CREATE INDEX "knowledge_items_team_state" ON "knowledge_items" USING btree ("team_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "knowledge_receipts_context" ON "knowledge_receipts" USING btree ("context_id","served_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_versions_item_revision" ON "knowledge_versions" USING btree ("item_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_versions_item_publication" ON "knowledge_versions" USING btree ("item_id","publication") WHERE publication is not null;--> statement-breakpoint
CREATE INDEX "knowledge_versions_team_status" ON "knowledge_versions" USING btree ("team_id","status","published_at");