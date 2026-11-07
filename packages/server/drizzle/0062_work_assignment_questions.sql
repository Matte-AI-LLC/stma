CREATE TABLE "work_assignment_questions" (
	"question_message_id" uuid PRIMARY KEY NOT NULL,
	"assignment_link_id" uuid NOT NULL,
	"recipient_installation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"first_served_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"answer_fingerprint" text,
	"reply_message_id" uuid,
	CONSTRAINT "work_assignment_questions_reply_message_id_unique" UNIQUE("reply_message_id"),
	CONSTRAINT "work_assignment_questions_request" UNIQUE("assignment_link_id","request_id"),
	CONSTRAINT "work_assignment_questions_answer" CHECK (
      ("work_assignment_questions"."answered_at" is null and "work_assignment_questions"."reply_message_id" is null and "work_assignment_questions"."answer_fingerprint" is null)
      or ("work_assignment_questions"."answered_at" is not null and "work_assignment_questions"."first_served_at" is not null and "work_assignment_questions"."answer_fingerprint" is not null)
    )
);
--> statement-breakpoint
ALTER TABLE "work_assignment_questions" ADD CONSTRAINT "work_assignment_questions_question_message_id_messages_id_fk" FOREIGN KEY ("question_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assignment_questions" ADD CONSTRAINT "work_assignment_questions_assignment_link_id_work_links_id_fk" FOREIGN KEY ("assignment_link_id") REFERENCES "public"."work_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assignment_questions" ADD CONSTRAINT "work_assignment_questions_reply_message_id_messages_id_fk" FOREIGN KEY ("reply_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_assignment_questions_pending" ON "work_assignment_questions" USING btree ("assignment_link_id","question_message_id") WHERE "work_assignment_questions"."answered_at" is null;