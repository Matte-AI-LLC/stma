CREATE TABLE "work_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"spec_revision" integer NOT NULL,
	"delivery_id" uuid NOT NULL,
	"evidence_manifest" jsonb NOT NULL,
	"evidence_manifest_hash" text NOT NULL,
	"evidence_epoch" bigint NOT NULL,
	"decision" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"actor_scope_snapshot" jsonb NOT NULL,
	"policy_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_acceptances_decision" CHECK ("work_acceptances"."decision" in ('accept', 'request_changes'))
);
--> statement-breakpoint
CREATE TABLE "work_blockers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" uuid,
	"reason" text NOT NULL,
	"next_action" text NOT NULL,
	"source_ref" text DEFAULT '' NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_kind" text,
	"resolved_by_id" uuid,
	"resolution_reason" text
);
--> statement-breakpoint
CREATE TABLE "work_commands" (
	"principal_kind" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"canonical_hash" text NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"result_ref" uuid,
	"result_version" bigint,
	"scope_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_commands_principal_kind_principal_id_request_id_pk" PRIMARY KEY("principal_kind","principal_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "work_context_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"bytes" integer NOT NULL,
	"incomplete" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_criteria" (
	"work_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"criterion_id" text NOT NULL,
	"text" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"evidence_kinds" jsonb NOT NULL,
	"verification_rule" jsonb NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "work_criteria_work_id_revision_criterion_id_pk" PRIMARY KEY("work_id","revision","criterion_id")
);
--> statement-breakpoint
CREATE TABLE "work_cursor_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"spec_revision" integer NOT NULL,
	"sequence" integer NOT NULL,
	"artifacts" jsonb NOT NULL,
	"artifact_set_hash" text NOT NULL,
	"run_id" uuid,
	"note" text,
	"submitted_by_kind" text NOT NULL,
	"submitted_by_id" uuid NOT NULL,
	"submitted_by_user_id" uuid,
	"supersedes_delivery_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_dependencies" (
	"work_id" uuid NOT NULL,
	"depends_on_id" uuid NOT NULL,
	"required_spec_revision" integer,
	"kind" text DEFAULT 'blocks' NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_dependencies_work_id_depends_on_id_pk" PRIMARY KEY("work_id","depends_on_id"),
	CONSTRAINT "work_dependencies_not_self" CHECK ("work_dependencies"."work_id" <> "work_dependencies"."depends_on_id"),
	CONSTRAINT "work_dependencies_kind" CHECK ("work_dependencies"."kind" = 'blocks')
);
--> statement-breakpoint
CREATE TABLE "work_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_seq" bigint NOT NULL,
	"work_id" uuid NOT NULL,
	"work_version" bigint NOT NULL,
	"type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"actor_user_id" uuid,
	"payload" jsonb NOT NULL,
	"filter_before" jsonb,
	"filter_after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"spec_revision" integer NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_version" text,
	"assertion" text NOT NULL,
	"excerpt" text,
	"provenance" text NOT NULL,
	"reported_by_kind" text NOT NULL,
	"reported_by_id" uuid NOT NULL,
	"reported_by_user_id" uuid,
	"observed_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_id" uuid,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "work_evidence_assertion" CHECK ("work_evidence"."assertion" in ('pass', 'fail', 'inconclusive')),
	CONSTRAINT "work_evidence_provenance" CHECK ("work_evidence"."provenance" in ('agent_reported', 'stma_observed', 'provider_observed', 'human_decision'))
);
--> statement-breakpoint
CREATE TABLE "work_external_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid,
	"connection_locator" text NOT NULL,
	"remote_id" text NOT NULL,
	"remote_url" text,
	"mode" text NOT NULL,
	"remote_revision" text,
	"last_observed_at" timestamp with time zone,
	"snapshot" jsonb,
	"snapshot_hash" text,
	"pending_snapshot" jsonb,
	"pending_revision" text,
	"sync_state" text DEFAULT 'current' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detached_at" timestamp with time zone,
	CONSTRAINT "work_external_refs_mode" CHECK ("work_external_refs"."mode" in ('reference', 'external_authoritative', 'imported_native')),
	CONSTRAINT "work_external_refs_sync_state" CHECK ("work_external_refs"."sync_state" in ('current', 'external_change_pending', 'conflict', 'unavailable', 'detached'))
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" bigint NOT NULL,
	"display_key" text NOT NULL,
	"origin" text DEFAULT 'native' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"spec_revision" integer DEFAULT 1 NOT NULL,
	"owner_user_id" uuid,
	"acceptor_user_id" uuid,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_delivery_id" uuid,
	"current_acceptance_id" uuid,
	"evidence_epoch" bigint DEFAULT 0 NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "work_items_scope" UNIQUE("id","team_id","project_id"),
	CONSTRAINT "work_items_state" CHECK ("work_items"."state" in ('draft', 'ready', 'in_progress', 'in_review', 'accepted', 'cancelled')),
	CONSTRAINT "work_items_origin" CHECK ("work_items"."origin" in ('native', 'external')),
	CONSTRAINT "work_items_priority" CHECK ("work_items"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "work_items_created_by_kind" CHECK ("work_items"."created_by_kind" in ('human', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "work_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"run_id" uuid,
	"handoff_id" uuid,
	"knowledge_item_id" uuid,
	"spec_revision" integer,
	"created_by_kind" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by_link_id" uuid,
	"correction_reason" text,
	CONSTRAINT "work_links_kind" CHECK ("work_links"."kind" in ('run', 'assignment', 'handoff', 'knowledge')),
	CONSTRAINT "work_links_one_target" CHECK (num_nonnulls("work_links"."run_id", "work_links"."handoff_id", "work_links"."knowledge_item_id") = 1 and (
        ("work_links"."kind" = 'run' and "work_links"."run_id" is not null) or
        ("work_links"."kind" in ('assignment', 'handoff') and "work_links"."handoff_id" is not null) or
        ("work_links"."kind" = 'knowledge' and "work_links"."knowledge_item_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "work_project_counters" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"next_work_number" bigint DEFAULT 1 NOT NULL,
	"next_event_seq" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_revisions" (
	"work_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"non_goals" text NOT NULL,
	"scope" jsonb NOT NULL,
	"risk_tier" text NOT NULL,
	"artifact_kind" text,
	"context_refs" jsonb NOT NULL,
	"acceptance_policy" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"source" text DEFAULT 'native' NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_revisions_work_id_revision_pk" PRIMARY KEY("work_id","revision"),
	CONSTRAINT "work_revisions_source" CHECK ("work_revisions"."source" in ('native', 'external'))
);
--> statement-breakpoint
CREATE TABLE "work_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"filter_fingerprint" text NOT NULL,
	"scope_fingerprint" text NOT NULL,
	"as_of_seq" bigint NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "rotated_to_run_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_observations" ADD COLUMN "subject_name" text;--> statement-breakpoint
ALTER TABLE "provider_observations" ADD COLUMN "subject_definition" text;--> statement-breakpoint
ALTER TABLE "work_acceptances" ADD CONSTRAINT "work_acceptances_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_acceptances" ADD CONSTRAINT "work_acceptances_delivery_id_work_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."work_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_acceptances" ADD CONSTRAINT "work_acceptances_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_blockers" ADD CONSTRAINT "work_blockers_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_blockers" ADD CONSTRAINT "work_blockers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_commands" ADD CONSTRAINT "work_commands_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_commands" ADD CONSTRAINT "work_commands_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_reads" ADD CONSTRAINT "work_context_reads_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_reads" ADD CONSTRAINT "work_context_reads_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_criteria" ADD CONSTRAINT "work_criteria_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_deliveries" ADD CONSTRAINT "work_deliveries_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_deliveries" ADD CONSTRAINT "work_deliveries_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_deliveries" ADD CONSTRAINT "work_deliveries_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_deliveries" ADD CONSTRAINT "work_deliveries_supersedes_delivery_id_work_deliveries_id_fk" FOREIGN KEY ("supersedes_delivery_id") REFERENCES "public"."work_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_dependencies" ADD CONSTRAINT "work_dependencies_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_dependencies" ADD CONSTRAINT "work_dependencies_depends_on_id_work_items_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_delivery_id_work_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."work_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_supersedes_id_work_evidence_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."work_evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_external_refs" ADD CONSTRAINT "work_external_refs_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_external_refs" ADD CONSTRAINT "work_external_refs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_external_refs" ADD CONSTRAINT "work_external_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_external_refs" ADD CONSTRAINT "work_external_refs_connection_id_team_integrations_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."team_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_acceptor_user_id_users_id_fk" FOREIGN KEY ("acceptor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_current_delivery_id_work_deliveries_id_fk" FOREIGN KEY ("current_delivery_id") REFERENCES "public"."work_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_current_acceptance_id_work_acceptances_id_fk" FOREIGN KEY ("current_acceptance_id") REFERENCES "public"."work_acceptances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_handoff_id_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_superseded_by_link_id_work_links_id_fk" FOREIGN KEY ("superseded_by_link_id") REFERENCES "public"."work_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_work_scope_fk" FOREIGN KEY ("work_id","team_id","project_id") REFERENCES "public"."work_items"("id","team_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_project_counters" ADD CONSTRAINT "work_project_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_project_counters" ADD CONSTRAINT "work_project_counters_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_revisions" ADD CONSTRAINT "work_revisions_work_id_work_items_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_revisions" ADD CONSTRAINT "work_revisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_snapshots" ADD CONSTRAINT "work_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_acceptances_work" ON "work_acceptances" USING btree ("work_id","created_at");--> statement-breakpoint
CREATE INDEX "work_blockers_work" ON "work_blockers" USING btree ("work_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_blockers_open_source" ON "work_blockers" USING btree ("work_id","kind","source_ref") WHERE resolved_at is null and source_ref <> '';--> statement-breakpoint
CREATE INDEX "work_commands_work" ON "work_commands" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "work_context_reads_work" ON "work_context_reads" USING btree ("work_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_deliveries_work_sequence" ON "work_deliveries" USING btree ("work_id","sequence");--> statement-breakpoint
CREATE INDEX "work_deliveries_work_revision" ON "work_deliveries" USING btree ("work_id","spec_revision");--> statement-breakpoint
CREATE INDEX "work_dependencies_upstream" ON "work_dependencies" USING btree ("depends_on_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_events_project_seq" ON "work_events" USING btree ("project_id","project_seq");--> statement-breakpoint
CREATE INDEX "work_events_work" ON "work_events" USING btree ("work_id","project_seq");--> statement-breakpoint
CREATE INDEX "work_evidence_delivery" ON "work_evidence" USING btree ("delivery_id","criterion_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_external_refs_remote" ON "work_external_refs" USING btree ("team_id","provider","connection_locator","remote_id") WHERE detached_at is null;--> statement-breakpoint
CREATE INDEX "work_external_refs_work" ON "work_external_refs" USING btree ("work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_project_number" ON "work_items" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "work_items_project_state" ON "work_items" USING btree ("project_id","state","updated_at","id");--> statement-breakpoint
CREATE INDEX "work_items_team_updated" ON "work_items" USING btree ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX "work_links_work" ON "work_links" USING btree ("work_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "work_links_active_run" ON "work_links" USING btree ("run_id") WHERE run_id is not null and superseded_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "work_links_active_handoff" ON "work_links" USING btree ("handoff_id") WHERE handoff_id is not null and superseded_at is null;--> statement-breakpoint
CREATE INDEX "work_snapshots_expires" ON "work_snapshots" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_rotated_to_run_id_agent_runs_id_fk" FOREIGN KEY ("rotated_to_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;