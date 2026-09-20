ALTER TABLE "agent_enrollments" ADD CONSTRAINT "agent_enrollments_scope_target" CHECK (("agent_enrollments"."scope" = 'personal' and "agent_enrollments"."team_id" is null and "agent_enrollments"."project_id" is null)
          or ("agent_enrollments"."scope" = 'team' and "agent_enrollments"."team_id" is not null and "agent_enrollments"."project_id" is null)
          or ("agent_enrollments"."scope" = 'project' and "agent_enrollments"."team_id" is not null and "agent_enrollments"."project_id" is not null));--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_scope_target" CHECK (("tokens"."scope" = 'personal' and "tokens"."team_id" is null and "tokens"."project_id" is null)
          or ("tokens"."scope" = 'team' and "tokens"."team_id" is not null and "tokens"."project_id" is null)
          or ("tokens"."scope" = 'project' and "tokens"."team_id" is not null and "tokens"."project_id" is not null));