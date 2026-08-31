import { ACTIVE_AGENT_RUN_STATUSES } from '@bridge/shared';
import { count, countDistinct, desc, eq, gt, inArray, isNull, max, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
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
  users,
} from '../db/schema';
import { adminConfigured, isAdminUser } from '../lib/admin';
import { activationFunnel, teamUsage, usageWindows } from '../lib/usage';
import { PLANS } from '../lib/entitlements';
import { emailIsFree, isEmail, normalizeEmail } from '../lib/email';
import { fmtDate, initials, timeAgo } from '../lib/format';
import { logLine } from '../lib/log';
import { metrics } from '../lib/metrics';
import type { AppEnv } from '../types';
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
  active: 'overview' | 'usage' | 'ops' | 'teams' | 'users' | 'crm';
}) => (
  <div class="tabs">
    <a class={`tab${active === 'overview' ? ' active' : ''}`} href="/admin">
      Overview
    </a>
    <a class={`tab${active === 'usage' ? ' active' : ''}`} href="/admin/usage">
      Usage
    </a>
    <a class={`tab${active === 'ops' ? ' active' : ''}`} href="/admin/ops">
      Ops
    </a>
    <a class={`tab${active === 'teams' ? ' active' : ''}`} href="/admin/teams">
      Teams
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

adminRoutes.get('/admin/usage', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const windows = await usageWindows(db);
  const funnel = await activationFunnel(db);
  const rows = await teamUsage(db);
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
            <div class="card-title">Activation funnel</div>
            <div class="card-note">
              By team, because STMA only does anything once a second machine shows up. The drop
              between two steps is the thing worth reading.
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
            Live errors and load for this replica. Counters are in-process and reset when the
            container restarts; the error log is persisted.
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
            <div class="card-title">Traffic — last 60 minutes</div>
            <div class="card-note">
              One bar per minute. Red marks a minute that contained a 5xx. Peak{' '}
              {nfmt(m.lastHour.peak)} req/min.
            </div>
          </div>
        </div>
        <div
          class="spark"
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

      <div class="card scroll-x">
        <div class="card-head">
          <div>
            <div class="card-title">Status codes</div>
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

adminRoutes.get('/admin/teams', async (c) => {
  const user = c.get('user')!;
  const db = c.get('db');
  const list = await db.select().from(teams).orderBy(desc(teams.createdAt));
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
  const error = c.req.query('error');
  const notice = c.req.query('ok');

  return c.html(
    <AppLayout user={user} active="admin" title="Admin — Teams">
      {error ? <Banner kind="error" text={error} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}
      <div class="page-head">
        <div>
          <h1 class="title">Teams</h1>
          <p class="sub">Every team on this instance. Plan changes take effect immediately.</p>
        </div>
      </div>
      <AdminTabs active="teams" />

      {list.length === 0 ? (
        <div class="card">
          <div class="empty">
            <h2>No teams yet</h2>
            <p>Teams appear here as soon as someone creates one in the app.</p>
          </div>
        </div>
      ) : (
        <div class="card scroll-x">
          <table class="tbl">
            <tr>
              <th>Team</th>
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
                  <div class="name">{t.name}</div>
                  <div class="mono muted small">{t.slug}</div>
                </td>
                <td>
                  <span class={`pill ${t.plan === 'free' ? 'pill-member' : 'pill-active'}`}>
                    {t.plan}
                  </span>
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
  const back = (msg: string, ok = false) =>
    c.redirect(`/admin/teams?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);
  const body = await c.req.parseBody();
  const plan = typeof body.plan === 'string' ? body.plan.trim() : '';
  if (!(planIds as string[]).includes(plan)) {
    return back(`Unknown plan "${plan.slice(0, 40)}". Valid plans: ${planIds.join(', ')}.`);
  }
  const updated = await db
    .update(teams)
    .set({ plan })
    .where(eq(teams.id, c.req.param('id')))
    .returning({ name: teams.name, slug: teams.slug });
  if (updated.length === 0) return back('Team not found.');
  logLine({ evt: 'admin', a: 'plan_change', u: user.username, team: updated[0]!.slug, plan });
  return back(`${updated[0]!.name} is now on the ${plan} plan.`, true);
});

// ---------------------------------------------------------------- users

adminRoutes.get('/admin/users', async (c) => {
  const user = c.get('user')!;
  const env = c.get('env');
  const db = c.get('db');
  const list = await db.select().from(users).orderBy(desc(users.createdAt));
  const memberRows = await db
    .select({ userId: memberships.userId, teamName: teams.name })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .orderBy(teams.name);
  const teamsByUser = new Map<string, string[]>();
  for (const r of memberRows) {
    const names = teamsByUser.get(r.userId) ?? [];
    names.push(r.teamName);
    teamsByUser.set(r.userId, names);
  }

  return c.html(
    <AppLayout user={user} active="admin" title="Admin — Users">
      <div class="page-head">
        <div>
          <h1 class="title">Users</h1>
          <p class="sub">
            Every account on this instance. The email is the sign-in identity — set one to unlock an
            account that predates email login.
          </p>
        </div>
      </div>
      <AdminTabs active="users" />
      {c.req.query('error') ? <Banner kind="error" text={c.req.query('error')!} /> : null}
      {c.req.query('ok') ? <Banner kind="success" text={c.req.query('ok')!} /> : null}

      <div class="card scroll-x">
        <table class="tbl">
          <tr>
            <th>User</th>
            <th>Email (sign-in)</th>
            <th>Display name</th>
            <th>Teams</th>
            <th>Auth</th>
            <th>Created</th>
          </tr>
          {list.map((u) => {
            const names = teamsByUser.get(u.id) ?? [];
            const shown = names.slice(0, 3).join(', ');
            return (
              <tr>
                <td class="name">{u.username}</td>
                <td>
                  <form class="inline m0" method="post" action={`/admin/users/${u.id}/email`}>
                    <input
                      class="in"
                      style="min-width:210px"
                      type="email"
                      name="email"
                      value={u.email ?? ''}
                      placeholder="none — sign-in blocked"
                      required
                    />
                    <button class="btn" type="submit">
                      Save
                    </button>
                  </form>
                </td>
                <td class="muted">{u.displayName ?? '—'}</td>
                <td class="muted" title={names.join(', ')}>
                  {names.length === 0
                    ? '—'
                    : `${names.length} · ${shown}${names.length > 3 ? ` +${names.length - 3}` : ''}`}
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
              </tr>
            );
          })}
        </table>
      </div>
    </AppLayout>,
  );
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
  await db.update(users).set({ email }).where(eq(users.id, id));
  logLine({ evt: 'admin', a: 'set_email', u: actor.username, target: target.username });
  return back(`${target.username} now signs in with ${email}.`, true);
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
