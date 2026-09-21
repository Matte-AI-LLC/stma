import { membershipUser } from '../lib/securityHooks';
import { and, desc, eq, gte, ilike, lte, or, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { Db } from '../db';
import { activity, memberships, projects, teams, tokens, users } from '../db/schema';
import { loginRedirect } from '../auth/session';
import { projectForTeam } from '../domain/access';
import { historyRetentionNote } from '../lib/cleanup';
import { grantedOrOwnPlan } from '../lib/planGrants';
import { timeAgo } from '../lib/format';
import { pageWindow, slicePage } from '../lib/pagination';
import { projectInPath, scopedProjectParam, sectionHref } from '../lib/scope';
import type { AppEnv } from '../types';
import { Lead, PageHead, ProjectScope, scopedTrail, Vr } from '../ui/Console';
import { AppLayout } from '../ui/Layout';
import { Pager } from '../ui/Pager';

export const activityRoutes = new Hono<AppEnv>();

const PAGE_SIZE = 100;

type ActivityFilters = {
  action: string;
  actor: string;
  agent: string;
  search: string;
  from: string;
  to: string;
};

const filtersFrom = (query: (name: string) => string | undefined): ActivityFilters => ({
  action: (query('action') ?? '').trim(),
  actor: (query('actor') ?? '').trim(),
  agent: (query('agent') ?? '').trim(),
  search: (query('q') ?? '').trim(),
  from: (query('from') ?? '').trim(),
  to: (query('to') ?? '').trim(),
});

const dateBoundary = (value: string, end = false): Date | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const activityWhere = (
  teamId: string,
  projectId: string | undefined,
  filters: ActivityFilters,
) => {
  const conditions: (SQL | undefined)[] = [
    eq(activity.teamId, teamId),
    projectId ? eq(activity.projectId, projectId) : undefined,
    filters.action ? eq(activity.action, filters.action) : undefined,
    filters.actor ? ilike(users.username, `%${filters.actor}%`) : undefined,
    filters.agent ? ilike(tokens.name, `%${filters.agent}%`) : undefined,
  ];
  const from = dateBoundary(filters.from);
  const to = dateBoundary(filters.to, true);
  if (from) conditions.push(gte(activity.createdAt, from));
  if (to) conditions.push(lte(activity.createdAt, to));
  if (filters.search) {
    const needle = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(activity.action, needle),
        ilike(activity.detail, needle),
        ilike(users.username, needle),
        ilike(tokens.name, needle),
        ilike(projects.name, needle),
      ),
    );
  }
  return and(...conditions);
};

/**
 * The log rows themselves, so a second page can show a slice of the same trail.
 *
 * A person's page shows the newest events attributed to them and links here for
 * the rest. It reads through this rather than writing its own query: the filter
 * on `actor` is a case-insensitive `ilike`, and a page that matched the username
 * exactly would show a different set of rows from the page it sends you to.
 */
export async function readActivity(
  db: Db,
  teamId: string,
  projectId: string | undefined,
  filters: ActivityFilters,
  window: { limit: number; offset: number },
) {
  return db
    .select({
      a: activity,
      username: users.username,
      tokenName: tokens.name,
      projectName: projects.name,
    })
    .from(activity)
    .leftJoin(users, eq(activity.userId, users.id))
    .leftJoin(tokens, eq(activity.tokenId, tokens.id))
    .leftJoin(projects, eq(activity.projectId, projects.id))
    .where(activityWhere(teamId, projectId, filters))
    .orderBy(desc(activity.createdAt))
    .limit(window.limit)
    .offset(window.offset);
}

/** The empty filter set, for a caller that narrows by one field only. */
export const noActivityFilters = (): ActivityFilters => filtersFrom(() => undefined);

const queryRecord = (project: string | undefined, filters: ActivityFilters) => ({
  project,
  action: filters.action || undefined,
  actor: filters.actor || undefined,
  agent: filters.agent || undefined,
  q: filters.search || undefined,
  from: filters.from || undefined,
  to: filters.to || undefined,
});

const queryString = (query: Record<string, string | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
};

async function teamForMember(db: Db, slug: string, userId: string) {
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(and(eq(teams.slug, slug), membershipUser(userId)))
    .limit(1);
  return rows[0];
}

/**
 * One page, two addresses: the workspace's log and one project's.
 *
 * `/app/teams/:slug/projects/:project/activity` is what the rail links to; the
 * `?project=` filter it replaces still answers, unchanged.
 */
const activityPage = async (c: Context<AppEnv>) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug') ?? '', user.id);
  if (!found) return c.notFound();
  const { team } = found;
  // The rule the sweep applies, which follows an operator's grant while it lasts.
  const retentionPlan = await grantedOrOwnPlan(db, team);

  const win = pageWindow(c.req.query('page'), PAGE_SIZE);
  const filters = filtersFrom((name) => c.req.query(name));
  // A project narrows the log to that project. Named in the path it is the page's
  // identity, so a spelling that matches nothing is a wrong address; as `?project=`
  // it stays a filter and the whole team is the default.
  const projectQuery = scopedProjectParam(c);
  const inPath = projectInPath(c);
  const scopeProject = projectQuery
    ? await projectForTeam(db, team.id, projectQuery)
    : undefined;
  if (inPath && !scopeProject) return c.notFound();
  /** This page's own address: paging, clearing and the export stay where the reader is. */
  const path = sectionHref(team.slug, inPath ? scopeProject!.slug : null, 'activity');
  /** The workspace address, for the two controls that pick a project by writing a query. */
  const everyProject = sectionHref(team.slug, null, 'activity');
  // Paging and the export carry the filters; the project only when the address is
  // not already carrying it.
  const filterQuery = queryRecord(inPath ? undefined : scopeProject?.id, filters);
  const projectParams = queryString(filterQuery);
  const teamProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug, repositoryIdentity: projects.repositoryIdentity })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name)
    .limit(50);
  const fetched = await readActivity(db, team.id, scopeProject?.id, filters, win);
  const page = slicePage(fetched, win);
  const rows = page.items;

  const newest = rows[0]?.a.createdAt ?? null;

  return c.html(
    <AppLayout
      user={user}
      active="activity"
      title={`Activity — ${team.name}`}
      strip={
        <>
          <Lead text={win.page === 1 ? 'Streaming' : 'Paged'} live={win.page === 1} />
          <Vr />
          <span>
            page {win.page} · {rows.length} {rows.length === 1 ? 'event' : 'events'}
          </span>
          {newest ? (
            <>
              <span class="dim">·</span>
              <span>newest {timeAgo(newest)}</span>
            </>
          ) : null}
          <Vr />
          <span data-freeze-state={win.page === 1 ? 'poll 30s' : 'paused on older pages'}>
            {win.page === 1 ? 'poll 30s' : 'paused on older pages'}
          </span>
        </>
      }
      scope={
        <>
          <span class="chip">
            team <b>{team.slug}</b>
          </span>
          {/* Picks a project, so it posts to the workspace address: its options carry
              project ids and a GET form can only write a query string. */}
          <ProjectScope path={everyProject} projects={teamProjects} current={scopeProject?.id ?? null} />
          <a class="chip" href={`${path}.csv${projectParams}`}>
            export csv
          </a>
        </>
      }
      head={
        <PageHead
          trail={scopedTrail({ team, project: scopeProject }, 'Activity')}
          title="Activity"
          sub={`A log, not a feed: what every member's agent did on the bridge, newest first, ${PAGE_SIZE} per page.`}
          actions={
            win.page === 1 ? (
              <button
                class="btn btn-sm"
                type="button"
                data-freeze="t"
                data-live-label="Pause stream"
                data-frozen-label="Resume stream"
              >
                Pause stream
              </button>
            ) : (
              <a class="btn btn-sm" href={path}>
                Back to newest
              </a>
            )
          }
        />
      }
      keys={[{ k: 'E', label: 'export csv' }]}
      keysNote={`events are immutable · ${historyRetentionNote(c.get('env'), retentionPlan)}`}
    >
      {/* Auto-refresh only on page 1: reloading page 4 under a reader would slide
          the window as new events arrive at the top. */}
      {win.page === 1 ? <div data-autorefresh="30" style="display:none"></div> : null}

      {/* The filter bar leads with a project picker, so it answers at the workspace
          address too; everything it narrows is in the query either way. */}
      <form method="get" action={everyProject} class="card card-pad activity-filters">
        <label>
          <span>Project</span>
          <select name="project">
            <option value="">All projects</option>
            {teamProjects.map((project) => (
              <option value={project.name} selected={project.name === scopeProject?.name}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Action</span>
          <input name="action" value={filters.action} placeholder="run_started" />
        </label>
        <label>
          <span>Person</span>
          <input name="actor" value={filters.actor} placeholder="username" />
        </label>
        <label>
          <span>Agent</span>
          <input name="agent" value={filters.agent} placeholder="agent name" />
        </label>
        <label class="activity-search">
          <span>Search log</span>
          <input name="q" value={filters.search} placeholder="action, project or detail" />
        </label>
        <label>
          <span>From</span>
          <input type="date" name="from" value={filters.from} />
        </label>
        <label>
          <span>To</span>
          <input type="date" name="to" value={filters.to} />
        </label>
        <div class="activity-filter-actions">
          <button class="btn btn-primary btn-sm" type="submit">Apply filters</button>
          <a class="btn btn-sm" href={path}>Clear</a>
        </div>
      </form>

      {rows.length === 0 && win.page === 1 ? (
        <div class="card">
          <div class="empty">
            <h2>No activity yet</h2>
            <p>Events appear as agents push snapshots, compare environments and talk in sessions.</p>
          </div>
        </div>
      ) : (
        <div class="card scroll-x">
          {rows.length === 0 ? (
            <div class="card-pad muted small">
              Nothing this far back — the feed ends before this page.
            </div>
          ) : (
            <table class="tbl">
              <tr>
                <th>When</th>
                <th>User</th>
                <th>Agent</th>
                <th>Action</th>
                <th>Project</th>
                <th>Detail</th>
              </tr>
              {rows.map((r) => (
                <tr>
                  <td class="muted" style="white-space:nowrap">
                    {timeAgo(r.a.createdAt)}
                  </td>
                  <td class="name">{r.username ?? 'automation'}</td>
                  <td class="mono">{r.tokenName ?? '—'}</td>
                  <td>
                    <span class="pill pill-member">{r.a.action}</span>
                  </td>
                  <td class="muted">{r.projectName ?? '—'}</td>
                  <td class="muted">{r.a.detail ?? ''}</td>
                </tr>
              ))}
            </table>
          )}
          <Pager
            path={path}
            query={filterQuery}
            window={win}
            page={page}
            noun="events"
          />
        </div>
      )}
    </AppLayout>,
  );
};

activityRoutes.get('/app/teams/:slug/activity', activityPage);
activityRoutes.get('/app/teams/:slug/projects/:project/activity', activityPage);

/** Rows a single export may carry. Bounded, and the response says when it hit the cap. */
const EXPORT_LIMIT = 5000;

/** RFC 4180: quote everything, double the quotes inside. Excel is not a parser. */
/**
 * One CSV cell, escaped for the file format and defused for the thing that
 * opens it.
 *
 * Quote-doubling makes the file correct; it does nothing about the other
 * reader. Excel and LibreOffice evaluate a cell that begins `=`, `+`, `-` or
 * `@` even inside quotes, and `detail` reaches this column from the inbound
 * announce hook, so a CI system holding a hook token could write a formula into
 * a file the owner later opens. A leading apostrophe is what both of them read
 * as "this is text".
 */
export const csvCell = (value: unknown): string => {
  const raw = String(value ?? '');
  const armed = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${armed.replaceAll('"', '""')}"`;
};

/**
 * The trail as a file. The console offers "export" on a page whose whole claim
 * is that it is a record rather than a feed — a record you cannot take with you
 * is a weaker claim, and an operator asked for their own audit log should not
 * have to scrape HTML for it.
 */
const activityCsv = async (c: Context<AppEnv>) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug') ?? '', user.id);
  if (!found) return c.notFound();
  const { team } = found;

  // The export honours the same project scope the page does — an audit scoped on
  // screen must not silently widen in the file — in whichever form the address
  // carries it, so the link beside a project's log exports that project.
  const projectQuery = scopedProjectParam(c);
  const scopeProject = projectQuery
    ? await projectForTeam(db, team.id, projectQuery)
    : undefined;
  if (projectInPath(c) && !scopeProject) return c.notFound();
  const filters = filtersFrom((name) => c.req.query(name));
  const rows = await db
    .select({
      a: activity,
      username: users.username,
      tokenName: tokens.name,
      projectName: projects.name,
    })
    .from(activity)
    .leftJoin(users, eq(activity.userId, users.id))
    .leftJoin(tokens, eq(activity.tokenId, tokens.id))
    .leftJoin(projects, eq(activity.projectId, projects.id))
    .where(
      activityWhere(team.id, scopeProject?.id, filters),
    )
    .orderBy(desc(activity.createdAt))
    .limit(EXPORT_LIMIT);

  const lines = [
    ['at', 'team', 'project', 'person', 'agent', 'action', 'detail'].map(csvCell).join(','),
    ...rows.map((row) =>
      [
        row.a.createdAt.toISOString(),
        team.slug,
        row.projectName ?? '',
        row.username ?? 'automation',
        row.tokenName ?? '',
        row.a.action,
        row.a.detail ?? '',
      ]
        .map(csvCell)
        .join(','),
    ),
  ];
  if (rows.length === EXPORT_LIMIT) {
    // Say it in the file rather than truncating in silence.
    lines.push(csvCell(`— truncated at ${EXPORT_LIMIT} rows, newest first —`));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  // A byte-order mark, because the file is opened in Excel more often than
  // anywhere else and Excel reads a BOM-less CSV in the machine's ANSI codepage:
  // without this, "çalışacağım" arrives as "Ã§alÄ±ÅŸacaÄŸÄ±m" on a Turkish Windows.
  return c.body(`\uFEFF${lines.join('\r\n')}\r\n`, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="stma-${team.slug}-activity-${stamp}.csv"`,
  });
};

activityRoutes.get('/app/teams/:slug/activity.csv', activityCsv);
// The export link sits beside a project's log, so it has the project's address too.
activityRoutes.get('/app/teams/:slug/projects/:project/activity.csv', activityCsv);
