CREATE TABLE "authenticator_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject_id" uuid,
	"actor_id" uuid,
	"actor_label" text NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authenticator_resets" ADD CONSTRAINT "authenticator_resets_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticator_resets" ADD CONSTRAINT "authenticator_resets_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authenticator_resets_subject" ON "authenticator_resets" USING btree ("subject_id","at");--> statement-breakpoint
CREATE INDEX "authenticator_resets_at" ON "authenticator_resets" USING btree ("at");