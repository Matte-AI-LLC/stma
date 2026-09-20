ALTER TABLE "knowledge_items" DROP CONSTRAINT "knowledge_items_state";--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD COLUMN "source_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD COLUMN "source_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD COLUMN "conflicts_with_version_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD COLUMN "conflict_reason" text;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD COLUMN "conflict_detected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD COLUMN "conflict_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_conflicts_with_version_id_knowledge_versions_id_fk" FOREIGN KEY ("conflicts_with_version_id") REFERENCES "public"."knowledge_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_state" CHECK ("knowledge_items"."state" in ('active', 'archived', 'withdrawn', 'deleted'));--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_conflict_shape" CHECK (("knowledge_versions"."conflicts_with_version_id" is null and "knowledge_versions"."conflict_reason" is null and "knowledge_versions"."conflict_detected_at" is null)
          or ("knowledge_versions"."conflicts_with_version_id" is not null and "knowledge_versions"."conflict_reason" is not null and "knowledge_versions"."conflict_detected_at" is not null));