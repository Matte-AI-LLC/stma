import { and, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod/v3';
import { loginRedirect } from '../auth/session';
import {
  projects,
  providerObservations,
  repositoryBindings,
  teamIntegrations,
  teams,
} from '../db/schema';
import { teamForUser } from '../domain/access';
import { integrationFor, removeIntegration } from '../domain/integrations';
import { recordProviderObservation } from '../domain/providerEvidence';
import { observeAdoBuild } from '../domain/adoEvidence';
import { readGithubRepository, readGithubWorkflow, normalizeRepo } from '../lib/github';
import { RepositoryFlow } from '../ui/RepositoryFlow';
import { track } from '../lib/track';
import type { AppEnv } from '../types';
import { effectiveLimits } from '../lib/entitlements';
import { checkAdoConnection, parseAdoLocator } from '../lib/azureDevops';
import { ensureRail } from '../lib/rail';

export const repositoriesRoutes = new Hono<AppEnv>();
async function renderRepositories(
  c: Context<AppEnv>,
  options: { error?: string; values?: Record<string, string> } = {},
) {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug')!);
  if (!access) return c.notFound();
  await ensureRail(db, user, access.team.slug);
  const connections = await db
    .select({
      id: teamIntegrations.id,
      repo: teamIntegrations.repo,
      provider: teamIntegrations.provider,
    })
    .from(teamIntegrations)
    .where(eq(teamIntegrations.teamId, access.team.id));
  const bindings = await db
    .select()
    .from(repositoryBindings)
    .where(eq(repositoryBindings.teamId, access.team.id));
  const projectList = await db.select().from(projects).where(eq(projects.teamId, access.team.id));
  const facts = await db
    .select({ fact: providerObservations, repo: repositoryBindings.fullName })
    .from(providerObservations)
    .innerJoin(repositoryBindings, eq(repositoryBindings.id, providerObservations.bindingId))
    .where(eq(repositoryBindings.teamId, access.team.id))
    .orderBy(desc(providerObservations.receivedAt))
    .limit(20);
  return c.html(
    <RepositoryFlow
      user={user}
      slug={access.team.slug}
      owner={access.role === 'owner'}
      connections={connections}
      bindings={bindings}
      projectList={projectList}
      facts={facts}
      selectedId={options.values?.binding ?? c.req.query('binding')}
      error={options.error ?? c.req.query('error')}
      values={options.values}
    />,
  );
}
repositoriesRoutes.get('/app/teams/:slug/repositories', (c) => renderRepositories(c));
repositoriesRoutes.post('/app/teams/:slug/repositories/:action', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const body = await c.req.parseBody();
  const fail = (error: string, status: 400 | 403 | 409 = 400) => {
    c.status(status);
    return renderRepositories(c, {
      error,
      values: Object.fromEntries(
        ['binding', 'connection', 'project', 'repo', 'run'].map((key) => [
          key,
          String(body[key] ?? '').slice(0, 200),
        ]),
      ),
    });
  };
  const back = () => c.redirect(`/app/teams/${access.team.slug}/repositories`, 303);
  if (c.req.param('action') === 'verify') {
    const parsed = z
      .object({
        binding: z.string().uuid(),
        run: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .safeParse(body);
    if (!parsed.success)
      return fail('Select a binding and numeric workflow run ID. Your input is preserved.');
    const [binding] = await db
      .select()
      .from(repositoryBindings)
      .where(
        and(
          eq(repositoryBindings.id, parsed.data.binding),
          eq(repositoryBindings.teamId, access.team.id),
        ),
      );
    if (!binding) return c.notFound();
    if (binding.provider === 'azure-devops') {
      const observation = await observeAdoBuild(
        db,
        c.get('env'),
        access.team.id,
        binding.id,
        parsed.data.run,
      );
      if (!observation.recorded && observation.reason !== 'duplicate')
        return fail(
          `No new evidence recorded (${observation.reason}). Existing observations are unchanged.`,
          409,
        );
      return back();
    }
    if (binding.provider !== 'github') return c.notFound();
    const [connection] = await db
      .select()
      .from(teamIntegrations)
      .where(
        and(
          eq(teamIntegrations.id, binding.connectionId),
          eq(teamIntegrations.teamId, access.team.id),
        ),
      );
    const config =
      connection && (await integrationFor(db, access.team.id, 'github', connection.repo));
    if (!config)
      return fail('Connection unavailable. Update the provider connection and retry.', 409);
    const result = await readGithubWorkflow(
      c.get('env'),
      { ...config, repo: binding.fullName },
      parsed.data.run,
    );
    if (
      !result.ok ||
      String(result.value.repository?.id) !== binding.repositoryId ||
      result.value.id !== parsed.data.run
    )
      return fail(
        'Provider identity or access could not be verified; result remains unknown.',
        409,
      );
    const wr = result.value;
    const observation = await recordProviderObservation(db, access.team.id, 'github', {
      repositoryId: binding.repositoryId,
      deliveryId: `read:${wr.id}:${wr.run_attempt}:${wr.updated_at}`,
      subjectId: `workflow:${wr.id}`,
      commitSha: wr.head_sha,
      kind: 'workflow',
      state: ['success', 'failure'].includes(wr.conclusion ?? '') ? wr.conclusion : 'unknown',
      attempt: wr.run_attempt,
      observedAt: wr.updated_at,
    });
    if (!observation.recorded && observation.reason !== 'duplicate')
      return fail(
        `No new evidence recorded (${observation.reason}). Return to Repository connections to inspect the existing facts.`,
        409,
      );
    return back();
  }
  if (access.role !== 'owner') return c.notFound();
  if (c.req.param('action') === 'rebind') {
    const parsed = z
      .object({
        binding: z.string().uuid(),
        project: z.string().uuid(),
        expectedProject: z.union([z.string().uuid(), z.literal('')]),
      })
      .safeParse(body);
    if (!parsed.success) return fail('Select a binding and project.');
    if ((await effectiveLimits(db, access.team, c.get('env').hosted)).readOnly)
      return fail('Evaluation ended. Existing bindings remain readable.', 403);
    const changed = await db.transaction(async (tx) => {
      await tx
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, access.team.id))
        .for('update');
      const [binding] = await tx
        .select()
        .from(repositoryBindings)
        .where(
          and(
            eq(repositoryBindings.id, parsed.data.binding),
            eq(repositoryBindings.teamId, access.team.id),
          ),
        )
        .for('update');
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, parsed.data.project), eq(projects.teamId, access.team.id)));
      if (!binding || !project || (binding.projectId ?? '') !== parsed.data.expectedProject)
        return false;
      await tx
        .update(repositoryBindings)
        .set({ projectId: project.id })
        .where(eq(repositoryBindings.id, binding.id));
      await track(tx as unknown as typeof db, {
        teamId: access.team.id,
        projectId: project.id,
        userId: user.id,
        action: 'repository_binding_changed',
        detail: `${binding.id}: ${binding.projectId ?? 'none'} -> ${project.id}`,
      });
      return true;
    });
    return changed
      ? back()
      : c.redirect(
          `/app/teams/${access.team.slug}/repositories?error=${encodeURIComponent('Binding changed since you loaded it, or the project is unavailable. Refresh and review before retrying.')}`,
          303,
        );
  }
  if (c.req.param('action') === 'disconnect') {
    if (!z.string().uuid().safeParse(body.id).success) return c.notFound();
    const [connection] = await db
      .select()
      .from(teamIntegrations)
      .where(
        and(eq(teamIntegrations.id, String(body.id)), eq(teamIntegrations.teamId, access.team.id)),
      );
    if (!connection) return c.notFound();
    await removeIntegration(
      db,
      access.team.id,
      connection.provider as 'github' | 'azure-devops' | 'jira',
      connection.repo,
    );
    return back();
  }
  if (c.req.param('action') !== 'bind') return c.notFound();
  const parsed = z
    .object({
      connection: z.string().uuid(),
      project: z.string().uuid(),
      repo: z.string().max(200),
    })
    .safeParse(body);
  if (!parsed.success)
    return fail('Select a connection, repository and existing project. Your input is preserved.');
  const limits = await effectiveLimits(db, access.team, c.get('env').hosted);
  if (limits.readOnly)
    return fail(
      'Evaluation ended. Existing bindings remain readable; upgrade explicitly to add new bindings.',
      403,
    );
  const [connection] = await db
    .select()
    .from(teamIntegrations)
    .where(
      and(
        eq(teamIntegrations.id, parsed.data.connection),
        eq(teamIntegrations.teamId, access.team.id),
      ),
    );
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, parsed.data.project), eq(projects.teamId, access.team.id)));
  const repo =
    connection?.provider === 'azure-devops'
      ? parseAdoLocator(parsed.data.repo)
        ? parsed.data.repo
        : null
      : normalizeRepo(parsed.data.repo);
  if (!connection || !project || !repo)
    return fail(
      'Choose an available connection, project and correctly formatted repository. Your input is preserved.',
    );
  if (!['github', 'azure-devops'].includes(connection.provider))
    return fail('This provider does not bind repositories.');
  const provider = connection.provider as 'github' | 'azure-devops';
  const config = await integrationFor(db, access.team.id, provider, connection.repo);
  if (!config)
    return fail('Connection unavailable. Update the provider connection and retry.', 409);
  const ado =
    provider === 'azure-devops'
      ? await checkAdoConnection(c.get('env'), { ...parseAdoLocator(repo)!, token: config.token })
      : null;
  const identity = ado
    ? ado.ok
      ? { ok: true as const, value: { id: ado.value.repoId, fullName: repo } }
      : { ok: false as const, error: 'Azure DevOps repository could not be verified.' }
    : await readGithubRepository(c.get('env'), { ...config, repo });
  if (!identity.ok) return fail(identity.error, 409);
  const result = await db.transaction(async (tx) => {
    await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, access.team.id)).for('update');
    const existing = await tx
      .select()
      .from(repositoryBindings)
      .where(eq(repositoryBindings.teamId, access.team.id));
    const same = existing.find(
      (b) => b.provider === provider && b.repositoryId === identity.value.id,
    );
    if (same)
      return same.projectId === project.id && same.connectionId === connection.id
        ? 'ok'
        : 'Repository already bound. Review the existing mapping; it was not overwritten.';
    if (limits.maxIntegrations !== null && existing.length >= limits.maxIntegrations)
      return 'Repository binding limit reached.';
    await tx.insert(repositoryBindings).values({
      connectionId: connection.id,
      teamId: access.team.id,
      projectId: project.id,
      provider,
      repositoryId: identity.value.id,
      fullName: identity.value.fullName,
      verifiedAt: new Date(),
    });
    return 'ok';
  });
  return result === 'ok' ? back() : fail(result, 409);
});
