import { AGENT_CLIENT_TYPES, AGENT_ROLES, type AgentClientType } from '@bridge/shared';
import { and, count, desc, eq, gt, inArray, isNull, max, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { Db } from '../db';
import {
  agentEnrollments,
  agentInstallations,
  launchAttempts,
  memberships,
  projects,
  snapshots,
  teams,
  tokens,
} from '../db/schema';
import { generatePat } from '../auth/pat';
import { loginRedirect } from '../auth/session';
import { projectForTeam, teamForUser } from '../domain/access';
import { revokeAgentInstallation } from '../domain/agents';
import { launchForViewer } from '../domain/collaboration';
import { connectionPairings, setCompanion, type ConnectionPairing } from '../domain/companions';
import { connectCommandFor, readConnectRequest } from '../domain/connectRequests';
import {
  AGENT_ENROLLMENT_TTL_MINUTES,
  TERMINAL_CONNECT_TTL_MINUTES,
  createAgentEnrollment,
  revokePendingEnrollment,
} from '../domain/enrollments';
import { agentConnectPrompt } from '../lib/agentConnect';
import { fmtDate, timeAgo } from '../lib/format';
import { grantLabel, type TokenScope } from '../lib/grants';
import { isCanonicalUuid } from '../lib/ids';
import { logLine } from '../lib/log';
import { mcpConnectPrompt, mcpServerAlias } from '../lib/mcpConnectPrompt';
import { launchPrompts } from '../lib/quickStart';
import { ensureRail } from '../lib/rail';
import { connectionsHref, sectionHref } from '../lib/scope';
import { membershipUser } from '../lib/securityHooks';
import type { AppEnv, User } from '../types';
import { ConnectCheckoutForm, ConnectCommand } from '../ui/ConnectAgent';
import { Band, PageHead, teamTrail, type Crumb } from '../ui/Console';
import { FirstExchange } from '../ui/FirstExchange';
import { AppLayout } from '../ui/Layout';
import { FlowSteps, Identity } from '../ui/ProductFlow';

/**
 * Agent connections: one page, inside a workspace.
 *
 * There were two connect screens and neither was inside the workspace it
 * connected to (the owner, 2026-09-27). "Agent connections" was an account page
 * that listed every workspace's projects in one picker, offered a Personal
 * connection reaching all of them, and was linked from a workspace's rail with a
 * `?team=` filter; "Connect & test" was a second page per workspace with its own
 * copy of the legacy prompt and the first-exchange card the first page also
 * carried. A project's Agents page held a third copy of the connect form.
 *
 * Now a connection is made where it will work. `/app/teams/:slug/connections`
 * connects to the workspace or one of its projects; the same handler answers
 * `/app/teams/:slug/projects/:project/connections`, where every choice is that
 * project and the page stays inside it. Three sections, in the order a person
 * needs them: connect an agent, test two of them together, and the caller's own
 * connections that can work here.
 *
 * The old addresses keep answering. `/app/tokens` is a door that takes a person
 * to their workspace's page (or asks which one), because it is in agents'
 * refusals, in the CLI's output and in emails already sent. `/setup` and
 * `/app/launches/:id` land on the Test section of the right scope.
 *
 * Writes still go through the doors they always did, outside `/app/teams/`:
 * `POST /app/tokens` issues a connection, `POST /app/launches` starts a test.
 * The identity layer checks a managed workspace's roles at those doors, when the
 * enrollment is issued, and a new address would have been a second policy for
 * the same act.
 */
export const connectionsRoutes = new Hono<AppEnv>();

/** A bound on one person's list, not a plan ceiling: their own connections here. */
const CONNECTION_ROWS = 300;
const PENDING_ROWS = 50;
/** Local-adapter commands are per project; past this the page links to Projects. */
const ADAPTER_PROJECT_LINKS = 12;

type Workspace = { id: string; slug: string; name: string; role: string };
type ProjectRef = { id: string; slug: string; name: string };
type Launch = typeof launchAttempts.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;

interface Scope {
  team: Workspace;
  project: ProjectRef | null;
  /** Every project of the workspace, for the pickers. */
  projects: ProjectRef[];
}

/** What `POST /app/tokens` hands back to the page it answers with. */
interface Answer {
  issued?: {
    enrollment: typeof agentEnrollments.$inferSelect;
    code: string;
    terminal: boolean;
    /** Null for a personal grant, which only the older direct-POST contract can ask for. */
    team: Workspace | null;
    project: ProjectRef | null;
  };
  refused?: { error: string; terminal: boolean; typed: Record<string, unknown> };
  /** Deprecated direct-POST compatibility; no form on the page submits this. */
  legacyToken?: string;
}

const typedString = (typed: Record<string, unknown> | undefined, key: string) =>
  typed && typeof typed[key] === 'string' ? (typed[key] as string) : undefined;

async function workspaceProjects(db: Db, teamId: string): Promise<ProjectRef[]> {
  return db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(eq(projects.teamId, teamId))
    .orderBy(projects.name);
}

async function memberWorkspaces(db: Db, userId: string): Promise<Workspace[]> {
  return db
    .select({ id: teams.id, slug: teams.slug, name: teams.name, role: memberships.role })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(membershipUser(userId))
    .orderBy(teams.name);
}

/**
 * The caller's own connections that can work in this scope: bound to it, bound
 * to the whole workspace, or an older personal one that reaches every workspace
 * the person is in. Other people's agents are on People and agents.
 */
function reachesHere(teamId: string, projectId: string | null) {
  return or(
    eq(tokens.scope, 'personal'),
    projectId
      ? and(eq(tokens.teamId, teamId), or(eq(tokens.scope, 'team'), eq(tokens.projectId, projectId)))
      : eq(tokens.teamId, teamId),
  );
}

async function connectionsHere(db: Db, userId: string, scope: Scope) {
  return db
    .select()
    .from(tokens)
    .where(and(eq(tokens.userId, userId), reachesHere(scope.team.id, scope.project?.id ?? null)))
    .orderBy(desc(tokens.createdAt))
    .limit(CONNECTION_ROWS);
}

/** What each connection reports as: the snapshots it pushed win over the label it was given. */
async function devicesFor(db: Db, list: TokenRow[]) {
  const devices = new Map<string, string>();
  if (list.length === 0) return devices;
  const ids = list.map((token) => token.id);
  for (const row of await db
    .select({ tokenId: agentInstallations.tokenId, device: agentInstallations.deviceLabel })
    .from(agentInstallations)
    .where(inArray(agentInstallations.tokenId, ids))) {
    if (row.tokenId && row.device) devices.set(row.tokenId, row.device);
  }
  for (const row of await db
    .select({ tokenId: snapshots.tokenId, label: max(snapshots.deviceLabel) })
    .from(snapshots)
    .where(inArray(snapshots.tokenId, ids))
    .groupBy(snapshots.tokenId)) {
    if (row.tokenId && row.label) devices.set(row.tokenId, row.label);
  }
  return devices;
}

async function pendingSetups(db: Db, userId: string, scope: Scope) {
  return db
    .select({ enrollment: agentEnrollments, project: projects })
    .from(agentEnrollments)
    .leftJoin(projects, eq(agentEnrollments.projectId, projects.id))
    .where(
      and(
        eq(agentEnrollments.userId, userId),
        or(isNull(agentEnrollments.teamId), eq(agentEnrollments.teamId, scope.team.id)),
        scope.project
          ? or(isNull(agentEnrollments.projectId), eq(agentEnrollments.projectId, scope.project.id))
          : undefined,
        isNull(agentEnrollments.redeemedAt),
        isNull(agentEnrollments.revokedAt),
        gt(agentEnrollments.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(agentEnrollments.createdAt))
    .limit(PENDING_ROWS);
}

/**
 * The test this page shows: the one its address names, when the caller may see
 * it and it belongs to this workspace, else the caller's newest in this scope.
 * A named test from another scope of the same workspace is answered by the
 * caller with a redirect, so a project's test is always read inside its project.
 */
async function launchHere(
  db: Db,
  userId: string,
  scope: Scope,
  requested: string | undefined,
): Promise<{ launch?: Launch; elsewhere?: Launch }> {
  if (requested && isCanonicalUuid(requested)) {
    const named = await launchForViewer(db, requested, userId);
    if (named && named.teamId === scope.team.id) {
      if ((named.projectId ?? null) !== (scope.project?.id ?? null)) return { elsewhere: named };
      return { launch: named };
    }
  }
  const [newest] = await db
    .select()
    .from(launchAttempts)
    .where(
      and(
        eq(launchAttempts.userId, userId),
        eq(launchAttempts.teamId, scope.team.id),
        scope.project ? eq(launchAttempts.projectId, scope.project.id) : isNull(launchAttempts.projectId),
      ),
    )
    .orderBy(desc(launchAttempts.createdAt))
    .limit(1);
  return { launch: newest };
}

async function launchIdentities(db: Db, launch: Launch) {
  const ids = [launch.firstInstallationId, launch.secondInstallationId].filter((id): id is string =>
    Boolean(id),
  );
  if (ids.length === 0) return [];
  return db
    .select({ installation: agentInstallations, credential: tokens })
    .from(agentInstallations)
    .leftJoin(tokens, eq(agentInstallations.tokenId, tokens.id))
    .where(inArray(agentInstallations.id, ids));
}

/** Where a launch is read: the page of its own scope, opened on the Test section. */
async function launchHref(db: Db, launch: Launch) {
  const [team] = await db.select({ slug: teams.slug }).from(teams).where(eq(teams.id, launch.teamId));
  const project = launch.projectId
    ? (await db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, launch.projectId)))[0]
    : undefined;
  return `${connectionsHref(team!.slug, project?.slug ?? null)}?launch=${launch.id}#test`;
}

/** In page words: what a connection can reach, seen from inside this workspace. */
function accessLabel(token: { scope: string; projectId: string | null }, projectsById: Map<string, ProjectRef>) {
  if (token.scope === 'project') {
    return `Project only · ${token.projectId ? (projectsById.get(token.projectId)?.name ?? 'a project') : 'a project'}`;
  }
  if (token.scope === 'team') return 'Entire workspace';
  return 'Every workspace you are in';
}

/** The state of a test in two words, for the section list at the top. */
function launchState(launch: Launch | undefined) {
  if (!launch) return 'not started';
  if (launch.firstRealResultAt) return 'handoff completed';
  if (launch.exchangeConfirmedAt) return 'exchange confirmed';
  if (launch.firstConnectedAt) return 'waiting for reply';
  return 'waiting for sender';
}

const StepHead = ({ id, n, title, note }: { id: string; n: number; title: string; note: string }) => (
  <header class="conn-head" id={id}>
    <span class="conn-n" aria-hidden="true">
      {n}
    </span>
    <div>
      <h2>{title}</h2>
      <p>{note}</p>
    </div>
  </header>
);

/**
 * The second line of a connection's name cell: what it is paired with.
 *
 * An adapter gets the control, because which agent works in a checkout is
 * something only its owner knows and an adapter activated before pairing
 * existed has to be pairable without being activated again. An agent gets a
 * sentence, because the pairing is edited from the adapter's side and the
 * person looking at the agent still needs to know it has ears.
 */
const PairingNote = ({ pairing, back }: { pairing?: ConnectionPairing; back: unknown }) => {
  if (!pairing) return null;
  if (!pairing.adapter) {
    return pairing.adapters.length ? (
      <div class="small muted" style="font-weight:400;margin-top:4px">
        Adapter paired: {pairing.adapters.join(', ')}. Its prompt hook announces work assigned to
        this agent.
      </div>
    ) : null;
  }
  const current = pairing.companion?.live ? pairing.companion.installationId : '';
  return (
    <div style="font-weight:400;margin-top:6px;display:flex;flex-direction:column;gap:4px">
      <form
        class="inline m0"
        method="post"
        action={`/app/installations/${pairing.installationId}/companion`}
        style="gap:6px"
      >
        {back}
        <label class="small muted" for={`companion-${pairing.installationId}`}>
          Local adapter · listens for
        </label>
        <select
          class="in"
          id={`companion-${pairing.installationId}`}
          name="companion"
          style="height:32px;font-size:13px;width:auto;max-width:300px"
        >
          <option value="none" selected={!current}>
            Nobody (not paired)
          </option>
          {pairing.choices.map((agent) => (
            <option value={agent.installationId} selected={agent.installationId === current}>
              {agent.name}
              {agent.device ? ` · ${agent.device}` : ''} · {agent.access}
            </option>
          ))}
        </select>
        <button class="btn btn-sm" type="submit">
          Save
        </button>
      </form>
      {pairing.companion && !pairing.companion.live ? (
        <div class="small" style="color:var(--red)">
          Was paired with {pairing.companion.name}, which is revoked. Choose the agent that works
          in this checkout now.
        </div>
      ) : !pairing.companion ? (
        <div class="small muted">
          Not paired: its hook is not told about work assigned to the agent beside it, and a
          stopped edit is filed under this adapter's name.
        </div>
      ) : null}
    </div>
  );
};

/** The test: the steps it has reached, the two checks, and the way out when it is stuck. */
const LaunchCard = ({
  launch,
  identities,
  user,
  baseUrl,
  scope,
  pageHref,
}: {
  launch: Launch;
  identities: Awaited<ReturnType<typeof launchIdentities>>;
  user: User;
  baseUrl: string;
  scope: Scope;
  pageHref: string;
}) => {
  const connected = Boolean(launch.exchangeConfirmedAt);
  const realResult = Boolean(launch.firstRealResultAt);
  const unavailable = identities.some(
    ({ installation, credential }) => installation.revokedAt || !credential || credential.revokedAt,
  );
  const prompts = launchPrompts({
    baseUrl,
    launchId: launch.id,
    teamSlug: scope.team.slug,
    projectId: launch.projectId,
  });
  const where = scope.project ? `the ${scope.project.name} project` : `the ${scope.team.name} workspace`;
  const current = realResult ? 4 : connected ? 3 : launch.firstConnectedAt ? 1 : 0;
  const next = unavailable
    ? 'An observed agent was revoked. Start a separate test with a new connection.'
    : realResult
      ? 'A tracked handoff was completed. Review its evidence before treating the work as delivered.'
      : connected
        ? 'Connection works. Now complete one bounded handoff; the exchange alone is not product activation.'
        : launch.firstConnectedAt
          ? 'Use the reply check in a separately connected second agent.'
          : 'Connect the first agent if it is not connected yet, then run the sender check in it.';
  const role = (id: string) => (id === launch.firstInstallationId ? 'Sender' : 'Reply');
  return (
    <section class="card xchg" id="launch">
      <div class="xchg-head">
        <span class="overline">
          Test · {launch.intent === 'teammates' ? 'with teammates' : 'your own agents'}
        </span>
        <h3>
          {realResult
            ? 'Your first tracked handoff completed'
            : connected
              ? 'Your agents exchanged a message'
              : launch.firstConnectedAt
                ? 'Waiting for the reply'
                : 'Waiting for your first agent'}
        </h3>
        <p>
          {realResult
            ? 'Connection is proven and one bounded task reached a reported completion.'
            : 'First prove the connection, then complete one bounded handoff. A hello is not activation.'}
        </p>
        {/* In view, not only in the doctor: `launch_check` takes it, and a person
            asked for "the launch id" should not have to open a fold to find it. */}
        <p>
          Launch id: <code>{launch.id}</code>
        </p>
      </div>
      <div class="card-pad" style="display:flex;flex-direction:column;gap:16px">
        {unavailable ? (
          <div class="banner banner-warn">
            <span class="ic">!</span>
            <span>{next}</span>
          </div>
        ) : null}
        <FlowSteps
          current={current}
          steps={[
            {
              title: 'Connect the first agent',
              detail: 'Connect it above, then run the sender check in it.',
              at: launch.firstConnectedAt,
            },
            {
              title: 'Connect another agent',
              detail: 'The other client gets its own connection, with its own name and machine.',
              at: launch.secondConnectedAt,
            },
            {
              title: 'Confirm the exchange',
              detail: 'The second check replies; STMA records the result.',
              at: launch.exchangeConfirmedAt,
            },
            {
              title: 'Complete one bounded handoff',
              detail: 'Offer, accept, resume and complete a real task; review evidence separately.',
              at: launch.firstRealResultAt,
            },
          ]}
        />
        {!connected ? (
          <p
            class="m0"
            data-launch-status={`/app/launches/${launch.id}/status`}
            data-launch-first={String(Boolean(launch.firstConnectedAt))}
            data-launch-refresh={`${pageHref}?launch=${launch.id}`}
            aria-live="polite"
          >
            {launch.firstConnectedAt ? 'Sender observed. Waiting for reply.' : 'Waiting for sender.'}{' '}
            Checks run for up to two minutes while this tab is visible.
          </p>
        ) : null}
        {unavailable ? null : (
          <p class="m0">
            <b>Next:</b> {next}
          </p>
        )}
        {!connected && !unavailable ? (
          <div>
            <b>
              {launch.firstConnectedAt
                ? 'Run the reply check in your second agent'
                : 'Run the sender check in your first agent'}
            </b>
            <p class="small">
              Each agent must already be connected, with access that includes {where}. Paste only
              the check below into the right agent. It carries a launch id, not a credential, and
              changes no local configuration.
            </p>
            <div class="flow-actions" style="margin-top:0">
              <button
                class="btn btn-primary"
                type="button"
                data-copy={prompts[launch.firstConnectedAt ? 'reply' : 'send']}
              >
                {launch.firstConnectedAt ? '2 · Copy reply check' : '1 · Copy sender check'}
              </button>
              <button
                class="btn"
                type="button"
                data-copy={prompts[launch.firstConnectedAt ? 'send' : 'reply']}
              >
                {launch.firstConnectedAt ? 'Copy sender check again' : 'Preview second-agent check'}
              </button>
            </div>
            <p class="small muted">
              STMA cannot wake either client. Open the client yourself; a working connection
              proves identity and scope, not that this exchange or repository work happened.
            </p>
          </div>
        ) : null}
        {identities.length > 0 ? (
          <div>
            {identities.map(({ installation, credential }) => (
              <div class="flow-record">
                <span class="small muted">{role(installation.id)}: </span>
                <Identity
                  human={installation.userId === user.id ? user.username : 'Teammate'}
                  agent={installation.name}
                  device={installation.deviceLabel}
                />
                <p class="small m0">
                  {installation.revokedAt || credential?.revokedAt
                    ? 'Access revoked'
                    : 'Authenticated connection observed; running state not asserted'}{' '}
                  · last seen {timeAgo(installation.lastSeenAt) ?? 'not recorded'}
                </p>
              </div>
            ))}
          </div>
        ) : null}
        {launch.sessionId ? (
          <p class="m0">
            <a href={`/app/sessions/${launch.sessionId}`}>Open the exchange</a>
          </p>
        ) : null}
        {connected && !realResult ? (
          <p class="m0">
            Ask your agent to offer a real task using <code>handoff_work</code>. The receiver
            explicitly accepts with <code>update_handoff</code>, inspects the worktree, then resumes.
            File access and execution still need your consent.
          </p>
        ) : null}
        {realResult ? (
          <p class="m0">
            The handoff lifecycle is complete. Open the exchange and inspect its exact run,
            repository checkpoint and provider evidence before merging or deploying.
          </p>
        ) : null}
        <p class="small muted m0">
          {realResult
            ? 'Proven: two authenticated installation identities exchanged a message and an authenticated participant reported a tracked handoff complete.'
            : connected
              ? 'Proven so far: two authenticated installation identities exchanged a message in this exact scope; no real task is complete yet.'
              : 'Confirmation requires two authenticated installation identities to exchange a message in this exact scope.'}{' '}
          It does not prove two physical computers, provider delivery, human approval or correct
          code.
          {launch.intent === 'teammates'
            ? ' A teammate signs in to their own account and opens this page; nobody shares a credential.'
            : ''}
        </p>
        <details>
          <summary>Connection doctor</summary>
          <dl class="flow-facts" style="margin-top:10px">
            <dt>Started</dt>
            <dd>{fmtDate(launch.createdAt)}</dd>
            <dt>Exchange</dt>
            <dd>{connected ? 'Confirmed' : launch.firstConnectedAt ? 'Sender only' : 'Not observed'}</dd>
            <dt>Handoff</dt>
            <dd>{realResult ? 'Reported complete' : 'Not completed'}</dd>
            <dt>Access</dt>
            <dd>
              {unavailable
                ? 'Revoked or unavailable'
                : identities.length
                  ? 'Active when last observed'
                  : 'No installation observed'}
            </dd>
          </dl>
          <p>
            Nothing appears in the agent: check the exact server address and reload its MCP
            connection. Wrong scope: connect it again with access that includes {where}; never
            broaden an existing connection. A revoked sender needs a separate test. STMA cannot wake
            a sleeping agent. The launch id is not a credential; access is checked on every request.
          </p>
          <form method="post" action="/app/launches">
            <input type="hidden" name="team" value={scope.team.slug} />
            <input type="hidden" name="intent" value={launch.intent} />
            <input type="hidden" name="fresh" value="yes" />
            {scope.project ? <input type="hidden" name="project" value={scope.project.id} /> : null}
            <button class="btn" type="submit">
              Start a separate test
            </button>
          </form>
          <p class="small muted m0" style="margin-top:6px">Existing connections are kept.</p>
        </details>
      </div>
    </section>
  );
};

interface PageProps {
  user: User;
  scope: Scope;
  baseUrl: string;
  list: TokenRow[];
  devices: Map<string, string>;
  pairings: Map<string, ConnectionPairing>;
  pending: Awaited<ReturnType<typeof pendingSetups>>;
  launch?: Launch;
  identities: Awaited<ReturnType<typeof launchIdentities>>;
  answer: Answer;
  notice?: string;
  error?: string;
  filterState: string;
  filterQuery: string;
}

const ConnectionsPage = (props: PageProps) => {
  const { user, scope, baseUrl, list, devices, pairings, pending, launch, answer } = props;
  const { team, project } = scope;
  const pageHref = connectionsHref(team.slug, project?.slug ?? null);
  const projectsById = new Map(scope.projects.map((row) => [row.id, row]));
  const back = (
    <>
      <input type="hidden" name="back_team" value={team.slug} />
      <input type="hidden" name="back_project" value={project?.slug ?? ''} />
    </>
  );
  const filters = (
    <>
      {back}
      <input type="hidden" name="back_q" value={props.filterQuery} />
    </>
  );
  const issued = answer.issued;
  const terminalCommand = issued?.terminal ? connectCommandFor(issued.code, baseUrl) : undefined;
  const setupPrompt =
    issued && !issued.terminal
      ? agentConnectPrompt({
          baseUrl,
          enrollmentId: issued.enrollment.id,
          enrollmentCode: issued.code,
          enrollmentExpiresAt: issued.enrollment.expiresAt,
          scope: issued.enrollment.scope as TokenScope,
          agentName: issued.enrollment.name,
          deviceLabel: issued.enrollment.deviceLabel,
          clientType: issued.enrollment.clientType,
          role: issued.enrollment.role ?? 'generalist',
          teamSlug: issued.team?.slug,
          projectName: issued.project?.name,
        })
      : undefined;
  const refusedTerminal = answer.refused?.terminal ? answer.refused.typed : undefined;
  const refusedLegacy = answer.refused && !answer.refused.terminal ? answer.refused.typed : undefined;
  const promptScope = {
    teamSlug: team.slug,
    projectSlug: project?.slug,
    projectName: project?.name,
  };
  const mcpAlias = mcpServerAlias(promptScope);
  const codexConnectPrompt = mcpConnectPrompt({ baseUrl, client: 'codex', ...promptScope });
  const claudeConnectPrompt = mcpConnectPrompt({ baseUrl, client: 'claude-code', ...promptScope });
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const agentsHome = project ? sectionHref(team.slug, project.slug, 'agents') : null;
  const trail: Crumb[] = project
    ? teamTrail(
        team,
        { label: 'Projects', href: `/app/teams/${team.slug}/projects` },
        { label: project.name, href: `/app/teams/${team.slug}/projects/${encodeURIComponent(project.slug)}` },
        { label: 'Agents', href: agentsHome! },
        { label: 'Agent connections' },
      )
    : teamTrail(team, { label: 'Agent connections' });
  const filterState = ['all', 'active', 'incomplete', 'revoked'].includes(props.filterState)
    ? props.filterState
    : 'all';
  const filterQuery = props.filterQuery.slice(0, 100).toLowerCase();
  const visible = list.filter((token) => {
    if (filterQuery && !token.name.toLowerCase().includes(filterQuery)) return false;
    const incomplete = Boolean(token.setupExpiresAt) && !token.activatedAt;
    if (filterState === 'active') return !token.revokedAt && !incomplete;
    if (filterState === 'incomplete') return !token.revokedAt && incomplete;
    if (filterState === 'revoked') return Boolean(token.revokedAt);
    return true;
  });
  const live = list.filter((token) => !token.revokedAt).length;
  const legacyAccess =
    typedString(refusedLegacy, 'access') ?? (project ? `project:${project.id}` : `team:${team.id}`);
  const legacyCount = list.length + pending.length + 1;
  const status = answer.refused ? undefined : props.error;
  return (
    <AppLayout
      user={user}
      active="tokens"
      title={project ? `Agent connections · ${project.name}` : `Agent connections · ${team.name}`}
      head={
        <PageHead
          trail={trail}
          title="Agent connections"
          sub={
            project
              ? `Connect an agent to ${project.name}, test two agents together, and manage your connections that can work in this project.`
              : `Connect your agents to ${team.name}, test two of them together, and manage your connections that can work here.`
          }
          actions={
            agentsHome ? (
              <a class="btn btn-sm" href={agentsHome}>
                Back to {project!.name} agents
              </a>
            ) : (
              <a class="btn btn-sm" href={sectionHref(team.slug, null, 'agents')}>
                People and agents
              </a>
            )
          }
        />
      }
      band={
        answer.refused ? (
          <Band kind="warn" tag="Check input">
            {answer.refused.error} Nothing was created, and what you typed is still in the form.
          </Band>
        ) : status ? (
          <Band kind="warn" tag="Not done">
            {status}
          </Band>
        ) : props.notice ? (
          <Band kind="info" tag="Done">
            {props.notice}
          </Band>
        ) : undefined
      }
      keysNote={`${live} connection${live === 1 ? '' : 's'} of yours can work here · agents and machines are not seats`}
    >
      <nav class="section-jump" aria-label="Agent connections sections">
        <a href="#connect">Connect an agent</a>
        <a href="#test">
          Test <span>{launchState(launch)}</span>
        </a>
        <a href="#connections">
          Your connections <span>{live}</span>
        </a>
      </nav>

      {terminalCommand && issued ? (
        <ConnectCommand
          command={terminalCommand}
          agent={issued.enrollment.name}
          device={issued.enrollment.deviceLabel}
          client={issued.enrollment.clientType as AgentClientType}
          scope={issued.enrollment.scope as TokenScope}
          teamSlug={issued.team?.slug}
          projectName={issued.project?.name}
        />
      ) : null}

      {setupPrompt && issued ? (
        <div class="reveal" id="setup-prompt">
          <div class="reveal-head">
            <span class="ic">✓</span>
            <div>
              <div class="reveal-title">Setup prompt ready</div>
              <div class="reveal-sub">
                Legacy fallback: paste the whole block into exactly one agent on the named machine.
                Its enrollment code is shown only now, expires in {AGENT_ENROLLMENT_TTL_MINUTES}{' '}
                minutes and can be used once. The agent will present one redacted disclosure and
                ask once before connecting. After yes, it consumes the embedded code automatically;
                you do not enter it again.
              </div>
            </div>
          </div>
          <div class="cmd setup-prompt">
            <code>{setupPrompt}</code>
            <button class="copybtn solid" type="button" data-copy={setupPrompt}>
              Copy prompt
            </button>
          </div>
          <div class="small" style="color:var(--green-ink)">
            Enforced access:{' '}
            <b>
              {grantLabel({
                scope: issued.enrollment.scope as TokenScope,
                teamSlug: issued.team?.slug ?? null,
                projectName: issued.project?.name ?? null,
              })}
            </b>
          </div>
          <p class="small m0">
            The MCP entry is persistent user-level configuration, so it is available to this client
            across repositories; server access remains limited to the enforced access above. Assume
            the resulting credential has no automatic expiry unless redemption reports one. Revoke
            server access below, then remove the local entry and reload the client to disconnect
            fully. If redemption succeeds but validation or the local config write fails, the helper
            automatically revokes that just-minted connection instead of leaving unused access
            active. Once the agent confirms <code>whoami</code>, <a href="#test">test it</a> with a
            second agent.
          </p>
        </div>
      ) : null}

      {answer.legacyToken ? (
        <div class="reveal">
          <div class="reveal-head">
            <span class="ic">!</span>
            <div>
              <div class="reveal-title">Legacy personal token created</div>
              <div class="reveal-sub">
                This backward-compatible token reaches all of your current memberships and is shown
                once. New agent connections should use the forms on this page.
              </div>
            </div>
          </div>
          <div class="cmd">
            <code>{answer.legacyToken}</code>
            <button class="copybtn solid" type="button" data-copy={answer.legacyToken}>
              Copy token
            </button>
          </div>
        </div>
      ) : null}

      <StepHead
        id="connect"
        n={1}
        title="Connect an agent"
        note={
          project
            ? `A connection made here can work in ${project.name}, or in all of ${team.name} if you choose that access. Each agent and machine gets its own, revocable on its own.`
            : `Every connection made here belongs to ${team.name}: the whole workspace, or one of its projects. Each agent and machine gets its own, revocable on its own.`
        }
      />

      <ConnectCheckoutForm
        action="/app/tokens"
        here={project ? { team: { name: team.name }, project: { id: project.id, name: project.name } } : undefined}
        teams={project ? undefined : [{ id: team.id, name: team.name, projects: scope.projects }]}
        typed={
          refusedTerminal
            ? {
                name: typedString(refusedTerminal, 'name'),
                device: typedString(refusedTerminal, 'device'),
                client: typedString(refusedTerminal, 'client'),
                access: typedString(refusedTerminal, 'access'),
              }
            : undefined
        }
        context={back}
        projectsHref={`/app/teams/${team.slug}/projects`}
      />

      <div class="card card-pad" style="display:flex;flex-direction:column;gap:16px">
        <div>
          <span class="overline">Any client · OAuth</span>
          <div class="card-title" style="margin-top:4px">Connect through your agent client</div>
          <div class="card-note">
            Paste one setup request into Codex or Claude Code, or add this same address yourself in
            another OAuth-capable MCP client. Your browser opens STMA, where you name the agent and
            machine and choose its access: {project ? `${project.name}, or all of ${team.name}` : `${team.name}, or one of its projects`}.
            The client stores the credential; STMA puts no secret in a prompt, terminal command,
            repository, or user-edited config file. After login, reload that client once so its
            running task can load the new tools.
          </div>
        </div>
        <div class="cmd">
          <code>{baseUrl}/mcp</code>
          <button class="copybtn solid" type="button" data-copy={`${baseUrl}/mcp`}>
            Copy MCP address
          </button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
          <div style="border:1px solid var(--line);border-radius:12px;padding:14px">
            <b>Codex</b>
            <p class="small muted">
              Paste one transparent request into Codex. It uses one native OAuth flow; you approve
              it, then reload the task once.
            </p>
            <button class="copybtn solid" type="button" data-copy={codexConnectPrompt}>
              Copy Codex setup request
            </button>
            <details class="small" style="margin-top:10px">
              <summary>Manual fallback</summary>
              <ol>
                <li>
                  Open Settings, then MCP servers, and add a Streamable HTTP server named{' '}
                  <code>{mcpAlias}</code>.
                </li>
                <li>Paste the MCP address above and save.</li>
                <li>Select Authenticate, then approve the exact access in STMA.</li>
              </ol>
              <div class="cmd" style="margin-top:8px">
                <code>{`codex mcp add ${mcpAlias} --url ${baseUrl}/mcp`}</code>
                <button class="copybtn" type="button" data-copy={`codex mcp add ${mcpAlias} --url ${baseUrl}/mcp`}>
                  Copy
                </button>
              </div>
              <p class="m0 muted">
                If Add did not start OAuth itself, run <code>{`codex mcp login ${mcpAlias}`}</code>.
                Never start a second login while one is open.
              </p>
            </details>
          </div>
          <div style="border:1px solid var(--line);border-radius:12px;padding:14px">
            <b>Claude Code</b>
            <p class="small muted">
              Claude Code 2.1.186+ connects each Git checkout (clone or worktree) as its own agent:
              the request names the entry after that checkout, adds it at local scope and
              authenticates with the native login. Paste the same request into every Claude Code
              agent, including several on one machine. If the agent shell is non-interactive, you
              run the one login command in a regular terminal inside that checkout.
            </p>
            <button class="copybtn solid" type="button" data-copy={claudeConnectPrompt}>
              Copy Claude setup request
            </button>
            <details class="small" style="margin-top:10px">
              <summary>Manual fallback</summary>
              <p class="m0 muted" style="margin-top:8px">
                In a terminal inside the checkout, pick a server name no other checkout on this
                machine uses, such as <code>stma-</code> plus the folder name. Claude Code keeps the
                login under that name, and logging in again under a name signs out its earlier login.
              </p>
              <div class="cmd" style="margin-top:8px">
                <code>{`claude mcp add --transport http --scope local NAME ${baseUrl}/mcp`}</code>
                <button
                  class="copybtn"
                  type="button"
                  data-copy={`claude mcp add --transport http --scope local NAME ${baseUrl}/mcp`}
                >
                  Copy
                </button>
              </div>
              <p class="m0 muted">
                Then run <code>claude mcp login NAME</code> in that checkout, approve in the browser
                and reload Claude Code there once. Remove an older machine-wide{' '}
                <code>{mcpAlias}</code> entry first, or every checkout also loads it. Local scope
                changes visibility only; STMA still enforces the approved access.
              </p>
            </details>
          </div>
        </div>
        <div class="banner banner-info">
          <span class="ic">i</span>
          <span>
            Each browser approval creates a unique installation ID and short-lived, automatically
            refreshed access. It grants STMA MCP access only. Local git hooks and file guards are a
            separate optional adapter and are never silently installed by this connection.
          </span>
        </div>
      </div>

      <details class="card fold-card" id="local-adapter">
        <summary class="card-head">
          <div>
            <div class="card-title">Track work in a checkout connected through OAuth</div>
            <div class="card-note">
              Separate opt-in: local hooks and a file guard for a checkout whose agent connected in
              the browser. The connect command above already includes them.
            </div>
          </div>
        </summary>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
          <p class="m0 small">
            MCP login alone does not observe edits or start runs. The first-party STMA CLI can
            install ignored, project-local hooks after you review the exact checkout and approve a
            separate project-scoped browser connection. No existing Codex or Claude MCP credential
            is read or copied. This creates a second, separately revocable installation for the
            local adapter; it is not the same identity as the MCP connection. Its approval screen
            asks which of your agents it listens for, so that agent's prompt hook hears work
            assigned to it; an adapter you activated earlier is paired in the list below.
          </p>
          {project ? (
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
              {(['codex', 'claude-code'] as const).map((target) => {
                const command = `stma adapter activate --target ${target} --team ${shellQuote(team.slug)} --project ${shellQuote(project.name)} --server ${shellQuote(baseUrl)}`;
                return (
                  <div class="cmd">
                    <code>{command}</code>
                    <button class="copybtn solid" type="button" data-copy={command}>
                      Copy {target} command
                    </button>
                  </div>
                );
              })}
            </div>
          ) : scope.projects.length === 0 ? (
            <p class="m0 muted">
              Hooks belong to one project's checkout, and this workspace has none yet.{' '}
              <a href={`/app/teams/${team.slug}/projects`}>Create a project</a> first.
            </p>
          ) : (
            <p class="m0">
              The command names one project. Open this page inside it:{' '}
              {scope.projects.slice(0, ADAPTER_PROJECT_LINKS).map((row, index) => (
                <>
                  {index > 0 ? ', ' : ''}
                  <a href={`${connectionsHref(team.slug, row.slug)}#local-adapter`}>{row.name}</a>
                </>
              ))}
              {scope.projects.length > ADAPTER_PROJECT_LINKS ? (
                <>
                  , or find the rest on <a href={`/app/teams/${team.slug}/projects`}>Projects</a>
                </>
              ) : null}
              .
            </p>
          )}
          <p class="small muted m0">
            Run this in a regular terminal at the Git checkout root after installing a STMA CLI
            version that supports <code>adapter activate</code>. Review the browser consent yourself.
            Codex also requires a separate <code>/hooks</code> trust review. File-tool guards do not
            cover shell, operating-system or every external write path. A real run must be observed
            before claiming coordination works.
          </p>
        </div>
      </details>

      <details class="card fold-card" id="legacy-prompt" open={Boolean(refusedLegacy)}>
        <summary class="card-head">
          <div>
            <div class="card-title">Legacy setup prompt (compatibility)</div>
            <div class="card-note">
              Only for an older MCP client that cannot complete OAuth.
            </div>
          </div>
        </summary>
        <div class="card-pad">
          <p class="m0 small">
            This path asks the agent to install user-level configuration and may be refused by the
            client; the two paths above avoid that. The prompt carries a single-use{' '}
            {AGENT_ENROLLMENT_TTL_MINUTES}-minute enrollment code. Before any network or user-level
            configuration change, the agent must show you the origin, persistent config target, exact
            access boundary, credential lifetime, revocation path, replacement state and any
            permission tightening, then wait for one explicit approval. After yes it uses the
            embedded one-use code automatically. The prompt itself does not prove that its service
            is trusted; reject an origin or access you do not recognize. For two computers, use
            separate prompts and machine labels. <a href="/docs#quickstart">Quick start</a>
          </p>
          <form class="authform" method="post" action="/app/tokens" style="margin-top:16px">
            {back}
            <div class="field">
              <label for="agent-name">Agent name</label>
              <input
                class="in"
                id="agent-name"
                type="text"
                name="name"
                placeholder="codex-reviewer"
                value={typedString(refusedLegacy, 'name') ?? `agent-${legacyCount}`}
                maxlength={80}
                required
              />
              <span class="help">The stable identity teammates see on runs and the agent map.</span>
            </div>
            <div class="field">
              <label for="device-label">Machine</label>
              <input
                class="in"
                id="device-label"
                type="text"
                name="device"
                placeholder="macbook-pro"
                value={typedString(refusedLegacy, 'device') ?? `computer-${legacyCount}`}
                maxlength={60}
                required
              />
              <span class="help">A short device label; another machine gets another prompt.</span>
            </div>
            <div class="field">
              <label for="client-type">Client</label>
              <select class="in" id="client-type" name="client">
                {AGENT_CLIENT_TYPES.filter((client) => ['codex', 'claude-code', 'cursor'].includes(client)).map((client) => (
                  <option value={client} selected={client === typedString(refusedLegacy, 'client')}>
                    {client}
                  </option>
                ))}
              </select>
            </div>
            <details>
              <summary>Agent role (optional)</summary>
              <div class="field">
                <label for="agent-role">Role</label>
                <select class="in" id="agent-role" name="role">
                  {AGENT_ROLES.map((role) => (
                    <option value={role} selected={role === (typedString(refusedLegacy, 'role') ?? 'generalist')}>
                      {role}
                    </option>
                  ))}
                </select>
                <span class="help">A visible label, not a permission.</span>
              </div>
            </details>
            <div class="field">
              <label for="agent-access">Access</label>
              <select class="in" id="agent-access" name="access" required>
                {project ? (
                  <option value={`project:${project.id}`} selected={legacyAccess === `project:${project.id}`}>
                    Project only · {project.name}
                  </option>
                ) : null}
                <option value={`team:${team.id}`} selected={legacyAccess === `team:${team.id}`}>
                  Entire workspace · {team.name}
                </option>
                {project
                  ? null
                  : scope.projects.map((row) => (
                      <option value={`project:${row.id}`} selected={legacyAccess === `project:${row.id}`}>
                        Project only · {row.name}
                      </option>
                    ))}
              </select>
              <span class="help">
                Project only is the least-privilege choice. Entire workspace includes every current
                and later project in {team.name}.
              </span>
            </div>
            <button class="btn btn-primary" type="submit" style="align-self:flex-start">
              Create legacy one-time prompt
            </button>
          </form>
        </div>
      </details>

      <StepHead
        id="test"
        n={2}
        title="Test two agents together"
        note="Before real work, prove two connected agents reach each other: one sends a short check, the other replies, and STMA confirms it here."
      />
      {launch ? (
        <LaunchCard
          launch={launch}
          identities={props.identities}
          user={user}
          baseUrl={baseUrl}
          scope={scope}
          pageHref={pageHref}
        />
      ) : (
        <FirstExchange baseUrl={baseUrl} teamSlug={team.slug} project={project?.slug} />
      )}

      <StepHead
        id="connections"
        n={3}
        title="Your connections here"
        note={`Every connection of yours that can work in ${project ? project.name : team.name}. Revoking one stops its server access at once; remove the local entry in the client too. Everybody's agents are on People and agents.`}
      />

      {pending.length ? (
        <div class="card scroll-x">
          <div class="card-head">
            <div>
              <div class="card-title">Setups not yet used</div>
              <div class="card-note">
                Codes cannot be shown again. Revoke one or let it expire, then create a fresh one.
              </div>
            </div>
          </div>
          <table class="tbl">
            <tr>
              <th>Agent</th>
              <th>Machine</th>
              <th>Access</th>
              <th>Expires</th>
              <th></th>
            </tr>
            {pending.map((row) => (
              <tr>
                <td class="name">{row.enrollment.name}</td>
                <td class="mono muted">{row.enrollment.deviceLabel}</td>
                <td>{accessLabel(row.enrollment, projectsById)}</td>
                <td class="muted">{row.enrollment.expiresAt.toISOString().slice(11, 16)} UTC</td>
                <td style="text-align:right">
                  <form
                    class="m0"
                    method="post"
                    action={`/app/enrollments/${row.enrollment.id}/revoke`}
                    data-confirm="If the one-time code is still unused, this invalidates it immediately. If the agent activated while this page was open, the same action follows that enrollment and revokes its connected installation and credential."
                    data-confirm-title="Revoke setup or connection?"
                    data-confirm-action="Revoke access"
                  >
                    {filters}
                    <button class="linklike" type="submit">
                      Revoke
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        </div>
      ) : null}

      <form
        method="get"
        action={pageHref}
        class="card card-pad"
        style="display:flex;gap:12px;flex-wrap:wrap;align-items:end"
      >
        <div class="field">
          <label for="connection-state">Status</label>
          <select class="in" name="state" id="connection-state">
            {['all', 'active', 'incomplete', 'revoked'].map((state) => (
              <option value={state} selected={filterState === state}>
                {state}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="connection-search">Agent name</label>
          <input
            class="in"
            name="q"
            id="connection-search"
            value={props.filterQuery.slice(0, 100)}
            placeholder="Search connections"
          />
        </div>
        <button class="btn" type="submit">
          Filter
        </button>
        <a class="btn" href={`${pageHref}#connections`}>
          Clear filters
        </a>
        <p class="help" style="flex-basis:100%">
          Awaiting client: reload the named client and check its STMA connection within 15 minutes
          of setup. Setup expired: create a fresh one. Active confirms client identity, not
          repository readiness or completed work. Legacy credentials without verification remain
          unverified.
        </p>
      </form>

      {visible.length === 0 ? (
        <div class="card">
          <div class="empty">
            <h2>{list.length ? 'No connections match these filters' : 'No connections here yet'}</h2>
            <p>
              Connect an agent above. It appears here once its client redeems the command or
              completes the browser approval.
            </p>
          </div>
        </div>
      ) : (
        <div class="card scroll-x">
          <table class="tbl">
            <tr>
              <th>Name</th>
              <th>Access</th>
              <th>Credential</th>
              <th class="hide-sm">Machine it reports as</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
            {visible.map((t) => (
              <tr style={t.revokedAt ? 'color:var(--mut-2)' : ''}>
                <td class="name">
                  {t.name}
                  {t.revokedAt ? null : <PairingNote pairing={pairings.get(t.id)} back={filters} />}
                </td>
                <td>{accessLabel(t, projectsById)}</td>
                <td class="mono">{t.audience ? 'OAuth · client-managed' : `${t.prefix}••••••••`}</td>
                <td class="mono muted hide-sm">{devices.get(t.id) ?? 'not yet'}</td>
                <td class="muted">{fmtDate(t.createdAt)}</td>
                <td class="muted">{timeAgo(t.lastUsedAt) ?? 'never'}</td>
                <td>
                  {t.revokedAt ? (
                    <span class="pill pill-muted">
                      <span class="dot gray" />
                      revoked
                    </span>
                  ) : t.setupExpiresAt && !t.activatedAt ? (
                    <span class="pill pill-muted">
                      <span class="dot gray" />
                      {t.setupExpiresAt <= new Date() ? 'setup expired' : 'awaiting client'}
                    </span>
                  ) : (
                    <span class="pill pill-active">
                      <span class="dot" />
                      {t.activatedAt ? 'active' : 'legacy · unverified'}
                    </span>
                  )}
                </td>
                <td style="text-align:right">
                  {t.revokedAt ? null : (
                    <form
                      class="m0"
                      method="post"
                      action={`/app/tokens/${t.id}/revoke`}
                      data-confirm={`The agent using "${t.name}" loses server access immediately; active runs become stale and their claims are released. Existing snapshots, runs and sessions are kept. This does not remove the local MCP entry or stop the client: remove it there and reload separately.${t.scope === 'personal' ? ' This connection reaches every workspace you are in, so it stops everywhere.' : ''}`}
                      data-confirm-title={`Revoke "${t.name}"?`}
                      data-confirm-action="Revoke connection"
                    >
                      {filters}
                      <button class="linklike" type="submit">
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </table>
        </div>
      )}
    </AppLayout>
  );
};

/**
 * Outside every workspace, the page has one thing to say: a connection belongs
 * to a workspace. With none it says where to make one; with several it asks
 * which, with what is already connected to each.
 */
const AccountConnections = (props: {
  user: User;
  workspaces: Array<Workspace & { live: number; waiting: number }>;
  everywhere: number;
  legacyToken?: string;
  error?: string;
  notice?: string;
}) => (
  <AppLayout
    user={props.user}
    active="tokens"
    title="Agent connections"
    head={
      <PageHead
        trail={[{ label: 'All workspaces', href: '/app' }, { label: 'Agent connections' }]}
        title="Agent connections"
        sub={
          props.workspaces.length
            ? 'A connection belongs to a workspace. Open the one your agent will work in: you connect, test and manage connections there.'
            : 'A connection belongs to a workspace, and you are not in one yet.'
        }
      />
    }
    band={
      props.error ? (
        <Band kind="warn" tag="Not done">
          {props.error}
        </Band>
      ) : props.notice ? (
        <Band kind="info" tag="Done">
          {props.notice}
        </Band>
      ) : undefined
    }
  >
    {props.legacyToken ? (
      <div class="reveal">
        <div class="reveal-head">
          <span class="ic">!</span>
          <div>
            <div class="reveal-title">Legacy personal token created</div>
            <div class="reveal-sub">
              This backward-compatible token reaches all of your current memberships and is shown
              once. New agent connections are made inside a workspace.
            </div>
          </div>
        </div>
        <div class="cmd">
          <code>{props.legacyToken}</code>
          <button class="copybtn solid" type="button" data-copy={props.legacyToken}>
            Copy token
          </button>
        </div>
      </div>
    ) : null}
    {props.workspaces.length === 0 ? (
      <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
        <div class="card-title">Create a workspace first</div>
        <div class="card-note">
          A workspace works for one person too. Give it a name, then connect your agents from
          inside it. No invitation to yourself or repository setup is needed.
        </div>
        <a class="btn btn-primary" href="/app" style="align-self:flex-start">
          Go to workspaces
        </a>
      </div>
    ) : (
      <div class="card scroll-x">
        <table class="tbl">
          <tr>
            <th>Workspace</th>
            <th>Your role</th>
            <th>Your connections</th>
            <th>Setups waiting</th>
            <th></th>
          </tr>
          {props.workspaces.map((ws) => (
            <tr>
              <td class="name">
                <a href={connectionsHref(ws.slug)}>{ws.name}</a>
              </td>
              <td class="muted">{ws.role}</td>
              <td>{ws.live}</td>
              <td class="muted">{ws.waiting}</td>
              <td style="text-align:right">
                <a class="btn btn-sm" href={connectionsHref(ws.slug)}>
                  Open
                </a>
              </td>
            </tr>
          ))}
        </table>
        {props.everywhere ? (
          <div class="card-pad muted small">
            {props.everywhere} older connection{props.everywhere === 1 ? '' : 's'} of yours reach
            {props.everywhere === 1 ? 'es' : ''} every workspace you are in; each workspace lists
            {props.everywhere === 1 ? ' it' : ' them'}, and revoking there stops it everywhere.
          </div>
        ) : null}
      </div>
    )}
  </AppLayout>
);

async function renderAccount(c: Context<AppEnv>, extra: { legacyToken?: string; error?: string } = {}) {
  const user = c.get('user')!;
  const db = c.get('db');
  const found = await memberWorkspaces(db, user.id);
  const ids = found.map((ws) => ws.id);
  const live = ids.length
    ? await db
        .select({ teamId: tokens.teamId, n: count() })
        .from(tokens)
        .where(and(eq(tokens.userId, user.id), isNull(tokens.revokedAt), inArray(tokens.teamId, ids)))
        .groupBy(tokens.teamId)
    : [];
  const waiting = ids.length
    ? await db
        .select({ teamId: agentEnrollments.teamId, n: count() })
        .from(agentEnrollments)
        .where(
          and(
            eq(agentEnrollments.userId, user.id),
            inArray(agentEnrollments.teamId, ids),
            isNull(agentEnrollments.redeemedAt),
            isNull(agentEnrollments.revokedAt),
            gt(agentEnrollments.expiresAt, new Date()),
          ),
        )
        .groupBy(agentEnrollments.teamId)
    : [];
  const [everywhere] = await db
    .select({ n: count() })
    .from(tokens)
    .where(and(eq(tokens.userId, user.id), isNull(tokens.revokedAt), eq(tokens.scope, 'personal')));
  const liveBy = new Map(live.map((row) => [row.teamId, row.n]));
  const waitingBy = new Map(waiting.map((row) => [row.teamId, row.n]));
  await ensureRail(db, user);
  return c.html(
    <AccountConnections
      user={user}
      workspaces={found.map((ws) => ({ ...ws, live: liveBy.get(ws.id) ?? 0, waiting: waitingBy.get(ws.id) ?? 0 }))}
      everywhere={everywhere?.n ?? 0}
      legacyToken={extra.legacyToken}
      error={extra.error ?? c.req.query('error')}
      notice={c.req.query('ok')}
    />,
    extra.error ? 422 : 200,
  );
}

/** The page for one scope, for a GET or for the POST that answers with it. */
async function renderConnections(
  c: Context<AppEnv>,
  scope: Scope,
  answer: Answer = {},
  query: { launch?: string; state?: string; q?: string; ok?: string; error?: string } = {},
) {
  const user = c.get('user')!;
  const db = c.get('db');
  const found = await launchHere(db, user.id, scope, query.launch);
  if (found.elsewhere) return c.redirect(await launchHref(db, found.elsewhere), 303);
  // A POST answers with a page, and a page draws the rail of the scope it shows.
  if (c.req.method !== 'GET') await ensureRail(db, user, scope.team.slug, scope.project?.slug ?? null);
  const list = await connectionsHere(db, user.id, scope);
  return c.html(
    <ConnectionsPage
      user={user}
      scope={scope}
      baseUrl={c.get('env').baseUrl}
      list={list}
      devices={await devicesFor(db, list)}
      pairings={await connectionPairings(db, user.id)}
      pending={await pendingSetups(db, user.id, scope)}
      launch={found.launch}
      identities={found.launch ? await launchIdentities(db, found.launch) : []}
      answer={answer}
      notice={query.ok}
      error={query.error}
      filterState={query.state ?? 'all'}
      filterQuery={query.q ?? ''}
    />,
    answer.refused ? 422 : 200,
  );
}

/** The scope a workspace page's address names, or nothing: an unknown one is a 404. */
async function scopeFor(db: Db, userId: string, slug: string, project?: string): Promise<Scope | undefined> {
  const access = await teamForUser(db, userId, slug);
  if (!access) return undefined;
  const team = { id: access.team.id, slug: access.team.slug, name: access.team.name, role: access.role };
  const all = await workspaceProjects(db, team.id);
  if (project === undefined) return { team, project: null, projects: all };
  const found = await projectForTeam(db, team.id, project);
  if (!found) return undefined;
  return { team, project: { id: found.id, slug: found.slug, name: found.name }, projects: all };
}

const pageQuery = (c: Context<AppEnv>) => ({
  launch: c.req.query('launch'),
  state: c.req.query('state'),
  q: c.req.query('q'),
  ok: c.req.query('ok'),
  error: c.req.query('error'),
});

connectionsRoutes.get('/app/teams/:slug/connections', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const scope = await scopeFor(db, user.id, c.req.param('slug'));
  if (!scope) return c.notFound();
  // A picker can only write `?project=`; the project's own address is the page.
  const filtered = (c.req.query('project') ?? '').trim();
  if (filtered) {
    const inside = await projectForTeam(db, scope.team.id, filtered);
    if (inside) {
      const params = new URLSearchParams(
        Object.entries(pageQuery(c)).filter((entry): entry is [string, string] => Boolean(entry[1])),
      );
      const rest = params.toString();
      return c.redirect(`${connectionsHref(scope.team.slug, inside.slug)}${rest ? `?${rest}` : ''}`, 303);
    }
  }
  return renderConnections(c, scope, {}, pageQuery(c));
});

connectionsRoutes.get('/app/teams/:slug/projects/:project/connections', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const scope = await scopeFor(c.get('db'), user.id, c.req.param('slug'), decodeURIComponent(c.req.param('project')));
  if (!scope) return c.notFound();
  return renderConnections(c, scope, {}, pageQuery(c));
});

/**
 * The old address, kept as a door. It is printed by agents' refusals, by the
 * CLI and in emails already sent, and none of those know which workspace the
 * reader means: one workspace is the answer, several are a choice, none is the
 * way to make one.
 */
connectionsRoutes.get('/app/tokens', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const carried = new URLSearchParams();
  for (const key of ['ok', 'error', 'state', 'q'] as const) {
    const value = c.req.query(key);
    if (value) carried.set(key, value.slice(0, 500));
  }
  const rest = carried.toString() ? `?${carried}` : '';
  const named = (c.req.query('team') ?? '').trim();
  if (named) {
    const access = await teamForUser(db, user.id, named);
    if (access) {
      const project = c.req.query('project')
        ? await projectForTeam(db, access.team.id, c.req.query('project')!)
        : undefined;
      return c.redirect(`${connectionsHref(access.team.slug, project?.slug ?? null)}${rest}`, 303);
    }
  }
  const found = await memberWorkspaces(db, user.id);
  if (found.length === 1) return c.redirect(`${connectionsHref(found[0]!.slug)}${rest}`, 303);
  return renderAccount(c);
});

/**
 * Where a write made from the page answers: the scope it was made in. The page
 * sends `back_team` and `back_project`; `filter_team` and `filter_project` are
 * what the account page used to send, still read for a tab opened before this.
 */
async function answerScope(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
  fallback?: { team: Workspace; project: ProjectRef | null },
): Promise<Scope | undefined> {
  const db = c.get('db');
  const user = c.get('user')!;
  const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim().slice(0, 300) : '');
  const teamSlug = text('back_team') || text('filter_team');
  if (teamSlug) {
    const projectRef = text('back_project') || text('filter_project');
    const scope = await scopeFor(db, user.id, teamSlug, projectRef || undefined);
    if (scope) return scope;
    const workspaceOnly = await scopeFor(db, user.id, teamSlug);
    if (workspaceOnly) return workspaceOnly;
  }
  if (fallback) {
    return { team: fallback.team, project: fallback.project, projects: await workspaceProjects(db, fallback.team.id) };
  }
  const [first] = await memberWorkspaces(db, user.id);
  return first ? { team: first, project: null, projects: await workspaceProjects(db, first.id) } : undefined;
}

/**
 * The one door that issues a connection: the connect command and the legacy
 * prompt from the page, and the older direct-POST contract, which the forms
 * never use (a bare `name` still mints a legacy token, and `personal` access is
 * still honoured for a caller that sends it). The page offers neither: a
 * connection is made inside a workspace.
 */
connectionsRoutes.post('/app/tokens', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : '';
  if (body.device === undefined && body.access === undefined && name) {
    const pat = generatePat();
    await db.insert(tokens).values({ userId: user.id, name, tokenHash: pat.hash, prefix: pat.prefix });
    const scope = await answerScope(c, body);
    if (!scope) return renderAccount(c, { legacyToken: pat.token });
    return renderConnections(c, scope, { legacyToken: pat.token });
  }
  const terminal = body.mode === 'terminal';
  const refuse = async (error: string, fallback?: { team: Workspace; project: ProjectRef | null }) => {
    const scope = await answerScope(c, body, fallback);
    if (!scope) return renderAccount(c, { error });
    return renderConnections(c, scope, { refused: { error, terminal, typed: body } });
  };
  const asked = readConnectRequest(body, { terminal });
  if ('error' in asked) return refuse(asked.error);
  const { device, client, role } = asked;
  const workspaces = await memberWorkspaces(db, user.id);
  if (workspaces.length === 0) return refuse('Create a workspace before connecting an agent.');
  const access = typeof body.access === 'string' ? body.access : '';
  let scope: TokenScope;
  let team: Workspace | undefined;
  let project: ProjectRef | undefined;
  if (access === 'personal') {
    scope = 'personal';
  } else if (access.startsWith('team:')) {
    scope = 'team';
    team = workspaces.find((ws) => ws.id === access.slice('team:'.length));
  } else if (access.startsWith('project:')) {
    scope = 'project';
    const projectId = access.slice('project:'.length);
    if (isCanonicalUuid(projectId)) {
      const [row] = await db
        .select({ id: projects.id, slug: projects.slug, name: projects.name, teamId: projects.teamId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      team = row ? workspaces.find((ws) => ws.id === row.teamId) : undefined;
      project = row && team ? { id: row.id, slug: row.slug, name: row.name } : undefined;
    }
  } else {
    return refuse('Choose an access boundary for this agent.');
  }
  if (terminal && scope !== 'project') {
    return refuse('A connect command is for one project: its hooks belong to one checkout.');
  }
  if ((scope !== 'personal' && !team) || (scope === 'project' && !project)) {
    return refuse('That workspace or project is no longer available to your account.');
  }
  const issued = await createAgentEnrollment(db, {
    userId: user.id,
    name,
    deviceLabel: device,
    clientType: client,
    role,
    scope,
    teamId: team?.id,
    projectId: project?.id,
    ...(terminal ? { ttlMinutes: TERMINAL_CONNECT_TTL_MINUTES } : {}),
  });
  // The code is shown once, so this answers with a page rather than a redirect,
  // in the scope the form was posted from.
  const at = await answerScope(c, body, team ? { team, project: project ?? null } : undefined);
  if (!at) return renderAccount(c);
  return renderConnections(c, at, {
    issued: { enrollment: issued.enrollment, code: issued.code, terminal, team: team ?? null, project: project ?? null },
  });
});

/**
 * Where revoke and pairing answer: back on the page they were pressed on, with
 * its name search kept and every state shown, so the row just revoked stays in
 * view instead of vanishing from an "active" filter.
 */
async function connectionReturn(c: Context<AppEnv>, message: string, ok = true) {
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const params = new URLSearchParams({ [ok ? 'ok' : 'error']: message });
  const q = typeof body.back_q === 'string' ? body.back_q : typeof body.filter_q === 'string' ? body.filter_q : '';
  if (q) params.set('q', q.slice(0, 100));
  const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim().slice(0, 300) : '');
  const teamSlug = text('back_team') || text('filter_team');
  if (teamSlug) {
    const scope = await scopeFor(c.get('db'), c.get('user')!.id, teamSlug, (text('back_project') || text('filter_project')) || undefined)
      ?? await scopeFor(c.get('db'), c.get('user')!.id, teamSlug);
    if (scope) return c.redirect(`${connectionsHref(scope.team.slug, scope.project?.slug ?? null)}?${params}#connections`);
  }
  return c.redirect(`/app/tokens?${params}`);
}

connectionsRoutes.post('/app/enrollments/:id/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (!isCanonicalUuid(c.req.param('id'))) return c.notFound();
  const db = c.get('db');
  const enrollmentId = c.req.param('id');
  const revoked = await revokePendingEnrollment(db, user.id, enrollmentId);
  if (revoked[0]) {
    return connectionReturn(c, 'Unused setup code revoked. No credential was created by it.');
  }
  // The page may still show the pending-code control when redemption wins in
  // another process. Revoke must follow the user's selected enrollment to the
  // installation it just created; making them find and click a second row
  // leaves live access behind after an apparently successful revoke flow.
  const [activated] = await db
    .select({ installationId: agentEnrollments.installationId })
    .from(agentEnrollments)
    .where(and(eq(agentEnrollments.id, enrollmentId), eq(agentEnrollments.userId, user.id)))
    .limit(1);
  if (activated?.installationId) {
    const result = await revokeAgentInstallation(db, user.id, activated.installationId);
    logLine({
      evt: 'agent_enrollment',
      a: 'revoke_followed_activation',
      enrollment: enrollmentId,
      installation: activated.installationId,
      alreadyInactive: 'error' in result,
    });
    return connectionReturn(
      c,
      'Setup activated before this page refreshed. Its agent connection and server credential are revoked.',
    );
  }
  return connectionReturn(
    c,
    'That setup code was expired, already revoked, or was not yours. No active connection was found for it.',
    false,
  );
});

connectionsRoutes.post('/app/tokens/:id/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (!isCanonicalUuid(c.req.param('id'))) return c.notFound();
  const db = c.get('db');
  const linked = await db
    .select({ id: agentInstallations.id })
    .from(agentInstallations)
    .where(and(eq(agentInstallations.tokenId, c.req.param('id')), eq(agentInstallations.userId, user.id)))
    .limit(1);
  if (linked[0]) {
    const result = await revokeAgentInstallation(db, user.id, linked[0].id);
    logLine({
      evt: 'agent_connection',
      a: 'revoked',
      installation: linked[0].id,
      alreadyInactive: 'error' in result,
      via: 'connections_page',
    });
    return connectionReturn(c, 'Server access revoked. Remove the local MCP entry and reload that client to disconnect fully.');
  }
  await db
    .update(tokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(tokens.id, c.req.param('id')), eq(tokens.userId, user.id)));
  return connectionReturn(c, 'Server access revoked. Remove the local MCP entry and reload that client to disconnect fully.');
});

/**
 * Pair one of your local adapters with the agent it sits beside, or unpair it.
 *
 * Its own route rather than a field on consent alone, because every adapter
 * activated before the pairing existed is already installed and working: the
 * only other way to pair one would be to activate it again, which mints a
 * second installation to deliver a label. Every rule (yours, live, an adapter,
 * a reachable agent) is `setCompanion`'s; this handler only carries the answer.
 */
connectionsRoutes.post('/app/installations/:id/companion', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (!isCanonicalUuid(c.req.param('id'))) return c.notFound();
  const body = await c.req.parseBody();
  const requested = typeof body.companion === 'string' ? body.companion.trim() : '';
  if (requested !== 'none' && !isCanonicalUuid(requested)) {
    return connectionReturn(c, 'Choose the agent this adapter listens for, or Nobody to unpair it.', false);
  }
  const result = await setCompanion(c.get('db'), user.id, c.req.param('id'), requested === 'none' ? null : requested);
  if ('error' in result) return connectionReturn(c, result.error, false);
  logLine({
    evt: 'agent_connection',
    a: result.companion ? 'paired' : 'unpaired',
    installation: result.adapter.id,
    companionOf: result.companion?.installationId,
    via: 'connections_page',
  });
  return connectionReturn(
    c,
    result.companion
      ? `${result.adapter.name} now listens for ${result.companion.name}: its prompt hook announces work assigned to ${result.companion.name}, an edit its guard stops is filed under ${result.companion.name}, and ${result.companion.name} may update, finish and hand off the runs these hooks start. It still cannot accept work itself or touch that agent's own runs.`
      : `${result.adapter.name} is no longer paired. Its hooks keep guarding the checkout; the agent beside it hears about assigned work only when somebody asks it to read its inbox, and is refused from its next call on the runs these hooks start.`,
  );
});

// ---------------------------------------------------------------- the test

/** The test used to be its own page per workspace; it is the page's second section. */
connectionsRoutes.get('/app/teams/:slug/setup', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const access = await teamForUser(c.get('db'), user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  return c.redirect(`${connectionsHref(access.team.slug)}#test`, 303);
});

/** Start a test, or resume the one already running in this scope. */
connectionsRoutes.post('/app/launches', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const body = await c.req.parseBody();
  const team = typeof body.team === 'string' ? body.team.trim().slice(0, 120) : '';
  const projectRef = typeof body.project === 'string' ? body.project.trim().slice(0, 300) : '';
  const intent = body.intent === 'teammates' ? 'teammates' : body.intent === undefined || body.intent === 'my_agents' ? 'my_agents' : undefined;
  if (!team || !intent) return c.text('Select a workspace on the connection page first.', 400);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, team);
  if (!access) return c.notFound();
  const project = projectRef ? await projectForTeam(db, access.team.id, projectRef) : null;
  if (projectRef && !project) return c.notFound();
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
          eq(launchAttempts.intent, intent),
        ),
      )
      .orderBy(desc(launchAttempts.createdAt))
      .limit(1);
    if (existing && body.fresh !== 'yes') return existing;
    return (
      await tx
        .insert(launchAttempts)
        .values({ userId: user.id, teamId: access.team.id, projectId: project?.id ?? null, intent })
        .returning()
    )[0]!;
  });
  return c.redirect(`${connectionsHref(access.team.slug, project?.slug ?? null)}?launch=${launch.id}#test`, 303);
});

/** A test's own address, from before it was a section: its scope's page, opened on it. */
connectionsRoutes.get('/app/launches/:id', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (!isCanonicalUuid(c.req.param('id'))) return c.notFound();
  const db = c.get('db');
  const launch = await launchForViewer(db, c.req.param('id'), user.id);
  if (!launch) return c.notFound();
  return c.redirect(await launchHref(db, launch), 303);
});

connectionsRoutes.get('/app/launches/:id/status', async (c) => {
  const user = c.get('user');
  if (!user || !isCanonicalUuid(c.req.param('id'))) return c.notFound();
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
