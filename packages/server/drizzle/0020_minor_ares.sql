WITH "ranked_active_flows" AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "team_id", "project_id"
		ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
	) AS "scope_rank"
	FROM "delivery_flows"
	WHERE "status" = 'active'
)
UPDATE "delivery_flows"
SET "status" = 'archived', "updated_at" = now()
WHERE "id" IN (
	SELECT "id" FROM "ranked_active_flows" WHERE "scope_rank" > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_flows_active_scope" ON "delivery_flows" USING btree ("team_id",coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "delivery_flows"."status" = 'active';
