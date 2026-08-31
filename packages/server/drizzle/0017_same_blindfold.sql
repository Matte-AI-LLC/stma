CREATE TABLE "saving_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"run_id" uuid,
	"confirmed_by" uuid,
	"helpful" boolean NOT NULL,
	"changed_behaviour" boolean DEFAULT false NOT NULL,
	"minutes_saved" integer,
	"spend_stopped" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "hourly_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "saving_confirmations" ADD CONSTRAINT "saving_confirmations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saving_confirmations" ADD CONSTRAINT "saving_confirmations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saving_confirmations" ADD CONSTRAINT "saving_confirmations_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saving_confirmations_ref_idx" ON "saving_confirmations" USING btree ("kind","ref_id");--> statement-breakpoint
CREATE INDEX "saving_confirmations_team_idx" ON "saving_confirmations" USING btree ("team_id","created_at");