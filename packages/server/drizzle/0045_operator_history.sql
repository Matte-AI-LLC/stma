CREATE TABLE "ceiling_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"team_slug" text NOT NULL,
	"field" text NOT NULL,
	"previous" text,
	"next" text,
	"source" text NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"route" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "load_samples" (
	"instance" text NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"redirects" integer DEFAULT 0 NOT NULL,
	"client_errors" integer DEFAULT 0 NOT NULL,
	"server_errors" integer DEFAULT 0 NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"latency" jsonb NOT NULL,
	"loop_lag_max_ms" integer DEFAULT 0 NOT NULL,
	"rss_mb" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "load_samples_instance_bucket_at_pk" PRIMARY KEY("instance","bucket_at")
);
--> statement-breakpoint
ALTER TABLE "ceiling_changes" ADD CONSTRAINT "ceiling_changes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceiling_changes" ADD CONSTRAINT "ceiling_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ceiling_changes_at" ON "ceiling_changes" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ceiling_changes_team" ON "ceiling_changes" USING btree ("team_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "load_samples_bucket" ON "load_samples" USING btree ("bucket_at" DESC NULLS LAST);