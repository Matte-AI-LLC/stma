import { MESSAGE_KINDS } from '@bridge/shared';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db';
import { debugSessions, memberships, messages, projects, teams, users } from '../db/schema';
import { loginRedirect } from '../auth/session';
import { fmtDate, initials, timeAgo } from '../lib/format';
import { notifyTeam } from '../lib/notify';
import { notifySessionActivity } from '../lib/notifications';
import { pageHref, pageWindow, slicePage } from '../lib/pagination';
import { findOrCreateProject } from '../lib/projects';
import { redactSecrets } from '../lib/redact';
import { track } from '../lib/track';
import {
  markRead,
  sessionForMember,
  sessionStats,
  type SessionResolution,
} from '../lib/sessions';
import type { AppEnv } from '../types';
import { AppLayout } from '../ui/Layout';
import { Pager } from '../ui/Pager';

export const sessionsRoutes = new Hono<AppEnv>();

/** Sessions per page in the list, and messages per page inside a thread. */
const LIST_PAGE_SIZE = 25;
const THREAD_PAGE_SIZE = 100;

async function myTeams(db: Db, userId: string) {
  return db
    .select({ team: teams })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(eq(memberships.userId, userId))
    .orderBy(teams.name);
}

const isKind = (k: unknown): k is (typeof MESSAGE_KINDS)[number] =>
  typeof k === 'string' && (MESSAGE_KINDS as readonly string[]).includes(k);

// ---------------------------------------------------------------- list

sessionsRoutes.get('/app/sessions', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const status = c.req.query('status') === 'resolved' ? 'resolved' : 'open';
  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  const error = c.req.query('error');

  const mine = await myTeams(db, user.id);
  const teamIds = mine.map((m) => m.team.id);
  const slugById = new Map(mine.map((m) => [m.team.id, m.team.slug]));

  const win = pageWindow(c.req.query('page'), LIST_PAGE_SIZE);
  const filters = { status: status === 'resolved' ? 'resolved' : undefined, q: q || undefined };
  let sessions: { s: typeof debugSessions.$inferSelect; projectName: string | null }[] = [];
  let paged = slicePage<(typeof sessions)[number]>([], win);
  let openCount = 0;
  let resolvedCount = 0;
  if (teamIds.length > 0) {
    const conds = [inArray(debugSessions.teamId, teamIds), eq(debugSessions.status, status)];
    if (status === 'resolved' && q) {
      const like = `%${q}%`;
      conds.push(
        or(ilike(debugSessions.title, like), sql`${debugSessions.resolution}::text ilike ${like}`)!,
      );
    }
    const fetched = await db
      .select({ s: debugSessions, projectName: projects.name })
      .from(debugSessions)
      .leftJoin(projects, eq(debugSessions.projectId, projects.id))
      .where(and(...conds))
      .orderBy(desc(debugSessions.createdAt))
      .limit(win.limit)
      .offset(win.offset);
    paged = slicePage(fetched, win);
    sessions = paged.items;
    const countRows = await db
      .select({ status: debugSessions.status, n: count() })
      .from(debugSessions)
      .where(inArray(debugSessions.teamId, teamIds))
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
      <div class="page-head">
        <div>
          <h1 class="title">Debug sessions</h1>
          <p class="sub">
            Topic-based threads where agents (and humans) debug together, asynchronously.
          </p>
        </div>
        {mine.length > 0 ? (
          <button class="btn btn-primary" type="button" data-open-dialog="#new-session">
            New session
          </button>
        ) : null}
      </div>

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
            <a class={`tab${status === 'open' ? ' active' : ''}`} href="/app/sessions">
              Open ({openCount})
            </a>
            <a
              class={`tab${status === 'resolved' ? ' active' : ''}`}
              href="/app/sessions?status=resolved"
            >
              Resolved ({resolvedCount})
            </a>
          </div>

          {status === 'resolved' ? (
            <form class="inline m0" method="get" action="/app/sessions">
              <input type="hidden" name="status" value="resolved" />
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
                <h2>{status === 'open' ? 'No open sessions' : q ? 'No archived match' : 'Nothing resolved yet'}</h2>
                <p>
                  {status === 'open'
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
                  path="/app/sessions"
                  query={filters}
                  window={win}
                  page={paged}
                  noun="sessions"
                />
              </div>
            </div>
          )}

          <dialog id="new-session" class="formdlg">
            <h3>New debug session</h3>
            <p class="dlgsub">Describe the problem — teammates' agents will see it in their inbox.</p>
            <form method="post" action="/app/sessions">
              {mine.length > 1 ? (
                <div class="field">
                  <label>Team</label>
                  <select class="in" name="team">
                    {mine.map((m) => (
                      <option value={m.team.slug}>{m.team.name}</option>
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
                <label>Project / repo (optional)</label>
                <input class="in" type="text" name="repo" placeholder="e.g. billing-api" maxlength={120} />
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
});

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
  const target = mine.find((m) => m.team.slug === teamSlug) ?? (mine.length === 1 ? mine[0] : undefined);
  if (!target) {
    return c.redirect(`/app/sessions?error=${encodeURIComponent('Pick a team you are a member of.')}`);
  }
  const repoName = typeof body.repo === 'string' ? body.repo.trim().slice(0, 120) : '';
  let projectId: string | null = null;
  if (repoName) {
    const pr = await findOrCreateProject(db, target.team, repoName, user.id);
    if ('error' in pr) {
      return c.redirect(`/app/sessions?error=${encodeURIComponent(pr.error)}`);
    }
    projectId = pr.project.id;
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
    <AppLayout user={user} active="sessions" title={session.title}>
      <div class="crumb">
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
          <form method="post" action={`/app/sessions/${session.id}/messages`} style="display:flex;flex-direction:column;gap:12px">
            <textarea
              class="in"
              name="body"
              placeholder="Write a message, or let your agent post over MCP… (no secret values)"
              required
              maxlength={20000}
            ></textarea>
            <div class="page-head" style="align-items:center">
              <select class="in" name="kind">
                {MESSAGE_KINDS.filter((k) => k !== 'announcement').map((k) => (
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
            <textarea class="in" name="root_cause" required maxlength={4000} placeholder="What was actually wrong?"></textarea>
          </div>
          <div class="field">
            <label>Fix</label>
            <textarea class="in" name="fix" required maxlength={4000} placeholder="What did you change? (PR link welcome)"></textarea>
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

sessionsRoutes.post('/app/sessions/:id/messages', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await sessionForMember(db, c.req.param('id'), user.id);
  if (!found) return c.notFound();
  const body = await c.req.parseBody();
  const content = typeof body.body === 'string' ? body.body.trim().slice(0, 20_000) : '';
  const kind = isKind(body.kind) ? body.kind : 'note';
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
  const rootCause = typeof body.root_cause === 'string' ? body.root_cause.trim().slice(0, 4000) : '';
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
