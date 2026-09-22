import { randomUUID } from 'node:crypto';
import { accountDeleted, membershipUser } from '../lib/securityHooks';
import {
  ACTIVE_AGENT_RUN_STATUSES,
  AGENT_CLIENT_TYPES,
  AGENT_ROLES,
  type AgentClientType,
} from '@bridge/shared';
import { and, count, countDistinct, desc, eq, gt, inArray, isNull, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Db } from '../db';
import {
  activity,
  agentEnrollments,
  agentEvents,
  agentInstallations,
  agentRuns,
  debugSessions,
  deliveryFlows,
  environmentBaselines,
  invites,
  memberships,
  messages,
  policyBundles,
  policyReceipts,
  projects,
  readState,
  snapshots,
  teams,
  tokens,
  users,
  webSessions,
  workClaims,
} from '../db/schema';
import { accessCodeRequired } from '../auth/accessCodes';
import {
  currentSessionId,
  destroySession,
  invalidateAllSessions,
  invalidateOtherSessions,
  loginRedirect,
  revokeSession,
  sessionHandle,
  sessionsFor,
  type BrowserSession,
} from '../auth/session';
import { generatePat } from '../auth/pat';
import { checkUserCode, CODE_TTL_MINUTES, issueAuthCode } from '../auth/codes';
import { hashPassword, randomCode, randomHex, verifyPassword } from '../lib/crypto';
import {
  DEFAULT_DEVICE,
  devicesByMember,
  lastSnapshotOf,
  type DeviceSummary,
} from '../lib/devices';
import { effectiveLimits, effectivePlanLabel } from '../lib/entitlements';
import { logLine } from '../lib/log';
import {
  hasNoOwner,
  recordMembershipChange,
  recordMembershipChanges,
} from '../lib/memberships';
import {
  emailChangeCodeEmail,
  emailChangedNotice,
  emailVerifyCodeEmail,
  failedSignInsEmail,
  passwordChangeCodeEmail,
  passwordChangedEmail,
  sendMail,
} from '../lib/mailer';
import {
  LOGIN_FAIL_WINDOW_MS,
  clearLoginFailures,
  lockedMessage,
  loginGate,
  recordLoginFailure,
} from '../auth/attempts';
 import { emailIsFree, isEmail, normalizeEmail } from '../lib/email';
import { agentConnectPrompt } from '../lib/agentConnect';
import { mcpConnectPrompt, mcpServerAlias } from '../lib/mcpConnectPrompt';
import { FirstExchange } from '../ui/FirstExchange';
import { ConnectCheckoutForm, ConnectCommand } from '../ui/ConnectAgent';
import { connectCommandFor, readConnectRequest } from '../domain/connectRequests';
import {
  AGENT_ENROLLMENT_TTL_MINUTES,
  TERMINAL_CONNECT_TTL_MINUTES,
  createAgentEnrollment,
  revokePendingEnrollment,
} from '../domain/enrollments';
import { grantLabel, type TokenScope } from '../lib/grants';
import {
  githubForTeam,
  adoForTeam,
  countIntegrations,
  clickupBindingsForTeam,
  clickupConnectionForTeam,
  clickupForTeam,
  integrationFor,
  jiraForTeam,
  recordClickupCheck,
  removeClickupBinding,
  removeGithubIntegration,
  removeIntegration,
  saveGithubIntegration,
  saveClickupBinding,
  saveIntegration,
  setClickupCommentOnFinish,
  setClickupPaused,
} from '../domain/integrations';
import { claimInviteMembership } from '../domain/invites';
import { revokeAgentInstallation } from '../domain/agents';
import { connectionPairings, setCompanion, type ConnectionPairing } from '../domain/companions';
import { adoHealth, adoLocator, describeAdoFailure, parseAdoLocator } from '../lib/azureDevops';
import { checkJiraConnection, describeJiraFailure, normalizeJiraSite } from '../lib/jira';
import { AdoTokenHelp, JiraTokenHelp } from '../ui/TokenHelp';
import { listOpenIssues } from '../lib/github';
import {
  clickupAuthorizeUrl,
  exchangeClickupCode,
  getClickupWorkspaces,
  listClickupLists,
  openClickupPending,
  sealClickupPending,
} from '../lib/clickup';
import { isSafeWebhookUrl } from '../lib/notify';
import { notifyTeamJoined } from '../lib/notifications';
import { fmtDate, initials, timeAgo } from '../lib/format';
import { ensureRail, workspaceCounters } from '../lib/rail';
import { slugify } from '../lib/slug';
import { track } from '../lib/track';
import type { AppEnv, User } from '../types';
import { Field, Lead, PageHead, teamTrail, Vr } from '../ui/Console';
import { AppLayout, Head, Logo } from '../ui/Layout';
import { Landing } from '../ui/Landing';
import { siteInfo } from '../ui/Site';
import { ProjectCreateBar } from '../ui/ProjectCreate';
import { Mail } from '../ui/Mail';

export const dashboardRoutes = new Hono<AppEnv>();

const DAY = 24 * 60 * 60 * 1000;

async function teamForMember(db: Db, slug: string, userId: string) {
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(and(eq(teams.slug, slug), membershipUser(userId)))
    .limit(1);
  return rows[0];
}

type TokenProject = { id: string; name: string; slug: string };
type TokenTeam = {
  id: string;
  name: string;
  slug: string;
  role: string;
  projects: TokenProject[];
};

/** Teams a personal machine token may act in, also used by the setup prompt picker. */
async function tokenTeamsFor(db: Db, userId: string): Promise<TokenTeam[]> {
  const rows = await db
    .select({ id: teams.id, name: teams.name, slug: teams.slug, role: memberships.role })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(membershipUser(userId))
    .orderBy(teams.name);
  if (rows.length === 0) return [];
  const projectRows = await db
    .select({ id: projects.id, teamId: projects.teamId, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.teamId, rows.map((team) => team.id)))
    .orderBy(projects.name);
  return rows.map((team) => ({
    ...team,
    projects: projectRows
      .filter((project) => project.teamId === team.id)
      .map(({ id, name, slug }) => ({ id, name, slug })),
  }));
}

async function enrollmentRowsFor(db: Db, userId: string) {
  return db
    .select({ enrollment: agentEnrollments, team: teams, project: projects })
    .from(agentEnrollments)
    .leftJoin(teams, eq(agentEnrollments.teamId, teams.id))
    .leftJoin(projects, eq(agentEnrollments.projectId, projects.id))
    .where(
      and(
        eq(agentEnrollments.userId, userId),
        isNull(agentEnrollments.redeemedAt),
        isNull(agentEnrollments.revokedAt),
        gt(agentEnrollments.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(agentEnrollments.createdAt))
    .limit(50);
}

async function validInvite(db: Db, code: string) {
  const rows = await db
    .select({ invite: invites, team: teams })
    .from(invites)
    .innerJoin(teams, eq(invites.teamId, teams.id))
    .where(eq(invites.code, code))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  if (row.invite.expiresAt <= new Date()) return undefined;
  if (row.invite.maxUses != null && row.invite.uses >= row.invite.maxUses) return undefined;
  return row;
}

/**
 * Member ids arrive as path parameters. Comparing a non-uuid against a uuid column
 * is a database error, not an empty result, so shape is checked before querying:
 * "not a member id" and "no such member" are the same 404 to the caller.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownerCount(db: Db, teamId: string) {
  const rows = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), eq(memberships.role, 'owner')));
  return rows[0]?.n ?? 0;
}

const Banner = ({ kind, text }: { kind: 'error' | 'success'; text: string }) => (
  <div class={`banner banner-${kind}`}>
    <span class="ic">{kind === 'error' ? '!' : '✓'}</span>
    <span>{text}</span>
    <button class="x" type="button" data-dismiss="t">
      ×
    </button>
  </div>
);

/**
 * Promote a member to owner, or hand ownership back down. Ownership is the only
 * exit from a one-owner team: without it the sole owner can neither leave nor be
 * replaced, and deleting the team is the only way out.
 */
const RoleForm = ({
  teamSlug,
  teamName,
  member,
  memberId,
  to,
  self = false,
}: {
  teamSlug: string;
  teamName: string;
  member: string;
  memberId: string;
  to: 'owner' | 'member';
  /** The viewer stepping down from their own ownership. */
  self?: boolean;
}) => {
  const label = to === 'owner' ? 'Make owner' : self ? 'Step down' : 'Demote';
  const body =
    to === 'owner'
      ? `${member} will be able to invite and remove members, publish policy, change team settings and delete the team.`
      : self
        ? `You keep access to ${teamName} as a member, but lose owner-only actions. Another owner has to promote you back.`
        : `${member} keeps access to ${teamName} as a member, but loses owner-only actions.`;
  return (
    <form
      class="m0"
      method="post"
      action={`/app/teams/${teamSlug}/members/${memberId}/role`}
      data-confirm={body}
      data-confirm-title={
        to === 'owner' ? `Make ${member} an owner of ${teamName}?` : self ? 'Step down to member?' : `Demote ${member} to member?`
      }
      data-confirm-action={label}
    >
      <input type="hidden" name="role" value={to} />
      <button class="linklike plain" type="submit">
        {label}
      </button>
    </form>
  );
};

const SnapshotCell = ({ last }: { last: Date | null | undefined }) =>
  last ? (
    <span class="with-dot">
      <span class={`dot${Date.now() - last.getTime() < DAY ? '' : ' gray'}`} />
      <span class="muted">{timeAgo(last)}</span>
    </span>
  ) : (
    <span style="color:var(--mut-2)">No snapshot yet</span>
  );

/** Named machines behind a member's snapshots — silent for a single unnamed one. */
const DeviceNames = ({ devices }: { devices: DeviceSummary[] }) =>
  devices.length > 1 || (devices[0] && devices[0].device !== DEFAULT_DEVICE) ? (
    <div class="mono" style="font-size:11px;color:var(--mut-2);margin-top:2px">
      {devices.map((d) => d.device).join(' · ')}
    </div>
  ) : null;


// ---------------------------------------------------------------- landing

dashboardRoutes.get('/', (c) => {
  if (c.get('user')) return c.redirect('/app');
  // One page in both site modes; only the doors differ (ui/Landing.tsx).
  return c.html(<Landing site={siteInfo(c)} baseUrl={c.get('env').baseUrl} />);
});

// ---------------------------------------------------------------- teams

dashboardRoutes.get('/app', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(membershipUser(user.id))
    .orderBy(teams.name);
  const teamIds = rows.map((r) => r.team.id);
  const lastSnaps = teamIds.length
    ? await db
        .select({ teamId: snapshots.teamId, last: max(snapshots.createdAt) })
        .from(snapshots)
        .where(inArray(snapshots.teamId, teamIds))
        .groupBy(snapshots.teamId)
    : [];
  const lastByTeam = new Map(lastSnaps.map((s) => [s.teamId, s.last]));
  // How much is in each one — the first question anybody asks of a list of teams.
  const projectCounts = teamIds.length
    ? await db
        .select({ teamId: projects.teamId, n: count() })
        .from(projects)
        .where(inArray(projects.teamId, teamIds))
        .groupBy(projects.teamId)
    : [];
  const projectsByTeam = new Map(projectCounts.map((r) => [r.teamId, r.n]));
  // What is going on in each one. This list replaced the rail's "across workspaces"
  // agent map, work and sessions: one ledger of every workspace answered "is anything
  // happening" and left every row ambiguous about where. A number per workspace,
  // each a link into that workspace's own page, answers it without the mixing.
  const counters = await workspaceCounters(db, user.id, teamIds);
  const error = c.req.query('error');
  const notice = c.req.query('ok');
  // A rejected create comes back here; hand the typing back rather than making
  // somebody retype a name because the tag they chose was taken.
  const draftName = c.req.query('name');
  const draftTag = c.req.query('tag');
  const draftWebhook = c.req.query('webhook_url');

  return c.html(
    <AppLayout user={user} active="teams" title="Workspaces">
      {error ? <Banner kind="error" text={error} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}
      <div class="page-head">
        <div>
          <h1 class="title">Workspaces</h1>
          <p>
            A workspace is for just you and your agents, or for several people.{' '}
            {c.get('env').betaUnmetered
              ? 'While the beta runs every workspace has every feature, so there is nothing to choose here.'
              : 'Team is a paid plan, not a required setup step.'}
          </p>
        </div>
        <button class="btn btn-primary" type="button" data-open-dialog="#new-team">
          New workspace
        </button>
      </div>

      {rows.length === 0 ? (
        <div class="card">
          <div class="empty">
            <span class="tile tile-52 tile-dashed">
              <span class="bar" />
            </span>
            <h2>Start with one workspace</h2>
            <p>
              Just connecting your own computers? Choose <b>New workspace</b>, name it “My workspace”,
              then connect each agent. No teammate invitation needed. Joining someone else?
              Open the invite link they sent you.
            </p>
            <button class="btn btn-primary" type="button" data-open-dialog="#new-team">
              New workspace
            </button>
          </div>
        </div>
      ) : (
        <div class="card scroll-x">
          <table class="tbl">
            <tr>
              <th>Workspace</th>
              <th>Role</th>
              <th>Projects</th>
              <th title="Agent runs that are live right now">Working now</th>
              <th title="Assigned or handed-over work nobody has finished">Work open</th>
              <th title="Open sessions holding a message you have not read">Unread</th>
              <th class="hide-sm">Last snapshot</th>
              <th></th>
            </tr>
            {rows.map((r) => (
              <tr>
                <td>
                  <div class="cellrow">
                    <span class={`tile tile-28 ${r.role === 'owner' ? 'tile-green' : 'tile-gray'}`}>
                      {initials(r.team.name)}
                    </span>
                    <div>
                      <a class="name" href={`/app/teams/${r.team.slug}`}>
                        {r.team.name}
                      </a>
                      <div class="mono small muted">{r.team.slug}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <span class={`pill ${r.role === 'owner' ? 'pill-owner' : 'pill-member'}`}>{r.role}</span>
                </td>
                <td>
                  <a href={`/app/teams/${r.team.slug}/projects`}>
                    {projectsByTeam.get(r.team.id) ?? 0}
                  </a>
                </td>
                {(
                  [
                    ['runs', `/app/agents?team=${encodeURIComponent(r.team.slug)}`],
                    ['work', `/app/handoffs?team=${encodeURIComponent(r.team.slug)}`],
                    ['unread', `/app/sessions?team=${encodeURIComponent(r.team.slug)}`],
                  ] as const
                ).map(([key, href]) => {
                  const n = counters.get(r.team.id)?.[key] ?? 0;
                  return (
                    <td class="mono">
                      {n > 0 ? <a href={href}>{n}</a> : <span class="muted">0</span>}
                    </td>
                  );
                })}
                <td class="hide-sm">
                  <SnapshotCell last={lastByTeam.get(r.team.id) ?? null} />
                </td>
                <td style="text-align:right">
                  <a class="chev" href={`/app/teams/${r.team.slug}`}>
                    ›
                  </a>
                </td>
              </tr>
            ))}
          </table>
        </div>
      )}

      {/* One button, one dialog. There used to be a "New team" link that jumped to
          an anchor and a separate "Create team" form under it: on a short page
          the jump moved nothing, so the button looked broken and the real
          control was somewhere else entirely. */}
      <dialog id="new-team" class="formdlg">
        <h3>New workspace</h3>
        <p class="dlgsub">
          A workspace is not a subscription. It can be just you and your agents.
          Only the name is needed; optional settings can wait.
          Members can see each other's shared runs, snapshots and sessions.
        </p>
        <form method="post" action="/app/teams">
          <Field
            id="team-name"
            label="Workspace name"
            required
            help="For example, My workspace. 1–60 characters."
          >
            <input
              class="in"
              id="team-name"
              type="text"
              name="name"
              maxlength={60}
              value={draftName ?? ''}
              placeholder="My workspace"
              required
              aria-required="true"
              aria-describedby="team-name-help"
              autofocus
            />
          </Field>
          <details open={Boolean(draftTag || draftWebhook)}><summary>Advanced settings (optional)</summary>
          <Field
            id="team-tag"
            label="Tag"
            help="The short id in URLs and in every agent's config, e.g. /app/teams/payments. Lowercase letters, digits and dashes. Left blank, it is derived from the name."
          >
            <input
              class="in"
              id="team-tag"
              type="text"
              name="tag"
              maxlength={40}
              value={draftTag ?? ''}
              placeholder="derived from the name"
              pattern="[A-Za-z0-9][A-Za-z0-9 _-]*"
              aria-describedby="team-tag-help"
            />
          </Field>
          <Field
            id="team-webhook"
            label="Team chat webhook"
            help="A Slack or Discord incoming webhook for the whole team's feed. Each person can also set their own on the notifications page."
          >
            <input
              class="in"
              id="team-webhook"
              type="url"
              name="webhook_url"
              value={draftWebhook ?? ''}
              placeholder="https://hooks.slack.com/services/…"
              aria-describedby="team-webhook-help"
            />
          </Field>
          </details>
          <div class="dialog-actions">
            <button class="btn" type="button" data-close-dialog="t">
              Cancel
            </button>
            <button class="btn btn-primary" type="submit">
              Create workspace
            </button>
          </div>
        </form>
      </dialog>
    </AppLayout>,
  );
});

dashboardRoutes.post('/app/teams', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const body = await c.req.parseBody();
  const str = (key: string, max: number): string =>
    typeof body[key] === 'string'
      ? // Flattened, not merely trimmed. A workspace name is interpolated into
        // notification subjects, and a subject is a header: today the only
        // transport is Resend over HTTP, where JSON.stringify escapes the
        // newline, so this is latent rather than live — which is exactly when
        // it is cheap to close. Control characters are stripped everywhere for
        // the same reason the session title is flattened before it is sent.
        (body[key] as string).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
      : '';
  const name = str('name', 200);
  const tag = str('tag', 60);
  const webhookUrl = str('webhook_url', 500);

  // Every rejection hands the form back, because the alternative is retyping
  // three fields to fix one of them.
  const reject = (message: string) => {
    const back = new URLSearchParams({ error: message });
    if (name) back.set('name', name);
    if (tag) back.set('tag', tag);
    if (webhookUrl) back.set('webhook_url', webhookUrl);
    return c.redirect(`/app?${back.toString()}`);
  };

  if (!name || name.length > 60) return reject('Team name must be 1-60 characters.');
  if (webhookUrl && !isSafeWebhookUrl(webhookUrl, env.nodeEnv === 'production')) {
    return reject('The team webhook must be a public https:// address, or left blank.');
  }

  let slug: string;
  if (tag) {
    // A tag somebody chose is not a suggestion. slugify() never fails — a name
    // with no Latin characters falls back to a "p-8f3a21" digest, which is the
    // right escape hatch for a slug derived from a name and the wrong answer for
    // a tag somebody typed: they would find out from the URL bar.
    if (!/[A-Za-z0-9]/.test(tag)) {
      return reject('The tag needs at least one letter (a-z) or digit.');
    }
    slug = slugify(tag);
    const clash = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug)).limit(1);
    if (clash.length > 0) return reject(`The tag "${slug}" is taken. Pick another one.`);
  } else {
    slug = slugify(name);
    const taken = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug)).limit(1);
    if (taken.length > 0) slug = `${slug}-${randomHex(2)}`;
  }

  const inserted = await db
    .insert(teams)
    .values({
      name,
      slug,
      createdBy: user.id,
      inboundToken: randomCode(16),
      webhookUrl: webhookUrl || null,
    })
    .returning();
  const team = inserted[0]!;
  await db.insert(memberships).values({ teamId: team.id, userId: user.id, role: 'owner' });
  // The first row of every workspace's access history, so the history explains
  // itself: whoever is the owner and never joined is the person who created it.
  await recordMembershipChange(db, {
    teamId: team.id,
    teamSlug: team.slug,
    action: 'added',
    subjectId: user.id,
    subjectLabel: user.username,
    previousRole: null,
    nextRole: 'owner',
    source: 'self',
    route: 'POST /app/teams',
    actorId: user.id,
    actorLabel: user.username,
    detail: 'created the workspace',
  });
  await c.get('lifecycle').teamMemberCountChanged?.({ db, teamId: team.id });
  return c.redirect(`/app/teams/${team.slug}`);
});

dashboardRoutes.get('/app/teams/:slug', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) {
    return c.html(
      <AppLayout user={user} active="teams" title="Not found">
        <div class="card card-pad joincard">
          <span class="tile tile-44 tile-gray">×</span>
          <h2 class="title m0">Team not found</h2>
          <p class="m0 sub">Either it does not exist or you are not a member.</p>
          <a class="btn" href="/app" style="align-self:flex-start">
            Back to teams
          </a>
        </div>
      </AppLayout>,
      404,
    );
  }
  const { team, role } = found;
  const TABS = (
    role === 'owner'
      ? ['overview', 'people', 'integrations', 'settings']
      : ['overview', 'people', 'settings']
  ) as readonly ('overview' | 'people' | 'integrations' | 'settings')[];
  const asked = c.req.query('tab');
  const tab = (TABS as readonly string[]).includes(asked ?? '')
    ? (asked as 'overview' | 'people' | 'integrations' | 'settings')
    : 'overview';
  const members = await db
    .select({ member: users, role: memberships.role, joined: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.teamId, team.id))
    .orderBy(memberships.createdAt);
  const owners = members.filter((m) => m.role === 'owner').length;
  // Invite URLs grant membership, so only owners should even receive them in
  // rendered HTML. The POST handlers independently enforce the same boundary.
  const activeInvites =
    role === 'owner'
      ? await db
          .select({ invite: invites, creator: users.username })
          .from(invites)
          .leftJoin(users, eq(invites.createdBy, users.id))
          .where(and(eq(invites.teamId, team.id), gt(invites.expiresAt, new Date())))
          .orderBy(desc(invites.createdAt))
      : [];
  const devicesByUser = await devicesByMember(db, team.id);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const teamProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name);
  const pids = teamProjects.map((p) => p.id);
  const openByProject = new Map<string, number>();
  const snapByProject = new Map<string, Date | null>();
  const agentsByProject = new Map<string, number>();
  if (pids.length > 0) {
    for (const r of await db
      .select({ pid: debugSessions.projectId, n: count() })
      .from(debugSessions)
      .where(and(inArray(debugSessions.projectId, pids), eq(debugSessions.status, 'open')))
      .groupBy(debugSessions.projectId)) {
      if (r.pid) openByProject.set(r.pid, r.n);
    }
    for (const r of await db
      .select({ pid: snapshots.projectId, last: max(snapshots.createdAt) })
      .from(snapshots)
      .where(inArray(snapshots.projectId, pids))
      .groupBy(snapshots.projectId)) {
      if (r.pid) snapByProject.set(r.pid, r.last);
    }
    for (const r of await db
      .select({ pid: agentRuns.projectId, n: countDistinct(agentRuns.installationId) })
      .from(agentRuns)
      .where(and(inArray(agentRuns.projectId, pids), gt(agentRuns.lastHeartbeatAt, weekAgo)))
      .groupBy(agentRuns.projectId)) {
      if (r.pid) agentsByProject.set(r.pid, r.n);
    }
  }
  // Three bounded counts for the health card. Each is the same predicate the
  // page that owns it uses, so the card cannot claim something those pages deny.
  const liveRuns =
    (
      await db
        .select({ n: count() })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.teamId, team.id),
            inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]),
          ),
        )
    )[0]?.n ?? 0;
  const driftCount =
    (
      await db
        .select({ n: count() })
        .from(policyReceipts)
        .innerJoin(agentRuns, eq(policyReceipts.runId, agentRuns.id))
        .where(and(eq(agentRuns.teamId, team.id), eq(policyReceipts.drift, true)))
    )[0]?.n ?? 0;
  const openSessionCount =
    (
      await db
        .select({ n: count() })
        .from(debugSessions)
        .where(and(eq(debugSessions.teamId, team.id), eq(debugSessions.status, 'open')))
    )[0]?.n ?? 0;

  const activeAgentRows = await db
    .select({ n: countDistinct(agentRuns.installationId) })
    .from(agentRuns)
    .where(and(eq(agentRuns.teamId, team.id), gt(agentRuns.lastHeartbeatAt, weekAgo)));
  const activeAgents7d = activeAgentRows[0]?.n ?? 0;

  const settingsError = c.req.query('error');
  const notice = c.req.query('ok');
  const limits = await effectiveLimits(db, team, env.hosted);
  const planLabel = effectivePlanLabel(team.plan, limits);

  // Only an owner can see or change it, and even they never get the token back.
  const github = role === 'owner' ? await githubForTeam(db, team.id) : undefined;
  const ado = role === 'owner' ? await adoForTeam(db, team.id) : undefined;
  const jira = role === 'owner' ? await jiraForTeam(db, team.id) : undefined;
  const clickup = role === 'owner' ? await clickupConnectionForTeam(db, team.id) : undefined;
  // A paused connection is not called at all, which includes drawing its List
  // picker: a pause somebody set because the token is misbehaving must not keep
  // costing them a failed round trip every time the page is opened.
  const clickupLists =
    role === 'owner' && tab === 'integrations' && clickup && !clickup.pausedAt
      ? await listClickupLists(env, clickup.token, clickup.workspaceId)
      : undefined;
  const clickupMappings =
    clickup && tab === 'integrations'
      ? await clickupBindingsForTeam(db, team.id, clickup.bindings)
      : [];

  const machines = [...devicesByUser.values()].reduce((n, list) => n + list.length, 0);

  return c.html(
    <AppLayout
      user={user}
      // The rail lists Members and Integrations as destinations of their own; they are
      // tabs of this page, so the tab decides which rail line is lit.
      active={tab === 'people' ? 'members' : tab === 'integrations' ? 'integrations' : 'team'}
      title={team.name}
      strip={
        <>
          <Lead
            text={`${members.length} ${members.length === 1 ? 'member' : 'members'}`}
            live={activeAgents7d > 0}
          />
          <Vr />
          <span>
            {teamProjects.length} {teamProjects.length === 1 ? 'project' : 'projects'}
          </span>
          <span class="dim">·</span>
          <span>
            {machines} {machines === 1 ? 'machine' : 'machines'}
          </span>
          <span class="dim">·</span>
          <span>{activeAgents7d} agents active (7d)</span>
          <Vr />
          {c.get('capabilities').managedBilling ? (
            <a href={`/app/teams/${team.slug}/plan`}>plan {planLabel}</a>
          ) : env.hosted ? (
            <span>plan {planLabel}</span>
          ) : (
            <span>self-hosted · unmetered</span>
          )}
        </>
      }
      scope={
        <>
          <span class="chip">
            you are <b>{role}</b>
          </span>
          <span class="tile tile-28 tile-green">{initials(team.name)}</span>
        </>
      }
      head={
        <PageHead
          trail={[{ label: 'All workspaces', href: '/app' }, { label: team.name }]}
          title={team.name}
          sub="Your workspace for agent connections, shared sessions and projects."
          actions={
            <>
              <a class={`btn btn-sm${members.length === 1 ? ' btn-primary' : ''}`} href={`/app/tokens?team=${encodeURIComponent(team.slug)}`}>
                Connect agent
              </a>
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/compare`}>
                Compare environments
              </a>
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/governance`}>
                Governance
              </a>
              {/* The invite links live on People now, so the action goes there
                  rather than at an anchor this tab no longer has. */}
              {role === 'owner' ? (
                <a class={`btn btn-sm${members.length > 1 ? ' btn-primary' : ''}`} href={`/app/teams/${team.slug}?tab=people#invites`}>
                  Invite member
                </a>
              ) : null}
            </>
          }
        />
      }
      keys={[
        { k: 'I', label: 'invite' },
        { k: 'T', label: 'new token' },
      ]}
      keysNote="owner-only actions are marked · every membership change writes to activity"
    >
      {settingsError ? <Banner kind="error" text={settingsError} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}

      {tab === 'overview' && members.length === 1 ? (
        <div class="card card-pad" style="margin-bottom:16px">
          <div class="card-title">Just you, two computers?</div>
          <p class="small muted">
            This workspace is ready for one person. Connect each agent with its own prompt and
            the same workspace; no invitation, repository or paid Team subscription is needed
            for your first message.
          </p>
          <a href={`/app/tokens?team=${encodeURIComponent(team.slug)}`}>Connect your agents</a>
          {' · '}<a href="/docs#quickstart">Follow the two-computer quick start</a>
        </div>
      ) : null}

      {/* Projects and people up front; integrations and settings where somebody
          looks for them rather than three screens down the same scroll. Links,
          not script — the tab is in the URL and survives a refresh. */}
      <div class="pagetabs" style="margin:0 0 16px;padding:0;border-bottom:1px solid var(--line)">
        {TABS.map((key) => (
          <a
            class={`tab${tab === key ? ' active' : ''}`}
            href={`/app/teams/${team.slug}${key === 'overview' ? '' : `?tab=${key}`}`}
          >
            {key === 'overview'
              ? 'Overview'
              : key === 'people'
                ? 'People'
                : key === 'integrations'
                  ? 'Integrations'
                  : 'Settings'}
          </a>
        ))}
      </div>

      <div class={tab === 'overview' ? 'grid2' : 'col'}>
        <div class="col">
          {tab === 'overview' ? (
          <div class="card scroll-x">
            <div class="card-head">
              <div>
                <div class="card-title">Projects</div>
                <div class="card-note">
                  Click one — policy, environment, flow and sessions live on its page.
                </div>
              </div>
              <span class="mono muted">{teamProjects.length}</span>
            </div>
            {teamProjects.length === 0 ? (
              <div class="card-pad muted small">
                No projects yet — they appear when an agent pushes a snapshot or opens a session
                with a repo name.
              </div>
            ) : (
              <table class="tbl">
                <tr>
                  <th>Project</th>
                  <th>Open sessions</th>
                  <th>Agents (7d)</th>
                  <th>Last snapshot</th>
                </tr>
                {teamProjects.map((p) => (
                  <tr>
                    <td class="name">
                      <a href={`/app/teams/${team.slug}/projects/${encodeURIComponent(p.slug)}`}>
                        {p.name}
                      </a>
                      {teamProjects.some((other) => other.id !== p.id && other.name === p.name) ? (
                        <div class="mono muted small">
                          {p.repositoryIdentity ? 'repository-bound' : p.slug}
                        </div>
                      ) : null}
                    </td>
                    <td>{openByProject.get(p.id) ?? 0}</td>
                    <td>{agentsByProject.get(p.id) ?? 0}</td>
                    <td class="muted">{timeAgo(snapByProject.get(p.id) ?? null) ?? '—'}</td>
                  </tr>
                ))}
              </table>
            )}
          </div>
          ) : null}

          {tab === 'people' ? (
          <div class="card scroll-x">
            <div class="card-head">
              <span class="card-title">Members</span>
              <span class="mono muted">{members.length}</span>
            </div>
            <table class="tbl">
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Joined</th>
                <th>Last snapshot</th>
                <th></th>
              </tr>
              {members.map((m) => (
                <tr>
                  <td>
                    <div class="cellrow">
                      <span class={`avatar ${m.member.id === user.id ? 'ink' : 'light'}`}>
                        {initials(m.member.username)}
                      </span>
                      <span class="name">
                        {m.member.username}
                        {m.member.id === user.id ? <span class="muted"> (you)</span> : null}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span class={`pill ${m.role === 'owner' ? 'pill-owner' : 'pill-member'}`}>{m.role}</span>
                  </td>
                  <td class="muted">{fmtDate(m.joined)}</td>
                  <td>
                    <SnapshotCell last={lastSnapshotOf(devicesByUser.get(m.member.id))} />
                    <DeviceNames devices={devicesByUser.get(m.member.id) ?? []} />
                  </td>
                  <td>
                    <div class="row" style="justify-content:flex-end;gap:14px">
                      {role === 'owner' && m.member.id !== user.id ? (
                        <RoleForm
                          teamSlug={team.slug}
                          teamName={team.name}
                          member={m.member.username}
                          memberId={m.member.id}
                          // Another member showing as owner means the team already has
                          // two, so demoting them can never empty the role; the last-owner
                          // case is only ever the viewer's own row, below.
                          to={m.role === 'owner' ? 'member' : 'owner'}
                        />
                      ) : null}
                      {role === 'owner' && m.member.id === user.id && owners > 1 ? (
                        <RoleForm
                          teamSlug={team.slug}
                          teamName={team.name}
                          member={m.member.username}
                          memberId={m.member.id}
                          to="member"
                          self
                        />
                      ) : null}
                      {role === 'owner' && m.member.id !== user.id ? (
                        <form
                          class="m0"
                          method="post"
                          action={`/app/teams/${team.slug}/members/${m.member.id}/remove`}
                          data-confirm={`${m.member.username} loses access to this team immediately. Their snapshots, messages and activity stay attributed to them.`}
                          data-confirm-title={`Remove ${m.member.username} from ${team.name}?`}
                          data-confirm-action="Remove member"
                        >
                          <button class="linklike" type="submit">
                            Remove
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </table>
          </div>
          ) : null}

          {tab === 'people' && role === 'owner' ? (
          <div class="card" id="invites">
            <div class="card-head">
              <div>
                <div class="card-title">Invite links</div>
                <div class="card-note">
                  Anyone with the link can join. Choose what it grants: a member reads everything
                  and does the work, an owner can also publish rules, connect providers, spend the
                  plan and remove people.
                </div>
              </div>
              <form method="post" action={`/app/teams/${team.slug}/invites`} class="m0 row" style="gap:8px;align-items:center">
                {/* The role is chosen where the link is made, not where it is
                    used: the person clicking it has no way to know what it
                    grants, and no say in it either. */}
                <select class="in" name="role" style="width:auto" aria-label="What this link grants">
                  <option value="member" selected>Joins as a member</option>
                  <option value="owner">Joins as an owner</option>
                </select>
                <button class="btn btn-sm" type="submit">
                  Generate link (valid 7 days)
                </button>
              </form>
            </div>
            {activeInvites.length === 0 ? (
              <div class="card-pad muted small">No active invite links.</div>
            ) : (
              activeInvites.map((row) => {
                const url = `${env.baseUrl}/join/${row.invite.code}`;
                return (
                  <div class="invrow">
                    <div class="invrow-main">
                      <div class="invurl">{url}</div>
                      <button class="btn btn-sm" type="button" data-copy={url}>
                        Copy
                      </button>
                      <form
                        method="post"
                        action={`/app/teams/${team.slug}/invites/${row.invite.id}/revoke`}
                        class="m0"
                        data-confirm="Anyone who has not used this link yet will no longer be able to join with it."
                        data-confirm-title="Revoke this invite link?"
                        data-confirm-action="Revoke link"
                      >
                        <button class="btn btn-sm btn-danger" type="submit">
                          Revoke
                        </button>
                      </form>
                    </div>
                    <div class="invmeta">
                      <span class="with-dot">
                        <span class="dot" />
                        Active
                      </span>
                      {/* Said on every row, not only the unusual one: a list
                          where the dangerous entry is the one with extra words
                          teaches people to skim past the words. */}
                      <span class={row.invite.role === 'owner' ? 'pill pill-danger' : 'pill'}>
                        {row.invite.role === 'owner' ? 'joins as an owner' : 'joins as a member'}
                      </span>
                      <span>Expires {fmtDate(row.invite.expiresAt)}</span>
                      <span>
                        {row.invite.uses}
                        {row.invite.maxUses != null ? ` / ${row.invite.maxUses}` : ''} uses
                      </span>
                      {row.creator ? <span>Created by {row.creator}</span> : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          ) : null}
        </div>

        <div class="col">
          {tab === 'overview' && machines === 0 && activeAgents7d === 0 ? (
          <div class="darkcard">
            <span class="overline">Next step</span>
            <h3>Connect your agent</h3>
            <p>
              Copy the matching setup request into your coding client. Approve its single browser
              flow, then reload once and ask the agent to check its STMA connection.
            </p>
            <a
              class="btn btn-white"
              href={`/app/tokens?team=${encodeURIComponent(team.slug)}`}
              style="align-self:flex-start"
            >
              Open Agent connections
            </a>
          </div>
          ) : null}

          {tab === 'overview' ? (
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
            <span class="card-title">Observed workspace activity</span>
            <div class="factrow">
              <span class={liveRuns > 0 ? 'y' : 'n'}>{liveRuns > 0 ? '✓' : '·'}</span>
              <span>
                {liveRuns} {liveRuns === 1 ? 'run' : 'runs'} live now —{' '}
                <a href="/app/agents">agent map</a>
              </span>
            </div>
            <div class="factrow">
              <span class="n">{driftCount > 0 ? '!' : '·'}</span>
              <span>
                {driftCount > 0
                  ? `${driftCount} run(s) reported a different policy hash`
                  : 'No hash mismatch recorded; unreported behavior is unknown'}{' '}
                — <a href={`/app/teams/${team.slug}/governance`}>governance</a>
              </span>
            </div>
            <div class="factrow">
              <span class="y">✓</span>
              <span>
                {openSessionCount} open {openSessionCount === 1 ? 'thread' : 'threads'} —{' '}
                <a href="/app/sessions">sessions</a>
              </span>
            </div>
          </div>
          ) : null}

          {tab === 'overview' ? (
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
            <span class="card-title">What agents share here</span>
            <div class="factrow">
              <span class="y">✓</span>
              <span>Runtime and package manager versions</span>
            </div>
            <div class="factrow">
              <span class="y">✓</span>
              <span>Lockfile hashes and git state</span>
            </div>
            <div class="factrow">
              <span class="y">✓</span>
              <span>
                Environment variable <em>names</em>, set or missing
              </span>
            </div>
            <div class="factrow">
              <span class="n">✕</span>
              <span>The snapshot collector omits secret values and source. Submitted messages and attachments can contain either; review them before sharing.</span>
            </div>
          </div>
          ) : null}
          {tab === 'integrations' ? (
            <>

          {role === 'owner' ? (
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
              <div class="integ-head">
                <span class="integ-mark" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 7a4 4 0 0 1 8 0v3l1.5 2h-11L4 10z" />
                    <path d="M6.5 13.5a1.6 1.6 0 0 0 3 0" />
                  </svg>
                </span>
                <div class="integ-title">
                  <div class="card-title">Team notifications and hooks</div>
                  {team.webhookUrl ? <span class="pill pill-active">Webhook set</span> : <span class="pill pill-muted">No webhook</span>}
                </div>
              </div>
              <div>
                <div class="card-note">
                  Optional Slack or Discord incoming-webhook URL. New and resolved sessions ping it
                  — message bodies are never sent.
                </div>
              </div>
              <form class="inline" method="post" action={`/app/teams/${team.slug}/settings`}>
                <input
                  class="in"
                  style="flex:1;min-width:200px"
                  type="text"
                  name="webhook_url"
                  aria-label="Team Slack or Discord webhook URL"
                  value={team.webhookUrl ?? ''}
                  placeholder="https://hooks.slack.com/services/…"
                />
                <button class="btn btn-sm" type="submit">
                  Save
                </button>
              </form>
              <div style="border-top:1px solid var(--line-2);padding-top:12px;display:flex;flex-direction:column;gap:8px">
                <div>
                  <div class="card-title" style="font-size:14px">
                    Inbound hooks
                  </div>
                  <div class="card-note">
                    POST here from CI or a GitHub webhook (push events) to announce to the team.
                    For GitHub, also paste the token as the webhook <b>Secret</b> — signed
                    requests are verified, and a bad signature is rejected.
                  </div>
                </div>
                {team.inboundToken ? (
                  <>
                    <div class="cmd inner">
                      <code>{`${env.baseUrl}/api/hooks/announce/${team.inboundToken}`}</code>
                    </div>
                    <div class="cmd inner">
                      <code>{`${env.baseUrl}/api/hooks/github/${team.inboundToken}`}</code>
                    </div>
                  </>
                ) : (
                  <p class="m0 small muted">No inbound token yet.</p>
                )}
                <form method="post" action={`/app/teams/${team.slug}/inbound-token`} class="m0">
                  <button class="btn btn-sm" type="submit">
                    {team.inboundToken ? 'Regenerate token' : 'Generate hook URLs'}
                  </button>
                </form>
              </div>
            </div>
          ) : null}

          {role === 'owner' ? (
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
              <div class="integ-head">
                <span class="integ-mark" aria-hidden="true">GH</span>
                <div class="integ-title">
                  <div class="card-title">GitHub issues</div>
                  {github ? <span class="pill pill-active">Connected</span> : <span class="pill pill-muted">Not connected</span>}
                </div>
              </div>
              <div>
                <div class="card-note">
                  <a href={`/app/teams/${team.slug}/repositories`}>Manage all repository connections and exact project bindings</a>. Agents list what is open
                  (<code>list_issues</code>), start a run on a number
                  (<code>start_run {'{'}"issue": 42{'}'}</code>), and when that run finishes or is
                  handed off, the issue gets a comment saying so. Needs a token with{' '}
                  <b>issues: read and write</b> — a fine-grained token scoped to this one repository
                  is the right shape.
                </div>
              </div>
              {github ? (
                <div class="factrow">
                  <span class="y">✓</span>
                  <span>
                    Connected to <b>{github.repo}</b>
                    {github.commentOnFinish
                      ? ' — finished runs comment back on the issue.'
                      : ' — commenting back is off, so this is read-only.'}
                  </span>
                </div>
              ) : null}
              <form
                method="post"
                action={`/app/teams/${team.slug}/integrations/github`}
                style="display:flex;flex-direction:column;gap:10px"
              >
                <label class="ifield">
                  <span>Repository</span>
                  <input
                    class="in"
                    type="text"
                    name="repo"
                    aria-label="GitHub repository, as owner/name"
                    value={github?.repo ?? ''}
                    placeholder="owner/name"
                  />
                </label>
                <label class="ifield">
                  <span>Access token</span>
                  <input
                    class="in"
                    type="password"
                    name="token"
                    autocomplete="off"
                    aria-label="GitHub access token with issues read and write"
                    placeholder={
                      github ? 'Stored — type a new token only to replace it' : 'github_pat_… or ghp_…'
                    }
                  />
                </label>
                <label class="checkrow">
                  <input
                    type="checkbox"
                    name="comment_on_finish"
                    value="on"
                    checked={github?.commentOnFinish ?? true}
                  />
                  <span>
                    <span class="checkrow-label">Comment on the issue when a run ends</span>
                    <span class="checkrow-note">
                      One comment per finished run or handoff, on issues an agent named. Off means
                      STMA only reads.
                    </span>
                  </span>
                </label>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn btn-sm btn-primary" type="submit" name="action" value="save">
                    {github ? 'Update connection' : 'Connect repository'}
                  </button>
                  {github ? (
                    <button class="btn btn-sm" type="submit" name="action" value="test">
                      Test access
                    </button>
                  ) : null}
                  {github ? (
                    <button class="btn btn-sm" type="submit" name="action" value="remove">
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          ) : null}

          {role === 'owner' ? (
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
              <div class="integ-head">
                <span class="integ-mark" aria-hidden="true">AZ</span>
                <div class="integ-title">
                  <div class="card-title">Azure DevOps</div>
                  {ado ? <span class="pill pill-active">Connected</span> : <span class="pill pill-muted">Not connected</span>}
                </div>
              </div>
              <div>
                <div class="card-note">
                  Where the <a href={`/app/teams/${team.slug}/delivery`}>delivery flow</a> gets
                  applied: STMA commits the rendered pipeline file into this repository and
                  registers the pipeline. Needs a PAT with <b>Code read &amp; write</b> and{' '}
                  <b>Build read &amp; execute</b>. Azure issues the PAT for the organization; STMA
                  limits its use through the exact repository-to-project binding you review on
                  the Repositories page.
                </div>
              </div>
              {ado ? (
                <div class="factrow">
                  <span class="y">✓</span>
                  <span>
                    Connected to <b class="mono">{`${ado.organization}/${ado.project}/${ado.repo}`}</b>
                  </span>
                </div>
              ) : null}
              <AdoTokenHelp />
              <form
                method="post"
                action={`/app/teams/${team.slug}/integrations/azure-devops`}
                style="display:flex;flex-direction:column;gap:10px"
              >
                <label class="ifield">
                  <span>Repository</span>
                  <input
                    class="in"
                    type="text"
                    name="locator"
                    aria-label="Azure DevOps repository, as organization/project/repo"
                    value={ado ? `${ado.organization}/${ado.project}/${ado.repo}` : ''}
                    placeholder="organization/project/repo — or paste the repo URL"
                  />
                </label>
                <label class="ifield">
                  <span>Personal access token</span>
                  <input
                    class="in"
                    type="password"
                    name="token"
                    autocomplete="off"
                    aria-label="Azure DevOps personal access token"
                    placeholder={ado ? 'Stored — type a new token only to replace it' : 'Personal access token'}
                  />
                </label>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn btn-sm btn-primary" type="submit" name="action" value="save">
                    {ado ? 'Update connection' : 'Connect Azure DevOps'}
                  </button>
                  {ado ? (
                    <button class="btn btn-sm" type="submit" name="action" value="test">
                      Test access
                    </button>
                  ) : null}
                  {ado ? (
                    <button class="btn btn-sm" type="submit" name="action" value="remove">
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          ) : null}

          {role === 'owner' ? (
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
              <div class="integ-head">
                <span class="integ-mark" aria-hidden="true">JI</span>
                <div class="integ-title">
                  <div class="card-title">Jira</div>
                  {jira ? <span class="pill pill-active">Connected</span> : <span class="pill pill-muted">Not connected</span>}
                </div>
              </div>
              <div>
                <div class="card-note">
                  For delivery flows whose tickets live in Jira: STMA verifies the connection and
                  reads issue titles — it never writes to the tracker. Needs the site, the account
                  email, and an API token from{' '}
                  <span class="mono">id.atlassian.com/manage-profile/security/api-tokens</span>.
                </div>
              </div>
              {jira ? (
                <div class="factrow">
                  <span class="y">✓</span>
                  <span>
                    Connected to <b class="mono">{jira.site}</b> as {jira.email}
                  </span>
                </div>
              ) : null}
              <JiraTokenHelp />
              <form
                method="post"
                action={`/app/teams/${team.slug}/integrations/jira`}
                style="display:flex;flex-direction:column;gap:10px"
              >
                <label class="ifield">
                  <span>Site</span>
                  <input
                    class="in"
                    type="text"
                    name="site"
                    aria-label="Jira site, like acme.atlassian.net"
                    value={jira?.site ?? ''}
                    placeholder="acme.atlassian.net"
                  />
                </label>
                <label class="ifield">
                  <span>Account email</span>
                  <input
                    class="in"
                    type="email"
                    name="email"
                    aria-label="Atlassian account email"
                    value={jira?.email ?? ''}
                    placeholder="you@company.com"
                  />
                </label>
                <label class="ifield">
                  <span>API token</span>
                  <input
                    class="in"
                    type="password"
                    name="token"
                    autocomplete="off"
                    aria-label="Jira API token"
                    placeholder={jira ? 'Stored — type a new token only to replace it' : 'API token'}
                  />
                </label>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn btn-sm btn-primary" type="submit" name="action" value="save">
                    {jira ? 'Update connection' : 'Connect Jira'}
                  </button>
                  {jira ? (
                    <button class="btn btn-sm" type="submit" name="action" value="test">
                      Test access
                    </button>
                  ) : null}
                  {jira ? (
                    <button class="btn btn-sm" type="submit" name="action" value="remove">
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          ) : null}

          {role === 'owner' ? (
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
              <div class="integ-head">
                <span class="integ-mark" aria-hidden="true">CU</span>
                <div class="integ-title">
                  <div class="card-title">ClickUp</div>
                  {!env.clickup ? <span class="pill pill-muted">Not configured</span> : clickup ? (clickup.pausedAt ? <span class="pill pill-warn">Paused</span> : <span class="pill pill-active">Connected</span>) : <span class="pill pill-muted">Not connected</span>}
                </div>
              </div>
              <div>
                <div class="card-note">
                  Connect in ClickUp's own consent screen, then map each STMA project to one exact
                  ClickUp List. Agents can pick up tasks and report finishes or handoffs without
                  receiving your ClickUp credential.
                </div>
              </div>
              {!env.clickup ? (
                <div class="factrow">
                  <span class="n">·</span>
                  <span>ClickUp OAuth is not configured on this STMA server.</span>
                </div>
              ) : !clickup ? (
                <a
                  class="btn btn-sm btn-primary"
                  style="align-self:flex-start"
                  href={`/app/teams/${team.slug}/integrations/clickup/start`}
                >
                  Connect ClickUp
                </a>
              ) : (
                <>
                  <div class="factrow">
                    <span class={clickup.pausedAt ? 'n' : 'y'}>{clickup.pausedAt ? '·' : '✓'}</span>
                    <span>
                      {clickup.pausedAt ? (
                        <>
                          <b>Paused</b> since {new Date(clickup.pausedAt).toLocaleString()} —
                          connected to <b>{clickup.workspaceName}</b>, mappings kept, and STMA makes
                          no ClickUp call for this workspace until you resume.
                        </>
                      ) : (
                        <>
                          Connected to <b>{clickup.workspaceName}</b>. The access token is stored
                          encrypted and is never rendered or sent to an agent.
                        </>
                      )}
                    </span>
                  </div>
                  <div class="small muted">
                    {clickup.lastCheck ? (
                      <div>
                        Last checked {new Date(clickup.lastCheck.at).toLocaleString()} —{' '}
                        {clickup.lastCheck.ok
                          ? 'ClickUp answered.'
                          : `ClickUp refused (${clickup.lastCheck.error ?? 'unknown'}).`}
                      </div>
                    ) : (
                      <div>Not checked yet — press Test access.</div>
                    )}
                    {clickup.lastComment ? (
                      <div>
                        Last comment {new Date(clickup.lastComment.at).toLocaleString()} on{' '}
                        <span class="mono">{clickup.lastComment.task}</span> in{' '}
                        {clickup.lastComment.list} —{' '}
                        {clickup.lastComment.ok
                          ? 'delivered.'
                          : `not delivered (${clickup.lastComment.error ?? 'unknown'}).`}
                      </div>
                    ) : (
                      <div>No comment has been sent from this connection yet.</div>
                    )}
                    <div>
                      Comments are one attempt, after STMA has already recorded the run's own
                      event. ClickUp's comment endpoint takes no idempotency key, so a failed
                      delivery is reported here rather than retried — two comments about one finish
                      would be worse than none. A tracker never fails a run.
                    </div>
                  </div>
                  {clickupMappings.length ? (
                    <div class="small muted">
                      {clickupMappings.map((binding) => {
                        const project = teamProjects.find((row) => row.id === binding.projectId);
                        return (
                          <div class="row" style="justify-content:space-between;gap:8px">
                            <span>
                              <b>{project?.name ?? 'Deleted project'}</b> → {binding.listName}{' '}
                              <span class="mono">({binding.listId})</span>
                              {binding.projectExists ? null : (
                                <span style="color:var(--red)">
                                  {' '}
                                  — its STMA project is gone, so this mapping resolves to nothing.
                                </span>
                              )}
                            </span>
                            <form
                              method="post"
                              action={`/app/teams/${team.slug}/integrations/clickup/binding/remove`}
                              class="m0"
                            >
                              <input type="hidden" name="project_id" value={binding.projectId} />
                              <button class="btn btn-sm" type="submit">Remove mapping</button>
                            </form>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div class="small muted">Connected, but no project is mapped yet.</div>
                  )}
                  <form
                    method="post"
                    action={`/app/teams/${team.slug}/integrations/clickup/comments`}
                    class="row"
                  >
                    <button class="btn btn-sm" type="submit" name="comment_on_finish" value={clickup.commentOnFinish ? 'off' : 'on'}>
                      {clickup.commentOnFinish ? 'Stop commenting on finish' : 'Comment on finish'}
                    </button>
                    <span class="small muted">
                      {clickup.commentOnFinish
                        ? 'A finished or handed-off run comments on its mapped ClickUp task.'
                        : 'STMA reads ClickUp here but writes nothing back.'}
                    </span>
                  </form>
                  {clickupLists?.ok && teamProjects.length ? (
                    <form
                      method="post"
                      action={`/app/teams/${team.slug}/integrations/clickup/binding`}
                      style="display:flex;flex-direction:column;gap:10px"
                    >
                      <label class="small" for="clickup-project">STMA project</label>
                      <select class="in" id="clickup-project" name="project_id" required>
                        {teamProjects.map((project) => (
                          <option value={project.id}>{project.name}</option>
                        ))}
                      </select>
                      <label class="small" for="clickup-list">ClickUp List</label>
                      <select class="in" id="clickup-list" name="list_id" required>
                        {clickupLists.value.map((list) => (
                          <option value={list.id}>{list.path}</option>
                        ))}
                      </select>
                      <button class="btn btn-sm btn-primary" style="align-self:flex-start" type="submit">
                        Save project mapping
                      </button>
                    </form>
                  ) : clickup.pausedAt ? (
                    <div class="small muted">
                      Resume the connection to choose a List — a paused connection is not read.
                    </div>
                  ) : clickupLists && !clickupLists.ok ? (
                    <div class="small" style="color:var(--red)">
                      ClickUp Lists could not be loaded ({clickupLists.error}). Test or reconnect the connection.
                    </div>
                  ) : teamProjects.length === 0 ? (
                    <div class="small muted">Create an STMA project before choosing its ClickUp List.</div>
                  ) : null}
                  <form method="post" action={`/app/teams/${team.slug}/integrations/clickup`} class="row">
                    <button class="btn btn-sm" type="submit" name="action" value="test">Test access</button>
                    <button class="btn btn-sm" type="submit" name="action" value={clickup.pausedAt ? 'resume' : 'pause'}>
                      {clickup.pausedAt ? 'Resume' : 'Pause'}
                    </button>
                    <button class="btn btn-sm" type="submit" name="action" value="remove">Disconnect</button>
                  </form>
                  <div class="small muted">
                    Pausing keeps every mapping and the credential; disconnecting removes both.
                    Test access still calls ClickUp while paused — it is how you decide whether to
                    resume.
                  </div>
                </>
              )}
            </div>
          ) : null}
            </>
          ) : null}

          {tab === 'settings' ? (
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <div class="card-title">Danger zone</div>
              <div class="card-note">These actions take effect immediately.</div>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small" style="color:var(--txt-2)">
                Leave this team. Everything you shared stays attributed to you.
              </span>
              <form
                method="post"
                action={`/app/teams/${team.slug}/leave`}
                class="m0"
                data-confirm={`You lose access to ${team.name} until someone invites you again. Snapshots, messages and activity you shared stay attributed to you.`}
                data-confirm-title={`Leave ${team.name}?`}
                data-confirm-action="Leave team"
              >
                <button class="btn btn-sm btn-danger" type="submit">
                  Leave team
                </button>
              </form>
            </div>
            {role === 'owner' ? (
              <div
                class="row"
                style="justify-content:space-between;border-top:1px solid var(--line-2);padding-top:12px"
              >
                <span class="small" style="color:var(--txt-2)">
                  Delete this team for all {members.length}{' '}
                  {members.length === 1 ? 'member' : 'members'}.
                </span>
                <form
                  method="post"
                  action={`/app/teams/${team.slug}/delete`}
                  class="m0"
                  data-confirm={`Every project, session, snapshot and the activity trail of ${team.name} is permanently deleted for all members. Personal tokens are not touched. This cannot be undone.`}
                  data-confirm-title={`Delete ${team.name}?`}
                  data-confirm-action="Delete team"
                >
                  <button class="btn btn-sm btn-danger" type="submit">
                    Delete team
                  </button>
                </form>
              </div>
            ) : null}
          </div>
          ) : null}
        </div>
      </div>
    </AppLayout>,
  );
});

// ------------------------------------------------------- membership lifecycle

dashboardRoutes.post('/app/teams/:slug/leave', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  if (found.role === 'owner' && (await ownerCount(db, found.team.id)) <= 1) {
    return c.redirect(
      `/app/teams/${found.team.slug}?tab=settings&error=${encodeURIComponent(
        'You are the only owner of this team. Delete the team instead, or make another member an owner first.',
      )}`,
    );
  }
  await db
    .delete(memberships)
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, user.id)));
  await recordMembershipChange(db, {
    teamId: found.team.id,
    teamSlug: found.team.slug,
    action: 'removed',
    subjectId: user.id,
    subjectLabel: user.username,
    previousRole: found.role,
    nextRole: null,
    source: 'self',
    route: 'POST /app/teams/:slug/leave',
    actorId: user.id,
    actorLabel: user.username,
    // Asked even though the route refuses a last owner two checks up: a member
    // can still leave a workspace that the organization path already left with
    // no owner, and the column must mean the same thing whichever route wrote
    // the row.
    leftOwnerless: await hasNoOwner(db, found.team.id),
  });
  await c.get('lifecycle').teamMemberCountChanged?.({ db, teamId: found.team.id });
  await track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'member_left',
    detail: `${user.username} left the team`,
  });
  return c.redirect(`/app?ok=${encodeURIComponent(`You left ${found.team.name}.`)}`);
});

/**
 * Promotion and demotion. Only owners may call it, and the team must always keep
 * at least one owner — checked against the database, not the rendered page, so a
 * stale tab or a hand-rolled POST cannot empty the role.
 */
dashboardRoutes.post('/app/teams/:slug/members/:userId/role', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  if (found.role !== 'owner') return c.text('Only team owners can change roles.', 403);
  const body = await c.req.parseBody();
  const role = body.role === 'owner' ? 'owner' : body.role === 'member' ? 'member' : null;
  if (!role) return c.notFound();
  const targetId = c.req.param('userId');
  if (!UUID_RE.test(targetId)) return c.notFound();
  const targetRows = await db
    .select({ username: users.username, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, targetId)))
    .limit(1);
  const target = targetRows[0];
  if (!target) return c.notFound();
  const back = `/app/teams/${found.team.slug}?tab=people`;
  if (target.role === role) return c.redirect(back);
  // Demoting the last owner — themselves or anyone else — would leave the team
  // with no one able to invite, remove, publish policy or delete it.
  if (role === 'member' && (await ownerCount(db, found.team.id)) <= 1) {
    return c.redirect(
      `${back}&error=${encodeURIComponent(
        'A team needs at least one owner. Make another member an owner first.',
      )}`,
    );
  }
  await db
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, targetId)));
  const self = targetId === user.id;
  await recordMembershipChange(db, {
    teamId: found.team.id,
    teamSlug: found.team.slug,
    action: 'role_changed',
    subjectId: targetId,
    subjectLabel: target.username,
    previousRole: target.role,
    nextRole: role,
    source: self ? 'self' : 'owner',
    route: 'POST /app/teams/:slug/members/:userId/role',
    actorId: user.id,
    actorLabel: user.username,
  });
  await track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: role === 'owner' ? 'member_promoted' : 'member_demoted',
    detail:
      role === 'owner'
        ? `${target.username} was made an owner by ${user.username}`
        : self
          ? `${user.username} stepped down to member`
          : `${target.username} was demoted to member by ${user.username}`,
  });
  const ok =
    role === 'owner'
      ? `${target.username} is now an owner.`
      : self
        ? `You are now a member of ${found.team.name}.`
        : `${target.username} is now a member.`;
  return c.redirect(`${back}&ok=${encodeURIComponent(ok)}`);
});

dashboardRoutes.post('/app/teams/:slug/members/:userId/remove', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  if (found.role !== 'owner') return c.text('Only team owners can remove members.', 403);
  const targetId = c.req.param('userId');
  if (!UUID_RE.test(targetId)) return c.notFound();
  if (targetId === user.id) {
    return c.redirect(
      `/app/teams/${found.team.slug}?tab=people&error=${encodeURIComponent(
        'You cannot remove yourself. Leave the team or delete it instead.',
      )}`,
    );
  }
  const targetRows = await db
    .select({ username: users.username, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, targetId)))
    .limit(1);
  const target = targetRows[0];
  if (!target) return c.notFound();
  await db
    .delete(memberships)
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, targetId)));
  await recordMembershipChange(db, {
    teamId: found.team.id,
    teamSlug: found.team.slug,
    action: 'removed',
    subjectId: targetId,
    subjectLabel: target.username,
    previousRole: target.role,
    nextRole: null,
    source: 'owner',
    route: 'POST /app/teams/:slug/members/:userId/remove',
    actorId: user.id,
    actorLabel: user.username,
    leftOwnerless: await hasNoOwner(db, found.team.id),
  });
  await c.get('lifecycle').teamMemberCountChanged?.({ db, teamId: found.team.id });
  await track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'member_removed',
    detail: `${target.username} was removed by ${user.username}`,
  });
  return c.redirect(
    `/app/teams/${found.team.slug}?tab=people&ok=${encodeURIComponent(`${target.username} was removed from the team.`)}`,
  );
});

dashboardRoutes.post('/app/teams/:slug/delete', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  if (found.role !== 'owner') return c.text('Only team owners can delete a team.', 403);
  const teamId = found.team.id;
  const deletion = await c.get('lifecycle').beforeTeamDelete?.({ db, teamId });
  if (deletion && !deletion.ok) {
    return c.redirect(
      `/app/teams/${found.team.slug}?tab=settings&error=${encodeURIComponent(deletion.message)}`,
    );
  }
  // Explicit ordered deletes: children before the rows they reference, so the
  // wipe is correct regardless of FK cascade configuration.
  await db.transaction(async (tx) => {
    const teamSessionIds = tx
      .select({ id: debugSessions.id })
      .from(debugSessions)
      .where(eq(debugSessions.teamId, teamId));
    await tx.delete(readState).where(inArray(readState.sessionId, teamSessionIds));
    await tx.delete(messages).where(inArray(messages.sessionId, teamSessionIds));
    await tx.delete(debugSessions).where(eq(debugSessions.teamId, teamId));
    await tx.delete(snapshots).where(eq(snapshots.teamId, teamId));
    await tx.delete(activity).where(eq(activity.teamId, teamId));
    await tx.delete(invites).where(eq(invites.teamId, teamId));
    const teamRunIds = tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.teamId, teamId));
    await tx.delete(workClaims).where(inArray(workClaims.runId, teamRunIds));
    await tx.delete(agentEvents).where(inArray(agentEvents.runId, teamRunIds));
    await tx.delete(policyReceipts).where(inArray(policyReceipts.runId, teamRunIds));
    await tx.delete(agentRuns).where(eq(agentRuns.teamId, teamId));
    await tx.delete(policyBundles).where(eq(policyBundles.teamId, teamId));
    await tx.delete(environmentBaselines).where(eq(environmentBaselines.teamId, teamId));
    // Delete before projects: project FKs become NULL on deletion, which could
    // transiently collide with the unique team-wide active-flow scope.
    await tx.delete(deliveryFlows).where(eq(deliveryFlows.teamId, teamId));
    await tx.delete(projects).where(eq(projects.teamId, teamId));
    // Every membership goes, and this is the one removal `lib/memberships`
    // deliberately does not record: `membership_changes` cascades with `teams`,
    // so a row written here would be deleted three statements later by this
    // same transaction. Writing it anyway would put a lie in the code and a
    // promise of completeness on the operator's page that nothing keeps. The
    // workspace's absence is the answer to why nobody is in it.
    await tx.delete(memberships).where(eq(memberships.teamId, teamId));
    await tx.delete(teams).where(eq(teams.id, teamId));
  });
  return c.redirect(`/app?ok=${encodeURIComponent(`Team ${found.team.name} was deleted.`)}`);
});

dashboardRoutes.post('/app/teams/:slug/settings', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const raw = typeof body.webhook_url === 'string' ? body.webhook_url.trim().slice(0, 500) : '';
  if (raw && !isSafeWebhookUrl(raw, env.nodeEnv === 'production')) {
    return c.redirect(
      `/app/teams/${found.team.slug}?tab=integrations&error=${encodeURIComponent('Webhook URL must be a public https:// address.')}`,
    );
  }
  await db.update(teams).set({ webhookUrl: raw || null }).where(eq(teams.id, found.team.id));
  return c.redirect(`/app/teams/${found.team.slug}?tab=integrations`);
});

/**
 * Connect, test or disconnect the team's GitHub repository.
 *
 * "Test access" is a real request against the repository rather than a format
 * check: a token that cannot read the issues fails silently at exactly the
 * moment an agent needed it, and an owner deserves to learn that here.
 */
dashboardRoutes.post('/app/teams/:slug/integrations/github', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const action = typeof body.action === 'string' ? body.action : 'save';
  const slug = found.team.slug;
  const back = (query: string) => c.redirect(`/app/teams/${slug}?tab=integrations&${query}`);
  const existing = await githubForTeam(db, found.team.id);

  if (action === 'remove') {
    await removeGithubIntegration(db, found.team.id, user.id);
    void track(db, {
      teamId: found.team.id,
      userId: user.id,
      action: 'integration_removed',
      detail: 'github',
    });
    return back(`ok=${encodeURIComponent('GitHub repository disconnected.')}`);
  }

  if (action === 'test') {
    if (!existing) return back(`error=${encodeURIComponent('Connect a repository first.')}`);
    const issues = await listOpenIssues(env, existing, 1);
    return issues.ok
      ? back(
          `ok=${encodeURIComponent(`${existing.repo} is reachable — ${issues.value.length > 0 ? `newest open issue is #${issues.value[0]!.number}` : 'nothing open right now'}.`)}`,
        )
      : back(
          `error=${encodeURIComponent(`GitHub refused the request (${issues.error}). Check the repository name and that the token can read its issues.`)}`,
        );
  }

  const repo = typeof body.repo === 'string' ? body.repo : '';
  // An empty token field on an existing connection means "keep the one you have" —
  // the field is a password input that never renders its value back.
  const typed = typeof body.token === 'string' ? body.token.trim() : '';
  const token = typed || existing?.token || '';
  const githubLimits = await effectiveLimits(db, found.team, env.hosted);
  if (githubLimits.readOnly) return back('error=Evaluation%20ended.%20Connections%20remain%20readable.');
  if (repo !== existing?.repo && githubLimits.maxIntegrations !== null && await countIntegrations(db, found.team.id) >= githubLimits.maxIntegrations) return back('error=Repository%20connection%20limit%20reached.');
  const saved = await saveGithubIntegration(db, {
    teamId: found.team.id,
    userId: user.id,
    repo,
    token,
    commentOnFinish: typeof body.comment_on_finish === 'string' && body.comment_on_finish !== '',
  });
  if (!saved.ok) return back(`error=${encodeURIComponent(saved.error)}`);
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'integration_saved',
    detail: `github: ${saved.repo}`,
  });
  return back(
    `ok=${encodeURIComponent(`Connected to ${saved.repo}. Ask an agent to call list_issues to confirm.`)}`,
  );
});

/**
 * The Azure DevOps and Jira connections, same shape as GitHub's: owner-only,
 * empty token means keep the stored one, and the token never renders back.
 * A *new* provider counts against the plan's maxIntegrations; updating or
 * removing an existing one never does.
 */
async function integrationRoomFor(
  db: Db,
  hosted: boolean,
  teamId: string,
  plan: string | null,
  provider: 'azure-devops' | 'jira' | 'clickup',
): Promise<string | null> {
  const existing = await integrationFor(db, teamId, provider);
  if ((await effectiveLimits(db, { id: teamId, plan }, hosted)).readOnly) return 'Evaluation ended. Existing integrations remain readable; new paid work requires an explicit upgrade.';
  if (existing) return null;
  const allowance = (await effectiveLimits(db, { id: teamId, plan }, hosted)).maxIntegrations;
  if (allowance === null) return null;
  const used = await countIntegrations(db, teamId);
  if (used < allowance) return null;
  return `This team's ${plan ?? 'free'} plan connects ${allowance} provider${allowance === 1 ? '' : 's'} and ${used} ${used === 1 ? 'is' : 'are'} already connected. Disconnect one first, or upgrade.`;
}

const CLICKUP_CONNECT_COOKIE = 'clickup_connect';
const CLICKUP_PENDING_COOKIE = 'clickup_pending';

async function persistClickupWorkspace(
  db: Db,
  input: {
    teamId: string;
    userId: string;
    workspaceId: string;
    workspaceName: string;
    token: string;
  },
) {
  const existing = await clickupConnectionForTeam(db, input.teamId);
  if (existing && existing.workspaceId !== input.workspaceId) {
    await removeIntegration(db, input.teamId, 'clickup', existing.workspaceId, {
      actorId: input.userId,
      action: 'integration_disconnected',
    });
  }
  const sameWorkspace = existing?.workspaceId === input.workspaceId;
  await saveIntegration(db, {
    teamId: input.teamId,
    userId: input.userId,
    provider: 'clickup',
    locator: input.workspaceId,
    token: input.token,
    commentOnFinish: existing?.commentOnFinish ?? true,
    config: {
      workspaceName: input.workspaceName,
      // A re-authorization of the same workspace keeps explicit mappings. A
      // different workspace cannot inherit list IDs that mean something else.
      bindings: sameWorkspace ? existing.bindings : [],
      // Re-authorizing is how somebody fixes a connection they paused, so it
      // resumes. Nothing else would: the pause has no expiry and the Resume
      // button sits under a card they just replaced.
      pausedAt: null,
    },
    audit: { actorId: input.userId, action: 'integration_connected' },
  });
}

dashboardRoutes.get('/app/teams/:slug/integrations/clickup/start', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  if (!env.clickup) return c.notFound();
  const found = await teamForMember(c.get('db'), c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const full = await integrationRoomFor(
    c.get('db'),
    env.hosted,
    found.team.id,
    found.team.plan,
    'clickup',
  );
  if (full) {
    return c.redirect(
      `/app/teams/${found.team.slug}?tab=integrations&error=${encodeURIComponent(full)}`,
    );
  }
  const state = randomCode(18);
  setCookie(
    c,
    CLICKUP_CONNECT_COOKIE,
    Buffer.from(
      JSON.stringify({ state, teamId: found.team.id, teamSlug: found.team.slug, userId: user.id }),
    ).toString('base64url'),
    {
      httpOnly: true,
      sameSite: 'Lax',
      secure: env.baseUrl.startsWith('https://'),
      path: '/',
      maxAge: 600,
    },
  );
  return c.redirect(clickupAuthorizeUrl(env, state));
});

dashboardRoutes.get('/auth/clickup/callback', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  if (!env.clickup) return c.notFound();
  const raw = getCookie(c, CLICKUP_CONNECT_COOKIE);
  deleteCookie(c, CLICKUP_CONNECT_COOKIE, { path: '/' });
  let saved:
    | { state: string; teamId: string; teamSlug: string; userId: string }
    | undefined;
  try {
    saved = raw
      ? (JSON.parse(Buffer.from(raw, 'base64url').toString()) as typeof saved)
      : undefined;
  } catch {
    saved = undefined;
  }
  const back = (message: string) =>
    c.redirect(
      `/app/teams/${saved?.teamSlug ?? ''}?tab=integrations&error=${encodeURIComponent(message)}`,
    );
  if (
    !saved ||
    saved.userId !== user.id ||
    saved.state !== c.req.query('state') ||
    !c.req.query('code')
  ) {
    return back('ClickUp authorization was cancelled or expired. Nothing was changed.');
  }
  const found = await teamForMember(c.get('db'), saved.teamSlug, user.id);
  if (!found || found.role !== 'owner' || found.team.id !== saved.teamId) return c.notFound();
  const token = await exchangeClickupCode(env, c.req.query('code')!);
  if (!token.ok) return back(`ClickUp authorization failed (${token.error}). Nothing was saved.`);
  const workspaces = await getClickupWorkspaces(env, token.value);
  if (!workspaces.ok || workspaces.value.length === 0) {
    return back(
      `ClickUp did not return an authorized workspace${workspaces.ok ? '' : ` (${workspaces.error})`}. Nothing was saved.`,
    );
  }
  if (workspaces.value.length === 1) {
    const workspace = workspaces.value[0]!;
    await persistClickupWorkspace(c.get('db'), {
      teamId: found.team.id,
      userId: user.id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      token: token.value,
    });
    void track(c.get('db'), {
      teamId: found.team.id,
      userId: user.id,
      action: 'integration_saved',
      detail: `clickup: ${workspace.name}`,
    });
    return c.redirect(
      `/app/teams/${found.team.slug}?tab=integrations&ok=${encodeURIComponent(`Connected to ClickUp workspace ${workspace.name}. Now map a project to a List.`)}`,
    );
  }

  setCookie(
    c,
    CLICKUP_PENDING_COOKIE,
    sealClickupPending(env, {
      token: token.value,
      userId: user.id,
      teamId: found.team.id,
      teamSlug: found.team.slug,
      workspaces: workspaces.value,
      expiresAt: Date.now() + 10 * 60_000,
    }),
    {
      httpOnly: true,
      sameSite: 'Lax',
      secure: env.baseUrl.startsWith('https://'),
      path: '/',
      maxAge: 600,
    },
  );
  return c.html(
    <AppLayout user={user} active="team" title="Choose ClickUp workspace">
      <div class="card card-pad" style="max-width:640px;display:flex;flex-direction:column;gap:14px">
        <h2 class="title m0">Choose one ClickUp workspace</h2>
        <p class="m0 sub">Only the workspace you choose will be connected to {found.team.name}.</p>
        <form method="post" action={`/app/teams/${found.team.slug}/integrations/clickup/workspace`}>
          {workspaces.value.map((workspace, index) => (
            <label class="checkrow">
              <input type="radio" name="workspace_id" value={workspace.id} checked={index === 0} />
              <span class="checkrow-label">{workspace.name}</span>
            </label>
          ))}
          <button class="btn btn-primary" type="submit">Connect selected workspace</button>
        </form>
      </div>
    </AppLayout>,
  );
});

dashboardRoutes.post('/app/teams/:slug/integrations/clickup/workspace', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  const raw = getCookie(c, CLICKUP_PENDING_COOKIE);
  deleteCookie(c, CLICKUP_PENDING_COOKIE, { path: '/' });
  const pending = raw ? openClickupPending(env, raw) : null;
  const found = await teamForMember(c.get('db'), c.req.param('slug'), user.id);
  if (
    !pending ||
    !found ||
    found.role !== 'owner' ||
    pending.userId !== user.id ||
    pending.teamId !== found.team.id ||
    pending.teamSlug !== found.team.slug
  ) {
    return c.notFound();
  }
  const body = await c.req.parseBody();
  const workspace = pending.workspaces.find((row) => row.id === body.workspace_id);
  if (!workspace) {
    return c.redirect(
      `/app/teams/${found.team.slug}?tab=integrations&error=${encodeURIComponent('Choose one of the workspaces ClickUp authorized. Nothing was saved.')}`,
    );
  }
  await persistClickupWorkspace(c.get('db'), {
    teamId: found.team.id,
    userId: user.id,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    token: pending.token,
  });
  void track(c.get('db'), { teamId: found.team.id, userId: user.id, action: 'integration_saved', detail: `clickup: ${workspace.name}` });
  return c.redirect(
    `/app/teams/${found.team.slug}?tab=integrations&ok=${encodeURIComponent(`Connected to ClickUp workspace ${workspace.name}. Now map a project to a List.`)}`,
  );
});

dashboardRoutes.post('/app/teams/:slug/integrations/clickup/binding', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const connection = await clickupConnectionForTeam(db, found.team.id);
  if (!connection) return c.notFound();
  const body = await c.req.parseBody();
  const lists = await listClickupLists(env, connection.token, connection.workspaceId);
  const list = lists.ok ? lists.value.find((row) => row.id === body.list_id) : undefined;
  if (!list) {
    return c.redirect(
      `/app/teams/${found.team.slug}?tab=integrations&error=${encodeURIComponent('That List is not available in the connected ClickUp workspace. Refresh and choose again.')}`,
    );
  }
  const savedBinding = await saveClickupBinding(db, {
    teamId: found.team.id,
    userId: user.id,
    projectId: typeof body.project_id === 'string' ? body.project_id : '',
    listId: list.id,
    listName: list.name,
  });
  if (!savedBinding.ok) {
    return c.redirect(
      `/app/teams/${found.team.slug}?tab=integrations&error=${encodeURIComponent(savedBinding.error)}`,
    );
  }
  void track(db, { teamId: found.team.id, userId: user.id, action: 'integration_binding_saved', detail: `clickup: ${list.id}` });
  return c.redirect(
    `/app/teams/${found.team.slug}?tab=integrations&ok=${encodeURIComponent(`Project mapped to ClickUp List ${list.name}.`)}`,
  );
});

/** Drop one project's ClickUp mapping, keeping the connection and the rest. */
dashboardRoutes.post('/app/teams/:slug/integrations/clickup/binding/remove', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const removed = await removeClickupBinding(db, {
    teamId: found.team.id,
    userId: user.id,
    projectId: typeof body.project_id === 'string' ? body.project_id : '',
  });
  const back = (key: 'ok' | 'error', message: string) =>
    c.redirect(`/app/teams/${found.team.slug}?tab=integrations&${key}=${encodeURIComponent(message)}`);
  if (!removed.ok) return back('error', removed.error);
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'integration_binding_removed',
    detail: 'clickup',
  });
  return back('ok', `Mapping to ClickUp List ${removed.listName} removed. The connection is untouched.`);
});

/**
 * Commenting on its own switch.
 *
 * It used to ride the mapping form, so turning writes off meant re-choosing a
 * project and a List — the one moment somebody wants to stop STMA writing into
 * their tracker was the moment they had to reconfigure it.
 */
dashboardRoutes.post('/app/teams/:slug/integrations/clickup/comments', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const on = body.comment_on_finish === 'on';
  const saved = await setClickupCommentOnFinish(db, {
    teamId: found.team.id,
    userId: user.id,
    commentOnFinish: on,
  });
  const back = (key: 'ok' | 'error', message: string) =>
    c.redirect(`/app/teams/${found.team.slug}?tab=integrations&${key}=${encodeURIComponent(message)}`);
  if (!saved.ok) return back('error', saved.error);
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'integration_scope_changed',
    detail: `clickup: comments ${on ? 'on' : 'off'}`,
  });
  return back(
    'ok',
    on
      ? 'STMA will comment on the mapped ClickUp task when a run finishes or is handed off.'
      : 'STMA will not write to ClickUp. Reads and task pickers are unchanged.',
  );
});

dashboardRoutes.post('/app/teams/:slug/integrations/clickup', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const back = (key: 'ok' | 'error', message: string) =>
    c.redirect(`/app/teams/${found.team.slug}?tab=integrations&${key}=${encodeURIComponent(message)}`);
  if (body.action === 'remove') {
    await removeIntegration(db, found.team.id, 'clickup', undefined, {
      actorId: user.id,
      action: 'integration_disconnected',
    });
    void track(db, { teamId: found.team.id, userId: user.id, action: 'integration_removed', detail: 'clickup' });
    return back('ok', 'ClickUp disconnected from STMA. You can also revoke the app in ClickUp settings.');
  }
  if (body.action === 'pause' || body.action === 'resume') {
    const paused = body.action === 'pause';
    const saved = await setClickupPaused(db, { teamId: found.team.id, userId: user.id, paused });
    if (!saved.ok) return back('error', saved.error);
    void track(db, {
      teamId: found.team.id,
      userId: user.id,
      // The same word the tamper-evident chain writes, so a reader comparing
      // the feed with the audit export is not told two different stories.
      action: 'integration_scope_changed',
      detail: `clickup: ${paused ? 'paused' : 'resumed'}`,
    });
    return back(
      'ok',
      paused
        ? 'ClickUp paused. Mappings and the credential are kept; STMA makes no ClickUp call for this workspace until you resume.'
        : 'ClickUp resumed. Existing project mappings are in effect again.',
    );
  }
  const connection = await clickupConnectionForTeam(db, found.team.id);
  if (!connection) return back('error', 'Connect ClickUp first.');
  // Deliberately still called while paused: this is the button somebody presses
  // to decide whether to resume, and it is a person acting rather than STMA
  // acting on their behalf.
  const workspaces = await getClickupWorkspaces(env, connection.token);
  const ok = workspaces.ok && workspaces.value.some((row) => row.id === connection.workspaceId);
  const error = workspaces.ok ? 'workspace_not_authorized' : workspaces.error;
  // Stored, not just flashed — the same rule Azure DevOps and Jira follow, so
  // the card can say when it was last known good instead of nothing at all.
  await recordClickupCheck(db, {
    teamId: found.team.id,
    userId: user.id,
    check: { ok, at: new Date().toISOString(), ...(ok ? {} : { error }) },
  });
  return ok
    ? back('ok', `${connection.workspaceName} is reachable; ${connection.bindings.length} project mapping(s) are stored.`)
    : back('error', `ClickUp refused the connection (${error}). Reconnect it.`);
});

dashboardRoutes.post('/app/teams/:slug/integrations/azure-devops', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const action = typeof body.action === 'string' ? body.action : 'save';
  // The same form lives on the team page and the delivery page (where the PAT
  // is needed at the moment of applying); come back to whichever sent it.
  const returnFlow =
    typeof body.flow_id === 'string' && UUID_RE.test(body.flow_id) ? body.flow_id : null;
  const back = (query: string) =>
    c.redirect(
      body.return_to === 'delivery'
        ? `/app/teams/${found.team.slug}/delivery?${returnFlow ? `flow=${returnFlow}&` : ''}${query}`
        : `/app/teams/${found.team.slug}?tab=integrations&${query}`,
    );
  const existing = await integrationFor(db, found.team.id, 'azure-devops');

  if (action === 'remove') {
    await removeIntegration(db, found.team.id, 'azure-devops', undefined, {
      actorId: user.id,
      action: 'integration_disconnected',
    });
    void track(db, { teamId: found.team.id, userId: user.id, action: 'integration_removed', detail: 'azure-devops' });
    return back(`ok=${encodeURIComponent('Azure DevOps disconnected.')}`);
  }
  if (action === 'test') {
    const config = await adoForTeam(db, found.team.id);
    if (!config) return back(`error=${encodeURIComponent('Connect Azure DevOps first.')}`);
    const health = await adoHealth(env, config);
    // The verdict is stored, not just flashed: the delivery page shows the
    // connection's last known state next to the Apply button.
    await saveIntegration(db, {
      teamId: found.team.id,
      userId: user.id,
      provider: 'azure-devops',
      locator: adoLocator(config),
      token: config.token,
      config: { lastCheck: health },
    });
    return health.ok
      ? back(
          `ok=${encodeURIComponent(
            health.empty
              ? `${adoLocator(config)} is reachable. The repository is empty — applying a flow will create the branch with the pipeline file as its first commit.`
              : `${adoLocator(config)} is reachable — default branch ${health.defaultBranch}.`,
          )}`,
        )
      : back(`error=${encodeURIComponent(describeAdoFailure(health.error ?? 'request_failed'))}`);
  }

  const parsed = parseAdoLocator(typeof body.locator === 'string' ? body.locator : '');
  if (!parsed) {
    return back(
      `error=${encodeURIComponent('The repository must look like organization/project/repo — all three, or a pasted dev.azure.com URL.')}`,
    );
  }
  const typed = typeof body.token === 'string' ? body.token.trim() : '';
  const token = typed || existing?.token || '';
  if (!token) return back(`error=${encodeURIComponent('A personal access token is required.')}`);
  const full = await integrationRoomFor(db, env.hosted, found.team.id, found.team.plan, 'azure-devops');
  if (full) return back(`error=${encodeURIComponent(full)}`);
  // Verify at the moment of saving — a connection that fails three days later
  // at apply time is this exact check, deferred to the worst moment. A failed
  // check still saves (retyping a 90-character locator is the wrong penance);
  // the message and the stored health say plainly what is wrong.
  const health = await adoHealth(env, { ...parsed, token });
  await saveIntegration(db, {
    teamId: found.team.id,
    userId: user.id,
    provider: 'azure-devops',
    locator: adoLocator(parsed),
    token,
    config: { lastCheck: health },
    audit: { actorId: user.id, action: 'integration_connected' },
  });
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'integration_saved',
    detail: `azure-devops: ${adoLocator(parsed)} (${health.ok ? 'verified' : health.error})`,
  });
  if (!health.ok) {
    return back(
      `error=${encodeURIComponent(`Saved, but the connection check failed. ${describeAdoFailure(health.error ?? 'request_failed')}`)}`,
    );
  }
  return back(
    `ok=${encodeURIComponent(
      health.empty
        ? `Connected to ${adoLocator(parsed)} and verified. The repository is empty — applying a flow will create the branch with the pipeline file as its first commit.`
        : `Connected to ${adoLocator(parsed)} and verified — default branch ${health.defaultBranch}. Apply a delivery flow when ready.`,
    )}`,
  );
});

dashboardRoutes.post('/app/teams/:slug/integrations/jira', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const action = typeof body.action === 'string' ? body.action : 'save';
  const back = (query: string) =>
    c.redirect(`/app/teams/${found.team.slug}?tab=integrations&${query}`);
  const existing = await integrationFor(db, found.team.id, 'jira');

  if (action === 'remove') {
    await removeIntegration(db, found.team.id, 'jira', undefined, {
      actorId: user.id,
      action: 'integration_disconnected',
    });
    void track(db, { teamId: found.team.id, userId: user.id, action: 'integration_removed', detail: 'jira' });
    return back(`ok=${encodeURIComponent('Jira disconnected.')}`);
  }
  if (action === 'test') {
    const config = await jiraForTeam(db, found.team.id);
    if (!config) return back(`error=${encodeURIComponent('Connect Jira first.')}`);
    const check = await checkJiraConnection(env, config);
    await saveIntegration(db, {
      teamId: found.team.id,
      userId: user.id,
      provider: 'jira',
      locator: config.site,
      token: config.token,
      config: {
        email: config.email,
        // Which API door answered: a scoped token's cloudId is remembered so
        // issue reads go straight there instead of re-failing the site door.
        ...(check.ok && check.value.cloudId ? { cloudId: check.value.cloudId } : {}),
        lastCheck: { ok: check.ok, at: new Date().toISOString(), ...(check.ok ? {} : { error: check.error }) },
      },
    });
    return check.ok
      ? back(
          `ok=${encodeURIComponent(
            `${config.site} answered — the token belongs to ${check.value.displayName}.${check.value.cloudId ? ' (Scoped token detected; calls route via api.atlassian.com.)' : ''}`,
          )}`,
        )
      : back(`error=${encodeURIComponent(describeJiraFailure(check.error, config.token))}`);
  }

  const site = normalizeJiraSite(typeof body.site === 'string' ? body.site : '');
  if (!site) {
    return back(
      `error=${encodeURIComponent('The site must be a *.atlassian.net host, like acme.atlassian.net.')}`,
    );
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email.includes('@')) return back(`error=${encodeURIComponent('The Atlassian account email is required.')}`);
  const typed = typeof body.token === 'string' ? body.token.trim() : '';
  const token = typed || existing?.token || '';
  if (!token) return back(`error=${encodeURIComponent('An API token is required.')}`);
  const full = await integrationRoomFor(db, env.hosted, found.team.id, found.team.plan, 'jira');
  if (full) return back(`error=${encodeURIComponent(full)}`);
  // Same rule as Azure DevOps: verify while the person is still at the form.
  const check = await checkJiraConnection(env, { site, email, token });
  await saveIntegration(db, {
    teamId: found.team.id,
    userId: user.id,
    provider: 'jira',
    locator: site,
    token,
    config: {
      email,
      ...(check.ok && check.value.cloudId ? { cloudId: check.value.cloudId } : {}),
      lastCheck: { ok: check.ok, at: new Date().toISOString(), ...(check.ok ? {} : { error: check.error }) },
    },
    audit: { actorId: user.id, action: 'integration_connected' },
  });
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'integration_saved',
    detail: `jira: ${site} (${check.ok ? 'verified' : check.error})`,
  });
  if (!check.ok) {
    return back(
      `error=${encodeURIComponent(`Saved, but the connection check failed. ${describeJiraFailure(check.error, token)}`)}`,
    );
  }
  return back(
    `ok=${encodeURIComponent(
      `Connected to ${site} and verified — the token belongs to ${check.value.displayName}.${check.value.cloudId ? ' (Scoped token detected; calls route via api.atlassian.com.)' : ''}`,
    )}`,
  );
});

dashboardRoutes.post('/app/teams/:slug/inbound-token', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  await db
    .update(teams)
    .set({ inboundToken: randomCode(16) })
    .where(eq(teams.id, found.team.id));
  return c.redirect(`/app/teams/${found.team.slug}?tab=integrations`);
});

dashboardRoutes.post('/app/teams/:slug/invites', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  // Two roles, and anything else is the safer one. A role is authority, so it
  // is read from a closed set rather than trusted from the form; only an owner
  // reaches this handler at all, which is what makes granting one legitimate.
  // A caller that posts nothing at all still gets a member invite, which is
  // what this route did before the field existed.
  let grants: 'owner' | 'member' = 'member';
  try {
    if ((await c.req.parseBody()).role === 'owner') grants = 'owner';
  } catch { /* no body is the old shape, and the old shape meant member */ }
  await db.insert(invites).values({
    teamId: found.team.id,
    code: randomCode(9),
    createdBy: user.id,
    role: grants,
    expiresAt: new Date(Date.now() + 7 * DAY),
  });
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'invite_created',
    detail: `joins as ${grants}`,
  });
  return c.redirect(`/app/teams/${found.team.slug}?tab=people#invites`);
});

dashboardRoutes.post('/app/teams/:slug/invites/:id/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  await db
    .update(invites)
    .set({ expiresAt: new Date() })
    .where(and(eq(invites.id, c.req.param('id')), eq(invites.teamId, found.team.id)));
  return c.redirect(`/app/teams/${found.team.slug}?tab=people#invites`);
});

// ---------------------------------------------------------------- join

dashboardRoutes.get('/join/:code', async (c) => {
  const code = c.req.param('code');
  const user = c.get('user');
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/join/${code}`)}`);
  const db = c.get('db');
  const row = await validInvite(db, code);
  if (!row) {
    return c.html(
      <AppLayout user={user} title="Invite">
        <div class="card card-pad joincard">
          <span class="overline">Team invitation</span>
          <span class="tile tile-44 tile-gray" style="font:500 20px/1 var(--sans)">
            ×
          </span>
          <h2 class="title m0" style="font-size:20px">
            This invite link is no longer valid
          </h2>
          <p class="m0" style="color:var(--txt-2)">
            It expired, was revoked, or has been used the maximum number of times. Ask a team owner
            for a fresh link.
          </p>
          <a class="btn" href="/app" style="align-self:flex-start">
            Back to teams
          </a>
        </div>
      </AppLayout>,
      404,
    );
  }
  const already = await teamForMember(db, row.team.slug, user.id);
  if (already) return c.redirect(`/app/teams/${row.team.slug}`);
  const memberCount =
    (await db.select({ n: count() }).from(memberships).where(eq(memberships.teamId, row.team.id)))[0]
      ?.n ?? 0;
  const creator = row.invite.createdBy
    ? (
        await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, row.invite.createdBy))
          .limit(1)
      )[0]?.username
    : undefined;

  return c.html(
    <AppLayout user={user} title="Join team">
      <div class="card card-pad joincard">
        <span class="overline">Team invitation</span>
        <div class="join-team">
          <span class="tile tile-44 tile-green">{initials(row.team.name)}</span>
          <div>
            <div class="join-name">{row.team.name}</div>
            <div class="mono muted">
              {row.team.slug} · {memberCount} {memberCount === 1 ? 'member' : 'members'}
            </div>
          </div>
        </div>
        {/* What the link grants, before it is accepted. The person clicking it
            had no say in which one it is, so the page has to be the one that
            says so — and an owner invitation says what ownership is, because
            "owner" on its own is a word, not an informed yes. */}
        <p class="m0" style="color:var(--txt-2)">
          {creator ? `${creator} invited you` : 'You were invited'} to join as{' '}
          {row.invite.role === 'owner' ? (
            <>
              an <b style="color:var(--ink)">owner</b>. As well as seeing the team's agent map, work
              and sessions and connecting your own agents, you will be able to publish the rules
              every agent on this team is given, connect providers, change the plan and remove
              people.
            </>
          ) : (
            <>
              a <b style="color:var(--ink)">member</b>. You'll see the team's agent map, work and
              sessions, and connect your own agents to it.
            </>
          )}
        </p>
        <div class="row">
          <form method="post" action={`/join/${code}`} class="m0">
            <button class="btn btn-primary" type="submit">
              Join team
            </button>
          </form>
          <a class="btn" href="/app">
            Decline
          </a>
        </div>
        <span class="mono muted small">
          Link expires {fmtDate(row.invite.expiresAt)} · used {row.invite.uses}
          {row.invite.maxUses != null ? ` of ${row.invite.maxUses}` : ''} times
        </span>
      </div>
    </AppLayout>,
  );
});

dashboardRoutes.post('/join/:code', async (c) => {
  const code = c.req.param('code');
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const claimed = await claimInviteMembership(db, { code, userId: user.id });
  if (!claimed.ok) {
    if (claimed.reason === 'member_limit') {
      return c.redirect(
        `/app?error=${encodeURIComponent(`Team member limit reached (${claimed.maxMembers} on the ${claimed.plan} plan).`)}`,
      );
    }
    return c.redirect(`/join/${code}`);
  }
  if (claimed.joined) {
    await notifyTeamJoined(db, c.get('env'), { teamId: claimed.team.id, userId: user.id });
    await c.get('lifecycle').teamMemberCountChanged?.({ db, teamId: claimed.team.id });
    return c.redirect(`/app/teams/${claimed.team.slug}`);
  }
  // Already in this team, and the link said owner. An invite adds a membership;
  // it does not change one, and quietly redirecting to the team page would let
  // somebody believe a link had promoted them. Saying so beats both silently
  // promoting on a link and leaving them to find out later.
  const [existing] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.teamId, claimed.team.id), eq(memberships.userId, user.id)))
    .limit(1);
  const stale = claimed.invite.role === 'owner' && existing?.role !== 'owner';
  return c.redirect(
    stale
      ? `/app/teams/${claimed.team.slug}?ok=${encodeURIComponent(
          "You are already in this team, so the link did not change anything. An invite adds a membership; it does not change one — an owner can promote you on the People tab.",
        )}`
      : `/app/teams/${claimed.team.slug}`,
  );
});

// ---------------------------------------------------------------- tokens

const TokensPage = (props: {
  devices: Map<string, string>;
  /** Which connection is a local adapter, and which agent it listens for — keyed by token. */
  pairings: Map<string, ConnectionPairing>;
  user: User;
  list: (typeof tokens.$inferSelect)[];
  enrollments: Array<{
    enrollment: typeof agentEnrollments.$inferSelect;
    team: typeof teams.$inferSelect | null;
    project: typeof projects.$inferSelect | null;
  }>;
  teamChoices: TokenTeam[];
  selectedTeam?: TokenTeam;
  selectedProject?: TokenProject;
  newEnrollment?: {
    enrollment: typeof agentEnrollments.$inferSelect;
    code: string;
    team?: TokenTeam;
    project?: TokenProject;
    /** Issued for `stma connect`: shown as one terminal command, never as a prompt. */
    terminal?: boolean;
  };
  /** Deprecated direct-POST compatibility; the current UI never submits this path. */
  legacyToken?: string;
  baseUrl: string;
  error?: string;
  notice?: string;
  filterTeam?: string;
  filterState?: string;
  filterQuery?: string;
}) => {
  const {
    user,
    list,
    devices,
    pairings,
    enrollments,
    teamChoices,
    selectedTeam,
    selectedProject,
    newEnrollment,
    legacyToken,
    baseUrl,
    error,
    notice,
  } = props;
  const terminalCommand = newEnrollment?.terminal
    ? connectCommandFor(newEnrollment.code, baseUrl)
    : undefined;
  const setupPrompt = newEnrollment && !newEnrollment.terminal
    ? agentConnectPrompt({
        baseUrl,
        enrollmentId: newEnrollment.enrollment.id,
        enrollmentCode: newEnrollment.code,
        enrollmentExpiresAt: newEnrollment.enrollment.expiresAt,
        scope: newEnrollment.enrollment.scope as TokenScope,
        agentName: newEnrollment.enrollment.name,
        deviceLabel: newEnrollment.enrollment.deviceLabel,
        clientType: newEnrollment.enrollment.clientType,
        role: newEnrollment.enrollment.role ?? 'generalist',
        teamSlug: newEnrollment.team?.slug,
        projectName: newEnrollment.project?.name,
      })
    : undefined;
  const preferredAccess = selectedProject
    ? `project:${selectedProject.id}`
    : selectedTeam
      ? `team:${selectedTeam.id}`
      : 'personal';
  const promptScope = {
    teamSlug: selectedTeam?.slug,
    projectSlug: selectedProject?.slug,
    projectName: selectedProject?.name,
  };
  const mcpAlias = mcpServerAlias(promptScope);
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const codexConnectPrompt = mcpConnectPrompt({
    baseUrl,
    client: 'codex',
    ...promptScope,
  });
  const claudeConnectPrompt = mcpConnectPrompt({
    baseUrl,
    client: 'claude-code',
    ...promptScope,
  });
  const ownerTeams = teamChoices.filter((team) => team.role === 'owner');
  const filterState = props.filterState ?? 'all';
  const filterQuery = (props.filterQuery ?? '').slice(0, 100);
  const FilterContext = () => <>
    <input type="hidden" name="filter_team" value={props.filterTeam ?? ''} />
    <input type="hidden" name="filter_project" value={selectedProject?.id ?? ''} />
    <input type="hidden" name="filter_q" value={filterQuery} />
  </>;
  /**
   * The second line of a connection's name cell: what it is paired with.
   *
   * An adapter gets the control, because which agent works in a checkout is
   * something only its owner knows and an adapter activated before pairing
   * existed has to be pairable without being activated again. An agent gets a
   * sentence, because the pairing is edited from the adapter's side and the
   * person looking at the agent still needs to know it has ears.
   */
  const PairingNote = ({ pairing }: { pairing?: ConnectionPairing }) => {
    if (!pairing) return null;
    if (!pairing.adapter) {
      return pairing.adapters.length ? (
        <div class="small muted" style="font-weight:400;margin-top:4px">
          Adapter paired: {pairing.adapters.join(', ')} — its prompt hook announces work assigned
          to this agent.
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
          <FilterContext />
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
              Nobody — not paired
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
  const visibleEnrollments = enrollments.filter(({ enrollment: row, team }) =>
    !row.redeemedAt && !row.revokedAt && row.expiresAt > new Date() &&
    (!props.filterTeam || team?.slug === props.filterTeam) &&
    (!selectedProject || row.projectId === selectedProject.id) &&
    (!filterQuery || row.name.toLowerCase().includes(filterQuery.toLowerCase())) &&
    ['all', 'incomplete'].includes(filterState),
  );
  const visibleTokens = list.filter((token) => {
    if (props.filterTeam && token.teamId !== teamChoices.find((team) => team.slug === props.filterTeam)?.id) return false;
    if (selectedProject && token.projectId !== selectedProject.id) return false;
    if (filterQuery && !token.name.toLowerCase().includes(filterQuery.toLowerCase())) return false;
    const pending = !!token.setupExpiresAt && !token.activatedAt;
    if (filterState === 'active') return !token.revokedAt && !pending;
    if (filterState === 'incomplete') return !token.revokedAt && pending;
    if (filterState === 'revoked') return !!token.revokedAt;
    return true;
  });
  const tokenScopeLabel = (token: (typeof tokens.$inferSelect)) => {
    const team = teamChoices.find((choice) => choice.id === token.teamId);
    const project = team?.projects.find((choice) => choice.id === token.projectId);
    const scope = ['personal', 'team', 'project'].includes(token.scope)
      ? (token.scope as TokenScope)
      : 'personal';
    return grantLabel({ scope, teamSlug: team?.slug ?? null, projectName: project?.name ?? null });
  };
  // Connecting is done from where the agent will work. Opened from a project, this
  // page is inside that project — the scope bar and the rail already say so — and
  // its trail is the way back to the project's agents; "Connect agent" used to be
  // a walk into personal settings with no return (the owner, 2026-09-20).
  const rail = user.rail;
  const workspace = rail?.team ? { slug: rail.team, name: rail.list.find((t) => t.slug === rail.team)?.name } : null;
  const agentsHome =
    rail?.scope === 'project' && workspace && rail.project
      ? `/app/teams/${workspace.slug}/projects/${encodeURIComponent(rail.project.slug)}/agents`
      : null;
  const trail =
    rail?.scope === 'project' && workspace && rail.project && agentsHome
      ? teamTrail(
          workspace,
          { label: 'Projects', href: `/app/teams/${workspace.slug}/projects` },
          { label: rail.project.name, href: `/app/teams/${workspace.slug}/projects/${encodeURIComponent(rail.project.slug)}` },
          { label: 'Agents', href: agentsHome },
          { label: 'Connect' },
        )
      : rail?.scope === 'workspace' && workspace
        ? teamTrail(workspace, { label: 'Agent connections' })
        : [{ label: 'All workspaces', href: '/app' }, { label: 'My agent connections' }];
  return (
    <AppLayout user={user} active="tokens" title="Agent connections">
      {error ? <Banner kind="error" text={error} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}
      <PageHead
        trail={trail}
        actions={
          agentsHome ? (
            <a class="btn btn-sm" href={agentsHome}>
              Back to {rail!.project!.name} agents
            </a>
          ) : undefined
        }
        title="Agent connections"
        sub="Add one stable MCP address to each client. STMA creates a separate, revocable agent identity during browser authorization — no setup code or credential in a prompt."
      />

      {teamChoices.length === 0 ? (
        <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
          <div class="card-title">Create or join a team first</div>
          <div class="card-note">
            A team is a workspace, even for one person. Create one named “My workspace”,
            then return here. No invitation to yourself or repository setup is needed.
          </div>
          <a class="btn btn-primary" href="/app" style="align-self:flex-start">Go to teams</a>
        </div>
      ) : (
      <>
      {ownerTeams.length > 0 ? (
        <ProjectCreateBar
          workspaces={ownerTeams.map(({ name, slug }) => ({ name, slug }))}
          selectedWorkspace={
            selectedTeam?.role === 'owner' ? selectedTeam.slug : ownerTeams[0]!.slug
          }
          returnTo="tokens"
        />
      ) : null}

      {terminalCommand && newEnrollment ? (
        <ConnectCommand
          command={terminalCommand}
          agent={newEnrollment.enrollment.name}
          device={newEnrollment.enrollment.deviceLabel}
          client={newEnrollment.enrollment.clientType as AgentClientType}
          scope={newEnrollment.enrollment.scope as TokenScope}
          teamSlug={newEnrollment.team?.slug}
          projectName={newEnrollment.project?.name}
        />
      ) : null}

      <ConnectCheckoutForm
        action="/app/tokens"
        teams={teamChoices}
        preferredAccess={preferredAccess}
        context={<FilterContext />}
      />

      <div class="card card-pad" style="display:flex;flex-direction:column;gap:16px">
        <div>
          <span class="overline">Any client · OAuth</span>
          <div class="card-title" style="margin-top:4px">Connect through your agent client</div>
          <div class="card-note">
            Paste one setup request into Codex or Claude Code, or add this same address yourself in
            another OAuth-capable MCP client.
            Your browser opens STMA, where you name the agent and machine and choose workspace or
            project access. The client stores the credential; STMA puts no secret in a prompt,
            terminal command, repository, or user-edited config file. After login, reload that
            client once so its running task can load the new tools.
          </div>
        </div>
        <div class="cmd">
          <code>{baseUrl}/mcp</code>
          <button class="copybtn solid" type="button" data-copy={`${baseUrl}/mcp`}>Copy MCP address</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
          <div style="border:1px solid var(--line);border-radius:12px;padding:14px">
            <b>Codex</b>
            <p class="small muted">Paste one transparent request into Codex. It uses one native OAuth flow; you approve it, then reload the task once.</p>
            <button class="copybtn solid" type="button" data-copy={codexConnectPrompt}>Copy Codex setup request</button>
            <details class="small" style="margin-top:10px"><summary>Manual fallback</summary>
              <ol>
                <li>Open Settings → MCP servers and add a Streamable HTTP server named <code>{mcpAlias}</code>.</li>
                <li>Paste the MCP address above and save.</li>
                <li>Select Authenticate; approve the exact project or workspace in STMA.</li>
              </ol>
              <div class="cmd" style="margin-top:8px"><code>{`codex mcp add ${mcpAlias} --url ${baseUrl}/mcp`}</code><button class="copybtn" type="button" data-copy={`codex mcp add ${mcpAlias} --url ${baseUrl}/mcp`}>Copy</button></div>
              <p class="m0 muted">If Add did not start OAuth itself, run <code>{`codex mcp login ${mcpAlias}`}</code>. Never start a second login while one is open.</p>
            </details>
          </div>
          <div style="border:1px solid var(--line);border-radius:12px;padding:14px">
            <b>Claude Code</b>
            <p class="small muted">Claude Code 2.1.186+ connects each Git checkout (clone or worktree) as its own agent: the request names the entry after that checkout, adds it at local scope and authenticates with the native login. Paste the same request into every Claude Code agent, including several on one machine. If the agent shell is non-interactive, you run the one login command in a regular terminal inside that checkout.</p>
            <button class="copybtn solid" type="button" data-copy={claudeConnectPrompt}>Copy Claude setup request</button>
            <details class="small" style="margin-top:10px"><summary>Manual fallback</summary>
              <p class="m0 muted" style="margin-top:8px">In a terminal inside the checkout, pick a server name no other checkout on this machine uses, such as <code>stma-</code> plus the folder name. Claude Code keeps the login under that name, and logging in again under a name signs out its earlier login.</p>
              <div class="cmd" style="margin-top:8px"><code>{`claude mcp add --transport http --scope local NAME ${baseUrl}/mcp`}</code><button class="copybtn" type="button" data-copy={`claude mcp add --transport http --scope local NAME ${baseUrl}/mcp`}>Copy</button></div>
              <p class="m0 muted">Then run <code>claude mcp login NAME</code> in that checkout, approve in the browser and reload Claude Code there once. Remove an older machine-wide <code>{mcpAlias}</code> entry first, or every checkout also loads it. Local scope changes visibility only; STMA still enforces the approved project or workspace.</p>
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

      <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
        <div>
          <span class="overline">Separate opt-in · local coordination</span>
          <div class="card-title" style="margin-top:4px">Automatically track work in this checkout</div>
          <div class="card-note">
            MCP login alone does not observe edits or start runs. The first-party STMA CLI can
            install ignored, project-local hooks after you review the exact checkout and approve
            a separate project-scoped browser connection. No existing Codex or Claude MCP credential
            is read or copied. This creates a second, separately revocable installation for the
            local adapter; it is not the same identity as the MCP connection. Its approval screen
            asks which of your agents it listens for, so that agent's prompt hook hears work
            assigned to it; an adapter you activated earlier is paired in the list below.
          </div>
        </div>
        {selectedTeam && selectedProject ? (
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
            {(['codex', 'claude-code'] as const).map((target) => {
              const command = `stma adapter activate --target ${target} --team ${shellQuote(selectedTeam.slug)} --project ${shellQuote(selectedProject.name)} --server ${shellQuote(baseUrl)}`;
              return <div class="cmd"><code>{command}</code><button class="copybtn solid" type="button" data-copy={command}>Copy {target} command</button></div>;
            })}
          </div>
        ) : <p class="m0 muted">Select one project above to get its exact local activation command.</p>}
        <p class="small muted m0">
          Run this in a regular terminal at the Git checkout root after installing a STMA CLI version
          that supports <code>adapter activate</code>. Review the browser consent yourself. Codex also
          requires a separate <code>/hooks</code> trust review. File-tool guards do not cover shell,
          operating-system or every external write path. A real run must be observed before claiming
          coordination works.
        </p>
      </div>

      <details class="card card-pad" open={!!setupPrompt}>
        <summary class="card-title">Legacy setup prompt (compatibility)</summary>
        <div class="card-note">
          Use this only for an older MCP client that cannot complete OAuth. This path asks the agent
          to install user-level configuration and may be refused by the client. The recommended flow
          above avoids that model-mediated installation entirely.{' '}
          The prompt carries a single-use {AGENT_ENROLLMENT_TTL_MINUTES}-minute enrollment code. Before any network or
          user-level configuration change, the agent must show you the origin, persistent config
          target, exact access boundary, credential lifetime, revocation path, replacement state and any
          permission tightening, then wait for one explicit approval. After yes it uses the embedded
          one-use code automatically; there is no second code-entry or setup-method step. The prompt
          itself does not prove that its service is trusted; reject
          an origin or grant you do not recognize. For two computers, use separate prompts and machine labels.{' '}
          <a href="/docs#quickstart">Quick start</a>
        </div>
        <form class="authform" method="post" action="/app/tokens" style="margin-top:16px">
          <FilterContext />
          <div class="field">
            <label for="agent-name">Agent name</label>
            <input
              class="in"
              id="agent-name"
              type="text"
              name="name"
              placeholder="codex-reviewer"
              value={`agent-${list.length + enrollments.filter((row) => !row.enrollment.redeemedAt).length + 1}`}
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
              value={`computer-${list.length + enrollments.filter((row) => !row.enrollment.redeemedAt).length + 1}`}
              maxlength={60}
              required
            />
            <span class="help">A short device label; another machine gets another prompt.</span>
          </div>
          <div class="field">
            <label for="client-type">Client</label>
            <select class="in" id="client-type" name="client">
              {AGENT_CLIENT_TYPES.filter((client) => ['codex', 'claude-code', 'cursor'].includes(client)).map((client) => (
                <option value={client}>{client}</option>
              ))}
            </select>
          </div>
          <details><summary>Agent role (optional)</summary>
          <div class="field">
            <label for="agent-role">Role</label>
            <select class="in" id="agent-role" name="role">
              {AGENT_ROLES.map((role) => (
                <option value={role} selected={role === 'generalist'}>
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
              {teamChoices.map((team) => (
                <optgroup label={team.name}>
                  <option value={`team:${team.id}`} selected={preferredAccess === `team:${team.id}`}>
                    Entire workspace — {team.slug}
                  </option>
                  {team.projects.map((project) => (
                    <option
                      value={`project:${project.id}`}
                      selected={preferredAccess === `project:${project.id}`}
                    >
                      Project only — {project.name}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value="personal" selected={preferredAccess === 'personal'}>
                Personal — all current workspace memberships
              </option>
            </select>
            <span class="help">
              Project only is the least-privilege choice. Entire workspace includes every current
              and later project in that workspace. Personal includes every membership this account
              can reach; it does not mean “I work alone”.
            </span>
          </div>
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">
            Create legacy one-time prompt
          </button>
        </form>
      </details>
      </>
      )}

      {setupPrompt ? (
        <div class="reveal">
          <div class="reveal-head">
            <span class="ic">✓</span>
            <div>
              <div class="reveal-title">Setup prompt ready</div>
              <div class="reveal-sub">
                Legacy fallback: paste the whole block into exactly one agent on the named machine. Its enrollment code
                is shown only now, expires in {AGENT_ENROLLMENT_TTL_MINUTES} minutes and can be used once.
                The agent will present one redacted disclosure and ask once before connecting. After
                yes, it consumes the embedded code automatically; you do not enter it again.
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
              {newEnrollment
                ? grantLabel({
                    scope: newEnrollment.enrollment.scope as TokenScope,
                    teamSlug: newEnrollment.team?.slug ?? null,
                    projectName: newEnrollment.project?.name ?? null,
                  })
                : ''}
            </b>
          </div>
          <p class="small">
            The MCP entry is persistent user-level configuration, so it is available to this client
            across repositories; server access remains limited to the enforced grant above. Assume
            the resulting credential has no automatic expiry unless redemption reports one. Revoke
            server access here, then remove the local entry and reload the client to disconnect fully.
            Activation uses a transient helper so the returned token does not pass through a command
            argument, environment variable, tool output, clipboard or temporary response file. If the
            client has no private input channel, it automatically uses a current-user-only OS-temp
            handoff for the short-lived code without asking you to choose another method. If redemption
            succeeds but validation or the local config write fails, the helper automatically revokes
            that just-minted connection instead of leaving unused access active.
          </p>
          <p class="small">
            Once the agent confirms <code>whoami</code>, open “Connect another agent” above for
            your other computer. Already connected both? <a href="#first-message">Send your first message</a> below.
          </p>
        </div>
      ) : null}

      {teamChoices.length > 0 ? (
        <FirstExchange
          baseUrl={baseUrl}
          teamSlug={newEnrollment ? newEnrollment.team?.slug : selectedTeam?.slug}
          projectName={newEnrollment ? newEnrollment.project?.name : selectedProject?.name}
        />
      ) : null}

      {legacyToken ? (
        <div class="reveal">
          <div class="reveal-head">
            <span class="ic">!</span>
            <div>
              <div class="reveal-title">Legacy personal token created</div>
              <div class="reveal-sub">
                This backward-compatible token reaches all of your current memberships and is
                shown once. New agent connections should use the scoped prompt form above.
              </div>
            </div>
          </div>
          <div class="cmd">
            <code>{legacyToken}</code>
            <button class="copybtn solid" type="button" data-copy={legacyToken}>Copy token</button>
          </div>
        </div>
      ) : null}

      {visibleEnrollments.length ? (
        <div class="card scroll-x">
          <div class="card-head">
            <div>
              <div class="card-title">Setup prompts not yet used</div>
              <div class="card-note">Codes cannot be shown again. Revoke or let them expire, then create a fresh prompt.</div>
            </div>
          </div>
          <table class="tbl">
            <tr><th>Agent</th><th>Machine</th><th>Access</th><th>Expires</th><th></th></tr>
            {visibleEnrollments
              .map((row) => (
                <tr>
                  <td class="name">{row.enrollment.name}</td>
                  <td class="mono muted">{row.enrollment.deviceLabel}</td>
                  <td>{grantLabel({ scope: row.enrollment.scope as TokenScope, teamSlug: row.team?.slug ?? null, projectName: row.project?.name ?? null })}</td>
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
                      <FilterContext />
                      <button class="linklike" type="submit">Revoke</button>
                    </form>
                  </td>
                </tr>
              ))}
          </table>
        </div>
      ) : null}

      <form method="get" action="/app/tokens" class="card card-pad" style="display:flex;gap:12px;flex-wrap:wrap;align-items:end">
        {selectedProject ? <input type="hidden" name="project" value={selectedProject.id} /> : null}
        <div class="field"><label for="connection-workspace">Workspace filter</label><select class="in" name="team" id="connection-workspace">
          <option value="">All my connections</option>
          {teamChoices.map((team) => <option value={team.slug} selected={props.filterTeam === team.slug}>{team.name}</option>)}
        </select></div>
        <div class="field"><label for="connection-state">Status</label><select class="in" name="state" id="connection-state">
          {['all', 'active', 'incomplete', 'revoked'].map((state) => <option value={state} selected={filterState === state}>{state}</option>)}
        </select></div>
        <div class="field"><label for="connection-search">Agent name</label><input class="in" name="q" id="connection-search" value={filterQuery} placeholder="Search connections" /></div>
        <button class="btn" type="submit">Filter</button><a class="btn" href="/app/tokens">Clear filters</a>
        <p class="help" style="flex-basis:100%">Awaiting client: reload the named client and check its STMA connection within 15 minutes of setup. Setup expired: create a fresh prompt. Active confirms client identity, not repository readiness or completed work. Legacy credentials without verification remain unverified.</p>
      </form>
      {visibleTokens.length === 0 ? (
        <div class="card">
          <div class="empty">
            <h2>{list.length ? 'No connections match these filters' : 'No connected agents yet'}</h2>
            <p>
              Create a prompt above. A token appears here only after that agent redeems its
              one-time enrollment code.
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
            {visibleTokens.map((t) => (
              <tr style={t.revokedAt ? 'color:var(--mut-2)' : ''}>
                <td class="name">
                  {t.name}
                  {t.revokedAt ? null : <PairingNote pairing={pairings.get(t.id)} />}
                </td>
                <td>{tokenScopeLabel(t)}</td>
                <td class="mono">{t.audience ? 'OAuth · client-managed' : `${t.prefix}••••••••`}</td>
                <td class="mono muted hide-sm">
                  {/* Not the token's name — the device label the snapshots it pushed
                      carry. The two differ the moment somebody renames a token, and
                      the one that matters for a diff is this one. */}
                  {devices.get(t.id) ?? 'not yet'}
                </td>
                <td class="muted">{fmtDate(t.createdAt)}</td>
                <td class="muted">{timeAgo(t.lastUsedAt) ?? '—'}</td>
                <td>
                  {t.revokedAt ? (
                    <span class="pill pill-muted">
                      <span class="dot gray" />
                      revoked
                    </span>
                  ) : t.setupExpiresAt && !t.activatedAt ? (
                    <span class="pill pill-muted"><span class="dot gray" />{t.setupExpiresAt <= new Date() ? 'setup expired' : 'awaiting client'}</span>
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
                      data-confirm={`The agent using "${t.name}" loses server access immediately; active runs become stale and their claims are released. Existing snapshots, runs and sessions are kept. This does not remove the local MCP entry or stop the client — remove it there and reload separately.`}
                      data-confirm-title={`Revoke "${t.name}"?`}
                      data-confirm-action="Revoke token"
                    >
                      <FilterContext />
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

      <div class="card card-pad" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <div>
          <div class="card-title">Everything else about you</div>
          <div class="card-note">
            This page is machines. Your password and the end of the road live on Account; what
            STMA emails you lives on Notifications.
          </div>
        </div>
        <div class="acts">
          <a class="btn" href="/app/account">
            Account
          </a>
          <a class="btn" href="/app/notifications">
            Notifications
          </a>
        </div>
      </div>
    </AppLayout>
  );
};


// ---------------------------------------------------------------- account

/** A browser, as its own owner would recognise it. */
const clientName = (ua: string | null): string => {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Macintosh|Mac OS/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
};

const AccountPage = (props: {
  user: User;
  confirmByEmail: boolean;
  support: string;
  sessions: BrowserSession[];
  pendingEmail?: string;
  error?: string;
  notice?: string;
}) => {
  const { user, confirmByEmail, support, sessions, pendingEmail, error, notice } = props;
  const unconfirmed = confirmByEmail && Boolean(user.email) && !user.emailVerifiedAt;
  return (
    <AppLayout user={user} active="account" title="Account">
      {error ? <Banner kind="error" text={error} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}
      <PageHead
        trail={[{ label: 'All workspaces', href: '/app' }, { label: 'Account' }]}
        title="Account"
        sub="Your sign-in and the end of the road. Agent credentials and machines live on Agent connections."
      />

      {/*
       * The address, first, because everything else on this page depends on it.
       * With sign-in codes on it is where the second factor and every password
       * reset go, so an address nobody has proved is an account nobody can get
       * back into — and a typo at signup used to mean exactly that, with an
       * operator as the only way out.
       */}
      {confirmByEmail && user.email ? (
        <div class="card card-pad" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <div class="card-title">
              Email address{' '}
              <span class={`pill ${unconfirmed ? 'pill-open' : 'pill-active'}`}>
                {unconfirmed ? 'not confirmed' : 'confirmed'}
              </span>
            </div>
            <div class="card-note">
              <b>{user.email}</b> is where your sign-in codes and password resets go. Nowhere else.
              {unconfirmed
                ? ' Nobody has shown they can read it yet, so confirm it or correct it while you are still signed in.'
                : ''}
            </div>
          </div>
          {unconfirmed ? (
            <form class="inline m0" method="post" action="/app/account/email/verify">
              <input
                class="in"
                style="max-width:160px"
                type="text"
                name="code"
                inputmode="numeric"
                pattern="[0-9]{6}"
                maxlength={6}
                placeholder="000000"
                aria-label="Confirmation code"
                required
              />
              <button class="btn btn-primary" type="submit">
                Confirm this address
              </button>
            </form>
          ) : null}
          {unconfirmed ? (
            <form class="inline m0" method="post" action="/app/account/email/code">
              <button class="btn btn-sm" type="submit">
                Email me a code
              </button>
            </form>
          ) : null}

          <details open={Boolean(pendingEmail)}>
            <summary class="small muted">Use a different address</summary>
            {pendingEmail ? (
              <form
                method="post"
                action="/app/account/email/change/confirm"
                style="display:flex;flex-direction:column;gap:12px;margin-top:12px"
              >
                <input type="hidden" name="email" value={pendingEmail} />
                <Field
                  id="email-change-code"
                  label={`Code sent to ${pendingEmail}`}
                  required
                  help="Nothing has changed yet. Entering this code is what moves the account."
                >
                  <input
                    class="in"
                    id="email-change-code"
                    type="text"
                    name="code"
                    inputmode="numeric"
                    pattern="[0-9]{6}"
                    maxlength={6}
                    placeholder="000000"
                    aria-describedby="email-change-code-help"
                    required
                  />
                </Field>
                <button class="btn btn-primary" type="submit" style="align-self:flex-start">
                  Move the account
                </button>
              </form>
            ) : (
              <form
                method="post"
                action="/app/account/email/change"
                style="display:flex;flex-direction:column;gap:12px;margin-top:12px"
              >
                <Field
                  id="email-new"
                  label="New address"
                  required
                  help="We mail a code there. The account moves only once you enter it, and the old address is told."
                >
                  <input
                    class="in"
                    id="email-new"
                    type="email"
                    name="email"
                    autocomplete="email"
                    aria-describedby="email-new-help"
                    required
                  />
                </Field>
                <Field
                  id="email-current-password"
                  label="Current password"
                  required
                  help="A borrowed session must not be able to redirect where this account's recovery goes."
                >
                  <input
                    class="in"
                    id="email-current-password"
                    type="password"
                    name="current_password"
                    autocomplete="current-password"
                    aria-describedby="email-current-password-help"
                    required
                  />
                </Field>
                <button class="btn" type="submit" style="align-self:flex-start">
                  Email a code to the new address
                </button>
              </form>
            )}
          </details>
        </div>
      ) : null}
      {user.passwordHash ? (
        <div class="card card-pad" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <div class="card-title">Account</div>
            <div class="card-note">
              Change the password for <b>{user.email ?? user.username}</b>. Other signed-in browser
              sessions are signed out; agent tokens keep working.
            </div>
          </div>
          {confirmByEmail ? (
            <form class="inline m0" method="post" action="/app/account/password/code">
              <button class="btn" type="submit">
                Email me a confirmation code
              </button>
              <span class="help">
                Required to change the password. The code is valid for {CODE_TTL_MINUTES} minutes.
              </span>
            </form>
          ) : null}
          <form class="authform" method="post" action="/app/account/password" style="max-width:360px">
            <div class="field">
              <label>Current password</label>
              <input
                class="in"
                type="password"
                name="current_password"
                autocomplete="current-password"
                required
              />
            </div>
            <div class="field">
              <label>New password</label>
              <input
                class="in"
                type="password"
                name="new_password"
                autocomplete="new-password"
                minlength={8}
                required
              />
              <span class="help">At least 8 characters.</span>
            </div>
            <div class="field">
              <label>Repeat new password</label>
              <input
                class="in"
                type="password"
                name="new_password_confirm"
                autocomplete="new-password"
                minlength={8}
                required
              />
            </div>
            {confirmByEmail ? (
              <div class="field">
                <label>Confirmation code</label>
                <input
                  class="in"
                  type="text"
                  name="code"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxlength={6}
                  placeholder="000000"
                  required
                />
                <span class="help">The 6 digits we emailed you.</span>
              </div>
            ) : null}
            <button class="btn btn-primary" type="submit" style="align-self:flex-start">
              Change password
            </button>
          </form>
        </div>
      ) : null}

      {/*
       * "Signed out everywhere" was a claim with no screen behind it. Somebody
       * who suspects their account has been taken over needs to see where it is
       * open and be able to close it, and a password change alone answers
       * neither question — it ends browser sessions silently and leaves agent
       * connections untouched.
       */}
      <div class="card card-pad" style="display:flex;flex-direction:column;gap:14px">
        <div>
          <div class="card-title">Where you are signed in</div>
          <div class="card-note">
            Browser sessions on this account, most recent first. Agent connections are separate and
            a password never touched them; they live on{' '}
            <a href="/app/tokens">Agent connections</a>.
          </div>
        </div>
        {sessions.length === 0 ? (
          <p class="m0 sub">Only this browser.</p>
        ) : (
          <div class="ledger">
            {sessions.map((s) => (
              <div class="lrow" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                <div style="flex:1;min-width:200px">
                  <div>
                    <b>{clientName(s.userAgent)}</b>
                    {s.current ? <span class="pill pill-active" style="margin-left:8px">this browser</span> : null}
                  </div>
                  {/*
                    A session that started before this page existed has no
                    address and no last-seen, and saying "never" about a live
                    session reads as broken. Say what is known and stop.
                  */}
                  <div class="small muted mono">
                    {s.lastSeenAt
                      ? `${s.lastIp ?? 'unknown address'} · last seen ${timeAgo(s.lastSeenAt)} · started ${timeAgo(s.createdAt)}`
                      : `started ${timeAgo(s.createdAt)} · nothing recorded since`}
                  </div>
                </div>
                <form class="m0" method="post" action="/app/account/sessions/revoke">
                  <input type="hidden" name="handle" value={s.handle} />
                  <button class="btn btn-sm" type="submit">
                    {s.current ? 'Sign out here' : 'Sign out'}
                  </button>
                </form>
              </div>
            ))}
          </div>
        )}
        <form
          class="m0"
          method="post"
          action="/app/account/sessions/revoke-all"
          data-confirm="Every browser signed in to this account is signed out, including this one. Agent connections are not affected."
          data-confirm-title="Sign out everywhere?"
          data-confirm-action="Sign out everywhere"
        >
          <button class="btn btn-danger" type="submit" style="align-self:flex-start">
            Sign out everywhere
          </button>
        </form>
      </div>

      {support ? (
        <div class="card card-pad">
          <div class="card-title">Get help</div>
          <div class="card-note">
            Write to{' '}
            <Mail to={support} /> from the address on this account. Never put a
            password, an access code or an agent token in that mail.
          </div>
        </div>
      ) : null}

      <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
        <div>
          <div class="card-title">Danger zone</div>
          <div class="card-note">
            Deleting your account signs you out everywhere, revokes all tokens and removes you from
            every team. Messages and snapshots you shared stay with their teams, attributed to a
            deleted account.
          </div>
        </div>
        <form
          method="post"
          action="/app/account/delete"
          class="m0"
          data-confirm="All your browser sessions, agent credentials, installations and team memberships are removed and your username is scrubbed. Content you shared with teams stays. This cannot be undone."
          data-confirm-title="Delete your account?"
          data-confirm-action="Delete account"
        >
          <button class="btn btn-danger" type="submit" style="align-self:flex-start">
            Delete account
          </button>
        </form>
      </div>
    </AppLayout>
  );
};

dashboardRoutes.get('/app/account', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const pending = normalizeEmail(c.req.query('pending_email'));
  return c.html(
    <AccountPage
      user={user}
      confirmByEmail={c.get('env').twoFactor}
      support={c.get('env').supportEmail}
      sessions={await sessionsFor(c.get('db'), user.id, currentSessionId(c))}
      // Only ever an address this account just asked to move to, and only for
      // as long as the code lives; it names the form, it authorizes nothing.
      pendingEmail={isEmail(pending) ? pending : undefined}
      error={c.req.query('error')}
      notice={c.req.query('ok')}
    />,
  );
});

dashboardRoutes.get('/app/tokens', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const teamChoices = await tokenTeamsFor(db, user.id);
  const selectedTeam =
    teamChoices.find((team) => team.slug === c.req.query('team')) ?? teamChoices[0];
  const requestedProject = c.req.query('project');
  const selectedProject = selectedTeam?.projects.find(
    (project) =>
      project.id === requestedProject ||
      project.slug === requestedProject ||
      project.name === requestedProject,
  );
  await ensureRail(db, user, selectedTeam?.slug);
  const list = await db
    .select()
    .from(tokens)
    .where(eq(tokens.userId, user.id))
    .orderBy(desc(tokens.createdAt));
  // What each token reports as, from the snapshots it actually pushed. Bounded by
  // this person's own tokens, and grouped rather than fetched row by row.
  const devices = new Map<string, string>();
  if (list.length > 0) {
    for (const row of await db
      .select({ tokenId: agentInstallations.tokenId, device: agentInstallations.deviceLabel })
      .from(agentInstallations)
      .where(
        inArray(
          agentInstallations.tokenId,
          list.map((token) => token.id),
        ),
      )) {
      if (row.tokenId && row.device) devices.set(row.tokenId, row.device);
    }
    for (const row of await db
      .select({ tokenId: snapshots.tokenId, label: max(snapshots.deviceLabel) })
      .from(snapshots)
      .where(
        inArray(
          snapshots.tokenId,
          list.map((t) => t.id),
        ),
      )
      .groupBy(snapshots.tokenId)) {
      // A real snapshot wins over enrollment metadata: this column answers
      // what the connection actually reports as, while still avoiding "not yet"
      // immediately after a successful activation.
      if (row.tokenId && row.label) devices.set(row.tokenId, row.label);
    }
  }
  return c.html(
    <TokensPage
      user={user}
      list={list}
      enrollments={await enrollmentRowsFor(db, user.id)}
      devices={devices}
      pairings={await connectionPairings(db, user.id)}
      teamChoices={teamChoices}
      selectedTeam={selectedTeam}
      selectedProject={selectedProject}
      baseUrl={c.get('env').baseUrl}
      error={c.req.query('error')}
      notice={c.req.query('ok')}
      filterTeam={c.req.query('team') || undefined}
      filterState={c.req.query('state')}
      filterQuery={c.req.query('q')}
    />,
  );
});

dashboardRoutes.post('/app/tokens', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const body = await c.req.parseBody();
  const name =
    typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : '';
  // Compatibility for pre-enrollment clients and the published CLI-era test
  // contract. The current form always sends device+access, so no normal user
  // falls into an all-memberships credential accidentally.
  if (body.device === undefined && body.access === undefined && name) {
    const pat = generatePat();
    await db.insert(tokens).values({
      userId: user.id,
      name,
      tokenHash: pat.hash,
      prefix: pat.prefix,
    });
    const teamChoices = await tokenTeamsFor(db, user.id);
    const list = await db
      .select()
      .from(tokens)
      .where(eq(tokens.userId, user.id))
      .orderBy(desc(tokens.createdAt));
    await ensureRail(db, user, teamChoices[0]?.slug);
    return c.html(
      <TokensPage
        user={user}
        list={list}
        enrollments={await enrollmentRowsFor(db, user.id)}
        devices={new Map()}
        pairings={await connectionPairings(db, user.id)}
        teamChoices={teamChoices}
        selectedTeam={teamChoices[0]}
        legacyToken={pat.token}
        baseUrl={c.get('env').baseUrl}
      />,
    );
  }
  // A connection started from a project's Agents page is refused back INTO that
  // project: the person is one corrected field away from a command, and landing on
  // the account's list took the project, the trail and the way back with it.
  const refused = (message: string) => {
    let query = `error=${encodeURIComponent(message)}`;
    for (const [field, param] of [['filter_team', 'team'], ['filter_project', 'project']] as const) {
      const held = body[field];
      if (typeof held === 'string' && held) query += `&${param}=${encodeURIComponent(held.slice(0, 100))}`;
    }
    return c.redirect(`/app/tokens?${query}`);
  };
  const terminal = body.mode === 'terminal';
  // The identity fields and the two clients a connect command can write hooks for
  // are read by `domain/connectRequests.ts`, which a project's Agents page calls
  // too: the same mistake must not get two different sentences depending on which
  // door it was made at.
  const asked = readConnectRequest(body, { terminal });
  if ('error' in asked) return refused(asked.error);
  const { device, client, role } = asked;
  const teamChoices = await tokenTeamsFor(db, user.id);
  if (teamChoices.length === 0) {
    return refused('Create or join a team before connecting an agent.');
  }
  const access = typeof body.access === 'string' ? body.access : '';
  let scope: TokenScope;
  let selectedTeam: TokenTeam | undefined;
  let selectedProject: TokenProject | undefined;
  if (access === 'personal') {
    scope = 'personal';
  } else if (access.startsWith('team:')) {
    scope = 'team';
    selectedTeam = teamChoices.find((team) => team.id === access.slice('team:'.length));
  } else if (access.startsWith('project:')) {
    scope = 'project';
    const projectId = access.slice('project:'.length);
    selectedTeam = teamChoices.find((team) => team.projects.some((project) => project.id === projectId));
    selectedProject = selectedTeam?.projects.find((project) => project.id === projectId);
  } else {
    return refused('Choose an access boundary for this agent.');
  }
  if (terminal && scope !== 'project') {
    return refused('A connect command is for one project: its hooks belong to one checkout.');
  }
  if ((scope !== 'personal' && !selectedTeam) || (scope === 'project' && !selectedProject)) {
    return refused('That team or project is no longer available to your account.');
  }
  const issued = await createAgentEnrollment(db, {
    userId: user.id,
    name,
    deviceLabel: device,
    clientType: client,
    role,
    scope,
    teamId: selectedTeam?.id,
    projectId: selectedProject?.id,
    ...(terminal ? { ttlMinutes: TERMINAL_CONNECT_TTL_MINUTES } : {}),
  });
  const list = await db
    .select()
    .from(tokens)
    .where(eq(tokens.userId, user.id))
    .orderBy(desc(tokens.createdAt));
  // The enrollment code is shown once, so this POST answers with a page rather
  // than a redirect — and a page draws the rail.
  // …in the scope the command is for. Without the project the rail fell back to the
  // workspace at the one moment the person needs the way to the project's Agents,
  // where the new agent is about to appear.
  await ensureRail(db, user, selectedTeam?.slug, selectedProject?.slug);
  return c.html(
    <TokensPage
      user={user}
      list={list}
      enrollments={await enrollmentRowsFor(db, user.id)}
      devices={new Map()}
      pairings={await connectionPairings(db, user.id)}
      teamChoices={teamChoices}
      selectedTeam={selectedTeam}
      selectedProject={selectedProject}
      newEnrollment={{
        enrollment: issued.enrollment,
        code: issued.code,
        team: selectedTeam,
        project: selectedProject,
        terminal,
      }}
      baseUrl={c.get('env').baseUrl}
    />,
  );
});

async function connectionReturn(c: Context<AppEnv>, message: string, ok = true) {
  const body = await c.req.parseBody();
  const params = new URLSearchParams({ [ok ? 'ok' : 'error']: message });
  for (const [field, name] of [['filter_team', 'team'], ['filter_project', 'project'], ['filter_q', 'q']] as const) {
    if (typeof body[field] === 'string' && body[field]) params.set(name, body[field].slice(0, 100));
  }
  // Preserve identity filters, but show every state so the newly revoked row
  // remains visible instead of disappearing from an "active" filter.
  return c.redirect(`/app/tokens?${params}`);
}

dashboardRoutes.post('/app/enrollments/:id/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (!UUID_RE.test(c.req.param('id'))) return c.notFound();
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
    return connectionReturn(c, 'Setup activated before this page refreshed. Its agent connection and server credential are revoked.');
  }

  return connectionReturn(c, 'That setup code was expired, already revoked, or was not yours. No active connection was found for it.', false);
});

dashboardRoutes.post('/app/tokens/:id/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (!UUID_RE.test(c.req.param('id'))) return c.notFound();
  const db = c.get('db');
  const linked = await db
    .select({ id: agentInstallations.id })
    .from(agentInstallations)
    .where(
      and(
        eq(agentInstallations.tokenId, c.req.param('id')),
        eq(agentInstallations.userId, user.id),
      ),
    )
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
 * second installation to deliver a label. Every rule — yours, live, an adapter,
 * a reachable agent — is `setCompanion`'s; this handler only carries the answer.
 */
dashboardRoutes.post('/app/installations/:id/companion', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  if (!UUID_RE.test(c.req.param('id'))) return c.notFound();
  const body = await c.req.parseBody();
  const requested = typeof body.companion === 'string' ? body.companion.trim() : '';
  if (requested !== 'none' && !UUID_RE.test(requested)) {
    return connectionReturn(c, 'Choose the agent this adapter listens for, or Nobody to unpair it.', false);
  }
  const result = await setCompanion(
    c.get('db'),
    user.id,
    c.req.param('id'),
    requested === 'none' ? null : requested,
  );
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

// ---------------------------------------------------------------- account

const accountBack = (c: Context<AppEnv>, msg: string, ok = false) =>
  c.redirect(`/app/account?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);

/**
 * The same lock the sign-in form and the invite door apply, for the two places
 * on this page that ask for the current password.
 *
 * `PRODUCT_FLOWS` F0a says the throttle belongs to the password rather than to
 * the sign-in form, and these were the remaining exceptions: `/app/*` carries
 * no per-IP limit of any kind, so a borrowed session could guess the account's
 * password without limit and, on a hit, either lock the real owner out or move
 * the address every future reset goes to. That is escalation from a stolen
 * cookie to permanent ownership, which is the thing the password is still
 * standing in the way of.
 *
 * Deliberately the same counter as the sign-in form, not a separate one: two
 * counters would let an attacker spend five guesses at each door. The cost is
 * that fumbling your own password here can lock you out of `/login` for the
 * rest of the window — which is exactly what it already does at the other two
 * doors, and a reset lifts it.
 */
async function checkAccountPassword(
  c: Context<AppEnv>,
  user: User,
  password: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const db = c.get('db');
  const email = user.email ?? '';
  const gate = await loginGate(db, email);
  if (gate.locked) {
    logLine({ evt: 'auth', a: 'account_locked', u: user.username });
    return { ok: false, message: lockedMessage(gate.resetAt) };
  }
  if (await verifyPassword(password, user.passwordHash!)) {
    await clearLoginFailures(db, email);
    return { ok: true };
  }
  const failed = await recordLoginFailure(db, email);
  logLine({ evt: 'auth', a: 'account_password_fail', u: user.username, n: failed.attempts });
  if (failed.justLocked && user.email) {
    void sendMail(c.get('env'), {
      to: user.email,
      ...failedSignInsEmail(c.get('env').baseUrl, Math.round(LOGIN_FAIL_WINDOW_MS / 60_000)),
    });
  }
  return {
    ok: false,
    message: failed.locked ? lockedMessage(failed.resetAt) : 'Current password is incorrect.',
  };
}

/** Email a fresh code proving the address already on the account. */
dashboardRoutes.post('/app/account/email/code', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  if (!env.twoFactor) return accountBack(c, 'This server does not use email confirmation codes.');
  if (!user.email) return accountBack(c, 'This account has no email address yet.');
  if (user.emailVerifiedAt) return accountBack(c, 'That address is already confirmed.', true);
  const issued = await issueAuthCode(c.get('db'), user.id, 'email_verify', user.email);
  if (!issued.ok) {
    return accountBack(c, 'Too many codes requested. Wait a few minutes, then try again.');
  }
  const sent = await sendMail(env, {
    to: user.email,
    ...emailVerifyCodeEmail(issued.code, CODE_TTL_MINUTES),
  });
  if (!sent.ok) {
    logLine({ evt: 'auth', a: 'verify_code_fail', u: user.username, why: sent.error });
    return accountBack(c, 'We could not email the code. Try again in a minute.');
  }
  return accountBack(c, `Code sent to ${user.email}. It is valid for ${CODE_TTL_MINUTES} minutes.`, true);
});

/** Confirm the address on the account by entering the code mailed to it. */
dashboardRoutes.post('/app/account/email/verify', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const code = typeof (await c.req.parseBody()).code === 'string' ? String((await c.req.parseBody()).code).trim() : '';
  if (!/^\d{6}$/.test(code)) return accountBack(c, 'Enter the 6-digit code we emailed you.');
  if (!user.email) return accountBack(c, 'This account has no email address yet.');
  // Bound to the address on the account now: a code mailed before an operator
  // moved the account elsewhere proves the old mailbox, not this one.
  const result = await checkUserCode(db, user.id, 'email_verify', code, user.email);
  if (result.status === 'invalid') {
    return accountBack(
      c,
      `That code is not right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.`,
    );
  }
  if (result.status !== 'ok') return accountBack(c, 'That code has expired or was already used. Request a new one.');
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
  logLine({ evt: 'auth', a: 'email_verified', u: user.username });
  return accountBack(c, 'Address confirmed. This is where your sign-in codes and password resets go.', true);
});

/**
 * Start moving the account to a different address.
 *
 * The code goes to the NEW address, because the point is to prove somebody can
 * read it before anything depends on it. The current password is required for
 * the same reason it is required to change a password: a borrowed session must
 * not be able to redirect the account's own recovery channel.
 */
dashboardRoutes.post('/app/account/email/change', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  const db = c.get('db');
  if (!env.twoFactor) return accountBack(c, 'This server does not use email confirmation codes.');
  const body = await c.req.parseBody();
  const wanted = normalizeEmail(body.email);
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  if (!user.passwordHash) return accountBack(c, 'This account has no password, so its address is an operator change.');
  const proved = await checkAccountPassword(c, user, current);
  if (!proved.ok) return accountBack(c, proved.message);
  if (!isEmail(wanted)) return accountBack(c, 'Enter a valid email address.');
  if (wanted === user.email) return accountBack(c, 'That is already the address on this account.');
  // Checked now for a clear answer, and again at confirm time, because the
  // window between the two is long enough for somebody else to take it.
  if (!(await emailIsFree(db, wanted))) {
    return accountBack(c, 'An account already uses that address.');
  }
  const issued = await issueAuthCode(db, user.id, 'email_change', wanted);
  if (!issued.ok) return accountBack(c, 'Too many codes requested. Wait a few minutes, then try again.');
  const sent = await sendMail(env, { to: wanted, ...emailChangeCodeEmail(issued.code, CODE_TTL_MINUTES) });
  if (!sent.ok) return accountBack(c, 'We could not email that address. Check it and try again.');
  logLine({ evt: 'auth', a: 'email_change_code', u: user.username });
  // The pending address rides the form rather than a column: it is only useful
  // for the next ten minutes, and a row would outlive the code that justifies it.
  return c.redirect(
    `/app/account?pending_email=${encodeURIComponent(wanted)}&ok=${encodeURIComponent(
      `Code sent to ${wanted}. Enter it below to finish; nothing changes until you do.`,
    )}`,
  );
});

dashboardRoutes.post('/app/account/email/change/confirm', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  const db = c.get('db');
  const body = await c.req.parseBody();
  const wanted = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!isEmail(wanted)) return accountBack(c, 'Start the change again — the new address was lost.');
  if (!/^\d{6}$/.test(code)) return accountBack(c, 'Enter the 6-digit code we emailed you.');
  // The address comes back from the form, so the code has to vouch for it: it
  // was mailed to one address and counts beside that one only.
  const result = await checkUserCode(db, user.id, 'email_change', code, wanted);
  if (result.status === 'invalid') {
    return accountBack(
      c,
      `That code is not right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.`,
    );
  }
  if (result.status !== 'ok') return accountBack(c, 'That code has expired or was already used. Start again.');
  if (!(await emailIsFree(db, wanted))) return accountBack(c, 'An account already uses that address.');
  const leaving = user.email;
  try {
    await db
      .update(users)
      // Proved by the code that reached it, so it lands confirmed.
      .set({ email: wanted, emailVerifiedAt: new Date() })
      .where(eq(users.id, user.id));
  } catch {
    return accountBack(c, 'An account already uses that address.');
  }
  logLine({ evt: 'auth', a: 'email_changed', u: user.username });
  // The address being left is the only warning it will ever get, and losing it
  // is how an account is quietly taken over.
  if (leaving) void sendMail(env, { to: leaving, ...emailChangedNotice(wanted, env.baseUrl) });
  return accountBack(c, `This account now signs in as ${wanted}.`, true);
});

/** End one browser session, named by the digest the page rendered. */
dashboardRoutes.post('/app/account/sessions/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const body = await c.req.parseBody();
  const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
  const mine = currentSessionId(c);
  const gone = await revokeSession(c.get('db'), user.id, handle);
  if (!gone) return accountBack(c, 'That session has already ended.');
  logLine({ evt: 'auth', a: 'session_revoked', u: user.username });
  // Revoking the one you are holding is a sign-out, and pretending otherwise
  // would leave the next page load answering 302 with no explanation.
  if (mine && sessionHandle(mine) === handle) {
    return c.redirect(`/login?ok=${encodeURIComponent('Signed out of this browser.')}`);
  }
  return accountBack(c, 'That browser is signed out.', true);
});

dashboardRoutes.post('/app/account/sessions/revoke-all', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  await invalidateAllSessions(c.get('db'), user.id);
  logLine({ evt: 'auth', a: 'sessions_revoked_all', u: user.username });
  return c.redirect(
    `/login?ok=${encodeURIComponent('Signed out of every browser. Your agent connections were not touched.')}`,
  );
});

/** Email a fresh password-change code to the signed-in account. */
dashboardRoutes.post('/app/account/password/code', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  if (!env.twoFactor) return accountBack(c, 'This server does not use email confirmation codes.');
  if (!user.passwordHash) return accountBack(c, 'This account has no password to change.');
  if (!user.email) {
    return accountBack(
      c,
      'Your account has no email address yet — ask an operator to set one before changing the password.',
    );
  }
  const issued = await issueAuthCode(c.get('db'), user.id, 'password_change');
  if (!issued.ok) {
    return accountBack(c, 'Too many codes requested. Wait a few minutes, then try again.');
  }
  const sent = await sendMail(env, {
    to: user.email,
    ...passwordChangeCodeEmail(issued.code, CODE_TTL_MINUTES),
  });
  if (!sent.ok) {
    logLine({ evt: 'auth', a: 'pwchange_code_fail', u: user.username, why: sent.error });
    return accountBack(c, 'We could not email the confirmation code. Try again in a minute.');
  }
  logLine({ evt: 'auth', a: 'pwchange_code', u: user.username });
  return accountBack(c, `Code sent. It is valid for ${CODE_TTL_MINUTES} minutes.`, true);
});

dashboardRoutes.post('/app/account/password', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  const db = c.get('db');
  const back = (msg: string, ok = false) => accountBack(c, msg, ok);
  if (!user.passwordHash) return back('This account has no password to change.');
  const body = await c.req.parseBody();
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  const confirm = typeof body.new_password_confirm === 'string' ? body.new_password_confirm : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const proved = await checkAccountPassword(c, user, current);
  if (!proved.ok) return back(proved.message);
  if (next.length < 8 || next.length > 128) return back('New password must be 8-128 characters.');
  if (next !== confirm) return back('New passwords do not match.');

  // Same second factor as sign-in: knowing the current password is not enough.
  if (env.twoFactor) {
    if (!user.email) {
      return back(
        'Your account has no email address yet — ask an operator to set one before changing the password.',
      );
    }
    if (!/^\d{6}$/.test(code)) {
      return back('Enter the 6-digit code we emailed you — request one with "Email me a confirmation code".');
    }
    const result = await checkUserCode(db, user.id, 'password_change', code);
    if (result.status === 'invalid') {
      return back(
        `That code is not right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.`,
      );
    }
    if (result.status !== 'ok') {
      logLine({ evt: 'auth', a: 'pwchange_code_bad', u: user.username, why: result.status });
      return back('That code has expired or was already used. Request a new one.');
    }
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(next) })
    .where(eq(users.id, user.id));
  await invalidateOtherSessions(c, user.id);
  logLine({ evt: 'auth', a: 'pwchange', u: user.username });
  if (user.email) {
    // Best effort: the change already happened, so a failed notice must not undo it.
    void sendMail(env, { to: user.email, ...passwordChangedEmail(env.baseUrl, env.supportEmail) });
  }
  return back('Password updated. Other browser sessions were signed out.', true);
});

dashboardRoutes.post('/app/account/delete', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const back = (msg: string) => c.redirect(`/app/account?error=${encodeURIComponent(msg)}`);

  const affectedTeams = await db
    .select({ teamId: memberships.teamId, teamSlug: teams.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(eq(memberships.userId, user.id));
  const ownedTeams = await db
    .select({ teamId: memberships.teamId, name: teams.name })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(and(eq(memberships.userId, user.id), eq(memberships.role, 'owner')));
  const blocking: string[] = [];
  for (const owned of ownedTeams) {
    if ((await ownerCount(db, owned.teamId)) <= 1) blocking.push(owned.name);
  }
  if (blocking.length > 0) {
    return back(
      `You are the only owner of: ${blocking.join(', ')}. Delete those teams or hand them to another owner first.`,
    );
  }

  const activeRunRows = await db
    .select({ n: count() })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .where(
      and(
        eq(agentInstallations.userId, user.id),
        inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]),
      ),
    );
  if ((activeRunRows[0]?.n ?? 0) > 0) {
    return back('You still have active agent runs. Finish or stop them before deleting the account.');
  }

  // Soft deletion: the user row is scrubbed, not removed — messages.authorId,
  // debug_sessions.opened_by and teams/projects/invites.created_by reference
  // users without a cascade, and snapshots would be cascade-deleted. Scrubbing
  // keeps every authored row and page join intact.
  await db.transaction(async (tx) => {
    await tx.delete(webSessions).where(eq(webSessions.userId, user.id));
    await tx
      .update(tokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(tokens.userId, user.id), isNull(tokens.revokedAt)));
    await tx.delete(readState).where(eq(readState.userId, user.id));
    await tx.delete(memberships).where(eq(memberships.userId, user.id));
    const myInstallIds = tx
      .select({ id: agentInstallations.id })
      .from(agentInstallations)
      .where(eq(agentInstallations.userId, user.id));
    const myRunIds = tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(inArray(agentRuns.installationId, myInstallIds));
    await tx.delete(workClaims).where(inArray(workClaims.runId, myRunIds));
    await tx.delete(agentEvents).where(inArray(agentEvents.runId, myRunIds));
    await tx.delete(policyReceipts).where(inArray(policyReceipts.runId, myRunIds));
    await tx.delete(agentRuns).where(inArray(agentRuns.installationId, myInstallIds));
    await tx.delete(agentInstallations).where(eq(agentInstallations.userId, user.id));
    await tx
      .update(users)
      .set({
        username: `deleted-${user.id}`,
        passwordHash: null,
        githubId: null,
        displayName: null,
        email: null,
        avatarUrl: null,
      })
      .where(eq(users.id, user.id));
    await accountDeleted(tx as unknown as Db, user.id);
  });
  // Every workspace above just lost a member, and until now that left no trace
  // anywhere: no feed row (nobody in those workspaces did anything), no audit.
  // The subject is deliberately **unnamed** — `users.username` was scrubbed
  // three statements ago at this person's own request, and writing it into an
  // operator record would undo that. `subject_id` still points at the scrubbed
  // row, which answers the operator's actual question (this workspace lost one
  // member, on this day, because the account was deleted) without naming them.
  // Written after the transaction commits: see `lib/memberships`.
  const deletionGroup = randomUUID();
  await recordMembershipChanges(
    db,
    affectedTeams.map((affected) => ({
      teamId: affected.teamId,
      teamSlug: affected.teamSlug,
      action: 'removed' as const,
      subjectId: user.id,
      subjectLabel: null,
      previousRole: affected.role,
      nextRole: null,
      source: 'self' as const,
      route: 'POST /app/account/delete',
      actorId: user.id,
      actorLabel: null,
      groupId: deletionGroup,
      detail: 'account deleted',
    })),
  );
  for (const affected of affectedTeams) {
    await c.get('lifecycle').teamMemberCountChanged?.({ db, teamId: affected.teamId });
  }
  await destroySession(c);
  return c.redirect('/');
});
