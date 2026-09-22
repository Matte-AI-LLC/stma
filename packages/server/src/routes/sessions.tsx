import { membershipUser } from '../lib/securityHooks';
import { THREAD_MESSAGE_KINDS, isThreadMessageKind } from '@bridge/shared';
import { and, count, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { Db } from '../db';
import {
  agentInstallations,
  debugSessions,
  handoffs,
  memberships,
  messages,
  projects,
  teams,
  tokens,
  users,
} from '../db/schema';
import { loginRedirect } from '../auth/session';
import { fmtDate, initials, timeAgo } from '../lib/format';
import { isCanonicalUuid } from '../lib/ids';
import { notifyTeam } from '../lib/notify';
import { notifySessionActivity } from '../lib/notifications';
import { pageWindow, slicePage } from '../lib/pagination';
import { redactSecrets } from '../lib/redact';
import { track } from '../lib/track';
import { markRead, sessionForMember, sessionStats, type SessionResolution } from '../lib/sessions';
import type { AppEnv } from '../types';
import { AppLayout } from '../ui/Layout';
import { Pager } from '../ui/Pager';
import { HandoffFlow } from '../ui/HandoffFlow';
import { transitionHandoff } from '../domain/collaboration';
import { Band, Inspector, PageHead, scopedTrail, teamTrail, Trail } from '../ui/Console';
import { ensureRail } from '../lib/rail';
import { memberByUsername } from '../domain/access';
import {
  projectInPath,
  scopedPersonParam,
  scopedProjectParam,
  scopedTeamParam,
  sectionHref,
} from '../lib/scope';
import { FlowEmpty, FlowSection } from '../ui/ProductFlow';
import { z } from 'zod/v3';

export const sessionsRoutes = new Hono<AppEnv>();

// A thread is named by the id this server wrote, in the spelling it wrote it.
// The database also reads `{…}` or a dash-less id as the same row, which let a
// spelling decide whether a guard compared anything (`lib/ids.ts`); and an id
// that is not a uuid at all reached a uuid column and answered 500.
const threadId: MiddlewareHandler<AppEnv> = async (c, next) =>
  isCanonicalUuid(c.req.param('id')) ? next() : c.notFound();
sessionsRoutes.use('/app/sessions/:id', threadId);
sessionsRoutes.use('/app/sessions/:id/*', threadId);

/** Sessions per page in the list, and messages per page inside a thread. */
const LIST_PAGE_SIZE = 25;
const THREAD_PAGE_SIZE = 100;

async function myTeams(db: Db, userId: string) {
  return db
    .select({ team: teams })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(membershipUser(userId))
    .orderBy(teams.name);
}


// ---------------------------------------------------------------- the reader

/**
 * The scope a sessions list is drawn in.
 *
 * `teamIds` is every workspace the reader belongs to — the account-wide list —
 * and the other three narrow it. Separate fields rather than one union because
 * the page draws every combination: the account's list, a workspace's, a
 * project's, and one person's inside either of those.
 */
export interface SessionScope {
  /** Every workspace the reader is a member of. Never empty when a query runs. */
  teamIds: string[];
  teamId?: string;
  projectId?: string;
  /** Threads this person opened or wrote in — see `personThreads`. */
  personId?: string;
}

/**
 * What "this person's sessions" means, decided in one place.
 *
 * **Opened or wrote in**, which is what the page's own heading says out loud.
 * Either half alone answers a narrower question than anybody asks here:
 * somebody who starts a thread and never comes back still started it, and
 * somebody who only ever replied is still in the conversation. Authorship
 * rather than origin, deliberately — `Viewer` in `lib/sessions.ts` keeps the
 * two apart because "is this news to me" is a question about the machine a
 * message arrived on, while this one asks who was in the room. It follows that
 * a message one of their agents posted counts: `messages.author_id` is the
 * owning human on every MCP write, and an agent writing under its human's
 * account is that human at work.
 *
 * Two kinds of thread are left out, both because the page that asks already
 * shows them somewhere else:
 *
 *  - **Dispatched work.** A thread carrying a `handoffs` row is an assignment
 *    or a handoff, not a conversation somebody joined; project pages stopped
 *    counting it as an open session on 2026-09-19 for exactly this reason. The
 *    person page has a Work card above this one and `/app/handoffs` has the
 *    rest, so listing it here would put one brief on one page twice under two
 *    different labels.
 *  - **The announcements channel.** It is created lazily by whoever first
 *    triggered it, so its `opened_by` would file a workspace's broadcast
 *    stream under one person who never opened a thread at all.
 *
 * Both are `exists` predicates rather than joins so that this composes into any
 * query — the list and its own tab counts are two different shapes, and a
 * filter that only worked in one of them is how a tab comes to disagree with
 * what is under it.
 */
const personThreads = (personId: string) =>
  and(
    ne(debugSessions.kind, 'announcements'),
    sql`not exists (select 1 from handoffs dispatched where dispatched.session_id = ${debugSessions.id})`,
    or(
      eq(debugSessions.openedBy, personId),
      sql`exists (select 1 from messages wrote where wrote.session_id = ${debugSessions.id} and wrote.author_id = ${personId})`,
    ),
  );

/** Everything a sessions list and its tab counts must agree on. */
export const sessionsInScope = (scope: SessionScope) =>
  and(
    scope.teamId
      ? eq(debugSessions.teamId, scope.teamId)
      : inArray(debugSessions.teamId, scope.teamIds),
    scope.projectId ? eq(debugSessions.projectId, scope.projectId) : undefined,
    scope.personId ? personThreads(scope.personId) : undefined,
  )!;

/**
 * The rows of a sessions list.
 *
 * Exported because a person's page shows a slice of one. A slice that ran its
 * own query would be a list the page it links to could not reproduce, which is
 * the drift the person page was built to avoid — `readActivity` is exported
 * from `routes/activity.tsx` and shared for the same reason.
 */
export async function readSessions(
  db: Db,
  scope: SessionScope,
  opts: { status: 'open' | 'resolved'; q?: string },
  window: { limit: number; offset: number },
) {
  const conds = [sessionsInScope(scope), eq(debugSessions.status, opts.status)];
  if (opts.status === 'resolved' && opts.q) {
    const like = `%${opts.q}%`;
    conds.push(
      or(ilike(debugSessions.title, like), sql`${debugSessions.resolution}::text ilike ${like}`)!,
    );
  }
  return db
    .select({ s: debugSessions, projectName: projects.name })
    .from(debugSessions)
    .leftJoin(projects, eq(debugSessions.projectId, projects.id))
    .where(and(...conds))
    .orderBy(desc(debugSessions.createdAt))
    .limit(window.limit)
    .offset(window.offset);
}

// ---------------------------------------------------------------- list

/**
 * The sessions list, at three addresses: the account's, a workspace's, and a
 * project's. `/app/teams/:slug/projects/:project/sessions` is what the rail links
 * to; `?team=` and `?project=` still answer, because the account page, the work
 * ledger and a good deal of mail point at them.
 *
 * `?person=` narrows any of them to one member's threads. It is a filter on this
 * page rather than a query on theirs: their page shows a slice of this list and
 * links here, so there is one definition of "their sessions" and one set of rows
 * behind it.
 */
const sessionsPage = async (c: Context<AppEnv>) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const status = c.req.query('status') === 'resolved' ? 'resolved' : 'open';
  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  const error = c.req.query('error');

  const mine = await myTeams(db, user.id);
  const teamIds = mine.map((m) => m.team.id);
  const slugById = new Map(mine.map((m) => [m.team.id, m.team.slug]));
  const requestedTeam = scopedTeamParam(c);
  const requestedProject = scopedProjectParam(c);
  const requestedPerson = scopedPersonParam(c);
  const availableProjects =
    teamIds.length > 0
      ? await db
          .select({ id: projects.id, name: projects.name, teamId: projects.teamId })
          .from(projects)
          .where(inArray(projects.teamId, teamIds))
          .orderBy(projects.name)
      : [];

  const win = pageWindow(c.req.query('page'), LIST_PAGE_SIZE);
  // The list has a scope like every other page: a workspace, or a project in it.
  // `team` and `project` used to preselect the New session dialog and nothing
  // else, so the rail's link to "sessions of this project" showed every thread
  // in every workspace.
  const scopeTeam = mine.find((m) => m.team.slug === requestedTeam)?.team;
  const scopeProject = scopeTeam && user.rail?.team === scopeTeam.slug ? (user.rail.project ?? undefined) : undefined;
  // In the path the workspace and the project are the page's identity, not a
  // filter on it: a spelling that names neither is a wrong address.
  const inPath = projectInPath(c);
  if (inPath && !scopeProject) return c.notFound();
  if (c.req.param('slug') !== undefined && !scopeTeam) return c.notFound();
  // A person filter names a membership, so it needs a workspace to name one in.
  // Without a workspace in the address there is nothing to check it against, and
  // a filter that cannot be honoured must not quietly draw every thread in every
  // workspace under one person's name. The same `notFound` for a member of some
  // other workspace as for an account that does not exist, which is the rule
  // `/app/teams/:slug/people/:username` already keeps: `memberByUsername` is the
  // one lookup, so the two pages cannot start answering differently.
  const person =
    requestedPerson && scopeTeam ? await memberByUsername(db, scopeTeam.id, requestedPerson) : undefined;
  if (requestedPerson && !person) return c.notFound();
  const personHome = person && scopeTeam
    ? `/app/teams/${scopeTeam.slug}/people/${encodeURIComponent(person.username)}`
    : undefined;
  /** This page's own address, so its tabs, its search and its pager stay in scope. */
  const here = inPath ? sectionHref(scopeTeam!.slug, scopeProject!.slug, 'sessions') : '/app/sessions';
  // Only the filter form needs to carry the scope; the path form already does.
  // The person is never in the path, so it rides along in both spellings.
  const scopeQuery = inPath ? {} : { team: scopeTeam?.slug, project: scopeProject?.slug };
  const carried = { ...scopeQuery, person: person?.username };
  const scoped = (extra: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...carried, ...extra })) if (value) params.set(key, value);
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  const filters = { ...carried, status: status === 'resolved' ? 'resolved' : undefined, q: q || undefined };
  let sessions: { s: typeof debugSessions.$inferSelect; projectName: string | null }[] = [];
  let paged = slicePage<(typeof sessions)[number]>([], win);
  let openCount = 0;
  let resolvedCount = 0;
  const scope: SessionScope = {
    teamIds,
    teamId: scopeTeam?.id,
    projectId: scopeProject?.id,
    personId: person?.id,
  };
  if (teamIds.length > 0) {
    paged = slicePage(await readSessions(db, scope, { status, q }, win), win);
    sessions = paged.items;
    // The tabs count what the list under them shows, person filter included:
    // one number meaning two things is how a page starts arguing with itself.
    const countRows = await db
      .select({ status: debugSessions.status, n: count() })
      .from(debugSessions)
      .where(sessionsInScope(scope))
      .groupBy(debugSessions.status);
    openCount = countRows.find((r) => r.status === 'open')?.n ?? 0;
    resolvedCount = countRows.find((r) => r.status === 'resolved')?.n ?? 0;
  }
  const ids = sessions.map((r) => r.s.id);
  // A browser is an origin with no token, so a message your own agent wrote on
  // another machine counts as unread here — you have genuinely not read it.
  const { stats, unread } = await sessionStats(db, { userId: user.id }, ids);
  const participantRows = ids.length
    ? await db
        .selectDistinct({ sessionId: messages.sessionId, username: users.username })
        .from(messages)
        .innerJoin(users, eq(messages.authorId, users.id))
        .where(inArray(messages.sessionId, ids))
    : [];
  const participants = new Map<string, string[]>();
  for (const p of participantRows) {
    const list = participants.get(p.sessionId) ?? [];
    if (list.length < 3) list.push(p.username);
    participants.set(p.sessionId, list);
  }

  return c.html(
    <AppLayout user={user} active="sessions" title="Sessions">
      {error ? (
        <div class="banner banner-error">
          <span class="ic">!</span>
          <span>{error}</span>
          <button class="x" type="button" data-dismiss="t">
            ×
          </button>
        </div>
      ) : null}
      {/* Narrowed to a person, the way back is their page: that is where the
          link came from, and the workspace trail alone would strand a reader on
          a list with somebody's name on it and no step to them. */}
      <Trail
        steps={
          person && scopeTeam
            ? teamTrail(
                scopeTeam,
                { label: 'People and agents', href: `/app/teams/${scopeTeam.slug}/agents` },
                { label: person.username, href: personHome },
                { label: 'Sessions' },
              )
            : scopedTrail({ team: scopeTeam, project: scopeProject }, 'Sessions')
        }
      />
      <div class="page-head">
        <div>
          <h1 class="title">{person ? `Debug sessions — ${person.username}` : 'Debug sessions'}</h1>
          <p class="sub">
            {person ? (
              <>
                Threads <b>{person.username}</b> opened or wrote in
                {scopeProject ? <> in {scopeProject.name}</> : null} — including what their agents
                posted under their account. Assignments and handoffs are work rather than
                conversation and are listed separately.
              </>
            ) : (
              'Topic-based threads where agents (and humans) debug together, asynchronously.'
            )}
          </p>
        </div>
        {mine.length > 0 ? (
          <button class="btn btn-primary" type="button" data-open-dialog="#new-session">
            New session
          </button>
        ) : null}
      </div>
      <p class="row">
        <a class="btn" href={scopeTeam ? sectionHref(scopeTeam.slug, scopeProject?.slug, 'work') : '/app/handoffs'}>
          Work — assignments and handoffs
        </a>
        {/* A filter with no way out is a trap: the tabs and the pager all keep
            the person, so this is the only link on the page that drops it. */}
        {person ? (
          <a class="btn" href={`${here}${scoped({ person: undefined, status: status === 'resolved' ? 'resolved' : undefined })}`}>
            Every thread here
          </a>
        ) : null}
      </p>

      {/* Page 1 only — a reader on page 3 should not have the window slide under them. */}
      {win.page === 1 ? <div data-autorefresh="30" style="display:none"></div> : null}
      {mine.length === 0 ? (
        <div class="card">
          <div class="empty">
            <h2>Join a team first</h2>
            <p>
              Debug sessions live inside a team. <a href="/app">Create or join a team</a>, then come
              back here.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div class="tabs">
            <a class={`tab${status === 'open' ? ' active' : ''}`} href={`${here}${scoped({})}`}>
              Open ({openCount})
            </a>
            <a
              class={`tab${status === 'resolved' ? ' active' : ''}`}
              href={`${here}${scoped({ status: 'resolved' })}`}
            >
              Resolved ({resolvedCount})
            </a>
          </div>

          {status === 'resolved' ? (
            <form class="inline m0" method="get" action={here}>
              <input type="hidden" name="status" value="resolved" />
              {scopeTeam && !inPath ? <input type="hidden" name="team" value={scopeTeam.slug} /> : null}
              {scopeProject && !inPath ? <input type="hidden" name="project" value={scopeProject.slug} /> : null}
              {/* A search inside one person's threads stays inside them; a GET
                  form writes the whole query string, so what it leaves out is
                  dropped. */}
              {person ? <input type="hidden" name="person" value={person.username} /> : null}
              <input
                class="in"
                style="width:320px"
                type="text"
                name="q"
                placeholder="Search titles, root causes, fixes…"
                value={q}
              />
              <button class="btn" type="submit">
                Search
              </button>
            </form>
          ) : null}

          {sessions.length === 0 && win.page === 1 ? (
            <div class="card">
              <div class="empty">
                <h2>
                  {person
                    ? status === 'open'
                      ? `Nothing of ${person.username}'s is open here`
                      : q
                        ? 'No archived match'
                        : `Nothing of ${person.username}'s is resolved here`
                    : status === 'open'
                      ? 'No open sessions'
                      : q
                        ? 'No archived match'
                        : 'Nothing resolved yet'}
                </h2>
                <p>
                  {person
                    ? // Pointing them at "open a session" would be advice for
                      // somebody else's page; what is missing here is rows, and
                      // the two places the rest of their work is are named.
                      'A thread counts here once they open it or write in it. Work assigned to or by them is on Work, and everything they did is on their own page.'
                    : status === 'open'
                      ? 'When something "works on my machine", open a session here — or let your agent do it with the open_session tool.'
                      : 'Resolved sessions keep their root cause and fix, searchable for the next time.'}
                </p>
              </div>
            </div>
          ) : (
            <div class="sesslist">
              {sessions.map(({ s, projectName }) => {
                const st = stats.get(s.id);
                const un = unread.get(s.id) ?? 0;
                const res = (s.resolution as SessionResolution | null) ?? null;
                const names = participants.get(s.id) ?? [];
                return (
                  <a
                    class={`sesscard${un > 0 ? ' unread' : ''}${s.status === 'resolved' ? ' resolved' : ''}`}
                    href={`/app/sessions/${s.id}`}
                  >
                    <div class="sesscard-head">
                      <span class="sesscard-title">{s.title}</span>
                      {s.status === 'open' ? (
                        <span class="pill pill-open">
                          <span class="dot" />
                          open
                        </span>
                      ) : (
                        <span class="pill pill-muted">resolved</span>
                      )}
                    </div>
                    {s.status === 'resolved' && res?.rootCause ? (
                      <p class="sesscard-root">
                        <b>Root cause:</b> {res.rootCause.slice(0, 180)}
                        {res.rootCause.length > 180 ? '…' : ''}
                      </p>
                    ) : null}
                    <div class="sesscard-meta">
                      <div class="sesscard-info">
                        {names.length > 0 ? (
                          <span class="avstack">
                            {names.map((n) => (
                              <span class="avatar light">{initials(n)}</span>
                            ))}
                          </span>
                        ) : null}
                        <span>{slugById.get(s.teamId)}</span>
                        {projectName ? <span>· {projectName}</span> : null}
                        <span>
                          {st?.n ?? 0} {(st?.n ?? 0) === 1 ? 'message' : 'messages'}
                          {st?.last ? ` · ${timeAgo(st.last)}` : ''}
                        </span>
                      </div>
                      {un > 0 ? (
                        <span class="unreadmark">
                          <span class="dot" />
                          {un} unread
                        </span>
                      ) : null}
                    </div>
                  </a>
                );
              })}
              {sessions.length === 0 ? (
                <div class="card card-pad muted small">
                  Nothing this far back — the list ends before this page.
                </div>
              ) : null}
              <div class="card">
                <Pager
                  path={here}
                  query={filters}
                  window={win}
                  page={paged}
                  noun="sessions"
                />
              </div>
            </div>
          )}

          <dialog
            id="new-session"
            class="formdlg"
            data-auto-open={c.req.query('new') === '1' ? 't' : undefined}
          >
            <h3>New debug session</h3>
            <p class="dlgsub">
              Describe the problem — teammates' agents will see it in their inbox.
            </p>
            <form method="post" action="/app/sessions">
              {mine.length > 1 ? (
                <div class="field">
                  <label>Team</label>
                  <select class="in" name="team" data-session-team>
                    {mine.map((m) => (
                      <option value={m.team.slug} selected={m.team.slug === requestedTeam}>
                        {m.team.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <input type="hidden" name="team" value={mine[0]!.team.slug} />
              )}
              <div class="field">
                <label>Title</label>
                <input
                  class="in"
                  type="text"
                  name="title"
                  placeholder='e.g. "migrations fail locally"'
                  required
                  maxlength={200}
                />
              </div>
              <div class="field">
                <label>Project (optional)</label>
                <select class="in" name="project" data-session-project>
                  <option value="">Team-wide / not project-specific</option>
                  {availableProjects.map((project) => (
                    <option
                      value={project.id}
                      data-team={slugById.get(project.teamId)}
                      // The project page links here with an id; the rail with a slug.
                      selected={project.id === scopeProject?.id || project.id === requestedProject}
                    >
                      {slugById.get(project.teamId)} / {project.name}
                    </option>
                  ))}
                </select>
                <span class="help">
                  Choose an existing project. Creating one from a typo would split its sessions,
                  activity and conflict history.
                </span>
              </div>
              <div class="field">
                <label>First message</label>
                <textarea
                  class="in"
                  name="body"
                  placeholder="Error output, repro steps, what you already ruled out… (no secret values)"
                  maxlength={20000}
                ></textarea>
              </div>
              <div class="dialog-actions">
                <button class="btn" type="button" data-close-dialog="t">
                  Cancel
                </button>
                <button class="btn btn-primary" type="submit">
                  Open session
                </button>
              </div>
            </form>
          </dialog>
        </>
      )}
    </AppLayout>,
  );
};

sessionsRoutes.get('/app/sessions', sessionsPage);
sessionsRoutes.get('/app/teams/:slug/projects/:project/sessions', sessionsPage);

sessionsRoutes.post('/app/sessions', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const body = await c.req.parseBody();
  const teamSlug = typeof body.team === 'string' ? body.team : '';
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
  const first = typeof body.body === 'string' ? body.body.trim().slice(0, 20_000) : '';
  if (!title) {
    return c.redirect(`/app/sessions?error=${encodeURIComponent('A session needs a title.')}`);
  }
  const mine = await myTeams(db, user.id);
  const target =
    mine.find((m) => m.team.slug === teamSlug) ?? (mine.length === 1 ? mine[0] : undefined);
  if (!target) {
    return c.redirect(
      `/app/sessions?error=${encodeURIComponent('Pick a team you are a member of.')}`,
    );
  }
  const requestedProject = typeof body.project === 'string' ? body.project.trim() : '';
  let projectId: string | null = null;
  if (requestedProject) {
    const selected = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, requestedProject), eq(projects.teamId, target.team.id)))
      .limit(1);
    if (!selected[0]) {
      return c.redirect(
        `/app/sessions?error=${encodeURIComponent('Pick an existing project from the selected team.')}`,
      );
    }
    projectId = selected[0].id;
  }
  const inserted = await db
    .insert(debugSessions)
    .values({ teamId: target.team.id, projectId, title, openedBy: user.id })
    .returning();
  const session = inserted[0]!;
  void track(db, {
    teamId: target.team.id,
    projectId,
    userId: user.id,
    action: 'open_session',
    detail: title,
  });
  if (first) {
    await db.insert(messages).values({
      sessionId: session.id,
      authorId: user.id,
      kind: 'question',
      body: redactSecrets(first),
    });
  }
  await markRead(db, user.id, session.id);
  notifyTeam(
    c.get('env'),
    target.team,
    `New debug session in ${target.team.slug}: "${title}" — opened by ${user.username}`,
  );
  return c.redirect(`/app/sessions/${session.id}`);
});

// ---------------------------------------------------------------- thread

sessionsRoutes.get('/app/sessions/:id', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await sessionForMember(db, c.req.param('id'), user.id);
  if (!found) {
    return c.html(
      <AppLayout user={user} active="sessions" title="Not found">
        <div class="card card-pad joincard">
          <span class="tile tile-44 tile-gray">×</span>
          <h2 class="title m0">Session not found</h2>
          <p class="m0 sub">Either it does not exist or you are not in its team.</p>
          <a class="btn" href="/app/sessions" style="align-self:flex-start">
            Back to sessions
          </a>
        </div>
      </AppLayout>,
      404,
    );
  }
  const { session, team } = found;
  const [offer] = await db.select().from(handoffs).where(eq(handoffs.sessionId, session.id));
  // Work dispatched from a project page is read from here; without the way back
  // a lead assigning four tasks walked rail → projects → project each time.
  const [home] = session.projectId
    ? await db
        .select({ name: projects.name, slug: projects.slug })
        .from(projects)
        .where(eq(projects.id, session.projectId))
        .limit(1)
    : [];
  const homeUrl = home ? `/app/teams/${team.slug}/projects/${encodeURIComponent(home.slug)}` : undefined;
  await ensureRail(db, user, team.slug, home?.slug ?? null);
  const work = offer?.kind === 'assignment' ? 'assignment' : 'handoff';
  const ended = offer && ['cancelled', 'declined'].includes(offer.state) ? offer.state : undefined;
  const [assignedTo] = offer?.targetInstallationId
    ? await db
        .select({ name: agentInstallations.name, device: agentInstallations.deviceLabel })
        .from(agentInstallations)
        .where(eq(agentInstallations.id, offer.targetInstallationId))
        .limit(1)
    : [];
  const receiverId = offer?.acceptedBy ?? offer?.targetUserId;
  const [receiver] = receiverId
    ? await db
        .select({ username: users.username })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.teamId, team.id), eq(memberships.userId, receiverId)))
    : [];
  const [installation] = offer?.installationId
    ? await db
        .select({
          revokedAt: agentInstallations.revokedAt,
          tokenRevokedAt: tokens.revokedAt,
          tokenId: tokens.id,
        })
        .from(agentInstallations)
        .leftJoin(tokens, eq(tokens.id, agentInstallations.tokenId))
        .where(eq(agentInstallations.id, offer.installationId))
    : [];
  const unavailable = Boolean(
    (receiverId && !receiver) ||
    (offer?.acceptedAt &&
      (!installation ||
        installation.revokedAt ||
        installation.tokenRevokedAt ||
        !installation.tokenId)),
  );
  // Paged from the *newest* end: a thread past one page used to render its oldest
  // 500 messages and silently drop everything after them — the resolution included.
  const win = pageWindow(c.req.query('page'), THREAD_PAGE_SIZE);
  const fetched = await db
    .select({ m: messages, author: users.username })
    .from(messages)
    .leftJoin(users, eq(messages.authorId, users.id))
    .where(eq(messages.sessionId, session.id))
    .orderBy(desc(messages.createdAt))
    .limit(win.limit)
    .offset(win.offset);
  const page = slicePage(fetched, win);
  const msgs = [...page.items].reverse(); // oldest-first inside the page
  const opener = session.openedBy
    ? (
        await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, session.openedBy))
          .limit(1)
      )[0]?.username
    : undefined;
  await markRead(db, user.id, session.id);
  const resolution = (session.resolution as SessionResolution | null) ?? null;

  return c.html(
    <AppLayout
      user={user}
      // Dispatched work belongs to its project; a plain thread belongs to Sessions.
      active={offer && home ? 'projects' : 'sessions'}
      title={session.title}
      band={
        ended && c.req.query('handoff') === ended ? (
          <Band
            kind="info"
            tag={ended}
            actions={
              homeUrl ? (
                <a class="btn btn-sm" href={`${homeUrl}#assigned-work`}>
                  Back to {home!.name}
                </a>
              ) : undefined
            }
          >
            This {work} is {ended}: nobody will be told about it and nobody can accept it any more.
            The brief stays readable, and the thread below stays open for messages.
          </Band>
        ) : undefined
      }
      inspector={
        offer ? (
          <Inspector>
            <HandoffFlow
              offer={offer}
              sessionId={session.id}
              userId={user.id}
              owner={
                assignedTo
                  ? `${assignedTo.name} (${receiver?.username ?? 'unknown owner'})`
                  : (receiver?.username ?? 'Any eligible recipient')
              }
              unavailable={unavailable}
              assignedTo={assignedTo}
            />
          </Inspector>
        ) : undefined
      }
    >
      <div class="crumb">
        {homeUrl ? (
          <>
            <a href={offer ? `${homeUrl}#assigned-work` : homeUrl}>← {home!.name}</a>
            {' · '}
          </>
        ) : null}
        <a href="/app/sessions">Sessions</a> / {team.slug}
      </div>
      <div class="card">
        <div class="card-head" style="align-items:flex-start">
          <div>
            <div class="card-title" style="font-size:17px">
              {session.title}
            </div>
            <div class="card-note mono">
              {team.slug} · opened by {opener ?? 'unknown'} · {fmtDate(session.createdAt)}
              {offer ? ` · ${work} ${offer.state === 'completed' ? 'completed — reported' : offer.state.replace('_', ' ')}` : ''}
            </div>
          </div>
          {session.kind === 'announcements' ? (
            <span class="pill pill-open">
              <span class="dot" />
              channel
            </span>
          ) : session.status === 'open' ? (
            <button class="btn btn-sm" type="button" data-open-dialog="#resolve-dialog">
              Mark resolved
            </button>
          ) : (
            <span class="pill pill-muted">resolved</span>
          )}
        </div>

        {page.hasMore || win.page > 1 ? (
          <Pager
            path={`/app/sessions/${session.id}`}
            window={win}
            page={page}
            noun="messages"
            note="Newest first by page; oldest first inside a page."
          />
        ) : null}

        <div class="thread">
          {msgs.length === 0 ? <p class="muted small m0">No messages yet.</p> : null}
          {msgs.map((r) => (
            <div class="msg">
              <span class={`avatar ${r.m.authorId === user.id ? 'ink' : 'light'}`}>
                {initials(r.author ?? 'ci')}
              </span>
              <div class="msg-main">
                <div class="msg-head">
                  <span class="msg-author">
                    {r.m.via ? `${r.m.via} · ` : ''}
                    {r.author ?? 'automation'}
                  </span>
                  <span class={`kindtag kind-${r.m.kind}`}>{r.m.kind}</span>
                  <span class="msg-time">{timeAgo(r.m.createdAt)}</span>
                </div>
                <p class="msg-text">{r.m.body}</p>
                {((r.m.attachments as { name: string; content: string }[] | null) ?? []).map(
                  (a) => (
                    <div class="attach">
                      <div class="attach-head">
                        <span>{a.name}</span>
                      </div>
                      <pre>{a.content}</pre>
                    </div>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>

        {session.status === 'resolved' && resolution ? (
          <div class="resolution-note">
            <span class="t">
              Resolved{resolution.resolvedBy ? ` by ${resolution.resolvedBy}` : ''}
            </span>
            <p>
              <b>Root cause:</b> {resolution.rootCause}
            </p>
            <p>
              <b>Fix:</b> {resolution.fix}
            </p>
          </div>
        ) : null}

        <div class="composer">
          <form
            method="post"
            action={`/app/sessions/${session.id}/messages`}
            style="display:flex;flex-direction:column;gap:12px"
          >
            <textarea
              class="in"
              name="body"
              placeholder="Write a message, or let your agent post over MCP… (no secret values)"
              required
              maxlength={20000}
            ></textarea>
            <div class="page-head" style="align-items:center">
              <select class="in" name="kind">
                {THREAD_MESSAGE_KINDS.map((k) => (
                  <option value={k} selected={k === 'question'}>
                    {k}
                  </option>
                ))}
              </select>
              <button class="btn btn-primary" type="submit">
                Send
              </button>
            </div>
          </form>
        </div>
      </div>

      <dialog id="resolve-dialog" class="formdlg">
        <h3>Mark session resolved</h3>
        <p class="dlgsub">
          Both fields go into the searchable archive, so the next agent hitting this can find it.
        </p>
        <form method="post" action={`/app/sessions/${session.id}/resolve`}>
          <div class="field">
            <label>Root cause</label>
            <textarea
              class="in"
              name="root_cause"
              required
              maxlength={4000}
              placeholder="What was actually wrong?"
            ></textarea>
          </div>
          <div class="field">
            <label>Fix</label>
            <textarea
              class="in"
              name="fix"
              required
              maxlength={4000}
              placeholder="What did you change? (PR link welcome)"
            ></textarea>
          </div>
          <div class="dialog-actions">
            <button class="btn" type="button" data-close-dialog="t">
              Cancel
            </button>
            <button class="btn btn-primary" type="submit">
              Resolve session
            </button>
          </div>
        </form>
      </dialog>
    </AppLayout>,
  );
});

/**
 * The work ledger, at three addresses, the same three the sessions list answers.
 * `/app/teams/:slug/projects/:project/work` is the rail's; `?team=`/`?project=`
 * still answer.
 */
const workPage = async (c: Context<AppEnv>) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const mine = await myTeams(db, user.id);
  const ids = mine.map((m) => m.team.id);
  const workTeam = mine.find((m) => m.team.slug === scopedTeamParam(c))?.team;
  const workProject = workTeam && user.rail?.team === workTeam.slug ? (user.rail.project ?? undefined) : undefined;
  // In the path the scope is the page's identity rather than a filter on it.
  if (projectInPath(c) && !workProject) return c.notFound();
  if (c.req.param('slug') !== undefined && !workTeam) return c.notFound();
  const sessionsHref = workTeam
    ? sectionHref(workTeam.slug, workProject?.slug, 'sessions')
    : '/app/sessions';
  const rows = ids.length
    ? await db
        .select({
          offer: handoffs,
          session: debugSessions,
          project: projects.name,
          agent: agentInstallations.name,
        })
        .from(handoffs)
        .innerJoin(debugSessions, eq(handoffs.sessionId, debugSessions.id))
        .leftJoin(projects, eq(projects.id, debugSessions.projectId))
        .leftJoin(agentInstallations, eq(agentInstallations.id, handoffs.targetInstallationId))
        .where(
          and(
            workTeam ? eq(debugSessions.teamId, workTeam.id) : inArray(debugSessions.teamId, ids),
            workProject ? eq(debugSessions.projectId, workProject.id) : undefined,
          ),
        )
        .orderBy(desc(handoffs.updatedAt))
        .limit(50)
    : [];
  return c.html(
    <AppLayout
      user={user}
      active="work"
      title="Work"
      bleed
      head={
        <PageHead
          title="Work"
          trail={scopedTrail({ team: workTeam, project: workProject }, 'Work')}
          sub="Assignments and handoffs: work given to an agent or waiting to be picked up, separate from unread messages. The code travels through git; STMA carries the brief and scope."
          actions={
            <>
              {workTeam && workProject ? (
                <a class="btn btn-primary" href={`/app/teams/${workTeam.slug}/projects/${encodeURIComponent(workProject.slug)}#assigned-work`}>
                  Assign work
                </a>
              ) : null}
              <a class="btn" href={sessionsHref}>
                Sessions
              </a>
            </>
          }
        />
      }
      keysNote="Latest 50 handoffs · completion is an agent report"
    >
      <FlowSection title="Handoff ledger">
        {rows.length ? (
          <div class="scroll-x">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Task · workspace</th>
                  <th>Project</th>
                  <th>Stage</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ offer, session, project, agent }) => (
                  <tr>
                    <td>
                      <a href={`/app/sessions/${session.id}`}>{session.title}</a>
                      <div class="small">
                        {mine.find((m) => m.team.id === session.teamId)?.team.name}
                        {offer.kind === 'assignment'
                          ? ` · assigned to ${agent ?? 'a revoked agent'}`
                          : ''}
                      </div>
                    </td>
                    <td>{project ?? 'Workspace'}</td>
                    <td>{offer.state === 'completed' ? 'Completed — reported' : offer.state}</td>
                    <td>
                      {['completed', 'cancelled', 'declined'].includes(offer.state)
                        ? 'Sender / reviewer'
                        : offer.acceptedBy === user.id || offer.targetUserId === user.id
                          ? 'You / your agent'
                          : offer.state === 'offered'
                            ? 'Eligible recipient'
                            : 'Accepting agent'}{' '}
                      · <a href={`/app/sessions/${session.id}`}>Inspect</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <FlowEmpty title="No tracked handoffs yet">
            <p>
              Work appears here when a lead assigns a task to a named agent (Assign work on a
              project page, or <code>assign_work</code>) or an agent hands its work over with{' '}
              <code>handoff_work</code>. Reading or replying to a message does not accept it.
            </p>
            <a class="btn btn-sm" href="/app/tokens">Connect an agent</a>
          </FlowEmpty>
        )}
      </FlowSection>
    </AppLayout>,
  );
};

sessionsRoutes.get('/app/handoffs', workPage);
sessionsRoutes.get('/app/teams/:slug/projects/:project/work', workPage);

sessionsRoutes.post('/app/sessions/:id/handoff/:action', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const action = c.req.param('action');
  if (
    !z.string().uuid().safeParse(c.req.param('id')).success ||
    (action !== 'cancel' && action !== 'decline')
  )
    return c.notFound();
  const result = await transitionHandoff(
    c.get('db'),
    c.req.param('id'),
    user.id,
    undefined,
    action,
  );
  if ('error' in result) return c.text(result.error!, 409);
  // Answer on the page the button was pressed on, and say what happened: a
  // reload that looks the same as before reads as "it did not work".
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  if (form.return_to === 'project' && action === 'cancel') {
    const [home] = await c
      .get('db')
      .select({ team: teams.slug, project: projects.slug })
      .from(debugSessions)
      .innerJoin(teams, eq(teams.id, debugSessions.teamId))
      .innerJoin(projects, eq(projects.id, debugSessions.projectId))
      .where(eq(debugSessions.id, c.req.param('id')))
      .limit(1);
    if (home) {
      return c.redirect(
        `/app/teams/${home.team}/projects/${encodeURIComponent(home.project)}?cancelled=${c.req.param('id')}#assigned-work`,
        303,
      );
    }
  }
  return c.redirect(`/app/sessions/${c.req.param('id')}?handoff=${action === 'cancel' ? 'cancelled' : 'declined'}`, 303);
});

sessionsRoutes.post('/app/sessions/:id/messages', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await sessionForMember(db, c.req.param('id'), user.id);
  if (!found) return c.notFound();
  const body = await c.req.parseBody();
  const content = typeof body.body === 'string' ? body.body.trim().slice(0, 20_000) : '';
  // A browser reply is conversation. `handoff` and `announcement` are what the
  // product writes through its own flows, and a posted one used to turn any open
  // thread into work waiting in every teammate's inbox.
  const kind = isThreadMessageKind(body.kind) ? body.kind : 'note';
  if (content) {
    const posted = await db
      .insert(messages)
      .values({
        sessionId: found.session.id,
        authorId: user.id,
        kind,
        via: 'web',
        body: redactSecrets(content),
      })
      .returning({ at: messages.createdAt });
    await markRead(db, user.id, found.session.id);
    await notifySessionActivity(db, c.get('env'), {
      sessionId: found.session.id,
      teamId: found.team.id,
      actorId: user.id,
      kind: 'session_reply',
      at: posted[0]!.at,
    });
    notifyTeam(
      c.get('env'),
      found.team,
      `New ${kind} from ${user.username} in "${found.session.title}" (${found.team.slug})`,
    );
    void track(db, {
      teamId: found.team.id,
      projectId: found.session.projectId,
      userId: user.id,
      action: 'post_message',
      detail: `${kind} in "${found.session.title}"`,
    });
  }
  return c.redirect(`/app/sessions/${found.session.id}`);
});

sessionsRoutes.post('/app/sessions/:id/resolve', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await sessionForMember(db, c.req.param('id'), user.id);
  if (!found) return c.notFound();
  const body = await c.req.parseBody();
  const rootCause =
    typeof body.root_cause === 'string' ? body.root_cause.trim().slice(0, 4000) : '';
  const fix = typeof body.fix === 'string' ? body.fix.trim().slice(0, 4000) : '';
  if (
    !rootCause ||
    !fix ||
    found.session.status === 'resolved' ||
    found.session.kind === 'announcements'
  ) {
    return c.redirect(`/app/sessions/${found.session.id}`);
  }
  const resolution: SessionResolution = {
    rootCause: redactSecrets(rootCause),
    fix: redactSecrets(fix),
    resolvedBy: user.username,
    resolvedAt: new Date().toISOString(),
  };
  await db
    .update(debugSessions)
    .set({ status: 'resolved', resolution, resolvedAt: new Date() })
    .where(eq(debugSessions.id, found.session.id));
  const posted = await db
    .insert(messages)
    .values({
      sessionId: found.session.id,
      authorId: user.id,
      kind: 'resolution',
      via: 'web',
      body: `Root cause: ${resolution.rootCause}\n\nFix: ${resolution.fix}`,
    })
    .returning({ at: messages.createdAt });
  await markRead(db, user.id, found.session.id);
  await notifySessionActivity(db, c.get('env'), {
    sessionId: found.session.id,
    teamId: found.team.id,
    actorId: user.id,
    kind: 'session_resolved',
    at: posted[0]!.at,
  });
  notifyTeam(
    c.get('env'),
    found.team,
    `Resolved in ${found.team.slug}: "${found.session.title}" — by ${user.username}`,
  );
  void track(db, {
    teamId: found.team.id,
    projectId: found.session.projectId,
    userId: user.id,
    action: 'resolve_session',
    detail: found.session.title,
  });
  return c.redirect(`/app/sessions/${found.session.id}`);
});
