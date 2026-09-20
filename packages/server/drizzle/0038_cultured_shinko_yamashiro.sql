CREATE TABLE "agent_read_state" (
	"token_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_read_state_token_id_session_id_pk" PRIMARY KEY("token_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "agent_read_state" ADD CONSTRAINT "agent_read_state_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_read_state" ADD CONSTRAINT "agent_read_state_session_id_debug_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."debug_sessions"("id") ON DELETE cascade ON UPDATE no action;