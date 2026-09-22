import { ACTIVE_AGENT_RUN_STATUSES } from '@bridge/shared';
import { and, count, countDistinct, desc, eq, gt, inArray, isNull, max, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { Db } from '../db';
import {
  activity,
  agentInstallations,
  agentRuns,
  crmContacts,
  debugSessions,
  errorEvents,
  memberships,
  messages,
  projects,
  snapshots,
  teams,
  tokens,
  users,
} from '../db/schema';
import { describeCohort } from '../auth/accessCodes';
import {
  BETA_LEDGER_MAX,
  betaLedger,
  ceilingSummary,
  ceilingText,
  cohortSummaries,
  nearestTheLine,
} from '../domain/betaCohorts';
import { adminConfigured, isAdminUser } from '../lib/admin';
import { ceilingHistory, setTeamPlan, type CeilingChangeRow } from '../lib/ceilings';
import { DEVICE_WINDOW_DAYS } from '../lib/devices';
import {
  appendMembershipChange,
  hasNoOwner,
  membershipHistory,
  recordMembershipChange,
  type MembershipChangeRow,
} from '../lib/memberships';
import {
  LOAD_BUCKET_MS,
  LOAD_WINDOWS,
  LOAD_WINDOW_KEYS,
  loadWindowKey,
  readLoadHistory,
  sliceErrorRate,
  slicePercentiles,
  type LoadHistory,
} from '../lib/loadHistory';
import {
  activationFunnel,
  ECONOMIC_SOURCE_COVERAGE,
  economicObservation,
  launchCohorts,
  PILOT_OBSERVATION_WEEKS,
  teamUsage,
  usageWindows,
} from '../lib/usage';
import { effectiveLimits, PLANS } from '../lib/entitlements';
import { emailIsFree, isEmail, normalizeEmail } from '../lib/email';
import { fmtDate, initials, timeAgo } from '../lib/format';
import { logLine } from '../lib/log';
import { historyRetentionDays } from '../lib/cleanup';
import {
  GRANTABLE_PLANS,
  MAX_GRANT_NOTE,
  activePlanGrants,
  describeGrant,
  endsAtFromLastDay,
  grantLastDay,
  isGrantActive,
  isGrantablePlan,
  normalizeGrantNote,
  planGrantFor,
  revokePlanGrant,
  setPlanGrant,
  type PlanGrant,
} from '../lib/planGrants';
import { emailChangedNotice, mailHealth, mailTransport, sendMail } from '../lib/mailer';
import { metrics } from '../lib/metrics';
import { criticalAudit, SecurityRefusal } from '../lib/securityHooks';
import { track } from '../lib/track';
import type { AppEnv } from '../types';
import { CeilingDistance, MAX_CHART_ROWS, chartOverflow } from '../ui/CeilingDistance';
import { AppLayout } from '../ui/Layout';

export const adminRoutes = new Hono<AppEnv>();

const DAY = 24 * 60 * 60 * 1000;
const nfmt = (n: number) => n.toLocaleString('en-US');

/**
 * Operator gate: unless ADMIN_USERNAMES or ADMIN_EMAILS is configured and the
 * signed-in user is on one of the lists, every /admin path is a plain 404 — the
 * area's existence is not disclosed.
 */
const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!adminConfigured(c.get('env')) || !user?.isAdmin) return c.notFound();
  await next();
};
adminRoutes.use('/admin', requireAdmin);
adminRoutes.use('/admin/*', requireAdmin);

// ---------------------------------------------------------------- shared UI

const Banner = ({ kind, text }: { kind: 'error' | 'success'; text: string }) => (
  <div class={`banner banner-${kind}`}>
    <span class="ic">{kind === 'error' ? '!' : '✓'}</span>
    <span>{text}</span>
    <button class="x" type="button" data-dismiss="t">
      ×
    </button>
  </div>
);

const AdminTabs = ({
  active,
}: {
  active: 'overview' | 'usage' | 'beta' | 'ops' | 'teams' | 'users' | 'crm';
}) => (
  <div class="tabs">
    <a class={`tab${active === 'overview' ? ' active' : ''}`} href="/admin">
      Overview
    </a>
    <a class={`tab${active === 'usage' ? ' active' : ''}`} href="/admin/usage">
      Usage
    </a>
    <a class={`tab${active === 'beta' ? ' active' : ''}`} href="/admin/beta">
      Beta
    </a>
    <a class={`tab${active === 'ops' ? ' active' : ''}`} href="/admin/ops">
      Ops
    </a>
    <a class={`tab${active === 'teams' ? ' active' : ''}`} href="/admin/teams">
      Workspaces
    </a>
    <a class={`tab${active === 'users' ? ' active' : ''}`} href="/admin/users">
      Users
    </a>
    <a class={`tab${active === 'crm' ? ' active' : ''}`} href="/admin/crm">
      CRM
    </a>
  </div>
);

const Stat = ({
  label,
  value,
  note,
  metric,
}: {
  label: string;
  value: string | number;
  note?: string;
  /** Stable hook for tests/scripts reading a single tile. */
  metric?: string;
}) => (
  <div class="card card-pad" style="display:flex;flex-direction:column;gap:8px">
    <span class="overline">{label}</span>
    <span style="font:600 26px/1 var(--mono)" data-metric={metric}>
      {value}
    </span>
    {note ? <span class="muted small">{note}</span> : null}
  </div>
);

const statGrid = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px';

/**
 * Which regime the rows below were written under.
 *
 * `STMA_HOSTED` and `BETA_UNMETERED` move every workspace's ceiling at once and
 * write nothing at all — they are read from the process, not the database — so
 * a history of per-workspace changes is only readable next to the answer to
 * "were the ceilings even being applied then". This is the honest version of a
 * gap the table cannot close.
 */
const meteringNote = (env: { hosted: boolean; betaUnmetered: boolean }) =>
  !env.hosted
    ? 'This instance is not hosted (STMA_HOSTED unset), so every workspace resolves UNMETERED and its plan column decides nothing.'
    : env.betaUnmetered
      ? 'This instance is hosted with BETA_UNMETERED=1: plans are recorded but the ceilings are lifted for everyone.'
      : 'This instance is hosted and metered: the plan column decides what each workspace may do.';

/**
 * What a grant does here, in the regime this instance runs under. Separate from
 * `meteringNote` because the beta case differs: plans decide nothing while it
 * runs, but a grant already decides how long history is kept.
 */
const grantRegimeNote = (env: { hosted: boolean; betaUnmetered: boolean }) =>
  !env.hosted
    ? 'This instance is not hosted (STMA_HOSTED unset): every workspace is unmetered and keeps history by ACTIVITY_RETENTION_DAYS, so a grant decides nothing here.'
    : env.betaUnmetered
      ? "While BETA_UNMETERED=1 every workspace already has every feature, so the grant takes over the day the beta ends — but it already decides how long this workspace's history is kept."
      : '';

/**
 * A plan given to this workspace, beside the one it has (`lib/planGrants`).
 *
 * Unlimited or through a last day, the operator's choice either way: the owner
 * asked for both, and an operator's page is where the wide door belongs. The
 * card says what happens at the end before anybody picks a date, because the
 * one irreversible consequence of a grant is not the grant — it is the history
 * sweep on the workspace's own plan once it is over.
 */
const PlanGrantCard = ({
  workspace,
  grant,
  env,
  managedBilling,
}: {
  workspace: { id: string; name: string; plan: string };
  grant: PlanGrant | null;
  env: { hosted: boolean; betaUnmetered: boolean; activityRetentionDays: number };
  managedBilling: boolean;
}) => {
  const live = grant ? isGrantActive(grant) : false;
  const today = new Date().toISOString().slice(0, 10);
  const ownDays = env.hosted ? historyRetentionDays(env, workspace.plan) : null;
  const regime = grantRegimeNote(env);
  return (
    <div class="card" id="plan-grant" data-card="plan-grant">
      <div class="card-head">
        <div>
          <div class="card-title">Complimentary plan</div>
          <div class="card-note">
            Give this workspace a plan with no subscription behind it, with no end date or through
            a last day you choose. While it lasts it decides every limit, whatever its own plan{' '}
            <b>{workspace.plan}</b>
            {managedBilling ? ' or a Stripe subscription' : ''} says, and its owner's Plan &amp;
            billing page says it was given and offers nothing to buy. When a dated grant ends the
            workspace is back on {workspace.plan} by itself — the clock decides, so nothing is
            written then and nothing needs undoing.{regime ? ` ${regime}` : ''}
          </div>
        </div>
      </div>
      <div class="card-pad">
        <div data-grant-state={!grant ? 'none' : live ? 'active' : 'ended'} style="margin-bottom:14px">
          {!grant ? (
            <span class="muted">None given.</span>
          ) : (
            <>
              <span class={`pill ${live ? 'pill-active' : 'pill-member'}`}>{live ? 'active' : 'ended'}</span>{' '}
              <b>{grant.plan}</b>{' '}
              {grant.endsAt
                ? live
                  ? `through ${grantLastDay(grant.endsAt)}`
                  : `ended after ${grantLastDay(grant.endsAt)}`
                : 'with no end date'}
              <div class="muted small">
                given by {grant.grantedByLabel ?? 'an operator'} {timeAgo(grant.grantedAt) ?? ''}
                {grant.note ? ` · ${grant.note}` : ''}
              </div>
            </>
          )}
        </div>
        <form
          method="post"
          action={`/admin/teams/${workspace.id}/grant`}
          style="display:grid;gap:12px;max-width:560px"
        >
          <label class="field" style="margin:0">
            <span>Plan</span>
            <select class="in" name="plan" required>
              {GRANTABLE_PLANS.map((p) => (
                <option value={p} selected={(live ? grant!.plan : 'team') === p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <div class="field" style="margin:0">
            <span>How long</span>
            <label class="row" style="gap:8px;align-items:center">
              <input type="radio" name="ends" value="never" checked={!(live && grant?.endsAt)} /> No
              end date, until you revoke it
            </label>
            <label class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
              <input type="radio" name="ends" value="date" checked={Boolean(live && grant?.endsAt)} />{' '}
              Through
              <input
                class="in"
                type="date"
                name="last_day"
                min={today}
                value={live && grant?.endsAt ? grantLastDay(grant.endsAt) : ''}
                style="max-width:190px"
                aria-label="Last day the plan applies"
              />
              <span class="muted small">the last day included, UTC</span>
            </label>
          </div>
          <label class="field" style="margin:0">
            <span>Note, for you only</span>
            <input
              class="in"
              name="note"
              maxlength={MAX_GRANT_NOTE}
              value={grant?.note ?? ''}
              placeholder="Who and why. Shown on this page only, never logged, never shown to them."
            />
          </label>
          {ownDays !== null ? (
            <div class="muted small" data-grant-retention>
              When it ends or is revoked, its history rule is {workspace.plan}'s again: activity
              and agent events older than {ownDays} days are deleted at the next sweep.
            </div>
          ) : null}
          <div class="row" style="gap:8px">
            <button class="btn btn-primary" type="submit">
              {live ? 'Update the grant' : 'Give this plan'}
            </button>
          </div>
        </form>
        {grant ? (
          <form
            method="post"
            action={`/admin/teams/${workspace.id}/grant/revoke`}
            class="m0"
            style="margin-top:12px"
          >
            <button class="btn btn-sm" type="submit">
              {live ? 'Revoke now' : 'Clear the ended grant'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
};

/**
 * What moved, both times said in full.
 *
 * "free → team" is the whole row; the route and the source are what tell an
 * operator whether a person did it or a webhook did, which is the first
 * question after "when".
 */
const CeilingHistoryCard = ({
  rows,
  title,
  note,
  withWorkspace,
}: {
  rows: CeilingChangeRow[];
  title: string;
  note: string;
  withWorkspace: boolean;
}) => (
  <div class="card scroll-x" data-card="ceiling-history">
    <div class="card-head">
      <div>
        <div class="card-title">{title}</div>
        <div class="card-note">{note}</div>
      </div>
    </div>
    {rows.length === 0 ? (
      <div class="card-pad muted small">
        No ceiling change recorded. Plan switches, grants and evaluations appear here from the
        moment they happen; changes made before this record existed are not in it.
      </div>
    ) : (
      <table class="tbl" data-table="ceiling-history">
        <tr>
          <th>When</th>
          {withWorkspace ? <th>Workspace</th> : null}
          <th>What</th>
          <th>Change</th>
          <th>By</th>
          <th class="hide-sm">Route</th>
        </tr>
        {rows.map((r) => (
          <tr>
            <td class="muted" style="white-space:nowrap" title={r.at.toISOString()}>
              {timeAgo(r.at)}
            </td>
            {withWorkspace ? (
              <td>
                <a href={`/admin/teams/${r.teamId}`}>{r.teamName ?? r.teamSlug}</a>
                {r.teamName && r.teamName !== r.teamSlug ? (
                  <div class="mono muted small">{r.teamSlug}</div>
                ) : null}
              </td>
            ) : null}
            <td>
              <span class="pill pill-member">{r.field}</span>
            </td>
            <td class="mono">
              {r.previous ?? '—'} → {r.next ?? '—'}
              {/* Prose, not a value: the change itself is the mono part. */}
              {r.detail ? <div class="muted small" style="font-family:var(--sans)">{r.detail}</div> : null}
            </td>
            <td>
              <span class={`pill ${r.source === 'billing' ? 'pill-active' : 'pill-member'}`}>
                {r.source}
              </span>
              {r.actorLabel ? <div class="muted small">{r.actorLabel}</div> : null}
            </td>
            <td class="mono muted small hide-sm">{r.route}</td>
          </tr>
        ))}
      </table>
    )}
  </div>
);

/**
 * Who gained or lost access, and who did it.
 *
 * The sibling of the card above, drawn separately for the reason the tables are
 * separate: the questions are different and the volumes are different. What it
 * must never imply is completeness — deleting a workspace removes every
 * membership in it *and* this record with it, which is why the note says so on
 * every rendering rather than leaving an operator to work it out from an
 * absence.
 */
const MembershipHistoryCard = ({
  rows,
  title,
  note,
  withWorkspace,
  withSubject = true,
}: {
  rows: MembershipChangeRow[];
  title: string;
  note: string;
  withWorkspace: boolean;
  withSubject?: boolean;
}) => (
  <div class="card scroll-x" data-card="membership-history">
    <div class="card-head">
      <div>
        <div class="card-title">{title}</div>
        <div class="card-note">{note}</div>
      </div>
    </div>
    {rows.length === 0 ? (
      <div class="card-pad muted small">
        No membership change recorded. Joins, role changes and removals appear here from the
        moment they happen; changes made before this record existed are not in it.
      </div>
    ) : (
      <table class="tbl" data-table="membership-history">
        <tr>
          <th>When</th>
          {withWorkspace ? <th>Workspace</th> : null}
          {withSubject ? <th>Who</th> : null}
          <th>What</th>
          <th>By</th>
          <th class="hide-sm">Route</th>
        </tr>
        {rows.map((r) => (
          <tr>
            <td class="muted" style="white-space:nowrap" title={r.at.toISOString()}>
              {timeAgo(r.at)}
            </td>
            {withWorkspace ? (
              <td>
                <a href={`/admin/teams/${r.teamId}`}>{r.teamName ?? r.teamSlug}</a>
                {r.teamName && r.teamName !== r.teamSlug ? (
                  <div class="mono muted small">{r.teamSlug}</div>
                ) : null}
              </td>
            ) : null}
            {withSubject ? (
              <td>
                {/* The label as it read then. Unnamed is a decision, not a gap:
                    an account deleting itself is scrubbed, and the row must not
                    put the name back. */}
                {r.subjectId ? (
                  <a href={`/admin/users/${r.subjectId}`}>{r.subjectLabel ?? 'account deleted'}</a>
                ) : (
                  <span class="muted">{r.subjectLabel ?? 'account deleted'}</span>
                )}
                {r.subjectLabel && r.subjectUsername && r.subjectUsername !== r.subjectLabel ? (
                  <div class="mono muted small">now {r.subjectUsername}</div>
                ) : null}
              </td>
            ) : null}
            <td class="mono">
              {r.action === 'added'
                ? `joined as ${r.nextRole ?? '—'}`
                : r.action === 'removed'
                  ? `removed (was ${r.previousRole ?? '—'})`
                  : `${r.previousRole ?? '—'} → ${r.nextRole ?? '—'}`}
              {r.leftOwnerless ? (
                <div class="small" style="font-family:var(--sans);color:var(--red)">
                  left the workspace with no owner
                </div>
              ) : null}
              {r.detail ? (
                <div class="muted small" style="font-family:var(--sans)">{r.detail}</div>
              ) : null}
            </td>
            <td>
              <span class={`pill ${r.source === 'identity' ? 'pill-active' : 'pill-member'}`}>
                {r.source}
              </span>
              {r.actorLabel ? <div class="muted small">{r.actorLabel}</div> : null}
            </td>
            <td class="mono muted small hide-sm">{r.route}</td>
          </tr>
        ))}
      </table>
    )}
  </div>
);

/**
 * Said on every rendering of the card, because an operator reading a short list
 * must not conclude the short list is all that happened.
 */
const MEMBERSHIP_LIMITS =
  'Deleting a workspace removes every membership in it and this record with it, so a workspace that is gone leaves nothing here. The workspace activity feed is the readers-inside-the-workspace copy and is swept by age.';

// ---------------------------------------------------------------- fleet

/** Bounded reads: the console must not scan an instance to draw a picture. */
const FLEET_ROWS = 60;
const FLEET_PEOPLE = 12;
/** An installation that has checked in this recently is drawn as live. */
const FLEET_LIVE_MS = 10 * 60 * 1000;

interface FleetAgent {
  name: string;
  clientType: string;
  live: boolean;
  revoked: boolean;
}

interface FleetPerson {
  username: string;
  agents: FleetAgent[];
  devices: number;
  lastSeen: Date;
  active: number;
}

const Bar = ({ label, n, top, k }: { label: string; n: number; top: number; k: number }) => (
  <div class="barrow">
    <span class="lbl">{label}</span>
    <span class="track">
      <span
        class={`fill k${k % 4}`}
        style={`width:${top > 0 ? Math.max(2, Math.round((n / top) * 100)) : 0}%`}
      ></span>
    </span>
    <span class="barval">{nfmt(n)}</span>
  </div>
);

const FleetRow = ({ p }: { p: FleetPerson }) => (
  <tr>
    <td>
      <div class="cellrow">
        <span class="avatar light">{initials(p.username)}</span>
        <div style="min-width:0">
          <div class="name">{p.username}</div>
          <div class="mono muted small">
            {p.devices} {p.devices === 1 ? 'device' : 'devices'} · {p.agents.length}{' '}
            {p.agents.length === 1 ? 'agent' : 'agents'}
          </div>
        </div>
      </div>
    </td>
    <td>
      <div class="agentchips">
        {p.agents.map((a) => (
          <span class={`agentchip${a.revoked ? ' off' : ''}`}>
            <span class={`dot${a.live && !a.revoked ? '' : ' gray'}`}></span>
            {a.name} · {a.clientType}
          </span>
        ))}
      </div>
    </td>
    <td class="muted" style="white-space:nowrap">
      {timeAgo(p.lastSeen)}
    </td>
    <td>
      {p.active > 0 ? (
        <span class="pill pill-active">{p.active} running</span>
      ) : (
        <span class="muted small">idle</span>
      )}
    </td>
  </tr>
);

// ---------------------------------------------------------------- overview

adminRoutes.get('/admin', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const n = async (rows: PromiseLike<{ n: number }[]>) => (await rows)[0]?.n ?? 0;
  const weekAgo = new Date(Date.now() - 7 * DAY);

  const totals = {
    users: await n(db.select({ n: count() }).from(users)),
    teams: await n(db.select({ n: count() }).from(teams)),
    projects: await n(db.select({ n: count() }).from(projects)),
    snapshots: await n(db.select({ n: count() }).from(snapshots)),
    openSessions: await n(
      db.select({ n: count() }).from(debugSessions).where(eq(debugSessions.status, 'open')),
    ),
    resolvedSessions: await n(
      db.select({ n: count() }).from(debugSessions).where(eq(debugSessions.status, 'resolved')),
    ),
    messages: await n(db.select({ n: count() }).from(messages)),
    installations: await n(db.select({ n: count() }).from(agentInstallations)),
    activeRuns: await n(
      db
        .select({ n: count() })
        .from(agentRuns)
        .where(inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES])),
    ),
  };
  const weekRows = await db
    .select({
      events: count(),
      activeUsers: countDistinct(activity.userId),
      activeTokens: countDistinct(activity.tokenId),
    })
    .from(activity)
    .where(gt(activity.createdAt, weekAgo));
  const week = weekRows[0] ?? { events: 0, activeUsers: 0, activeTokens: 0 };

  const recent = await db
    .select({ a: activity, teamName: teams.name, username: users.username })
    .from(activity)
    .innerJoin(teams, eq(activity.teamId, teams.id))
    .leftJoin(users, eq(activity.userId, users.id))
    .orderBy(desc(activity.createdAt))
    .limit(20);

  // ---- fleet: which agent clients exist, and who is running them
  const byClient = await db
    .select({ clientType: agentInstallations.clientType, n: count() })
    .from(agentInstallations)
    .where(isNull(agentInstallations.revokedAt))
    .groupBy(agentInstallations.clientType);
  byClient.sort((a, b) => b.n - a.n);

  const installRows = await db
    .select({
      username: users.username,
      name: agentInstallations.name,
      clientType: agentInstallations.clientType,
      device: agentInstallations.deviceFingerprint,
      lastSeenAt: agentInstallations.lastSeenAt,
      revokedAt: agentInstallations.revokedAt,
    })
    .from(agentInstallations)
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .orderBy(desc(agentInstallations.lastSeenAt))
    .limit(FLEET_ROWS);

  const activeByUser = await db
    .select({ username: users.username, n: count() })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .where(inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]))
    .groupBy(users.username);
  const runningBy = new Map(activeByUser.map((r) => [r.username, r.n]));

  const fleetBy = new Map<string, FleetPerson>();
  const devicesBy = new Map<string, Set<string>>();
  for (const row of installRows) {
    const person = fleetBy.get(row.username) ?? {
      username: row.username,
      agents: [],
      devices: 0,
      lastSeen: row.lastSeenAt,
      active: runningBy.get(row.username) ?? 0,
    };
    person.agents.push({
      name: row.name,
      clientType: row.clientType,
      live: Date.now() - row.lastSeenAt.getTime() < FLEET_LIVE_MS,
      revoked: !!row.revokedAt,
    });
    const seen = devicesBy.get(row.username) ?? new Set<string>();
    seen.add(row.device);
    devicesBy.set(row.username, seen);
    person.devices = seen.size;
    fleetBy.set(row.username, person);
  }
  const fleet = [...fleetBy.values()].slice(0, FLEET_PEOPLE);
  const ceilings = await ceilingHistory(db, { limit: 15 });
  const accessChanges = await membershipHistory(db, { limit: 15 });
  const clientTop = byClient[0]?.n ?? 0;
  const runnersTop = activeByUser.reduce((m, r) => Math.max(m, r.n), 0);
  const runners = [...activeByUser].sort((a, b) => b.n - a.n).slice(0, 8);

  return c.html(
    <AppLayout user={user} active="admin" title="Admin">
      <div class="page-head">
        <div>
          <h1 class="title">Admin</h1>
          <p class="sub">Operator console — instance totals, teams, users and the design-partner CRM.</p>
        </div>
      </div>
      <AdminTabs active="overview" />

      <div style={statGrid}>
        <Stat label="Users" value={totals.users} />
        <Stat label="Teams" value={totals.teams} />
        <Stat label="Projects" value={totals.projects} />
        <Stat label="Snapshots" value={totals.snapshots} />
        <Stat label="Open sessions" value={totals.openSessions} />
        <Stat label="Resolved sessions" value={totals.resolvedSessions} />
        <Stat label="Messages" value={totals.messages} />
        <Stat label="Agent installations" value={totals.installations} />
        <Stat label="Active agent runs" value={totals.activeRuns} />
      </div>

      <div>
        <div class="card-title">Last 7 days</div>
        <div class="card-note">Derived from the cross-team activity feed.</div>
      </div>
      <div style={statGrid}>
        <Stat label="Activity events (7d)" value={week.events} />
        <Stat label="Active users (7d)" value={week.activeUsers} />
        <Stat label="Active agent tokens (7d)" value={week.activeTokens} />
      </div>

      <CeilingHistoryCard
        rows={ceilings}
        title="Recent ceiling changes"
        note={`When a workspace's limits last moved, whoever moved them — an operator here, a workspace owner starting an evaluation, or a Stripe reconciliation nobody was watching. Newest ${ceilings.length}; a workspace's whole history is on its own page. ${meteringNote(c.get('env'))}`}
        withWorkspace
      />

      <div style="margin-top:14px">
        <MembershipHistoryCard
          rows={accessChanges}
          title="Recent access changes"
          note={`Who joined, changed role or lost access to a workspace, and who did it — an owner, an operator here, an invite, or an organization's identity administrator. Newest ${accessChanges.length}; a workspace's whole history is on its own page and a person's is on theirs. ${MEMBERSHIP_LIMITS}`}
          withWorkspace
        />
      </div>

      <div>
        <div class="card-title">Fleet</div>
        <div class="card-note">
          Which agent clients are installed across the instance, and who is running them.
        </div>
      </div>
      {installRows.length === 0 ? (
        <div class="card card-pad muted small">No agent installations registered yet.</div>
      ) : (
        <div class="grid2">
          <div class="col">
            <div class="card scroll-x">
              <div class="card-head">
                <div>
                  <div class="card-title">Who has which agent</div>
                  <div class="card-note">
                    The {FLEET_PEOPLE} people with the most recently seen installations, from the
                    last {FLEET_ROWS} registrations.
                  </div>
                </div>
              </div>
              <table class="tbl">
                <tr>
                  <th>Person</th>
                  <th>Agents</th>
                  <th>Last seen</th>
                  <th>Now</th>
                </tr>
                {fleet.map((p) => (
                  <FleetRow p={p} />
                ))}
              </table>
              <div class="pager">
                <span class="pager-note">
                  A grey dot means the installation has not checked in for 10 minutes; a faded chip
                  is revoked.
                </span>
              </div>
            </div>
          </div>
          <div class="col">
            <div class="card">
              <div class="card-head">
                <div>
                  <div class="card-title">Agent clients</div>
                  <div class="card-note">Active installations, whole instance.</div>
                </div>
              </div>
              <div class="barlist">
                {byClient.map((row, i) => (
                  <Bar label={row.clientType} n={row.n} top={clientTop} k={i} />
                ))}
              </div>
            </div>
            <div class="card">
              <div class="card-head">
                <div>
                  <div class="card-title">Running right now</div>
                  <div class="card-note">Active runs per person.</div>
                </div>
              </div>
              {runners.length === 0 ? (
                <div class="card-pad muted small">No active runs.</div>
              ) : (
                <div class="barlist">
                  {runners.map((row, i) => (
                    <Bar label={row.username} n={row.n} top={runnersTop} k={i} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">Recent activity</div>
            <div class="card-note">Last 20 events across all teams.</div>
          </div>
        </div>
        {recent.length === 0 ? (
          <div class="card-pad muted small">No activity recorded yet.</div>
        ) : (
          <table class="tbl">
            <tr>
              <th>When</th>
              <th>Team</th>
              <th>User</th>
              <th>Action</th>
              <th>Detail</th>
            </tr>
            {recent.map((r) => (
              <tr>
                <td class="muted" style="white-space:nowrap">
                  {timeAgo(r.a.createdAt)}
                </td>
                <td class="name">{r.teamName}</td>
                <td>{r.username ?? 'automation'}</td>
                <td>
                  <span class="pill pill-member">{r.a.action}</span>
                </td>
                <td class="muted">{r.a.detail ?? ''}</td>
              </tr>
            ))}
          </table>
        )}
      </div>
    </AppLayout>,
  );
});

// ---------------------------------------------------------------- usage

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
const usd = (cents: number | null) => (cents === null ? 'unknown' : `$${(cents / 100).toFixed(2)}`);

adminRoutes.get('/admin/usage', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const [windows, funnel, cohorts, rows, economics] = await Promise.all([
    usageWindows(db),
    activationFunnel(db),
    launchCohorts(db),
    teamUsage(db),
    economicObservation(db),
  ]);
  const top = funnel[0]?.teams ?? 0;

  return c.html(
    <AppLayout user={user} active="admin" title="Usage">
      <div class="page-head">
        <div>
          <h1 class="title">Usage</h1>
          <p class="sub">
            Is anyone actually using this, and where do teams fall off. Read from the activity
            feed — every meaningful call is already recorded there.
          </p>
        </div>
      </div>
      <AdminTabs active="usage" />

      <div style={statGrid}>
        <Stat label="Monthly active humans" value={nfmt(windows.monthly.humans)} metric="mau" note="30 days" />
        <Stat label="Weekly active humans" value={nfmt(windows.weekly.humans)} note="7 days" />
        <Stat label="Daily active humans" value={nfmt(windows.daily.humans)} note="24 hours" />
        <Stat
          label="Stickiness"
          value={windows.stickiness == null ? '—' : `${Math.round(windows.stickiness * 100)}%`}
          note="weekly ÷ monthly"
        />
        <Stat label="Active agents (30d)" value={nfmt(windows.monthly.agents)} metric="agents-30d" note="distinct tokens" />
        <Stat label="Active teams (30d)" value={nfmt(windows.monthly.teams)} />
        <Stat label="Events (30d)" value={nfmt(windows.monthly.events)} />
        <Stat label="Events (24h)" value={nfmt(windows.daily.events)} />
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Independent feature adoption counts</div>
            <div class="card-note">
              These are independent retained-history totals, not a sequential funnel. Solo use needs no second human. Legacy activity cannot prove activation.
            </div>
          </div>
        </div>
        <div class="barlist">
          {funnel.map((step, i) => (
            <div class="funnelrow">
              <div class="barrow" style="grid-template-columns:170px 1fr 96px">
                <span class="lbl">{step.label}</span>
                <span class="track">
                  <span
                    class={`fill k${i % 4}`}
                    style={`width:${top > 0 ? Math.max(2, pct(step.teams, top)) : 0}%`}
                  ></span>
                </span>
                <span class="barval">
                  {nfmt(step.teams)} · {pct(step.teams, top)}%
                </span>
              </div>
              <div class="funnelnote">{step.note}</div>
            </div>
          ))}
        </div>
      </div>

      <section class="card card-pad"><h3>Launch cohorts · last 30 days</h3><p>Durable, sequential connection-test milestones. A hello is not real work. Completion is an authenticated report, not provider verification. Older unobserved launches remain unknown.</p>{cohorts.map((row) => <p>{row.intent}: {row.opened} opened → {row.first} sender → {row.second} second installation → {row.exchanged} exchanged → {row.realResultReported} real handoff reported complete. Mean time to exchange: {row.meanSecondsToExchange === null ? 'unknown' : `${Math.round(Number(row.meanSecondsToExchange))}s`}.</p>)}</section>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Pilot value and cost signals · last {economics.days} days</div>
            <div class="card-note">
              Counts distinct workflows or runs, not event volume. They are retained signals with
              explicit provenance, not customer acceptance or an ROI claim.
            </div>
          </div>
        </div>
        <div style={statGrid} class="card-pad">
          <Stat
            label="First real results"
            value={nfmt(economics.firstRealResults.reports)}
            note={`${nfmt(economics.firstRealResults.teams)} workspaces · authenticated report`}
            metric="first-real-results"
          />
          <Stat
            label="Repeat handoff workspaces"
            value={nfmt(economics.handoffs.repeatTeams)}
            note={`${nfmt(economics.handoffs.resumed)} resumed · ${nfmt(economics.handoffs.completed)} completed`}
            metric="repeat-handoff-teams"
          />
          <Stat
            label="Repeat review-signal workspaces"
            value={nfmt(economics.reviewSignals.repeatTeams)}
            note={`${nfmt(economics.reviewSignals.runs)} distinct runs · provider PR/CI signal`}
            metric="repeat-review-teams"
          />
          <Stat
            label="Measured run cost"
            value={usd(economics.runCosts.measuredCents)}
            note={`${nfmt(economics.runCosts.measuredRuns)} agent-reported measured runs`}
            metric="measured-run-cost"
          />
          <Stat
            label="Estimated run cost"
            value={usd(economics.runCosts.estimatedCents)}
            note={`${nfmt(economics.runCosts.estimatedRuns)} runs · excluded from measured total`}
            metric="estimated-run-cost"
          />
          <Stat
            label="Run cost not reported"
            value={nfmt(economics.runCosts.unreportedRuns)}
            note="Unknown is not zero"
            metric="unreported-run-cost"
          />
        </div>
        <div class="card-pad" style="padding-top:0">
          <p class="small muted m0">
            Latest retained signals — first result:{' '}
            {timeAgo(economics.firstRealResults.latestAt) ?? 'none retained'}; handoff:{' '}
            {timeAgo(economics.handoffs.latestAt) ?? 'none retained'}; provider review:{' '}
            {timeAgo(economics.reviewSignals.latestAt) ?? 'none retained'}.
          </p>
        </div>
      </div>

      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">Economic source coverage</div>
            <div class="card-note">
              Missing inputs stay unknown. Activity, message volume and quota are never converted
              into support time, expense or billable consumption.
            </div>
          </div>
        </div>
        <table class="tbl">
          <tr>
            <th>Input</th>
            <th>Status</th>
            <th>Source</th>
            <th>Boundary</th>
          </tr>
          {ECONOMIC_SOURCE_COVERAGE.map((row) => (
            <tr>
              <td class="name">{row.label}</td>
              <td>
                <span
                  class={`pill ${
                    row.status === 'retained'
                      ? 'pill-active'
                      : row.status === 'partial'
                        ? 'pill-warn'
                        : 'pill-muted'
                  }`}
                >
                  {row.status}
                </span>
              </td>
              <td>{row.source}</td>
              <td class="muted">{row.boundary}</td>
            </tr>
          ))}
        </table>
        <div class="card-pad small muted">
          Contribution is not estimated on this page. The pilot calculation keeps subscription
          cash, optional managed-job cash and consumed service separate; included usage is never
          added to revenue, and one expense identity can be allocated only once. Fixed company
          costs remain outside customer contribution.
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Four-week pilot observation plan</div>
            <div class="card-note">
              Four weeks is the observation window, not an implementation estimate. Do not collect
              source, prompt or secret content.
            </div>
          </div>
        </div>
        <div class="card-pad" style="padding-top:0">
          {PILOT_OBSERVATION_WEEKS.map((week) => (
            <div class="introw">
              <div class="mono">W{week.week}</div>
              <div>
                <div class="name">{week.focus}</div>
                <div class="muted small">{week.observe}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">Teams by activity</div>
            <div class="card-note">
              Last 30 days, busiest first. "Calls today" is the same counter the daily quota
              enforces, so a capped team and this page never disagree.
            </div>
          </div>
        </div>
        {rows.length === 0 ? (
          <div class="card-pad muted small">No activity in the last 30 days.</div>
        ) : (
          <table class="tbl">
            <tr>
              <th>Team</th>
              <th>Plan</th>
              <th>Members</th>
              <th>Humans 30d</th>
              <th>Agents 30d</th>
              <th>Events 30d</th>
              <th>Calls today</th>
              <th>Last active</th>
            </tr>
            {rows.map((row) => (
              <tr>
                <td>
                  <div class="name">{row.name}</div>
                  <div class="mono muted small">{row.slug}</div>
                </td>
                <td>
                  <span class={`pill ${row.plan === 'free' ? 'pill-member' : 'pill-active'}`}>
                    {row.plan}
                  </span>
                </td>
                <td class="mono">{nfmt(row.members)}</td>
                <td class="mono">{nfmt(row.humans30d)}</td>
                <td class="mono">{nfmt(row.agents30d)}</td>
                <td class="mono">{nfmt(row.events30d)}</td>
                <td class="mono">{nfmt(row.callsToday)}</td>
                <td class="muted" style="white-space:nowrap">
                  {timeAgo(row.lastActiveAt)}
                </td>
              </tr>
            ))}
          </table>
        )}
      </div>
    </AppLayout>,
  );
});

// ---------------------------------------------------------------- beta reach

/**
 * Who did we give how much beta to, and what does the flip cost them.
 *
 * `BETA_UNMETERED=1` lifts every ceiling from the process environment and
 * writes no plan onto any workspace, which is what makes it safe to switch off
 * — `teams.plan` is `NOT NULL DEFAULT 'free'`, so unsetting it drops everybody
 * onto the free row with nothing to unwind. There is deliberately no migration
 * path and no grandfathering here. What there is, is the distance: this page
 * exists so the day somebody unsets it is a decision rather than a surprise.
 *
 * Two things it says out loud rather than leaving to be discovered, because
 * each one is a place where the obvious reading is wrong:
 *
 * - **The beta does not lift retention, by decision (2026-09-21).**
 *   `historyRetentionDays` in `lib/cleanup.ts` reads the plan and ignores the
 *   flag, so a beta workspace on `free` is swept at 90 days today. It is not in
 *   the table because unsetting the flag does not change it — which is the
 *   point: lifting it would have made the flip the day history is deleted.
 * - **An evidence-pack read is not recorded**, so that switch answers
 *   `unrecorded` rather than pretending silence means unused.
 *
 * Devices per member is counted the way `push_snapshot` counts it: distinct
 * device labels per person over the last `DEVICE_WINDOW_DAYS`, so the busiest
 * member's number is the one the gate would refuse on.
 */
const BetaKey = () => (
  <div class="cd-key">
    <span>
      <b>M</b> members
    </span>
    <span>
      <b>P</b> projects
    </span>
    <span>
      <b>C</b> tool calls today
    </span>
    <span>
      <b>H</b> handoffs per 30 days
    </span>
    <span>
      <b>I</b> connected integrations
    </span>
    <span>
      <b>D</b> devices per member, last {DEVICE_WINDOW_DAYS} days
    </span>
    <span>
      <b>F</b> claiming ground
    </span>
    <span>
      <b>G</b> governance
    </span>
    <span>
      <b>E</b> evidence packs
    </span>
    <span>
      <b>S</b> savings ledger
    </span>
  </div>
);

adminRoutes.get('/admin/beta', async (c) => {
  const user = c.get('user')!;
  const env = c.get('env');
  const ledger = await betaLedger(c.get('db'));
  const cohorts = cohortSummaries(ledger);
  const fromCode = ledger.workspaces.filter((w) => w.cohort !== null);
  const over = ledger.workspaces.filter((w) => w.over.length > 0);
  const losing = ledger.workspaces.filter((w) => w.losing.length > 0);
  const given = ledger.workspaces.filter((w) => w.grant !== null);
  const namedCohorts = cohorts.filter((row) => row.cohort !== null);
  const overflow = chartOverflow(ledger.workspaces.length);

  return c.html(
    <AppLayout user={user} active="admin" title="Admin — Beta reach">
      <div class="page-head">
        <div>
          <h1 class="title">Beta reach</h1>
          <p class="sub">
            Which access-code cohort every workspace arrived through, what it has done since, and
            how far it already is from the ceilings of the plan it lands on when{' '}
            <code>BETA_UNMETERED</code> is unset — free, unless you gave it a plan from its
            workspace page. {meteringNote(env)}
          </p>
        </div>
      </div>
      <AdminTabs active="beta" />

      <div style={statGrid}>
        <Stat
          label="Through a code"
          value={nfmt(fromCode.length)}
          note={`of ${nfmt(ledger.workspaces.length)} workspace${ledger.workspaces.length === 1 ? '' : 's'}`}
          metric="beta-from-code"
        />
        <Stat
          label="Cohorts"
          value={nfmt(namedCohorts.length)}
          note={
            env.signupAccessCodes.length > 0
              ? `${env.signupAccessCodes.length} code${env.signupAccessCodes.length === 1 ? '' : 's'} configured now`
              : 'SIGNUP_ACCESS_CODES is unset: the door is open'
          }
          metric="beta-cohorts"
        />
        <Stat
          label="Already over a ceiling"
          value={nfmt(over.length)}
          note="would be refused on day one"
          metric="beta-over"
        />
        <Stat
          label="Would lose a feature"
          value={nfmt(losing.length)}
          note="using something its landing plan does not carry"
          metric="beta-losing"
        />
        <Stat
          label="Given a plan"
          value={nfmt(given.length)}
          note="land on what you gave them, not on free"
          metric="beta-given"
        />
      </div>

      <div class="card" style="margin-top:14px" data-card="beta-distance">
        <div class="card-head">
          <div>
            <div class="card-title">Distance to the ceiling each one lands on</div>
            <div class="card-note">
              One rule is the ceiling of the plan each workspace lands on — free, or the plan you
              gave it. Every mark is a workspace's use of one ceiling, placed by
              how much of that ceiling it has spent — left of the rule is room, on it is one person
              or one project away, right of it is already past. Closest to the rule first, at most{' '}
              {MAX_CHART_ROWS} drawn. Anything at twice a ceiling or more pins to the right edge as
              an arrow rather than stretching an axis nobody could read.
            </div>
          </div>
        </div>
        {ledger.workspaces.length === 0 ? (
          <div class="card-pad muted small">
            No workspaces yet. They appear here as soon as somebody creates one.
          </div>
        ) : (
          <>
            <div class="cd-scroll">
              <CeilingDistance
                workspaces={nearestTheLine(ledger.workspaces, MAX_CHART_ROWS)}
                href={(w) => `/admin/teams/${w.teamId}`}
                cohortLabel={describeCohort}
              />
            </div>
            <BetaKey />
            {overflow ? <div class="cd-over">{overflow}</div> : null}
          </>
        )}
      </div>

      <div class="card scroll-x" style="margin-top:14px" data-card="beta-cohorts">
        <div class="card-head">
          <div>
            <div class="card-title">Cohorts</div>
            <div class="card-note">
              Folded from the same rows as the table below, so a count here and the workspaces under
              it cannot disagree. The cohort is the label on the access code the workspace's creator
              signed up with — never the code, which is never stored anywhere. Waves in the order
              they were sent; accounts that arrived through no code at all are last.
            </div>
          </div>
        </div>
        {cohorts.length === 0 ? (
          <div class="card-pad muted small">Nothing to group yet.</div>
        ) : (
          <table class="tbl" data-table="beta-cohorts">
            <tr>
              <th>Cohort</th>
              <th>Workspaces</th>
              <th>People</th>
              <th>Events · {ledger.windowDays}d</th>
              <th>Over a ceiling</th>
              <th>Losing a feature</th>
              <th class="hide-sm">First arrival</th>
            </tr>
            {cohorts.map((row) => (
              <tr>
                <td>
                  <span class={`pill ${row.cohort === null ? 'pill-member' : 'pill-active'}`}>
                    {describeCohort(row.cohort)}
                  </span>
                </td>
                <td class="mono">{nfmt(row.workspaces)}</td>
                <td class="mono">{nfmt(row.people)}</td>
                <td class="mono">{nfmt(row.events)}</td>
                <td class="mono">{nfmt(row.over)}</td>
                <td class="mono">{nfmt(row.losing)}</td>
                <td class="muted hide-sm" style="white-space:nowrap">
                  {row.firstAt ? fmtDate(row.firstAt) : '—'}
                </td>
              </tr>
            ))}
          </table>
        )}
      </div>

      <div class="card scroll-x" style="margin-top:14px" data-card="beta-workspaces">
        <div class="card-head">
          <div>
            <div class="card-title">Every workspace</div>
            <div class="card-note">
              Newest first, at most {BETA_LEDGER_MAX}
              {ledger.truncated ? ' — this instance has more, and the rest are not shown' : ''}.
              Tool calls and handoffs are read from the counters the limiter itself writes, so this
              and a capped workspace are looking at one number. Devices are counted the way{' '}
              <code>push_snapshot</code> counts them: the busiest member's distinct device labels
              over the last {DEVICE_WINDOW_DAYS} days. Retention is deliberately absent: the beta
              does not lift it, so the sweep already keeps each workspace's own rule — free's 90
              days, or what the plan you gave it keeps — and unsetting the flag deletes nothing. And nothing records an evidence-pack
              read, so that switch cannot be answered from stored rows for any workspace: it is
              the <code>?</code> above and never a verdict.
            </div>
          </div>
        </div>
        {ledger.workspaces.length === 0 ? (
          <div class="card-pad muted small">No workspaces yet.</div>
        ) : (
          <table class="tbl" data-table="beta-workspaces">
            <tr>
              <th>Workspace</th>
              <th>Cohort</th>
              <th class="hide-sm">Arrived</th>
              <th class="hide-sm">Last active</th>
              <th>Events</th>
              <th>Against the plan it lands on</th>
              <th>Would stop working</th>
            </tr>
            {ledger.workspaces.map((w) => (
              <tr>
                <td>
                  <div class="name">
                    <a href={`/admin/teams/${w.teamId}`}>{w.name}</a>
                  </div>
                  <div class="mono muted small">{w.slug}</div>
                </td>
                <td>
                  <span class={`pill ${w.cohort === null ? 'pill-member' : 'pill-active'}`}>
                    {describeCohort(w.cohort)}
                  </span>
                  {w.createdBy ? <div class="muted small">by {w.createdBy}</div> : null}
                </td>
                <td class="muted hide-sm" style="white-space:nowrap">
                  {fmtDate(w.createdAt)}
                  {/* The workspace was made here; the code was redeemed when its
                      creator signed up, which can be an earlier day entirely. */}
                  {w.cohortAt && w.cohort !== null ? (
                    <div class="small">code {fmtDate(w.cohortAt)}</div>
                  ) : null}
                </td>
                <td class="muted hide-sm" style="white-space:nowrap">
                  {timeAgo(w.lastActiveAt) ?? '—'}
                </td>
                <td class="mono">{nfmt(w.events)}</td>
                <td>
                  {/* The ones that are already past, named, then every one with
                      its numbers — "what it has used since" is the question
                      this column answers, and a reader should not have to hover
                      the chart above to get it. */}
                  <div class="small" data-lands-on={w.landsOn}>
                    lands on <b>{w.landsOn}</b>
                    {w.grant ? (
                      <span class="muted">
                        {' '}
                        · given
                        {w.grant.endsAt ? `, through ${grantLastDay(w.grant.endsAt)}` : ', no end date'}
                      </span>
                    ) : null}
                  </div>
                  {w.over.length === 0 ? (
                    <div class="muted small">within every ceiling</div>
                  ) : (
                    w.over.map((use) => (
                      <div class="mono small" style="color:var(--red-ink)">
                        {use.label.toLowerCase()} {ceilingText(use)}
                      </div>
                    ))
                  )}
                  <div class="mono muted small">{ceilingSummary(w.ceilings)}</div>
                </td>
                <td>
                  {/* Only what this workspace is actually using. Evidence packs
                      are `unrecorded` for every row — nothing writes when one is
                      read — so the pill would be the same noise on every line
                      and the card note says it once instead. */}
                  {w.losing.length === 0 ? (
                    <span class="muted small">nothing recorded in use</span>
                  ) : (
                    w.losing.map((f) => (
                      <div style="margin-bottom:2px">
                        <span class="pill pill-open" title={f.evidence}>
                          {f.label}
                        </span>
                      </div>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </table>
        )}
      </div>
    </AppLayout>,
  );
});

// ---------------------------------------------------------------- ops

const fmtBytes = (b: number | null | undefined) =>
  b == null ? '—' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
/** Percentiles come from a fixed histogram, so they are bucket upper bounds. */
const fmtLatency = (v: number | null) => (v == null ? '—' : `≤${nfmt(v)} ms`);
const fmtUptime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
};
const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bounded row counts for the storage card. */
async function tableCounts(db: Db): Promise<Array<{ table: string; rows: number }>> {
  const n = async (rows: PromiseLike<{ n: number }[]>) => (await rows)[0]?.n ?? 0;
  const of = [
    ['users', users],
    ['teams', teams],
    ['projects', projects],
    ['snapshots', snapshots],
    ['messages', messages],
    ['debug_sessions', debugSessions],
    ['activity', activity],
    ['agent_runs', agentRuns],
    ['error_events', errorEvents],
  ] as const;
  const out: Array<{ table: string; rows: number }> = [];
  for (const [table, tbl] of of) out.push({ table, rows: await n(db.select({ n: count() }).from(tbl)) });
  return out;
}

/**
 * Physical database size. Postgres only — the embedded PGlite path has no
 * pg_database_size, so a failure just omits the number.
 */
async function databaseSize(db: Db, hasPostgres: boolean): Promise<number | null> {
  if (!hasPostgres) return null;
  try {
    const res: unknown = await db.execute(sql`select pg_database_size(current_database()) as size`);
    const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
      size?: unknown;
    }>;
    const raw = rows[0]?.size;
    const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A slice label narrow enough to read and wide enough to be unambiguous.
 *
 * The hour alone is only unambiguous inside a single day: over a week, "06:00"
 * appears seven times, which is exactly the confusion the history exists to
 * remove. So a day-wide slice is the date, a slice inside one day is the hour,
 * and anything in between says both.
 */
const sliceLabel = (at: Date, sliceMs: number, windowMs: number) =>
  sliceMs >= 24 * 3_600_000
    ? at.toISOString().slice(5, 10)
    : windowMs > 24 * 3_600_000
      ? `${at.toISOString().slice(5, 10)} ${hhmm(at)}`
      : hhmm(at);

/**
 * When a history bar goes red.
 *
 * The live chart paints a minute red for a single 5xx, and that is right: one
 * minute with an error is an event. A slice here is an hour or a day, and the
 * same rule painted two thirds of the chart red for one failed request in
 * fifteen hundred — a chart where most bars are red carries no information and
 * the eye stops reading it. So a slice goes red when 5xx crossed this share of
 * its requests; the exact count is in the tooltip and in the table either way,
 * so nothing is hidden, only ranked.
 */
const BAD_SLICE_PCT = 1;

/**
 * The record, beside the live numbers and never mixed into them.
 *
 * Everything above this card on the page is one process since it booted, and
 * everything in it is what was written down. Keeping the boundary visible is
 * the point: an operator reading "p95 ≤200 ms" has to know whether that is the
 * last four minutes of a container that restarted or the last four weeks.
 */
const LoadHistoryCard = ({ history, days }: { history: LoadHistory; days: number }) => {
  const spec = LOAD_WINDOWS[history.window];
  const peak = Math.max(1, ...history.slices.map((s) => s.requests));
  const totals = slicePercentiles(history.totals);
  const covered = history.totals.buckets;
  return (
    <div class="card" data-card="load-history">
      <div class="card-head">
        <div>
          <div class="card-title">Load history — the record</div>
          <div class="card-note">
            Five-minute rollups written to the database, so a restart does not erase them.{' '}
            {covered === 0
              ? `Nothing recorded yet: the first bucket is written about ${LOAD_BUCKET_MS / 60_000} minutes after boot.`
              : `${nfmt(covered)} buckets in this window, ${nfmt(history.totals.requests)} requests, p95 ${fmtLatency(totals.p95)}, p99 ${fmtLatency(totals.p99)}.`}{' '}
            {history.gaps > 0
              ? `${nfmt(history.gaps)} buckets have no row at all — the process was not running for about ${nfmt(Math.round((history.gaps * LOAD_BUCKET_MS) / 60_000))} minutes of it.`
              : covered === 0
                ? ''
                : 'No gaps: a row for every bucket since the oldest one kept.'}{' '}
            {history.truncated
              ? 'The window was truncated at the read limit, so the oldest part is missing.'
              : ''}{' '}
            A bar is red where 5xx crossed {BAD_SLICE_PCT}% of the slice's requests — the table has
            the exact count for every slice. Kept for{' '}
            {days === 0 ? 'as long as the row cap allows' : `${days} days`}.
          </div>
        </div>
        <div class="row" style="gap:6px">
          {LOAD_WINDOW_KEYS.map((key) => (
            <a
              class={`btn btn-sm${key === history.window ? ' btn-primary' : ''}`}
              href={`/admin/ops?history=${key}`}
            >
              {LOAD_WINDOWS[key].label}
            </a>
          ))}
        </div>
      </div>
      <div
        class="spark"
        data-spark="history"
        role="img"
        aria-label={`Requests per ${spec.slice} over the last ${spec.label}. ${nfmt(history.totals.requests)} requests recorded, ${nfmt(history.totals.serverErrors)} server errors, ${nfmt(history.gaps)} five-minute buckets missing.`}
      >
        {history.slices.map((s) => (
          <span
            class={`spark-bar${sliceErrorRate(s) >= BAD_SLICE_PCT ? ' bad' : s.requests > 0 ? ' on' : ''}`}
            style={`height:${s.requests === 0 ? 2 : Math.max(6, Math.round((s.requests / peak) * 100))}%`}
            title={`${s.at.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${nfmt(s.requests)} req · ${nfmt(s.serverErrors)} 5xx · ${nfmt(s.clientErrors)} 4xx`}
          />
        ))}
      </div>
      <div class="scroll-x">
        <table class="tbl" data-table="load-history">
          <tr>
            <th>{spec.sliceMs >= 24 * 3_600_000 ? 'Day (UTC)' : 'From (UTC)'}</th>
            <th>Requests</th>
            <th>Peak/min</th>
            <th>4xx</th>
            <th>5xx</th>
            <th>Error rate</th>
            <th>p95</th>
            <th>p99</th>
            <th class="hide-sm">Rate limited</th>
            <th class="hide-sm">Peak rss</th>
            <th class="hide-sm">Peak lag</th>
            <th class="hide-sm">Coverage</th>
          </tr>
          {[...history.slices]
            .reverse()
            .filter((s) => s.buckets > 0)
            .map((s) => {
              const p = slicePercentiles(s);
              const rate = sliceErrorRate(s);
              return (
                <tr>
                  <td class="mono" style="white-space:nowrap">
                    {sliceLabel(s.at, spec.sliceMs, spec.ms)}
                  </td>
                  <td>{nfmt(s.requests)}</td>
                  <td class="muted">{nfmt(Math.round(s.peakPerMinute))}</td>
                  <td class="muted">{nfmt(s.clientErrors)}</td>
                  <td class={s.serverErrors > 0 ? 'mono' : 'muted'}>{nfmt(s.serverErrors)}</td>
                  <td class="muted">{rate.toFixed(rate >= 10 ? 0 : 1)}%</td>
                  <td class="muted">{fmtLatency(p.p95)}</td>
                  <td class="muted">{fmtLatency(p.p99)}</td>
                  <td class="muted hide-sm">{nfmt(s.rateLimited)}</td>
                  <td class="muted hide-sm">{s.rssMb === 0 ? '—' : `${nfmt(s.rssMb)} MB`}</td>
                  <td class="muted hide-sm">{nfmt(s.loopLagMaxMs)} ms</td>
                  {/* Buckets held against buckets that should exist by now. The
                      slice we are inside expects only what has elapsed, so a
                      still-filling hour does not read as downtime. */}
                  <td class={`hide-sm ${s.buckets < s.expected ? 'mono' : 'muted'}`}>
                    {s.buckets}/{s.expected}
                    {s.instances > 1 ? ` · ${s.instances} processes` : ''}
                  </td>
                </tr>
              );
            })}
        </table>
      </div>
      {covered === 0 ? null : (
        <div class="card-pad small muted" style="border-top:1px solid var(--line-2);padding:10px 18px">
          Percentiles are recomputed from the stored latency histograms, never averaged — a p95 of
          two windows is not the mean of their p95s. Slices with no recorded bucket are left out of
          the table and drawn flat in the chart.
        </div>
      )}
    </div>
  );
};

const PathTable = ({
  title,
  note,
  rows,
  metric,
}: {
  title: string;
  note: string;
  rows: Array<{ path: string; n: number; meanMs: number; maxMs: number }>;
  metric: 'busiest' | 'slowest';
}) => (
  <div class="card scroll-x">
    <div class="card-head">
      <div>
        <div class="card-title">{title}</div>
        <div class="card-note">{note}</div>
      </div>
    </div>
    {rows.length === 0 ? (
      <div class="card-pad muted small">No requests recorded yet.</div>
    ) : (
      <table class="tbl" data-table={metric}>
        <tr>
          <th>Path</th>
          <th>Requests</th>
          <th>Mean</th>
          <th>Max</th>
        </tr>
        {rows.map((r) => (
          <tr>
            <td class="mono">{r.path}</td>
            <td>{nfmt(r.n)}</td>
            <td class="muted">{nfmt(r.meanMs)} ms</td>
            <td class="muted">{nfmt(r.maxMs)} ms</td>
          </tr>
        ))}
      </table>
    )}
  </div>
);

adminRoutes.get('/admin/ops', async (c) => {
  const user = c.get('user')!;
  const env = c.get('env');
  const db = c.get('db');
  const m = metrics.read();
  const dayAgo = new Date(Date.now() - DAY);
  const mailTransportName = mailTransport(env);
  const mailCounts = mailHealth.counts();
  const mailFails = mailHealth.failures();

  const recent = await db
    .select()
    .from(errorEvents)
    .orderBy(desc(errorEvents.at))
    .limit(50);
  const repeats = await db
    .select({ message: errorEvents.message, n: count(), last: max(errorEvents.at) })
    .from(errorEvents)
    .where(gt(errorEvents.at, dayAgo))
    .groupBy(errorEvents.message)
    .orderBy(desc(count()))
    .limit(10);
  // error_events.userId is a plain text column (no FK); only resolve well-formed ids.
  const userIds = [
    ...new Set(recent.map((r) => r.userId).filter((v): v is string => !!v && UUID_RE.test(v))),
  ];
  const usernames = new Map<string, string>(
    userIds.length === 0
      ? []
      : (
          await db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(inArray(users.id, userIds))
        ).map((r) => [r.id, r.username] as const),
  );
  const activeRunRows = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]));
  const activeRuns = activeRunRows[0]?.n ?? 0;
  const storage = await tableCounts(db);
  const dbSize = await databaseSize(db, Boolean(env.databaseUrl));
  const history = await readLoadHistory(db, loadWindowKey(c.req.query('history')));

  const total = Math.max(1, m.totals.requests);
  const classes = [
    { label: '2xx', value: m.totals.byClass.c2xx, tone: 'var(--green)' },
    { label: '3xx', value: m.totals.byClass.c3xx, tone: 'var(--mut-2)' },
    { label: '4xx', value: m.totals.byClass.c4xx, tone: '#c98a00' },
    { label: '5xx', value: m.totals.byClass.c5xx, tone: 'var(--red)' },
  ];
  const peak = Math.max(1, m.lastHour.peak);

  return c.html(
    <AppLayout user={user} active="admin" title="Admin — Ops">
      <div data-autorefresh="30" style="display:none"></div>
      <div class="page-head">
        <div>
          <h1 class="title">Ops</h1>
          <p class="sub">
            Two different things on one page, and the difference matters. The tiles, the sparkline,
            the status mix, the endpoint tables and <strong>Mail</strong> are{' '}
            <strong>this process since it booted</strong> — in memory, gone on restart. The error
            log and <strong>Load history</strong> are the <strong>record</strong>, and they survive
            one.
          </p>
        </div>
      </div>
      <AdminTabs active="ops" />

      <div style={statGrid}>
        <Stat
          label="Requests (1h)"
          value={nfmt(m.lastHour.requests)}
          metric="requests-hour"
          note={`${nfmt(m.totals.requests)} since boot`}
        />
        <Stat
          label="Error rate (1h)"
          value={`${m.lastHour.errorRate.toFixed(m.lastHour.errorRate >= 10 ? 0 : 1)}%`}
          metric="error-rate-hour"
          note={`${nfmt(m.lastHour.serverErrors)} × 5xx · ${nfmt(m.lastHour.clientErrors)} × 4xx`}
        />
        <Stat
          label="p95 latency"
          value={fmtLatency(m.totals.p95)}
          metric="p95"
          note={`p50 ${fmtLatency(m.totals.p50)} · p99 ${fmtLatency(m.totals.p99)}`}
        />
        <Stat
          label="Uptime"
          value={fmtUptime(m.uptimeMs)}
          metric="uptime"
          note={`since ${m.startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`}
        />
        <Stat
          label="Memory (rss)"
          value={fmtBytes(m.memory.rss)}
          metric="rss"
          note={`heap ${fmtBytes(m.memory.heapUsed)} · loop lag ${nfmt(m.eventLoopLagMs)} ms`}
        />
        <Stat label="Active agent runs" value={nfmt(activeRuns)} metric="active-runs" />
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Traffic — last 60 minutes (this process)</div>
            <div class="card-note">
              One bar per minute, from memory. Red marks a minute that contained a 5xx. Peak{' '}
              {nfmt(m.lastHour.peak)} req/min. For anything older, read the record below.
            </div>
          </div>
        </div>
        {/* Two charts share this page now, so each says which it is: a test or a
            script counting bars has to be able to name the one it means. */}
        <div
          class="spark"
          data-spark="live"
          role="img"
          aria-label={`Requests per minute over the last 60 minutes. ${nfmt(
            m.lastHour.requests,
          )} requests total, peak ${nfmt(m.lastHour.peak)} in a minute, ${nfmt(
            m.lastHour.serverErrors,
          )} server errors.`}
        >
          {m.lastHour.minutes.map((b) => (
            <span
              class={`spark-bar${b.serverErrors > 0 ? ' bad' : b.requests > 0 ? ' on' : ''}`}
              style={`height:${b.requests === 0 ? 2 : Math.max(6, Math.round((b.requests / peak) * 100))}%`}
              title={`${hhmm(b.at)} UTC · ${b.requests} req · ${b.serverErrors} 5xx · ${b.clientErrors} 4xx`}
            />
          ))}
        </div>
        <div class="card-pad small muted" style="border-top:1px solid var(--line-2);padding:10px 18px">
          {hhmm(m.lastHour.minutes[0]?.at ?? new Date())} →{' '}
          {hhmm(m.lastHour.minutes[m.lastHour.minutes.length - 1]?.at ?? new Date())} UTC · rate
          limited {nfmt(m.rateLimited)} · loop guard trips {nfmt(m.loopGuardTrips)} · tracked paths{' '}
          {nfmt(m.trackedPaths)}
        </div>
      </div>

      <LoadHistoryCard history={history} days={env.loadRetentionDays} />

      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">Status codes (this process)</div>
            <div class="card-note">
              Since boot, {nfmt(m.totals.requests)} requests (static assets and /health excluded).
            </div>
          </div>
        </div>
        <table class="tbl">
          <tr>
            <th>Class</th>
            <th>Requests</th>
            <th>Share</th>
            <th style="width:40%">&nbsp;</th>
          </tr>
          {classes.map((row) => (
            <tr>
              <td class="mono">{row.label}</td>
              <td>{nfmt(row.value)}</td>
              <td class="muted">{((row.value / total) * 100).toFixed(1)}%</td>
              <td>
                <span class="meter">
                  <span
                    class="meter-fill"
                    style={`width:${Math.round((row.value / total) * 100)}%;background:${row.tone}`}
                  />
                </span>
              </td>
            </tr>
          ))}
        </table>
      </div>

      {/*
       * Mail is the one subsystem that fails completely silently. `sendMail`
       * returns a result instead of throwing, so nothing reaches the error
       * handler and nothing reaches the error log below — a provider refusing
       * every message looked exactly like a quiet evening. Sign-in codes and
       * password resets are the traffic, so "quiet evening" and "nobody can get
       * in and nobody can tell us" render identically without this card.
       *
       * Per process, like the traffic numbers above it: no database write on the
       * failure path, and production runs one replica.
       */}
      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">Mail (this process)</div>
            <div class="card-note">
              {mailCounts.failed > 0
                ? 'Sends are failing. A sign-in code or password reset that does not arrive is a person who cannot get in and has nobody to tell.'
                : 'Sign-in codes, password resets and notifications. Counted since this process started.'}
            </div>
          </div>
          <span class={`pill ${mailCounts.failed > 0 ? 'pill-warn' : 'pill-active'}`}>
            {mailTransportName === 'memory' ? 'not sending' : 'resend'}
          </span>
        </div>
        <table class="tbl">
          <tr>
            <th>Transport</th>
            <th>From</th>
            <th>Sent</th>
            <th>Failed</th>
          </tr>
          <tr>
            <td class="mono">{mailTransportName}</td>
            <td class="mono">{env.mailFrom}</td>
            <td>{nfmt(mailCounts.sent)}</td>
            <td class={mailCounts.failed > 0 ? 'mono' : 'muted'}>{nfmt(mailCounts.failed)}</td>
          </tr>
        </table>
        {mailTransportName === 'memory' ? (
          <div class="card-pad muted small">
            No <code>RESEND_API_KEY</code>, so nothing leaves this process — codes are recorded in
            memory and logged. Email sign-in codes and self-service password reset are off.
          </div>
        ) : null}
        {mailFails.length > 0 ? (
          <table class="tbl" data-table="mail-failures">
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>To</th>
              <th>What the provider said</th>
            </tr>
            {/* The provider's own words: an unverified sending domain says so here. */}
            {mailFails.map((f) => (
              <tr>
                <td class="muted" style="white-space:nowrap" title={f.at.toISOString()}>
                  {timeAgo(f.at)}
                </td>
                <td>
                  <span class="pill pill-member">{f.kind}</span>
                </td>
                <td class="mono muted">{f.to}</td>
                <td class="mono small" style="max-width:420px;white-space:pre-wrap">
                  {f.reason}
                </td>
              </tr>
            ))}
          </table>
        ) : null}
      </div>

      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">Recent errors</div>
            <div class="card-note">
              Last {recent.length} of the persisted error log — secrets are redacted before storage.
            </div>
          </div>
        </div>
        {recent.length === 0 ? (
          <div class="card-pad muted small">No errors recorded. </div>
        ) : (
          <table class="tbl" data-table="recent-errors">
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Request</th>
              <th>Message</th>
              <th>User</th>
              <th>Team</th>
            </tr>
            {recent.map((e) => (
              <tr>
                <td class="muted" style="white-space:nowrap" title={e.at.toISOString()}>
                  {timeAgo(e.at)}
                </td>
                <td>
                  <span class="pill pill-member">{e.kind}</span>
                </td>
                <td class="mono">{e.status ?? '—'}</td>
                <td class="mono">
                  {e.method ?? ''} {e.path ?? '—'}
                </td>
                <td style="max-width:420px">
                  <details>
                    <summary style="cursor:pointer">
                      {e.message.length > 80 ? `${e.message.slice(0, 80)}…` : e.message}
                    </summary>
                    <div class="mono small" style="white-space:pre-wrap;margin-top:8px">
                      {e.stack ?? e.message}
                    </div>
                  </details>
                </td>
                <td class="muted">{(e.userId && usernames.get(e.userId)) ?? '—'}</td>
                <td class="muted">{e.teamSlug ?? '—'}</td>
              </tr>
            ))}
          </table>
        )}
      </div>

      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">Top error messages (24h)</div>
            <div class="card-note">Grouped by message — the fastest way to spot a repeat.</div>
          </div>
        </div>
        {repeats.length === 0 ? (
          <div class="card-pad muted small">Nothing in the last 24 hours.</div>
        ) : (
          <table class="tbl" data-table="top-errors">
            <tr>
              <th>Count</th>
              <th>Message</th>
              <th>Last seen</th>
            </tr>
            {repeats.map((r) => (
              <tr>
                <td class="mono">{nfmt(r.n)}</td>
                <td title={r.message}>
                  {r.message.length > 110 ? `${r.message.slice(0, 110)}…` : r.message}
                </td>
                <td class="muted" style="white-space:nowrap">
                  {timeAgo(r.last) ?? '—'}
                </td>
              </tr>
            ))}
          </table>
        )}
      </div>

      <PathTable
        title="Slowest endpoints"
        note="By mean latency since boot. Paths are templated so ids do not split the numbers."
        rows={m.slowestPaths}
        metric="slowest"
      />
      <PathTable
        title="Busiest endpoints"
        note="Most-requested templated paths since boot."
        rows={m.busiestPaths}
        metric="busiest"
      />

      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">MCP tool usage</div>
            <div class="card-note">Tool calls seen on /mcp since boot.</div>
          </div>
        </div>
        {m.tools.length === 0 ? (
          <div class="card-pad muted small">No MCP tool calls yet.</div>
        ) : (
          <table class="tbl" data-table="tools">
            <tr>
              <th>Tool</th>
              <th>Calls</th>
            </tr>
            {m.tools.map((t) => (
              <tr>
                <td class="mono">{t.tool}</td>
                <td>{nfmt(t.n)}</td>
              </tr>
            ))}
          </table>
        )}
      </div>

      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">Storage</div>
            <div class="card-note">
              Row counts for the main tables
              {dbSize == null ? '.' : ` · database size ${fmtBytes(dbSize)}.`}
            </div>
          </div>
        </div>
        <table class="tbl" data-table="storage">
          <tr>
            <th>Table</th>
            <th>Rows</th>
          </tr>
          {storage.map((row) => (
            <tr>
              <td class="mono">{row.table}</td>
              <td>{nfmt(row.rows)}</td>
            </tr>
          ))}
        </table>
      </div>
    </AppLayout>,
  );
});

// ---------------------------------------------------------------- teams

const planIds = Object.keys(PLANS) as (keyof typeof PLANS)[];
const membershipRoles = ['member', 'owner'] as const;
const adminFilter = (value: string | undefined, max = 100) => (value ?? '').trim().slice(0, max);

async function adminOwnerCount(db: Db, teamId: string): Promise<number> {
  return (
    await db
      .select({ n: count() })
      .from(memberships)
      .where(and(eq(memberships.teamId, teamId), eq(memberships.role, 'owner')))
  )[0]?.n ?? 0;
}

async function adminMembershipAllowed(
  c: Context<AppEnv>,
  teamId: string,
  action: 'add' | 'role' | 'remove',
) {
  return (
    (await c.get('lifecycle').beforeAdminMembershipChange?.({
      db: c.get('db'),
      teamId,
      action,
    })) ?? { ok: true as const }
  );
}

const userAdminBack = (id: string, message: string, ok = false) =>
  `/admin/users/${id}?${ok ? 'ok' : 'error'}=${encodeURIComponent(message)}`;

adminRoutes.get('/admin/teams', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const managedBilling = c.get('capabilities').managedBilling;
  const all = await db.select().from(teams).orderBy(desc(teams.createdAt));
  const q = adminFilter(c.req.query('q')).toLocaleLowerCase('en-US');
  const requestedPlan = adminFilter(c.req.query('plan'), 20);
  const plan = (planIds as string[]).includes(requestedPlan) ? requestedPlan : '';
  const list = all.filter(
    (workspace) =>
      (!q || `${workspace.name} ${workspace.slug}`.toLocaleLowerCase('en-US').includes(q)) &&
      (!plan || workspace.plan === plan),
  );
  const byTeam = <T,>(rows: { id: string | null; v: T }[]) =>
    new Map(rows.filter((r) => r.id != null).map((r) => [r.id as string, r.v]));
  const memberCounts = byTeam(
    await db
      .select({ id: memberships.teamId, v: count() })
      .from(memberships)
      .groupBy(memberships.teamId),
  );
  const projectCounts = byTeam(
    await db.select({ id: projects.teamId, v: count() }).from(projects).groupBy(projects.teamId),
  );
  const openCounts = byTeam(
    await db
      .select({ id: debugSessions.teamId, v: count() })
      .from(debugSessions)
      .where(eq(debugSessions.status, 'open'))
      .groupBy(debugSessions.teamId),
  );
  const lastActivity = byTeam(
    await db
      .select({ id: activity.teamId, v: max(activity.createdAt) })
      .from(activity)
      .groupBy(activity.teamId),
  );
  // Which of these an operator has given a plan to: one query, whatever the count.
  const grants = await activePlanGrants(db, list.map((t) => t.id));
  const error = c.req.query('error');
  const notice = c.req.query('ok');

  return c.html(
    <AppLayout user={user} active="admin" title="Admin — Workspaces">
      {error ? <Banner kind="error" text={error} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}
      <div class="page-head">
        <div>
          <h1 class="title">Workspaces</h1>
          <p class="sub">
            The billing and authorization parent. Every project, membership and scoped agent
            connection belongs to a workspace. Plan changes take effect immediately
            {managedBilling ? '; a later Stripe webhook supersedes a manual override for managed subscriptions' : ''}.
          </p>
        </div>
        {managedBilling ? <a class="btn btn-sm" href="/admin/billing">Stripe billing</a> : null}
      </div>
      <AdminTabs active="teams" />

      <form class="card card-pad" method="get" action="/admin/teams" style="margin-bottom:14px">
        <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
          <label class="field" style="margin:0;min-width:260px;flex:1">
            <span>Search workspaces</span>
            <input class="in" type="search" name="q" value={adminFilter(c.req.query('q'))} placeholder="Name or slug" />
          </label>
          <label class="field" style="margin:0;min-width:170px">
            <span>Plan</span>
            <select class="in" name="plan">
              <option value="">All plans</option>
              {planIds.map((id) => <option value={id} selected={plan === id}>{id}</option>)}
            </select>
          </label>
          <button class="btn btn-primary" type="submit">Filter</button>
          <a class="btn" href="/admin/teams">Clear</a>
          <span class="muted small">{list.length} of {all.length}</span>
        </div>
      </form>

      {all.length === 0 ? (
        <div class="card">
          <div class="empty">
            <h2>No workspaces yet</h2>
            <p>Workspaces appear here as soon as someone creates one in the app.</p>
          </div>
        </div>
      ) : list.length === 0 ? (
        <div class="card">
          <div class="empty">
            <h2>No matching workspaces</h2>
            <p>Clear or change the filters above.</p>
          </div>
        </div>
      ) : (
        <div class="card scroll-x">
          <table class="tbl">
            <tr>
              <th>Workspace</th>
              <th>Plan</th>
              <th>Members</th>
              <th>Projects</th>
              <th>Open sessions</th>
              <th>Created</th>
              <th>Last activity</th>
              <th>Change plan</th>
            </tr>
            {list.map((t) => (
              <tr>
                <td>
                  <div class="name"><a href={`/admin/teams/${t.id}`}>{t.name}</a></div>
                  <div class="mono muted small">{t.slug}</div>
                </td>
                <td>
                  <span class={`pill ${t.plan === 'free' ? 'pill-member' : 'pill-active'}`}>
                    {t.plan}
                  </span>
                  {/* The column is the workspace's own plan; a grant rides beside it and
                      decides while it lasts, so it is named here rather than hidden. */}
                  {grants.get(t.id) ? (
                    <div class="muted small" data-grant={t.slug}>
                      given {describeGrant(grants.get(t.id)!)}
                    </div>
                  ) : null}
                </td>
                <td>{memberCounts.get(t.id) ?? 0}</td>
                <td>{projectCounts.get(t.id) ?? 0}</td>
                <td>{openCounts.get(t.id) ?? 0}</td>
                <td class="muted">{fmtDate(t.createdAt)}</td>
                <td class="muted">{timeAgo(lastActivity.get(t.id) ?? null) ?? '—'}</td>
                <td>
                  <form
                    class="inline m0"
                    method="post"
                    action={`/admin/teams/${t.id}/plan`}
                    style="flex-wrap:nowrap;gap:6px"
                  >
                    <select class="in" name="plan" style="height:32px;font-size:12px">
                      {planIds.map((p) => (
                        <option value={p} selected={t.plan === p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <button class="btn btn-sm" type="submit">
                      Save
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        </div>
      )}
    </AppLayout>,
  );
});

adminRoutes.post('/admin/teams/:id/plan', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const id = c.req.param('id');
  const body = await c.req.parseBody();
  const returnToDetail = body.return_to === 'detail' && UUID_RE.test(id);
  const back = (msg: string, ok = false) =>
    c.redirect(`${returnToDetail ? `/admin/teams/${id}` : '/admin/teams'}?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);
  const plan = typeof body.plan === 'string' ? body.plan.trim() : '';
  if (!(planIds as string[]).includes(plan)) {
    return back(`Unknown plan "${plan.slice(0, 40)}". Valid plans: ${planIds.join(', ')}.`);
  }
  if (!UUID_RE.test(id)) return back('Team not found.');
  // setTeamPlan owns the update and the history row in one transaction; this
  // route no longer writes teams.plan itself, and nothing else may.
  const result = await setTeamPlan(db, {
    teamId: id,
    plan,
    source: 'operator',
    route: 'POST /admin/teams/:id/plan',
    actorId: user.id,
    actorLabel: user.username,
  });
  if (!result) return back('Team not found.');
  if (!result.changed) return back(`${result.team.name} was already on the ${plan} plan.`, true);
  logLine({
    evt: 'admin',
    a: 'plan_change',
    u: user.username,
    team: result.team.slug,
    from: result.previous,
    plan,
  });
  return back(
    `${result.team.name} moved from ${result.previous} to the ${plan} plan.`,
    true,
  );
});

/**
 * Give a workspace a plan, or change the one given: no end date or through a
 * last day. `lib/planGrants` owns the write and its history row in one
 * transaction; the note never reaches a log line.
 */
adminRoutes.post('/admin/teams/:id/grant', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.notFound();
  const body = await c.req.parseBody();
  const back = (msg: string, ok = false) =>
    c.redirect(`/admin/teams/${id}?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}#plan-grant`);
  const plan = typeof body.plan === 'string' ? body.plan.trim() : '';
  if (!isGrantablePlan(plan)) {
    return back(`Choose ${GRANTABLE_PLANS.join(', ')} to give; free is where every workspace already stands.`);
  }
  let endsAt: Date | null = null;
  if (body.ends === 'date') {
    const parsed = endsAtFromLastDay(typeof body.last_day === 'string' ? body.last_day.trim() : '');
    if ('error' in parsed) return back(parsed.error);
    endsAt = parsed.endsAt;
  }
  const result = await setPlanGrant(db, {
    teamId: id,
    plan,
    endsAt,
    note: normalizeGrantNote(body.note),
    actorId: user.id,
    actorLabel: user.username,
    route: 'POST /admin/teams/:id/grant',
  });
  if (!result) return c.notFound();
  if (!result.changed) return back(`${result.team.name} already has ${describeGrant(result.grant!)}.`, true);
  logLine({
    evt: 'admin',
    a: 'plan_grant',
    u: user.username,
    team: result.team.slug,
    plan,
    through: endsAt ? grantLastDay(endsAt) : null,
  });
  return back(`${result.team.name} now has ${describeGrant(result.grant!)}.`, true);
});

/** Take a grant back, or clear one that has already ended. */
adminRoutes.post('/admin/teams/:id/grant/revoke', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.notFound();
  const back = (msg: string, ok = false) =>
    c.redirect(`/admin/teams/${id}?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}#plan-grant`);
  const result = await revokePlanGrant(db, {
    teamId: id,
    actorId: user.id,
    actorLabel: user.username,
    route: 'POST /admin/teams/:id/grant/revoke',
  });
  if (!result) return c.notFound();
  if (!result.previous) return back(`${result.team.name} has no complimentary plan.`, true);
  const wasLive = isGrantActive(result.previous);
  logLine({
    evt: 'admin',
    a: wasLive ? 'plan_grant_revoked' : 'plan_grant_cleared',
    u: user.username,
    team: result.team.slug,
    plan: result.previous.plan,
  });
  return back(
    wasLive
      ? `Revoked. ${result.team.name} is back on its own plan, ${result.team.plan}.`
      : `Cleared the ended grant. ${result.team.name} was already on its own plan, ${result.team.plan}.`,
    true,
  );
});

adminRoutes.get('/admin/teams/:id', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.notFound();
  const workspace = (await db.select().from(teams).where(eq(teams.id, id)).limit(1))[0];
  if (!workspace) return c.notFound();

  const memberRows = await db
    .select({ user: users, role: memberships.role, joinedAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.teamId, id))
    .orderBy(users.username);
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.teamId, id))
    .orderBy(projects.name);
  const connectionRows = await db
    .select({
      tokenId: tokens.id,
      tokenName: tokens.name,
      scope: tokens.scope,
      projectId: tokens.projectId,
      projectName: projects.name,
      username: users.username,
      installationId: agentInstallations.id,
      installationName: agentInstallations.name,
      deviceLabel: agentInstallations.deviceLabel,
      clientType: agentInstallations.clientType,
      tokenRevokedAt: tokens.revokedAt,
      installationRevokedAt: agentInstallations.revokedAt,
      lastUsedAt: tokens.lastUsedAt,
    })
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .leftJoin(projects, eq(tokens.projectId, projects.id))
    .leftJoin(agentInstallations, eq(agentInstallations.tokenId, tokens.id))
    .where(eq(tokens.teamId, id))
    .orderBy(desc(tokens.createdAt));
  const ceilings = await ceilingHistory(db, { teamId: id, limit: 50 });
  const accessChanges = await membershipHistory(db, { teamId: id, limit: 50 });
  const grant = await planGrantFor(db, id);
  const grantLive = grant ? isGrantActive(grant) : false;
  const projectConnections = new Map<string, number>();
  for (const connection of connectionRows) {
    if (!connection.projectId || connection.tokenRevokedAt || connection.installationRevokedAt) continue;
    projectConnections.set(
      connection.projectId,
      (projectConnections.get(connection.projectId) ?? 0) + 1,
    );
  }

  return c.html(
    <AppLayout user={user} active="admin" title={`Admin — ${workspace.name}`}>
      {c.req.query('error') ? <Banner kind="error" text={c.req.query('error')!} /> : null}
      {c.req.query('ok') ? <Banner kind="success" text={c.req.query('ok')!} /> : null}
      <div class="page-head">
        <div>
          <div class="overline"><a href="/admin/teams">Workspaces</a> / {workspace.slug}</div>
          <h1 class="title">{workspace.name}</h1>
          <p class="sub">Workspace → projects → scoped agent connections. Membership and plan live at the workspace boundary.</p>
        </div>
        <form class="inline m0" method="post" action={`/admin/teams/${workspace.id}/plan`}>
          <input type="hidden" name="return_to" value="detail" />
          <select class="in" name="plan">
            {planIds.map((plan) => <option value={plan} selected={workspace.plan === plan}>{plan}</option>)}
          </select>
          <button class="btn" type="submit">Change plan</button>
        </form>
      </div>
      <AdminTabs active="teams" />

      <div style={statGrid}>
        <Stat
          label="Workspace plan"
          value={grantLive ? `${grant!.plan}, given` : workspace.plan}
          note={
            grantLive
              ? `complimentary ${grant!.endsAt ? `through ${grantLastDay(grant!.endsAt)}` : 'with no end date'}; its own plan is ${workspace.plan}`
              : 'Applies to this workspace, not directly to a user'
          }
        />
        <Stat label="Members" value={memberRows.length} note="Humans; agents are not seats" />
        <Stat label="Projects" value={projectRows.length} note="Children of this workspace" />
        <Stat label="Scoped connections" value={connectionRows.length} note="Team + project credentials" />
      </div>

      <div style="margin-top:14px">
        <PlanGrantCard
          workspace={{ id: workspace.id, name: workspace.name, plan: workspace.plan }}
          grant={grant}
          env={c.get('env')}
          managedBilling={Boolean(c.get('capabilities').managedBilling)}
        />
      </div>

      <div style="margin-top:14px">
        <CeilingHistoryCard
          rows={ceilings}
          title="Ceiling history"
          note={`Every time this workspace's limits moved, newest first (up to 50). ${meteringNote(c.get('env'))} Membership add, role change and removal are not here — they spend a ceiling rather than move one, and they are in Access history below.`}
          withWorkspace={false}
        />
      </div>

      <div style="margin-top:14px">
        <MembershipHistoryCard
          rows={accessChanges}
          title="Access history"
          note={`Every join, role change and removal in this workspace, newest first (up to 50). ${MEMBERSHIP_LIMITS}`}
          withWorkspace={false}
        />
      </div>

      <div class="card scroll-x" style="margin-top:14px">
        <div class="card-head"><div><div class="card-title">Members</div><div class="card-note">Manage a person's workspace memberships from their user detail.</div></div></div>
        <table class="tbl">
          <tr><th>User</th><th>Role</th><th>Joined</th><th></th></tr>
          {memberRows.map((row) => (
            <tr>
              <td class="name"><a href={`/admin/users/${row.user.id}`}>{row.user.username}</a><div class="muted small">{row.user.email ?? 'no sign-in email'}</div></td>
              <td><span class={`pill ${row.role === 'owner' ? 'pill-owner' : 'pill-member'}`}>{row.role}</span></td>
              <td class="muted">{fmtDate(row.joinedAt)}</td>
              <td><a class="btn btn-sm" href={`/admin/users/${row.user.id}`}>Manage membership</a></td>
            </tr>
          ))}
        </table>
      </div>

      <div class="card scroll-x" style="margin-top:14px">
        <div class="card-head"><div><div class="card-title">Projects</div><div class="card-note">Every row is inside this workspace; project-scoped credentials cannot leave it.</div></div></div>
        {projectRows.length === 0 ? <div class="card-pad muted">No projects.</div> : (
          <table class="tbl">
            <tr><th>Project</th><th>Repository identity</th><th>Active project connections</th><th>Created</th></tr>
            {projectRows.map((project) => (
              <tr>
                <td><div class="name">{project.name}</div><div class="mono muted small">{project.slug}</div></td>
                <td class="mono muted small">{project.repositoryIdentity ?? 'not bound'}</td>
                <td>{projectConnections.get(project.id) ?? 0}</td>
                <td class="muted">{fmtDate(project.createdAt)}</td>
              </tr>
            ))}
          </table>
        )}
      </div>

      <div class="card scroll-x" style="margin-top:14px">
        <div class="card-head"><div><div class="card-title">Agent connections</div><div class="card-note">Only credentials explicitly bound to this workspace. Personal cross-workspace credentials are intentionally not relabelled as workspace connections.</div></div></div>
        {connectionRows.length === 0 ? <div class="card-pad muted">No workspace- or project-scoped connections.</div> : (
          <table class="tbl">
            <tr><th>Agent</th><th>User</th><th>Scope</th><th>Project</th><th>Client / device</th><th>Last used</th><th>Status</th></tr>
            {connectionRows.map((connection) => {
              const revoked = Boolean(connection.tokenRevokedAt || connection.installationRevokedAt);
              return (
                <tr>
                  <td><div class="name">{connection.installationName ?? connection.tokenName}</div><div class="mono muted small">{connection.installationId ?? connection.tokenId}</div></td>
                  <td><a href={`/admin/users?${new URLSearchParams({ q: connection.username })}`}>{connection.username}</a></td>
                  <td><span class={`pill ${connection.scope === 'project' ? 'pill-member' : 'pill-active'}`}>{connection.scope}</span></td>
                  <td>{connection.projectName ?? (connection.scope === 'team' ? 'All workspace projects' : '—')}</td>
                  <td class="muted">{connection.clientType ?? 'legacy'} · {connection.deviceLabel ?? 'unknown device'}</td>
                  <td class="muted">{timeAgo(connection.lastUsedAt) ?? 'never'}</td>
                  <td>{revoked ? <span class="pill pill-member">revoked</span> : <span class="pill pill-active">active</span>}</td>
                </tr>
              );
            })}
          </table>
        )}
      </div>
    </AppLayout>,
  );
});

// ---------------------------------------------------------------- users

adminRoutes.get('/admin/users', async (c) => {
  const user = c.get('user')!;
  const env = c.get('env');
  const db = c.get('db');
  const all = await db.select().from(users).orderBy(desc(users.createdAt));
  const memberRows = await db
    .select({
      userId: memberships.userId,
      teamId: memberships.teamId,
      teamName: teams.name,
      teamSlug: teams.slug,
      teamPlan: teams.plan,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .orderBy(teams.name);
  type UserWorkspace = (typeof memberRows)[number];
  const workspacesByUser = new Map<string, UserWorkspace[]>();
  for (const r of memberRows) {
    const rows = workspacesByUser.get(r.userId) ?? [];
    rows.push(r);
    workspacesByUser.set(r.userId, rows);
  }
  const q = adminFilter(c.req.query('q')).toLocaleLowerCase('en-US');
  const requestedPlan = adminFilter(c.req.query('plan'), 20);
  const plan = (planIds as string[]).includes(requestedPlan) ? requestedPlan : '';
  const membership = ['has', 'none'].includes(c.req.query('membership') ?? '')
    ? c.req.query('membership')!
    : '';
  const auth = ['password', 'github', 'admin', 'blocked'].includes(c.req.query('auth') ?? '')
    ? c.req.query('auth')!
    : '';
  const list = all.filter((account) => {
    const workspaceRows = workspacesByUser.get(account.id) ?? [];
    const haystack = [
      account.username,
      account.email ?? '',
      account.displayName ?? '',
      ...workspaceRows.flatMap((row) => [row.teamName, row.teamSlug]),
    ].join(' ').toLocaleLowerCase('en-US');
    return (
      (!q || haystack.includes(q)) &&
      (!plan || workspaceRows.some((row) => row.teamPlan === plan)) &&
      (!membership || (membership === 'has' ? workspaceRows.length > 0 : workspaceRows.length === 0)) &&
      (!auth ||
        (auth === 'password' && Boolean(account.passwordHash)) ||
        (auth === 'github' && account.githubId != null) ||
        (auth === 'admin' && isAdminUser(env, account)) ||
        (auth === 'blocked' && !account.passwordHash && account.githubId == null))
    );
  });

  return c.html(
    <AppLayout user={user} active="admin" title="Admin — Users">
      <div class="page-head">
        <div>
          <h1 class="title">Users</h1>
          <p class="sub">
            Accounts are people. Plans belong to workspaces, so one user can appear under several
            workspace plans and roles. Open a user to manage those memberships.
          </p>
        </div>
      </div>
      <AdminTabs active="users" />
      {c.req.query('error') ? <Banner kind="error" text={c.req.query('error')!} /> : null}
      {c.req.query('ok') ? <Banner kind="success" text={c.req.query('ok')!} /> : null}

      <form class="card card-pad" method="get" action="/admin/users" style="margin-bottom:14px">
        <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
          <label class="field" style="margin:0;min-width:260px;flex:1">
            <span>Search users</span>
            <input class="in" type="search" name="q" value={adminFilter(c.req.query('q'))} placeholder="Username, email or workspace" />
          </label>
          <label class="field" style="margin:0;min-width:160px"><span>Workspace plan</span><select class="in" name="plan"><option value="">Any plan</option>{planIds.map((id) => <option value={id} selected={plan === id}>{id}</option>)}</select></label>
          <label class="field" style="margin:0;min-width:150px"><span>Membership</span><select class="in" name="membership"><option value="">Any</option><option value="has" selected={membership === 'has'}>Has workspace</option><option value="none" selected={membership === 'none'}>No workspace</option></select></label>
          <label class="field" style="margin:0;min-width:150px"><span>Authentication</span><select class="in" name="auth"><option value="">Any</option><option value="password" selected={auth === 'password'}>Password</option><option value="github" selected={auth === 'github'}>GitHub</option><option value="admin" selected={auth === 'admin'}>Admin</option><option value="blocked" selected={auth === 'blocked'}>No sign-in</option></select></label>
          <button class="btn btn-primary" type="submit">Filter</button>
          <a class="btn" href="/admin/users">Clear</a>
          <span class="muted small">{list.length} of {all.length}</span>
        </div>
      </form>

      <div class="card scroll-x">
        <table class="tbl">
          <tr>
            <th>User</th>
            <th>Email</th>
            <th>Display name</th>
            <th>Workspace memberships</th>
            <th>Auth</th>
            <th>Created</th>
            <th></th>
          </tr>
          {list.map((u) => {
            const workspaceRows = workspacesByUser.get(u.id) ?? [];
            return (
              <tr data-user-row={u.username}>
                <td class="name"><a href={`/admin/users/${u.id}`}>{u.username}</a></td>
                <td class="muted">{u.email ?? '—'}</td>
                <td class="muted">{u.displayName ?? '—'}</td>
                <td>
                  {workspaceRows.length === 0 ? <span class="muted">—</span> : (
                    <div class="row" style="gap:6px;flex-wrap:wrap">
                      {workspaceRows.map((workspace) => (
                        <a class={`pill ${workspace.teamPlan === 'free' ? 'pill-member' : 'pill-active'}`} href={`/admin/teams/${workspace.teamId}`} title={`${workspace.teamSlug} · ${workspace.role}`}>
                          {workspace.teamName} · {workspace.role} · {workspace.teamPlan}
                        </a>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  <div class="row" style="gap:6px;flex-wrap:wrap">
                    {u.passwordHash ? <span class="pill pill-member">password</span> : null}
                    {u.githubId != null ? <span class="pill pill-member">github</span> : null}
                    {isAdminUser(env, u) ? <span class="pill pill-owner">admin</span> : null}
                    {!u.passwordHash && u.githubId == null && !isAdminUser(env, u) ? (
                      <span class="muted small">—</span>
                    ) : null}
                  </div>
                </td>
                <td class="muted">{fmtDate(u.createdAt)}</td>
                <td><a class="btn btn-sm" href={`/admin/users/${u.id}`}>Manage</a></td>
              </tr>
            );
          })}
        </table>
      </div>
    </AppLayout>,
  );
});

adminRoutes.get('/admin/users/:id', async (c) => {
  const actor = c.get('user')!;
  const env = c.get('env');
  const db = c.get('db');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.notFound();
  const account = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
  if (!account) return c.notFound();
  const workspaceRows = await db
    .select({ team: teams, role: memberships.role, joinedAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(eq(memberships.userId, id))
    .orderBy(teams.name);
  const accessChanges = await membershipHistory(db, { subjectId: id, limit: 50 });
  const allWorkspaces = await db.select().from(teams).orderBy(teams.name);
  const currentIds = new Set(workspaceRows.map((row) => row.team.id));
  const available = allWorkspaces.filter((workspace) => !currentIds.has(workspace.id));
  const authentication = [
    account.passwordHash ? 'password' : '',
    account.githubId != null ? 'GitHub' : '',
    isAdminUser(env, account) ? 'admin' : '',
  ].filter(Boolean).join(', ') || 'none — sign-in blocked';

  return c.html(
    <AppLayout user={actor} active="admin" title={`Admin — ${account.username}`}>
      {c.req.query('error') ? <Banner kind="error" text={c.req.query('error')!} /> : null}
      {c.req.query('ok') ? <Banner kind="success" text={c.req.query('ok')!} /> : null}
      <div class="page-head">
        <div>
          <div class="overline"><a href="/admin/users">Users</a> / {account.username}</div>
          <h1 class="title">{account.displayName ?? account.username}</h1>
          <p class="sub">One person, with independently managed roles in each workspace.</p>
        </div>
      </div>
      <AdminTabs active="users" />

      <div class="grid2">
        <div class="card card-pad">
          <div class="card-title">Account</div>
          <dl class="kv">
            <dt>Username</dt><dd>{account.username}</dd>
            <dt>Display name</dt><dd>{account.displayName ?? '—'}</dd>
            <dt>Created</dt><dd>{fmtDate(account.createdAt)}</dd>
            <dt>Authentication</dt><dd>{authentication}</dd>
          </dl>
          <form method="post" action={`/admin/users/${account.id}/email`} style="margin-top:14px">
            <label class="field"><span>Email (sign-in)</span><div class="inline"><input class="in" type="email" name="email" value={account.email ?? ''} placeholder="none — sign-in blocked" required /><button class="btn" type="submit">Save email</button></div></label>
          </form>
        </div>
        <div class="card card-pad">
          <div class="card-title">Add workspace membership</div>
          <p class="small muted">Plans belong to the selected workspace. Organization-managed workspaces refuse this action and must use their identity administrator.</p>
          {available.length === 0 ? <p class="muted">This user already belongs to every workspace.</p> : (
            <form method="post" action={`/admin/users/${account.id}/memberships`}>
              <label class="field"><span>Workspace</span><select class="in" name="team_id" required><option value="">Choose workspace</option>{available.map((workspace) => <option value={workspace.id}>{workspace.name} · {workspace.plan}</option>)}</select></label>
              <label class="field"><span>Role</span><select class="in" name="role">{membershipRoles.map((role) => <option value={role}>{role}</option>)}</select></label>
              <button class="btn btn-primary" type="submit">Add membership</button>
            </form>
          )}
        </div>
      </div>

      <div class="card scroll-x" style="margin-top:14px">
        <div class="card-head"><div><div class="card-title">Workspace memberships</div><div class="card-note">Each membership has its own role. Changing one does not affect another workspace.</div></div><span class="mono muted">{workspaceRows.length}</span></div>
        {workspaceRows.length === 0 ? <div class="card-pad muted">No workspace memberships.</div> : (
          <table class="tbl">
            <tr><th>Workspace</th><th>Plan</th><th>Joined</th><th>Role</th><th></th></tr>
            {workspaceRows.map((row) => (
              <tr>
                <td><div class="name"><a href={`/admin/teams/${row.team.id}`}>{row.team.name}</a></div><div class="mono muted small">{row.team.slug}</div></td>
                <td><span class={`pill ${row.team.plan === 'free' ? 'pill-member' : 'pill-active'}`}>{row.team.plan}</span></td>
                <td class="muted">{fmtDate(row.joinedAt)}</td>
                <td>
                  <form class="inline m0" method="post" action={`/admin/users/${account.id}/memberships/${row.team.id}/role`}>
                    <select class="in" name="role" style="height:32px;font-size:12px">{membershipRoles.map((role) => <option value={role} selected={row.role === role}>{role}</option>)}</select>
                    <button class="btn btn-sm" type="submit">Save role</button>
                  </form>
                </td>
                <td><form class="inline m0" method="post" action={`/admin/users/${account.id}/memberships/${row.team.id}/remove`} data-confirm={`Remove ${account.username} from ${row.team.name}? Their team/project-scoped agent credentials stop working immediately. This does not delete the account or its other memberships.`}><button class="btn btn-sm btn-danger" type="submit">Remove</button></form></td>
              </tr>
            ))}
          </table>
        )}
      </div>

      {/* The list above is where they are now; this is how they got there and
          what they have lost, which is the question asked after an identity
          provider has already acted. */}
      <div style="margin-top:14px">
        <MembershipHistoryCard
          rows={accessChanges}
          title="Access history"
          note={`Every workspace this person joined, changed role in or lost, newest first (up to 50). ${MEMBERSHIP_LIMITS}`}
          withWorkspace
          withSubject={false}
        />
      </div>
    </AppLayout>,
  );
});

adminRoutes.post('/admin/users/:id/memberships', async (c) => {
  const actor = c.get('user')!;
  const db = c.get('db');
  const userId = c.req.param('id');
  if (!UUID_RE.test(userId)) return c.notFound();
  const body = await c.req.parseBody();
  const teamId = typeof body.team_id === 'string' ? body.team_id : '';
  const role = membershipRoles.includes(body.role as (typeof membershipRoles)[number])
    ? (body.role as (typeof membershipRoles)[number])
    : 'member';
  if (!UUID_RE.test(teamId)) return c.redirect(userAdminBack(userId, 'Choose a valid workspace.'));
  const account = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  const workspace = (await db.select().from(teams).where(eq(teams.id, teamId)).limit(1))[0];
  if (!account || !workspace) return c.redirect(userAdminBack(userId, 'User or workspace not found.'));
  const allowed = await adminMembershipAllowed(c, teamId, 'add');
  if (!allowed.ok) return c.redirect(userAdminBack(userId, allowed.message));
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select ${teams.id} from ${teams} where ${teams.id} = ${teamId} for update`);
      const lockedWorkspace = (
        await tx.select().from(teams).where(eq(teams.id, teamId)).limit(1)
      )[0];
      if (!lockedWorkspace) return { kind: 'missing' } as const;
      const existing = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)))
        .limit(1);
      if (existing[0]) return { kind: 'existing' } as const;
      const limits = await effectiveLimits(
        tx as unknown as Db,
        lockedWorkspace,
        c.get('env').hosted,
      );
      const memberCount = (
        await tx.select({ n: count() }).from(memberships).where(eq(memberships.teamId, teamId))
      )[0]?.n ?? 0;
      if (memberCount >= limits.maxMembers) {
        return { kind: 'limit', plan: lockedWorkspace.plan } as const;
      }
      const rows = await tx
        .insert(memberships)
        .values({ teamId, userId, role })
        .onConflictDoNothing()
        .returning({ userId: memberships.userId });
      if (rows[0]) {
        await criticalAudit(tx as unknown as Db, {
          teamId,
          actorId: actor.id,
          action: 'membership_joined',
          subjectId: userId,
        });
        // On the transaction, because `criticalAudit` above already rolls the
        // insert back if it refuses and a second failure mode here would be
        // the one that leaves the two records disagreeing.
        await appendMembershipChange(tx as unknown as Db, {
          teamId,
          teamSlug: lockedWorkspace.slug,
          action: 'added',
          subjectId: userId,
          subjectLabel: account.username,
          previousRole: null,
          nextRole: role,
          source: 'operator',
          route: 'POST /admin/users/:id/memberships',
          actorId: actor.id,
          actorLabel: actor.username,
        });
      }
      return rows[0] ? { kind: 'inserted' } as const : { kind: 'existing' } as const;
    });
    if (result.kind === 'missing') {
      return c.redirect(userAdminBack(userId, 'Workspace not found.'));
    }
    if (result.kind === 'existing') {
      return c.redirect(userAdminBack(userId, `${account.username} is already a member of ${workspace.name}.`, true));
    }
    if (result.kind === 'limit') {
      return c.redirect(userAdminBack(userId, `${workspace.name} is at its ${result.plan} plan member limit.`));
    }
  } catch (error) {
    if (error instanceof SecurityRefusal) return c.redirect(userAdminBack(userId, error.message));
    throw error;
  }
  await c.get('lifecycle').teamMemberCountChanged?.({ db, teamId });
  await track(db, { teamId, userId: actor.id, action: 'admin_member_added', detail: `${account.username} was added as ${role} by operator ${actor.username}` });
  logLine({ evt: 'admin', a: 'membership_add', u: actor.username, target: account.username, team: workspace.slug, role });
  return c.redirect(userAdminBack(userId, `${account.username} was added to ${workspace.name} as ${role}.`, true));
});

adminRoutes.post('/admin/users/:id/memberships/:teamId/role', async (c) => {
  const actor = c.get('user')!;
  const db = c.get('db');
  const userId = c.req.param('id');
  const teamId = c.req.param('teamId');
  if (!UUID_RE.test(userId) || !UUID_RE.test(teamId)) return c.notFound();
  const body = await c.req.parseBody();
  const role = membershipRoles.includes(body.role as (typeof membershipRoles)[number])
    ? (body.role as (typeof membershipRoles)[number])
    : null;
  if (!role) return c.redirect(userAdminBack(userId, 'Choose member or owner.'));
  const allowed = await adminMembershipAllowed(c, teamId, 'role');
  if (!allowed.ok) return c.redirect(userAdminBack(userId, allowed.message));
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select ${teams.id} from ${teams} where ${teams.id} = ${teamId} for update`);
    const row = (
      await tx
        .select({ username: users.username, workspaceName: teams.name, workspaceSlug: teams.slug, currentRole: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .innerJoin(teams, eq(memberships.teamId, teams.id))
        .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)))
        .limit(1)
    )[0];
    if (!row) return { kind: 'missing' } as const;
    if (row.currentRole === role) return { kind: 'same', row } as const;
    if (
      row.currentRole === 'owner' &&
      role === 'member' &&
      (await adminOwnerCount(tx as unknown as Db, teamId)) <= 1
    ) {
      return { kind: 'last_owner' } as const;
    }
    await tx
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)));
    return { kind: 'updated', row } as const;
  });
  if (result.kind === 'missing') return c.redirect(userAdminBack(userId, 'Membership not found.'));
  if (result.kind === 'same') return c.redirect(userAdminBack(userId, `${result.row.username} is already ${role} in ${result.row.workspaceName}.`, true));
  if (result.kind === 'last_owner') {
    return c.redirect(userAdminBack(userId, 'A workspace needs at least one owner. Promote another member first.'));
  }
  const row = result.row;
  await recordMembershipChange(db, {
    teamId,
    teamSlug: row.workspaceSlug,
    action: 'role_changed',
    subjectId: userId,
    subjectLabel: row.username,
    previousRole: row.currentRole,
    nextRole: role,
    source: 'operator',
    route: 'POST /admin/users/:id/memberships/:teamId/role',
    actorId: actor.id,
    actorLabel: actor.username,
  });
  await track(db, { teamId, userId: actor.id, action: role === 'owner' ? 'member_promoted' : 'member_demoted', detail: `${row.username} was changed to ${role} by operator ${actor.username}` });
  logLine({ evt: 'admin', a: 'membership_role', u: actor.username, target: row.username, team: row.workspaceSlug, role });
  return c.redirect(userAdminBack(userId, `${row.username} is now ${role} in ${row.workspaceName}.`, true));
});

adminRoutes.post('/admin/users/:id/memberships/:teamId/remove', async (c) => {
  const actor = c.get('user')!;
  const db = c.get('db');
  const userId = c.req.param('id');
  const teamId = c.req.param('teamId');
  if (!UUID_RE.test(userId) || !UUID_RE.test(teamId)) return c.notFound();
  const allowed = await adminMembershipAllowed(c, teamId, 'remove');
  if (!allowed.ok) return c.redirect(userAdminBack(userId, allowed.message));
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select ${teams.id} from ${teams} where ${teams.id} = ${teamId} for update`);
    const row = (
      await tx
        .select({ username: users.username, workspaceName: teams.name, workspaceSlug: teams.slug, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .innerJoin(teams, eq(memberships.teamId, teams.id))
        .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)))
        .limit(1)
    )[0];
    if (!row) return { kind: 'missing' } as const;
    if (row.role === 'owner' && (await adminOwnerCount(tx as unknown as Db, teamId)) <= 1) {
      return { kind: 'last_owner' } as const;
    }
    await tx
      .delete(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)));
    return { kind: 'removed', row } as const;
  });
  if (result.kind === 'missing') return c.redirect(userAdminBack(userId, 'Membership not found.'));
  if (result.kind === 'last_owner') {
    return c.redirect(userAdminBack(userId, 'The last workspace owner cannot be removed. Promote another member first.'));
  }
  const row = result.row;
  await recordMembershipChange(db, {
    teamId,
    teamSlug: row.workspaceSlug,
    action: 'removed',
    subjectId: userId,
    subjectLabel: row.username,
    previousRole: row.role,
    nextRole: null,
    source: 'operator',
    route: 'POST /admin/users/:id/memberships/:teamId/remove',
    actorId: actor.id,
    actorLabel: actor.username,
    leftOwnerless: await hasNoOwner(db, teamId),
  });
  await c.get('lifecycle').teamMemberCountChanged?.({ db, teamId });
  await track(db, { teamId, userId: actor.id, action: 'member_removed', detail: `${row.username} was removed by operator ${actor.username}` });
  logLine({ evt: 'admin', a: 'membership_remove', u: actor.username, target: row.username, team: row.workspaceSlug });
  return c.redirect(userAdminBack(userId, `${row.username} was removed from ${row.workspaceName}.`, true));
});

/**
 * Lockout escape hatch: give an account the email it signs in with. Accounts
 * created before email login (and dev/OAuth accounts without a verified address)
 * have none, and nobody but an operator can set the first one.
 */
adminRoutes.post('/admin/users/:id/email', async (c) => {
  const actor = c.get('user')!;
  const db = c.get('db');
  const id = c.req.param('id');
  const back = (msg: string, ok = false) =>
    c.redirect(`/admin/users?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  if (!isEmail(email)) return back('Enter a valid email address.');

  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const target = rows[0];
  if (!target) return back('That account no longer exists.');
  if (target.email === email) return back(`${target.username} already signs in with ${email}.`, true);
  if (!(await emailIsFree(db, email, id))) {
    return back('Another account already uses that email.');
  }
  // Unconfirmed, whatever the old address was: an operator typing an address
  // proves nothing about who reads it, and `email_verified_at` is what the
  // operator gate itself trusts. The account confirms it like any other, from
  // Account, with a code sent there.
  await db.update(users).set({ email, emailVerifiedAt: null }).where(eq(users.id, id));
  logLine({ evt: 'admin', a: 'set_email', u: actor.username, target: target.username });
  // The address being left is told, as it is when a person moves their own:
  // followed by a reset, this action hands the account to whoever reads the
  // new one, and the old inbox is the only place that can still notice.
  if (target.email) void sendMail(c.get('env'), { to: target.email, ...emailChangedNotice(email, c.get('env').baseUrl) });
  return back(`${target.username} now signs in with ${email}, unconfirmed until a code sent there comes back.`, true);
});

// ---------------------------------------------------------------- CRM

export const CRM_STATUSES = [
  'lead',
  'contacted',
  'demo',
  'onboarding',
  'active',
  'churned',
  'lost',
] as const;
const PIPELINE_STATUSES = ['lead', 'contacted', 'demo', 'onboarding', 'active'] as const;
const ARCHIVED_STATUSES = ['churned', 'lost'] as const;

type Contact = typeof crmContacts.$inferSelect;

const optField = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return s || null;
};

/** Shared create/update form parsing; returns an error message or the column values. */
function parseContactForm(
  body: Record<string, unknown>,
):
  | { error: string }
  | {
      values: {
        name: string;
        org: string | null;
        contact: string | null;
        source: string | null;
        status: string;
        notes: string | null;
        nextActionAt: Date | null;
      };
    } {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) return { error: 'A contact needs a name.' };
  const status = typeof body.status === 'string' && body.status.trim() ? body.status.trim() : 'lead';
  if (!(CRM_STATUSES as readonly string[]).includes(status)) {
    return { error: `Unknown status "${status.slice(0, 40)}". Valid: ${CRM_STATUSES.join(', ')}.` };
  }
  const nextRaw = typeof body.next_action === 'string' ? body.next_action.trim() : '';
  let nextActionAt: Date | null = null;
  if (nextRaw) {
    const d = new Date(`${nextRaw}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextRaw) || Number.isNaN(d.getTime())) {
      return { error: 'Next action must be a date (YYYY-MM-DD).' };
    }
    nextActionAt = d;
  }
  return {
    values: {
      name,
      org: optField(body.org, 120),
      contact: optField(body.contact, 200),
      source: optField(body.source, 120),
      status,
      notes: optField(body.notes, 4000),
      nextActionAt,
    },
  };
}

const ContactDialog = ({ ct }: { ct?: Contact }) => (
  <dialog id={ct ? `edit-contact-${ct.id}` : 'new-contact'} class="formdlg">
    <h3>{ct ? 'Edit contact' : 'Add contact'}</h3>
    <p class="dlgsub">
      {ct ? `Update ${ct.name} — only the name is required.` : 'A design partner, lead or champion. Only the name is required.'}
    </p>
    <form method="post" action={ct ? `/admin/crm/${ct.id}/update` : '/admin/crm'}>
      <div class="field">
        <label>Name</label>
        <input class="in" type="text" name="name" value={ct?.name ?? ''} required maxlength={120} />
      </div>
      <div class="field">
        <label>Organization</label>
        <input class="in" type="text" name="org" value={ct?.org ?? ''} maxlength={120} />
      </div>
      <div class="field">
        <label>Contact (email / handle)</label>
        <input class="in" type="text" name="contact" value={ct?.contact ?? ''} maxlength={200} />
      </div>
      <div class="field">
        <label>Source</label>
        <input
          class="in"
          type="text"
          name="source"
          value={ct?.source ?? ''}
          placeholder="e.g. HN launch, referral, conference"
          maxlength={120}
        />
      </div>
      <div class="field">
        <label>Status</label>
        <select class="in" name="status">
          {CRM_STATUSES.map((s) => (
            <option value={s} selected={(ct?.status ?? 'lead') === s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label>Next action date</label>
        <input
          class="in"
          type="date"
          name="next_action"
          value={ct?.nextActionAt ? ct.nextActionAt.toISOString().slice(0, 10) : ''}
        />
        <span class="help">Optional. Past dates are highlighted in the pipeline.</span>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea class="in" name="notes" maxlength={4000}>
          {ct?.notes ?? ''}
        </textarea>
      </div>
      <div class="dialog-actions">
        <button class="btn" type="button" data-close-dialog="t">
          Cancel
        </button>
        <button class="btn btn-primary" type="submit">
          {ct ? 'Save changes' : 'Add contact'}
        </button>
      </div>
    </form>
  </dialog>
);

const ContactRow = ({ ct }: { ct: Contact }) => {
  const overdue = ct.nextActionAt != null && ct.nextActionAt.getTime() < Date.now();
  const notes = ct.notes ?? '';
  return (
    <tr>
      <td class="name">{ct.name}</td>
      <td class="muted">{ct.org ?? '—'}</td>
      <td class="mono">{ct.contact ?? '—'}</td>
      <td class="muted">{ct.source ?? '—'}</td>
      <td style="white-space:nowrap">
        {ct.nextActionAt ? (
          overdue ? (
            <span class="with-dot" style="color:var(--red);font-weight:500">
              <span class="dot red" />
              {fmtDate(ct.nextActionAt)}
            </span>
          ) : (
            <span class="muted">{fmtDate(ct.nextActionAt)}</span>
          )
        ) : (
          <span style="color:var(--mut-2)">—</span>
        )}
      </td>
      <td class="muted" title={notes}>
        {notes ? (notes.length > 70 ? `${notes.slice(0, 70)}…` : notes) : '—'}
      </td>
      <td style="text-align:right">
        <div class="row" style="justify-content:flex-end;flex-wrap:nowrap">
          <form
            class="inline m0"
            method="post"
            action={`/admin/crm/${ct.id}/status`}
            style="flex-wrap:nowrap;gap:6px"
          >
            <select class="in" name="status" style="height:32px;font-size:12px">
              {CRM_STATUSES.map((s) => (
                <option value={s} selected={ct.status === s}>
                  {s}
                </option>
              ))}
            </select>
            <button class="btn btn-sm" type="submit">
              Save
            </button>
          </form>
          <button class="btn btn-sm" type="button" data-open-dialog={`#edit-contact-${ct.id}`}>
            Edit
          </button>
          <form
            class="m0"
            method="post"
            action={`/admin/crm/${ct.id}/delete`}
            data-confirm={`${ct.name} and their notes are removed from the CRM permanently.`}
            data-confirm-title={`Delete ${ct.name}?`}
            data-confirm-action="Delete contact"
          >
            <button class="linklike" type="submit">
              Delete
            </button>
          </form>
        </div>
      </td>
    </tr>
  );
};

adminRoutes.get('/admin/crm', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const contacts = await db
    .select()
    .from(crmContacts)
    .orderBy(crmContacts.nextActionAt, crmContacts.createdAt);
  const byStatus = new Map<string, Contact[]>();
  for (const ct of contacts) {
    const bucket = byStatus.get(ct.status) ?? [];
    bucket.push(ct);
    byStatus.set(ct.status, bucket);
  }
  const archived = ARCHIVED_STATUSES.flatMap((s) => byStatus.get(s) ?? []);
  const error = c.req.query('error');
  const notice = c.req.query('ok');

  return c.html(
    <AppLayout user={user} active="admin" title="Admin — CRM">
      {error ? <Banner kind="error" text={error} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}
      <div class="page-head">
        <div>
          <h1 class="title">Design-partner CRM</h1>
          <p class="sub">
            The pipeline from first contact to active design partner. Operator-only — teams never
            see this.
          </p>
        </div>
        <button class="btn btn-primary" type="button" data-open-dialog="#new-contact">
          Add contact
        </button>
      </div>
      <AdminTabs active="crm" />

      {contacts.length === 0 ? (
        <div class="card">
          <div class="empty">
            <h2>No contacts yet</h2>
            <p>
              Track the people you talk to about STMA — leads, demos, onboardings — so the next
              action never slips.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div class="card scroll-x">
            <table class="tbl">
              <tr>
                <th>Name</th>
                <th>Org</th>
                <th>Contact</th>
                <th>Source</th>
                <th>Next action</th>
                <th>Notes</th>
                <th style="text-align:right">Actions</th>
              </tr>
              {PIPELINE_STATUSES.map((status) => {
                const bucket = byStatus.get(status) ?? [];
                return (
                  <>
                    <tr class="section">
                      <td colspan={7}>
                        {status} <span class="soft">· {bucket.length}</span>
                      </td>
                    </tr>
                    {bucket.map((ct) => (
                      <ContactRow ct={ct} />
                    ))}
                  </>
                );
              })}
            </table>
          </div>

          <details class="card">
            <summary style="padding:14px 18px;cursor:pointer;font:600 15px/1.2 var(--sans)">
              Archived <span class="muted small">churned + lost · {archived.length}</span>
            </summary>
            {archived.length === 0 ? (
              <div class="card-pad muted small" style="border-top:1px solid var(--line-2)">
                Nothing churned or lost.
              </div>
            ) : (
              <div class="scroll-x" style="border-top:1px solid var(--line-2)">
                <table class="tbl">
                  <tr>
                    <th>Name</th>
                    <th>Org</th>
                    <th>Contact</th>
                    <th>Source</th>
                    <th>Next action</th>
                    <th>Notes</th>
                    <th style="text-align:right">Actions</th>
                  </tr>
                  {archived.map((ct) => (
                    <ContactRow ct={ct} />
                  ))}
                </table>
              </div>
            )}
          </details>
        </>
      )}

      <ContactDialog />
      {contacts.map((ct) => (
        <ContactDialog ct={ct} />
      ))}
    </AppLayout>,
  );
});

adminRoutes.post('/admin/crm', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const back = (msg: string, ok = false) =>
    c.redirect(`/admin/crm?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);
  const parsed = parseContactForm(await c.req.parseBody());
  if ('error' in parsed) return back(parsed.error);
  const inserted = await db.insert(crmContacts).values(parsed.values).returning({ id: crmContacts.id });
  logLine({ evt: 'admin', a: 'crm_create', u: user.username, contact: inserted[0]!.id });
  return back(`${parsed.values.name} added to the pipeline.`, true);
});

adminRoutes.post('/admin/crm/:id/update', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const back = (msg: string, ok = false) =>
    c.redirect(`/admin/crm?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);
  const parsed = parseContactForm(await c.req.parseBody());
  if ('error' in parsed) return back(parsed.error);
  const updated = await db
    .update(crmContacts)
    .set({ ...parsed.values, updatedAt: new Date() })
    .where(eq(crmContacts.id, c.req.param('id')))
    .returning({ id: crmContacts.id });
  if (updated.length === 0) return back('Contact not found.');
  logLine({ evt: 'admin', a: 'crm_update', u: user.username, contact: updated[0]!.id });
  return back(`${parsed.values.name} updated.`, true);
});

adminRoutes.post('/admin/crm/:id/status', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const back = (msg: string, ok = false) =>
    c.redirect(`/admin/crm?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);
  const body = await c.req.parseBody();
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!(CRM_STATUSES as readonly string[]).includes(status)) {
    return back(`Unknown status "${status.slice(0, 40)}". Valid: ${CRM_STATUSES.join(', ')}.`);
  }
  const updated = await db
    .update(crmContacts)
    .set({ status, updatedAt: new Date() })
    .where(eq(crmContacts.id, c.req.param('id')))
    .returning({ id: crmContacts.id, name: crmContacts.name });
  if (updated.length === 0) return back('Contact not found.');
  logLine({
    evt: 'admin',
    a: 'crm_status',
    u: user.username,
    contact: updated[0]!.id,
    status,
  });
  return back(`${updated[0]!.name} moved to ${status}.`, true);
});

adminRoutes.post('/admin/crm/:id/delete', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const back = (msg: string, ok = false) =>
    c.redirect(`/admin/crm?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);
  const deleted = await db
    .delete(crmContacts)
    .where(eq(crmContacts.id, c.req.param('id')))
    .returning({ id: crmContacts.id, name: crmContacts.name });
  if (deleted.length === 0) return back('Contact not found.');
  logLine({ evt: 'admin', a: 'crm_delete', u: user.username, contact: deleted[0]!.id });
  return back(`${deleted[0]!.name} deleted.`, true);
});
