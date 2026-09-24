ALTER TABLE "invites" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD COLUMN "member_joined" boolean DEFAULT true NOT NULL;