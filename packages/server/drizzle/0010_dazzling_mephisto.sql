CREATE TABLE "auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_codes_user_purpose" ON "auth_codes" USING btree ("user_id","purpose");--> statement-breakpoint
-- Email becomes the login identity: normalize what is already stored so the
-- unique index below sees one canonical form (lib/email.normalizeEmail).
UPDATE "users" SET "email" = lower(btrim("email")) WHERE "email" IS NOT NULL;--> statement-breakpoint
-- Keep the oldest holder of a duplicate address and clear the others, so the
-- index applies on any existing database. A cleared account signs in again once
-- an operator sets its email in /admin/users.
UPDATE "users" SET "email" = NULL WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (PARTITION BY "email" ORDER BY "created_at", "id") AS rn
		FROM "users" WHERE "email" IS NOT NULL
	) dupes WHERE dupes.rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email") WHERE email is not null;