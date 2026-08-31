ALTER TABLE "snapshots" ADD COLUMN "device_label" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
-- Backfill: rows pushed before the personal-fleet change keep a recognizable
-- device slot by adopting the name of the token that pushed them ("one token per
-- machine" is the documented convention). Mirrors normalizeDeviceLabel() in
-- src/lib/devices.ts; anything unusable stays 'default'.
UPDATE "snapshots" SET "device_label" = coalesce(nullif(btrim(left(regexp_replace(lower(btrim("tokens"."name")), '[^a-z0-9._-]+', '-', 'g'), 40), '-._'), ''), 'default') FROM "tokens" WHERE "snapshots"."token_id" = "tokens"."id";--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_device_id_agent_installations_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshots_team_user_device_created" ON "snapshots" USING btree ("team_id","user_id","device_label","created_at");
