import { AGENT_CLIENT_TYPES } from '@bridge/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod/v3';
import { loginRedirect } from '../auth/session';
import {
  agentEnrollments,
  agentInstallations,
  launchAttempts,
  projects,
  teams,
  tokens,
} from '../db/schema';
import { projectForTeam, teamForUser } from '../domain/access';
import { launchForViewer } from '../domain/collaboration';
import type { AppEnv } from '../types';
import { AppLayout } from '../ui/Layout';
import { launchPrompts } from '../lib/quickStart';
import { agentConnectPrompt } from '../lib/agentConnect';
import { normalizeDeviceLabel } from '../lib/devices';
import { createAgentEnrollment, revokePendingEnrollment } from '../domain/enrollments';
import { Band, Field, Inspector, PageHead, teamTrail } from '../ui/Console';
import { FlowSection, FlowSteps, Identity, ScopePill } from '../ui/ProductFlow';
import { ensureRail } from '../lib/rail';
import { sectionHref } from '../lib/scope';
import { FirstExchange } from '../ui/FirstExchange';

export const launchRoutes = new Hono<AppEnv>();
launchRoutes.get('/app/teams/:slug/setup', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const access = await teamForUser(c.get('db'), user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const [launch] = await c
    .get('db')
    .select()
    .from(launchAttempts)
    .where(and(eq(launchAttempts.userId, user.id), eq(launchAttempts.teamId, access.team.id)))
    .orderBy(desc(launchAttempts.createdAt))
    .limit(1);
  if (launch) return c.redirect(`/app/launches/${launch.id}`, 303);
  return c.html(
    <AppLayout
      user={user}
      active="setup"
      title="Connect your agents"
      head={
        <PageHead
          trail={teamTrail(access.team, { label: 'Connect & test' })}
          title="Two agents, one result"
          sub="One account. Authorize each client through the same MCP address, then run two secret-free checks."
        />
      }
    >
      <FirstExchange baseUrl={c.get('env').baseUrl} teamSlug={access.team.slug} />
    </AppLayout>,
  );
});
launchRoutes.get('/app/launches/:id/status', async (c) => {
  const user = c.get('user');
  if (!user || !z.string().uuid().safeParse(c.req.param('id')).success) return c.notFound();
  const launch = await launchForViewer(c.get('db'), c.req.param('id'), user.id);
  if (!launch) return c.notFound();
  return c.json(
    {
      first: Boolean(launch.firstConnectedAt),
      second: Boolean(launch.secondConnectedAt),
      exchanged: Boolean(launch.exchangeConfirmedAt),
    },
    200,
    { 'cache-control': 'private, no-store' },
  );
});
launchRoutes.post('/app/launches', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const body = await c.req.parseBody();
  const parsed = z
    .object({
      team: z.string().min(1).max(120),
      project: z.string().max(300).optional(),
      intent: z.enum(['my_agents', 'teammates']).default('my_agents'),
      fresh: z.string().optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.text('Select a workspace on the connection page first.', 400);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, parsed.data.team);
  if (!access) return c.notFound();
  const project = parsed.data.project
    ? await projectForTeam(db, access.team.id, parsed.data.project)
    : null;
  if (parsed.data.project && !project) return c.notFound();
  // Serialize repeated submits without keeping any enrollment code in the URL.
  const launch = await db.transaction(async (tx) => {
    await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, access.team.id)).for('update');
    const [existing] = await tx
      .select()
      .from(launchAttempts)
      .where(
        and(
          eq(launchAttempts.userId, user.id),
          eq(launchAttempts.teamId, access.team.id),
          project ? eq(launchAttempts.projectId, project.id) : isNull(launchAttempts.projectId),
          eq(launchAttempts.intent, parsed.data.intent),
        ),
      )
      .orderBy(desc(launchAttempts.createdAt))
      .limit(1);
    if (existing && parsed.data.fresh !== 'yes') return existing;
    return (
      await tx
        .insert(launchAttempts)
        .values({
          userId: user.id,
          teamId: access.team.id,
          projectId: project?.id ?? null,
          intent: parsed.data.intent,
        })
        .returning()
    )[0]!;
  });
  return c.redirect(`/app/launches/${launch.id}`, 303);
});

async function renderLaunch(
  c: Context<AppEnv>,
  options: {
    issued?: Awaited<ReturnType<typeof createAgentEnrollment>>;
    values?: { name?: string; device?: string; client?: string };
    error?: string;
  } = {},
) {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.notFound();
  const db = c.get('db');
  const launch = await launchForViewer(db, c.req.param('id')!, user.id);
  if (!launch) return c.notFound();
  const [team] = await db.select().from(teams).where(eq(teams.id, launch.teamId));
  const project = launch.projectId
    ? (await db.select().from(projects).where(eq(projects.id, launch.projectId)))[0]
    : null;
  // A launch started inside a project belongs to that project: its address names
  // neither, so the rail, the trail and the way back are told here. Without the
  // project this page drew the workspace's rail and offered "Back to workspace"
  // to somebody who had come from one project's agents.
  await ensureRail(db, user, team!.slug, project?.slug ?? null);
  const connected = Boolean(launch.exchangeConfirmedAt);
  const realResult = Boolean(launch.firstRealResultAt);
  const identities = await db
    .select({ installation: agentInstallations, credential: tokens })
    .from(agentInstallations)
    .leftJoin(tokens, eq(agentInstallations.tokenId, tokens.id))
    .where(
      inArray(
        agentInstallations.id,
        [launch.firstInstallationId, launch.secondInstallationId].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    );
  const unavailable = identities.some(
    ({ installation, credential }) => installation.revokedAt || !credential || credential.revokedAt,
  );
  const enrollmentId = options.issued?.enrollment.id ?? c.req.query('enrollment');
  const [saved] =
    enrollmentId && z.string().uuid().safeParse(enrollmentId).success
      ? await db
          .select()
          .from(agentEnrollments)
          .where(
            and(
              eq(agentEnrollments.id, enrollmentId),
              eq(agentEnrollments.userId, user.id),
              eq(agentEnrollments.teamId, launch.teamId),
              launch.projectId
                ? eq(agentEnrollments.projectId, launch.projectId)
                : isNull(agentEnrollments.projectId),
            ),
          )
      : [];
  const enrollment = options.issued?.enrollment ?? saved;
  const pending =
    enrollment &&
    !enrollment.redeemedAt &&
    !enrollment.revokedAt &&
    enrollment.expiresAt > new Date();
  const expired =
    enrollment &&
    !enrollment.redeemedAt &&
    (enrollment.revokedAt || enrollment.expiresAt <= new Date());
  const action = launch.firstConnectedAt ? 'reply' : 'send';
  const setupPrompt = options.issued
    ? agentConnectPrompt({
        baseUrl: c.get('env').baseUrl,
        enrollmentId: options.issued.enrollment.id,
        enrollmentCode: options.issued.code,
        enrollmentExpiresAt: options.issued.enrollment.expiresAt,
        scope: launch.projectId ? 'project' : 'team',
        agentName: options.issued.enrollment.name,
        deviceLabel: options.issued.enrollment.deviceLabel,
        clientType: options.issued.enrollment.clientType,
        role: 'generalist',
        teamSlug: team!.slug,
        projectName: project?.name,
        launch: { id: launch.id, action },
      })
    : undefined;
  const prompts = launchPrompts({
    baseUrl: c.get('env').baseUrl,
    launchId: launch.id,
    teamSlug: team!.slug,
    projectId: launch.projectId,
  });
  const mcpUrl = `${c.get('env').baseUrl}/mcp`;
  const current = realResult ? 4 : connected ? 3 : launch.firstConnectedAt ? 1 : 0;
  const next = unavailable
    ? 'An observed agent was revoked. Start a separate launch with a new connection.'
    : realResult
      ? 'A tracked handoff was completed. Review its evidence before treating the work as delivered.'
      : connected
        ? 'Connection works. Now complete one bounded handoff; the exchange alone is not product activation.'
      : setupPrompt
        ? 'A legacy setup prompt is ready. Prefer OAuth unless this client cannot authenticate it.'
        : launch.firstConnectedAt
          ? 'Use the reply check in a separately authorized second agent.'
          : 'Authorize the first client through OAuth if needed, then run the sender check.';
  const link = `/app/launches/${launch.id}`;
  return c.html(
    <AppLayout
      user={user}
      title="Launch your agents"
      active="setup"
      bleed
      strip={
        <>
          <span class="flow-status">Setup</span>
          <span>
            {realResult
              ? 'First real handoff completed'
              : connected
                ? 'Exchange confirmed · real task pending'
              : `${launch.firstConnectedAt ? 1 : 0} sender observed`}
          </span>
        </>
      }
      scope={<ScopePill workspace={team!.slug} project={project?.name} />}
      head={
        <PageHead
          trail={
            project
              ? teamTrail(
                  team!,
                  { label: 'Projects', href: `/app/teams/${team!.slug}/projects` },
                  { label: project.name, href: `/app/teams/${team!.slug}/projects/${encodeURIComponent(project.slug)}` },
                  { label: 'Connect & test' },
                )
              : teamTrail(team!, { label: 'Connect & test' })
          }
          title={
            realResult
              ? 'Your first tracked handoff completed'
              : connected
                ? 'Your agents exchanged a message'
                : 'Connect your agents'
          }
          sub={
            realResult
              ? 'Connection is proven and one bounded task reached a reported completion.'
              : 'First prove the connection, then complete one bounded handoff. A hello is not activation.'
          }
          actions={
            project ? (
              <a class="btn" href={sectionHref(team!.slug, project.slug, 'agents')}>
                Back to {project.name} agents
              </a>
            ) : (
              <a class="btn" href={`/app/teams/${team!.slug}`}>
                Back to workspace
              </a>
            )
          }
        />
      }
      band={
        options.error || unavailable || expired ? (
          <Band
            kind={unavailable ? 'danger' : 'warn'}
            tag={unavailable ? 'Access changed' : expired ? 'Code unavailable' : 'Check input'}
          >
            {options.error ??
              (unavailable
                ? next
                : 'This code expired or was revoked. Reissue from the same names below; no new credential was created by this page.')}
          </Band>
        ) : undefined
      }
      inspector={
        <Inspector>
          <FlowSection title="Next action">
            <p>{next}</p>
            <Identity human={user.username} />
            <p class="small">
              A teammate signs in to their own account and opens this launch link. Never share your
              credential.
            </p>
          </FlowSection>
          <FlowSection title={realResult ? 'What this result proves' : connected ? 'What this proves so far' : 'What confirmation will prove'}>
            <p>
              {realResult
                ? 'Two authenticated installation identities exchanged a message and an authenticated participant reported a tracked handoff complete.'
                : connected
                  ? 'Two authenticated installation identities exchanged a message in this exact scope; no real task is complete yet.'
                : 'Confirmation requires two authenticated installation identities to exchange a message in this exact scope.'}{' '}
              It does not prove two physical computers, provider delivery, human approval or correct code.
            </p>
          </FlowSection>
          <FlowSection title="Trail">
            <dl class="flow-facts">
              <dt>Started</dt>
              <dd>{launch.createdAt.toISOString()}</dd>
              <dt>Sender</dt>
              <dd>{launch.firstConnectedAt?.toISOString() ?? 'Not observed'}</dd>
              <dt>Reply</dt>
              <dd>{launch.exchangeConfirmedAt?.toISOString() ?? 'Not observed'}</dd>
            </dl>
          </FlowSection>
        </Inspector>
      }
      keysNote="Progress survives refresh · agents and devices are not seats"
    >
      <FlowSection title="Four steps to a first useful result">
        <FlowSteps
          current={current}
          steps={[
            {
              title: 'Connect the first agent',
              detail: 'Authorize it in the browser, then run the sender check.',
              at: launch.firstConnectedAt,
            },
            {
              title: 'Connect another agent',
              detail: 'The other client gets its own browser-approved installation.',
              at: launch.secondConnectedAt,
            },
            {
              title: 'Confirm the exchange',
              detail: 'The second secret-free check replies; STMA records the result.',
              at: launch.exchangeConfirmedAt,
            },
            {
              title: 'Complete one bounded handoff',
              detail: 'Offer, accept, resume and complete a real task; review evidence separately.',
              at: launch.firstRealResultAt,
            },
          ]}
        />
        {!connected && (
          <p
            data-launch-status={`${link}/status`}
            data-launch-first={String(Boolean(launch.firstConnectedAt))}
            data-launch-refresh={link}
            aria-live="polite"
          >
            {launch.firstConnectedAt ? 'Sender observed. Waiting for reply.' : 'Waiting for sender'}{' '}
            — checks run for up to two minutes while this tab is visible.
          </p>
        )}
      </FlowSection>
      {!connected && !unavailable && (
        <FlowSection title={launch.firstConnectedAt ? 'Run the reply in your second agent' : 'Run the sender check in your first agent'}>
          <p>
            Each client must already be authorized through <code>{mcpUrl}</code>. If it is not,
            open <a href={`/app/tokens?team=${encodeURIComponent(team!.slug)}${project ? `&project=${encodeURIComponent(project.slug)}` : ''}`}>Agent connections</a>,
            add that same MCP address and approve this exact scope in the STMA browser page. Then
            paste only the bounded check below into the correct connected agent. It carries a launch
            ID, not a credential, and changes no local configuration.
          </p>
          <div class="flow-actions">
            <button class="btn btn-primary" type="button" data-copy={prompts[launch.firstConnectedAt ? 'reply' : 'send']}>
              {launch.firstConnectedAt ? '2 · Copy reply check' : '1 · Copy sender check'}
            </button>
            <button class="btn" type="button" data-copy={prompts[launch.firstConnectedAt ? 'send' : 'reply']}>
              {launch.firstConnectedAt ? 'Copy sender check again' : 'Preview second-agent check'}
            </button>
          </div>
          <p class="small muted">
            STMA cannot wake either client. Open the client yourself; a successful OAuth connection
            proves identity and scope, not that this exchange or repository work happened.
          </p>
        </FlowSection>
      )}
      {!connected && !unavailable && (
        <FlowSection
          title="Legacy setup prompt (compatibility)"
        >
          <details open={Boolean(setupPrompt)}>
            <summary>Use only when this client cannot complete remote MCP OAuth</summary>
          {setupPrompt ? (
            <>
              <p>
                The one-time code is shown only now and expires at{' '}
                {enrollment!.expiresAt.toISOString()}. The prompt first discloses the external origin,
                persistent user-level configuration, exact grant, credential lifetime and revocation
                path, then waits for one explicit approval. After yes, the agent uses the embedded code
                automatically without another code-entry or method-selection step. The credential is
                returned only to the redeeming agent and stays redacted in its visible report. If
                response validation or the local config write fails after redemption, the helper
                automatically revokes that just-minted connection.
              </p>
              <div class="cmd setup-prompt">
                <code>{setupPrompt}</code>
              </div>
              <div class="flow-actions">
                <button class="btn btn-primary" type="button" data-copy={setupPrompt}>
                  Copy setup and exchange prompt
                </button>
                <a class="btn" href={`${link}?enrollment=${enrollment!.id}`}>
                  Refresh status
                </a>
              </div>
              <form method="post" action={`${link}/enrollments/${enrollment!.id}/revoke`}>
                <button class="btn" type="submit">
                  Revoke unused code
                </button>
              </form>
            </>
          ) : (
            <>
              {pending && (
                <p>
                  A code is still pending, but its secret cannot be shown again. Creating another
                  prompt revokes that unused code.
                </p>
              )}
              <form method="post" action={`${link}/enroll`}>
                {enrollment && <input type="hidden" name="replace" value={enrollment.id} />}
                <div class="flow-form-row">
                  <Field
                    id="launch-agent"
                    label="Agent name"
                    required
                    help="The identity you see on the agent map."
                  >
                    <input
                      class="in"
                      id="launch-agent"
                      name="name"
                      maxlength={80}
                      required
                      value={
                        options.values?.name ??
                        enrollment?.name ??
                        (launch.firstConnectedAt ? 'second-agent' : 'first-agent')
                      }
                    />
                  </Field>
                  <Field
                    id="launch-device"
                    label="Machine"
                    required
                    help="A label, not hardware attestation."
                  >
                    <input
                      class="in"
                      id="launch-device"
                      name="device"
                      maxlength={60}
                      required
                      value={
                        options.values?.device ??
                        enrollment?.deviceLabel ??
                        (launch.firstConnectedAt ? 'second-computer' : 'first-computer')
                      }
                    />
                  </Field>
                </div>
                <Field id="launch-client" label="Client">
                  <select class="in" id="launch-client" name="client">
                    {AGENT_CLIENT_TYPES.filter((client) => ['codex', 'claude-code', 'cursor'].includes(client)).map((client) => (
                      <option
                        value={client}
                        selected={
                          client === (options.values?.client ?? enrollment?.clientType ?? 'codex')
                        }
                      >
                        {client}
                      </option>
                    ))}
                  </select>
                </Field>
                <p class="small">
                  Enforced access: <ScopePill workspace={team!.slug} project={project?.name} />. The
                  prompt cannot broaden this scope.
                </p>
                <button class="btn btn-primary" type="submit">
                  {enrollment ? 'Reissue one-time setup prompt' : 'Create one-time setup prompt'}
                </button>
              </form>
            </>
          )}
          </details>
        </FlowSection>
      )}
      {identities.length > 0 && (
        <FlowSection title="Observed installations">
          {identities.map(({ installation, credential }) => (
            <div class="flow-record">
              <Identity
                human={installation.userId === user.id ? user.username : 'Teammate'}
                agent={installation.name}
                device={installation.deviceLabel}
              />
              <p class="small">
                {installation.revokedAt || credential?.revokedAt
                  ? 'Access revoked'
                  : 'Authenticated connection observed; running state not asserted'}{' '}
                · last seen {installation.lastSeenAt?.toISOString() ?? 'not recorded'}
              </p>
            </div>
          ))}
        </FlowSection>
      )}
      <FlowSection title={realResult ? 'Review the completed handoff' : connected ? 'Choose a real task together' : 'Recovery and connection doctor'}>
        {launch.sessionId && (
          <p>
            <a href={`/app/sessions/${launch.sessionId}`}>Open the exchange</a>
          </p>
        )}
        {connected && !realResult && (
          <p>
            Ask your agent to offer a real task using <code>handoff_work</code>. The receiver
            explicitly accepts with <code>update_handoff</code>, inspects the worktree, then
            resumes. File access and execution still need your consent.
          </p>
        )}
        {realResult && (
          <p>
            The handoff lifecycle is complete. Open the exchange and inspect its exact run,
            repository checkpoint and provider evidence before merging or deploying.
          </p>
        )}
        <details>
          <summary>Connection doctor</summary>
          <dl class="flow-facts">
            <dt>Server exchange</dt>
            <dd>{connected ? 'Confirmed' : launch.firstConnectedAt ? 'Sender only' : 'Not observed'}</dd>
            <dt>Real handoff</dt>
            <dd>{realResult ? 'Reported complete' : 'Not completed'}</dd>
            <dt>Credential health</dt>
            <dd>{unavailable ? 'Revoked or unavailable' : identities.length ? 'Active when last observed' : 'No installation observed'}</dd>
            <dt>Pending setup code</dt>
            <dd>{pending ? `Valid until ${enrollment!.expiresAt.toISOString()}` : expired ? 'Expired or revoked' : 'None'}</dd>
          </dl>
          <p>
            Expired setup code: generate a new one on Connections. Nothing appears in the agent:
            check the exact server URL and restart/reload its MCP connection. Wrong scope: use a
            separate appropriately scoped enrollment, never broaden this one. A revoked sender needs
            a new launch. STMA cannot wake a sleeping agent.
          </p>
          <p>
            Diagnostic ID: {launch.id}. This ID is not a credential; access is checked on every
            request.
          </p>
          <form method="post" action="/app/launches">
            <input type="hidden" name="team" value={team!.slug} />
            <input type="hidden" name="intent" value={launch.intent} />
            <input type="hidden" name="fresh" value="yes" />
            {launch.projectId && <input type="hidden" name="project" value={launch.projectId} />}
            <button class="btn" type="submit">
              Start a separate launch (keep existing credentials)
            </button>
          </form>
        </details>
      </FlowSection>
    </AppLayout>,
    options.error ? 400 : 200,
  );
}
launchRoutes.get('/app/launches/:id', (c) => renderLaunch(c));
launchRoutes.post('/app/launches/:id/enroll', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.notFound();
  const db = c.get('db');
  const launch = await launchForViewer(db, c.req.param('id'), user.id);
  if (!launch || launch.exchangeConfirmedAt) return c.notFound();
  const body = await c.req.parseBody();
  const values = {
    name: String(body.name ?? '')
      .trim()
      .slice(0, 80),
    device: String(body.device ?? '').slice(0, 60),
    client: String(body.client ?? 'generic'),
  };
  const device = normalizeDeviceLabel(values.device);
  const client = AGENT_CLIENT_TYPES.find((value) => value === values.client);
  if (!values.name || !device || !client)
    return renderLaunch(c, {
      values,
      error: 'Name one agent and one machine; choose a supported client. Your input is preserved.',
    });
  const issued = await db.transaction(async (tx) => {
    if (typeof body.replace === 'string' && z.string().uuid().safeParse(body.replace).success) {
      const [old] = await tx
        .select()
        .from(agentEnrollments)
        .where(
          and(
            eq(agentEnrollments.id, body.replace),
            eq(agentEnrollments.userId, user.id),
            eq(agentEnrollments.teamId, launch.teamId),
            launch.projectId
              ? eq(agentEnrollments.projectId, launch.projectId)
              : isNull(agentEnrollments.projectId),
          ),
        );
      if (old) await revokePendingEnrollment(tx as unknown as typeof db, user.id, old.id);
    }
    return createAgentEnrollment(tx as unknown as typeof db, {
      userId: user.id,
      name: values.name,
      deviceLabel: device,
      clientType: client,
      role: 'generalist',
      scope: launch.projectId ? 'project' : 'team',
      teamId: launch.teamId,
      projectId: launch.projectId ?? undefined,
    });
  });
  return renderLaunch(c, { issued });
});
launchRoutes.post('/app/launches/:id/enrollments/:enrollment/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (
    ![c.req.param('id'), c.req.param('enrollment')].every(
      (id) => z.string().uuid().safeParse(id).success,
    )
  )
    return c.notFound();
  const launch = await launchForViewer(c.get('db'), c.req.param('id'), user.id);
  if (!launch) return c.notFound();
  const [pending] = await c
    .get('db')
    .select()
    .from(agentEnrollments)
    .where(
      and(
        eq(agentEnrollments.id, c.req.param('enrollment')),
        eq(agentEnrollments.userId, user.id),
        eq(agentEnrollments.teamId, launch.teamId),
        launch.projectId
          ? eq(agentEnrollments.projectId, launch.projectId)
          : isNull(agentEnrollments.projectId),
      ),
    );
  if (!pending) return c.notFound();
  await revokePendingEnrollment(c.get('db'), user.id, c.req.param('enrollment'));
  return c.redirect(`/app/launches/${launch.id}?enrollment=${c.req.param('enrollment')}`, 303);
});
