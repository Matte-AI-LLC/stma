CREATE TABLE "handoff_requests" (
	"token_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"session_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoff_requests_token_id_request_key_pk" PRIMARY KEY("token_id","request_key")
);
--> statement-breakpoint
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_session_id_debug_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."debug_sessions"("id") ON DELETE cascade ON UPDATE no action;