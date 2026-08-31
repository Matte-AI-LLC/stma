CREATE TABLE "error_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text DEFAULT 'http' NOT NULL,
	"method" text,
	"path" text,
	"status" integer,
	"message" text NOT NULL,
	"stack" text,
	"user_id" text,
	"team_slug" text,
	"request_id" text
);
--> statement-breakpoint
CREATE INDEX "error_events_at" ON "error_events" USING btree ("at" DESC NULLS LAST);