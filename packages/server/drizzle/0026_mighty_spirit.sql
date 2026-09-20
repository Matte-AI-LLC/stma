CREATE TABLE "delivery_setup_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setup_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"token_id" uuid,
	"digest" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_setup_receipts_digest_unique" UNIQUE("digest")
);
--> statement-breakpoint
CREATE TABLE "delivery_setups" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_setup_receipts" ADD CONSTRAINT "delivery_setup_receipts_setup_id_delivery_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."delivery_setups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_setup_receipts" ADD CONSTRAINT "delivery_setup_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_setup_receipts" ADD CONSTRAINT "delivery_setup_receipts_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_setups" ADD CONSTRAINT "delivery_setups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_setups" ADD CONSTRAINT "delivery_setups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;