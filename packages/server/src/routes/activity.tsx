import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db';
import { activity, memberships, projects, teams, tokens, users } from '../db/schema';
import { loginRedirect } from '../auth/session';
import { projectForTeam } from '../domain/access';
import { timeAgo } from '../lib/format';
import { pageWindow, slicePage } from '../lib/pagination';
import type { AppEnv } from '../types';
import { Lead, PageHead, ProjectScope, Vr } from '../ui/Console';
import { AppLayout } from '../ui/Layout';
import { Pager } from '../ui/Pager';

export const activityRoutes = new Hono<AppEnv>();

const PAGE_SIZE = 100;

async function teamForMember(db: Db, slug: string, userId: string) {
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(and(eq(teams.slug, slug), eq(memberships.userId, userId)))
    .limit(1);
  return rows[0];
}

activityRoutes.get('/app/teams/:slug/activity', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  const { team } = found;

  const path = `/app/teams/${team.slug}/activity`;
  const win = pageWindow(c.req.query('page'), PAGE_SIZE);
  // Same idiom as governance: `?project=` narrows the log to one project, the
  // whole team stays the default, and the choice lives in the URL.
  const projectQuery = (c.req.query('project') ?? '').trim();
  const scopeProject = projectQuery
    ? await projectForTeam(db, team.id, projectQuery)
    : undefined;
  const projectParams = scopeProject ? `?project=${encodeURIComponent(scopeProject.name)}` : '';
  const teamProjects = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name)
    .limit(50);
  const fetched = await db
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
      and(
        eq(activity.teamId, team.id),
        scopeProject ? eq(activity.projectId, scopeProject.id) : undefined,
      ),
    )
    .orderBy(desc(activity.createdAt))
    .limit(win.limit)
    .offset(win.offset);
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
          <ProjectScope path={path} projects={teamProjects} current={scopeProject?.name ?? null} />
          <a class="chip" href={`${path}.csv${projectParams}`}>
            export csv
          </a>
        </>
      }
      head={
        <PageHead
          crumb={`/ ${team.slug} / activity`}
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
      keysNote={`events are immutable · purged after ${c.get('env').activityRetentionDays} days`}
    >
      {/* Auto-refresh only on page 1: reloading page 4 under a reader would slide
          the window as new events arrive at the top. */}
      {win.page === 1 ? <div data-autorefresh="30" style="display:none"></div> : null}

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
            query={{ project: scopeProject?.name }}
            window={win}
            page={page}
            noun="events"
          />
        </div>
      )}
    </AppLayout>,
  );
});

/** Rows a single export may carry. Bounded, and the response says when it hit the cap. */
const EXPORT_LIMIT = 5000;

/** RFC 4180: quote everything, double the quotes inside. Excel is not a parser. */
const csvCell = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`;

/**
 * The trail as a file. The console offers "export" on a page whose whole claim
 * is that it is a record rather than a feed — a record you cannot take with you
 * is a weaker claim, and an operator asked for their own audit log should not
 * have to scrape HTML for it.
 */
activityRoutes.get('/app/teams/:slug/activity.csv', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  const { team } = found;

  // The export honours the same `?project=` filter the page does — an audit
  // scoped on screen must not silently widen in the file.
  const projectQuery = (c.req.query('project') ?? '').trim();
  const scopeProject = projectQuery
    ? await projectForTeam(db, team.id, projectQuery)
    : undefined;
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
      and(
        eq(activity.teamId, team.id),
        scopeProject ? eq(activity.projectId, scopeProject.id) : undefined,
      ),
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
});
