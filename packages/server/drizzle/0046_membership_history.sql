CREATE TABLE "membership_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"team_slug" text NOT NULL,
	"action" text NOT NULL,
	"subject_id" uuid,
	"subject_label" text,
	"previous_role" text,
	"next_role" text,
	"source" text NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"route" text NOT NULL,
	"left_ownerless" boolean DEFAULT false NOT NULL,
	"group_id" uuid,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_changes_at" ON "membership_changes" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "membership_changes_team" ON "membership_changes" USING btree ("team_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "membership_changes_subject" ON "membership_changes" USING btree ("subject_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "membership_changes_group" ON "membership_changes" USING btree ("group_id");