ALTER TABLE "agent_enrollments" ADD COLUMN "companion_of" uuid;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD COLUMN "companion_of" uuid;--> statement-breakpoint
ALTER TABLE "agent_enrollments" ADD CONSTRAINT "agent_enrollments_companion_of_agent_installations_id_fk" FOREIGN KEY ("companion_of") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_companion_of_agent_installations_id_fk" FOREIGN KEY ("companion_of") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_installations_companion" ON "agent_installations" USING btree ("companion_of") WHERE companion_of is not null;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_companion_not_self" CHECK ("agent_installations"."companion_of" is null or "agent_installations"."companion_of" <> "agent_installations"."id");--> statement-breakpoint
-- Adapters activated before this migration carry nothing that says they are
-- adapters: the installation row is identical to an MCP agent's, and only the
-- OAuth client it was issued to tells them apart. New ones are marked at
-- redemption; these are marked here, from the same fact, so the owner can pair
-- an existing adapter on Agent connections without activating it again (which
-- would mint a second installation to deliver a label). A live adapter always
-- holds one unrotated refresh grant, so the join finds every one still in use.
-- Nothing is paired by this: which agent an adapter sits beside is the owner's
-- call, and a guess from two similar names is how the wrong agent gets blamed.
UPDATE "agent_installations" AS i
SET "capabilities" = i."capabilities" || '["local-adapter"]'::jsonb
WHERE NOT (i."capabilities" @> '["local-adapter"]'::jsonb)
  AND EXISTS (
    SELECT 1
    FROM "oauth_refresh_tokens" r
    JOIN "oauth_clients" c ON c."id" = r."client_id"
    WHERE r."token_id" = i."token_id"
      AND c."client_name" LIKE 'STMA local adapter (%'
  );