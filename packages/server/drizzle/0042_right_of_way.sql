ALTER TABLE "work_claims" ADD COLUMN "first_declared_at" timestamp with time zone;--> statement-breakpoint
-- Claims held while this migration runs were declared no later than their row was
-- last written, which is the best the old shape can say. Without it every live
-- claim would read as "declared by nobody first" and two runs on one file would
-- keep stopping each other until both restated their scope. Additive and
-- idempotent: an older binary ignores the column.
UPDATE "work_claims" SET "first_declared_at" = "created_at" WHERE "first_declared_at" IS NULL;
