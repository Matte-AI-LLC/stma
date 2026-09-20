import type { AgentClientType } from '@bridge/shared';
import { Hono, type Context } from 'hono';
import { loginRedirect } from '../auth/session';
import { agentEnrollments } from '../db/schema';
import { memberByUsername, projectForTeam, teamForUser } from '../domain/access';
import {
  connectCommandFor,
  issueConnectCommand,
  readConnectRequest,
} from '../domain/connectRequests';
import {
  agentRoster,
  rosterByPerson,
  runsForPerson,
  workForPerson,
  type RosterEntry,
} from '../domain/roster';
import { fmtDate, timeAgo } from '../lib/format';
import { pageWindow, slicePage } from '../lib/pagination';
import { ensureRail } from '../lib/rail';
import { personSessionsHref } from '../lib/scope';
import type { AppEnv } from '../types';
import { ConnectCheckoutForm, ConnectCommand } from '../ui/ConnectAgent';
import { PageHead, teamTrail } from '../ui/Console';
import { AppLayout } from '../ui/Layout';
import { Pager } from '../ui/Pager';
import { noActivityFilters, readActivity } from './activity';
import { readSessions } from './sessions';

/**
 * Agents, where a person looks for them.
 *
 * Three pages over one reader (`domain/roster.ts`). Inside a project: the agents
 * that can work there, what each is doing, and the way to connect another one
 * without leaving the project — "Connect agent" used to land in personal
 * settings with no way back (the owner, 2026-09-20). In the workspace: the same
 * rows grouped by person, because the question there is who did what with which
 * agent. And one person at a time, because a name in that list was a link to a
 * filtered log and nothing else. None of them writes anything except the connect
 * form, and none re-derives a fact another page owns: a run's detail is the agent
 * map's inspector, a thread is its own page, the log is Activity.
 */
export const rosterRoutes = new Hono<AppEnv>();

/** How a run ended, in a reader's words: `stale` is what the sweep calls a run that stopped reporting. */
const ENDED: Record<string, string> = { completed: 'finished', failed: 'failed', stale: 'stopped reporting' };
/** The thread title carries the kind as a prefix; beside an agent the kind is already plain. */
const workTitle = (title: string) => title.replace(/^(Assignment|Handoff):\s*/i, '');

const STATE: Record<string, string> = {
  offered: 'waiting for the agent',
  accepted: 'accepted',
  in_progress: 'in progress',
  needs_attention: 'needs attention',
  completed: 'completed — reported',
  cancelled: 'cancelled',
  declined: 'declined',
};

/** A person's page shows a slice of the trail and links to the page that owns it. */
const TRAIL_SHOWN = 20;
/** Same rule for their threads: a window, and a link to the list that owns it. */
const SESSIONS_SHOWN = 10;

const Row = ({
  entry,
  team,
  here,
  showOwner,
}: {
  entry: RosterEntry;
  team: string;
  /** The project this page is inside, when it is inside one. */
  here?: { id: string; slug: string };
  showOwner: boolean;
}) => {
  const { agent, live, last } = entry;
  const scoped = (run: string, project?: { slug: string } | null) =>
    `/app/agents?run=${run}&team=${encodeURIComponent(team)}${project ? `&project=${encodeURIComponent(project.slug)}` : ''}`;
  const elsewhere = Boolean(live && here && live.project?.id !== here.id);
  return (
    <tr>
      <td>
        <div class="name">{agent.name}</div>
        <div class="small muted">
          {showOwner ? (
            <>
              <a href={`/app/teams/${team}/people/${encodeURIComponent(agent.owner)}`}>{agent.owner}</a>
              {' · '}
            </>
          ) : (
            ''
          )}
          {agent.device ?? 'no device label'} · {agent.client}
          {agent.role ? ` · ${agent.role}` : ''}
        </div>
      </td>
      <td>
        {entry.reach === 'project' ? (
          <span class="pill pill-active" title="Its credential is bound to one project and can work nowhere else.">
            {here && entry.boundProject?.id === here.id ? 'this project' : (entry.boundProject?.name ?? 'one project')}
          </span>
        ) : (
          <span class="pill pill-muted" title="Its credential reaches every project of this workspace.">
            workspace-wide
          </span>
        )}
      </td>
      <td>
        {live ? (
          <>
            <a href={scoped(live.runId, live.project)}>{live.name ?? 'untitled run'}</a>
            <div class="small muted">
              {elsewhere ? `in ${live.project?.name ?? 'another project'} · ` : ''}
              {live.status}
              {live.branch ? ` · ${live.branch}` : ''}
              {live.holding > 0 ? ` · holding ${live.holding}` : ''} · {timeAgo(live.lastHeartbeatAt)}
            </div>
          </>
        ) : (
          <span class="muted">idle</span>
        )}
      </td>
      <td>
        {entry.work.length === 0 ? (
          <span class="muted">—</span>
        ) : (
          entry.work.slice(0, 3).map((work) => (
            <div>
              <a href={`/app/sessions/${work.sessionId}`}>{workTitle(work.title)}</a>{' '}
              <span class="small muted">{STATE[work.state] ?? work.state}</span>
            </div>
          ))
        )}
        {entry.work.length > 3 ? <div class="small muted">+{entry.work.length - 3} more</div> : null}
      </td>
      <td>
        {last ? (
          <>
            <span>{last.name ?? 'untitled run'}</span>
            <div class="small muted">
              {!here && last.project ? `${last.project.name} · ` : ''}
              {ENDED[last.status] ?? last.status} {timeAgo(last.endedAt ?? new Date())}
            </div>
          </>
        ) : (
          <span class="muted">nothing yet</span>
        )}
      </td>
      <td class="mono">{timeAgo(agent.lastSeenAt)}</td>
    </tr>
  );
};

const Head = ({ project }: { project: boolean }) => (
  <thead>
    <tr>
      <th>Agent</th>
      <th>Reach</th>
      <th>Now</th>
      <th>Work given to it</th>
      <th>{project ? 'Last finished here' : 'Last finished'}</th>
      <th>Last seen</th>
    </tr>
  </thead>
);

/** What a refused connect request hands back: the reason, and everything that was typed. */
interface RefusedConnect {
  error: string;
  typed: Record<string, unknown>;
}

/** The command a successful request produced, shown once, on the page it was asked for. */
interface IssuedConnect {
  enrollment: typeof agentEnrollments.$inferSelect;
  code: string;
}

rosterRoutes.get('/app/teams/:slug/projects/:project/agents', (c) => renderProjectAgents(c));

/**
 * A project's agents, drawn for a GET or handed back by the connect form.
 *
 * Connecting used to be a link to the account's Agent connections page. Phase 4
 * made that page come back correctly, but the person still left the project to
 * fill in a form and read a command. The form is here now, and so is its answer —
 * whether that answer is a one-time command or a refusal with the fields still
 * in it (`renderPolicyEditor` and `renderKnowledge` set that contract).
 */
async function renderProjectAgents(
  c: Context<AppEnv>,
  issued?: IssuedConnect,
  refused?: RefusedConnect,
) {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug') ?? '');
  if (!access) return c.notFound();
  const { team } = access;
  const project = await projectForTeam(db, team.id, decodeURIComponent(c.req.param('project') ?? ''));
  if (!project) return c.notFound();
  // A POST that answers with a page draws its own rail, in the scope it was posted for.
  if (issued || refused) await ensureRail(db, user, team.slug, project.slug);
  const entries = await agentRoster(db, team.id, { projectId: project.id });
  const working = entries.filter((entry) => entry.live && entry.live.project?.id === project.id).length;
  const inScope = `?team=${encodeURIComponent(team.slug)}&project=${encodeURIComponent(project.slug)}`;
  const home = `/app/teams/${team.slug}/projects/${encodeURIComponent(project.slug)}`;
  const connectAction = `${home}/agents/connect`;
  const form = (
    <ConnectCheckoutForm
      action={connectAction}
      here={{ team: { name: team.name }, project: { name: project.name } }}
      typed={
        refused
          ? {
              name: typeof refused.typed.name === 'string' ? refused.typed.name : undefined,
              device: typeof refused.typed.device === 'string' ? refused.typed.device : undefined,
              client: typeof refused.typed.client === 'string' ? refused.typed.client : undefined,
            }
          : undefined
      }
      idPrefix="pc"
    />
  );
  return c.html(
    <AppLayout
      user={user}
      active="agents"
      title={`Agents — ${project.name}`}
      bleed
      head={
        <PageHead
          trail={teamTrail(
            team,
            { label: 'Projects', href: `/app/teams/${team.slug}/projects` },
            { label: project.name, href: home },
            { label: 'Agents' },
          )}
          title="Agents"
          sub={`The agents that can work in ${project.name}: what each is doing now, the work given to it, and what it last finished here.`}
          actions={
            <>
              <a class="btn btn-sm" href={`/app/agents${inScope}`}>
                Live map
              </a>
              <a class="btn btn-sm" href={`${home}#assigned-work`}>
                Assign work
              </a>
              <a class="btn btn-sm" href={`/app/tokens${inScope}`}>
                All my connections
              </a>
              {/* The form is on this page now, so this is a jump rather than a
                  journey. The label stays what it was, because it is what
                  somebody is looking for. */}
              <a class="btn btn-sm btn-primary" href="#connect-agent">
                Connect agent here
              </a>
            </>
          }
        />
      }
      keysNote={`${entries.length} agent${entries.length === 1 ? '' : 's'} can work here · ${working} working now`}
    >
      {/* The answer to the form is at the top, where the page's own padding does
          not reach: this layout is `bleed`, so the cards carry their own margin. */}
      {refused ? (
        <div style="padding:16px 16px 0">
          <div class="banner banner-error">
            {refused.error} Nothing was created, and what you typed is still below.
          </div>
        </div>
      ) : null}
      {issued ? (
        <div style="padding:16px 16px 0">
          <ConnectCommand
            command={connectCommandFor(issued.code, c.get('env').baseUrl)}
            agent={issued.enrollment.name}
            device={issued.enrollment.deviceLabel}
            client={issued.enrollment.clientType as AgentClientType}
            scope="project"
            teamSlug={team.slug}
            projectName={project.name}
          />
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div class="empty">
          <h2>No agent can work here yet</h2>
          <p>
            Connect one from the checkout of this project: it takes one command in that folder's
            terminal, and the agent appears here as soon as its client confirms.
          </p>
        </div>
      ) : (
        <div class="card scroll-x" style="margin:16px">
          <table class="tbl">
            <Head project />
            <tbody>
              {entries.map((entry) => (
                <Row entry={entry} team={team.slug} here={project} showOwner />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div id="connect-agent" style="padding:0 16px 16px">
        {form}
      </div>
    </AppLayout>,
    // A refused write answers with the page that still holds the work, not 200:
    // the address did not change, and the submission did not succeed.
    refused ? 422 : 200,
  );
}

/**
 * Issue the command for this project, and answer on this page.
 *
 * The scope is the address, not the form: the page already proved membership of
 * this workspace and resolved this project, so nothing a browser posts can move
 * the grant somewhere else. Everything a form can get wrong is checked by the
 * same `readConnectRequest` that `POST /app/tokens` calls.
 */
rosterRoutes.post('/app/teams/:slug/projects/:project/agents/connect', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const project = await projectForTeam(db, access.team.id, decodeURIComponent(c.req.param('project')));
  if (!project) return c.notFound();
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const asked = readConnectRequest(body, { terminal: true });
  if ('error' in asked) return renderProjectAgents(c, undefined, { error: asked.error, typed: body });
  const issued = await issueConnectCommand(db, {
    userId: user.id,
    name: asked.name,
    device: asked.device,
    client: asked.client,
    role: asked.role,
    teamId: access.team.id,
    projectId: project.id,
  });
  return renderProjectAgents(c, issued);
});

rosterRoutes.get('/app/teams/:slug/agents', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const { team } = access;
  const entries = await agentRoster(db, team.id);
  const people = rosterByPerson(entries);
  const working = entries.filter((entry) => entry.live).length;
  return c.html(
    <AppLayout
      user={user}
      active="people"
      title={`People and agents — ${team.name}`}
      bleed
      head={
        <PageHead
          trail={teamTrail(team, { label: 'People and agents' })}
          title="People and agents"
          sub="Who has which agent, where it can work, what it is doing now and what it last finished. A person's name opens everything they and their agents did."
          actions={
            <>
              <a class="btn btn-sm" href={`/app/agents?team=${encodeURIComponent(team.slug)}`}>
                Agent map
              </a>
              <a class="btn btn-sm btn-primary" href={`/app/tokens?team=${encodeURIComponent(team.slug)}`}>
                Connect agent
              </a>
            </>
          }
        />
      }
      keysNote={`${people.length} ${people.length === 1 ? 'person' : 'people'} · ${entries.length} agents · ${working} working now`}
    >
      {people.length === 0 ? (
        <div class="empty">
          <h2>No agents in this workspace yet</h2>
          <p>
            An agent appears here once somebody connects one. Connecting takes one command in a
            checkout's terminal.
          </p>
          <p class="m0">
            <a class="btn btn-primary" href={`/app/tokens?team=${encodeURIComponent(team.slug)}`}>
              Connect agent
            </a>
          </p>
        </div>
      ) : (
        people.map((person) => (
          <div class="card scroll-x" style="margin:16px">
            <div class="card-head">
              <div>
                <div class="card-title">
                  <a href={`/app/teams/${team.slug}/people/${encodeURIComponent(person.owner)}`}>
                    {person.owner}
                  </a>
                </div>
                <div class="card-note">
                  {person.entries.length} agent{person.entries.length === 1 ? '' : 's'} ·{' '}
                  {person.entries.filter((entry) => entry.live).length} working now
                </div>
              </div>
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/people/${encodeURIComponent(person.owner)}`}>
                Everything {person.owner} did
              </a>
            </div>
            <table class="tbl">
              <Head project={false} />
              <tbody>
                {person.entries.map((entry) => (
                  <Row entry={entry} team={team.slug} showOwner={false} />
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </AppLayout>,
  );
});

/**
 * One person, in this workspace.
 *
 * Until now the answer to "what has this person been doing" was Activity with
 * `?actor=`, which is a log and says nothing about their agents, their runs or
 * the work they dispatched. This page puts the four beside each other and owns
 * none of them: the agents come from `agentRoster`, the runs and the work from
 * the readers next to it, and the trail from the reader Activity itself uses, so
 * this page and the pages it links to cannot tell different stories.
 *
 * Any member may read it about any other member. That is the same boundary the
 * team directory and the agent map already draw, and narrowing it here would
 * leave People and agents listing rows nobody could open.
 */
rosterRoutes.get('/app/teams/:slug/people/:username', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const { team } = access;
  const username = decodeURIComponent(c.req.param('username'));
  // Not a member of this workspace, or no such account: the same 404, because a
  // console that distinguishes them answers "does this person exist" to anybody
  // holding a workspace slug. `memberByUsername` is shared with the sessions
  // list's `?person=` filter, so the page and the list it links to cannot start
  // disagreeing about who is a member here.
  const person = await memberByUsername(db, team.id, username);
  if (!person) return c.notFound();

  const home = `/app/teams/${team.slug}/people/${encodeURIComponent(person.username)}`;
  const entries = (await agentRoster(db, team.id)).filter((entry) => entry.agent.ownerId === person.id);
  const runs = await runsForPerson(db, team.id, person.id);
  const work = await workForPerson(
    db,
    team.id,
    person.id,
    entries.map((entry) => entry.agent.installationId),
  );
  const win = pageWindow(c.req.query('page'), TRAIL_SHOWN);
  const trail = slicePage(
    await readActivity(db, team.id, undefined, { ...noActivityFilters(), actor: person.username }, win),
    win,
  );
  // The threads, read through the Sessions list's own reader under the Sessions
  // list's own filter, so this card and the page it links to are the same rows
  // — the reason the filter went on Sessions first rather than a second query
  // here. Open ones, because that is the tab `?person=` lands on.
  const threadWindow = pageWindow('1', SESSIONS_SHOWN);
  const threads = slicePage(
    await readSessions(db, { teamIds: [team.id], teamId: team.id, personId: person.id }, { status: 'open' }, threadWindow),
    threadWindow,
  );
  const activityHref = `/app/teams/${team.slug}/activity?actor=${encodeURIComponent(person.username)}`;
  const sessionsHref = personSessionsHref(team.slug, null, person.username);
  const live = entries.filter((entry) => entry.live).length;

  return c.html(
    <AppLayout
      user={user}
      active="people"
      title={`${person.username} — ${team.name}`}
      bleed
      head={
        <PageHead
          trail={teamTrail(
            team,
            { label: 'People and agents', href: `/app/teams/${team.slug}/agents` },
            { label: person.username },
          )}
          title={person.username}
          sub={`${person.role} in ${team.name} since ${fmtDate(person.joinedAt)}. Their agents, their runs, the work they sent and were given, and their trail.`}
          actions={
            <>
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/agents`}>
                Everyone here
              </a>
              <a class="btn btn-sm" href={`/app/agents?team=${encodeURIComponent(team.slug)}`}>
                Agent map
              </a>
            </>
          }
        />
      }
      keysNote={`${entries.length} agent${entries.length === 1 ? '' : 's'} · ${live} working now · ${runs.filter((run) => run.live).length} live runs`}
    >
      <div class="card scroll-x" style="margin:16px">
        <div class="card-head">
          <div>
            <div class="card-title">Agents</div>
            <div class="card-note">
              What {person.username} has connected in {team.name}, and what each one is doing.
            </div>
          </div>
          <a class="btn btn-sm" href={`/app/teams/${team.slug}/agents`}>
            People and agents
          </a>
        </div>
        {entries.length === 0 ? (
          <div class="card-pad muted small">
            No agent of theirs is connected here. An agent appears once its client confirms the
            connection.
          </div>
        ) : (
          <table class="tbl">
            <Head project={false} />
            <tbody>
              {entries.map((entry) => (
                <Row entry={entry} team={team.slug} showOwner={false} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="card scroll-x" style="margin:16px">
        <div class="card-head">
          <div>
            <div class="card-title">Runs</div>
            <div class="card-note">
              Live first, then the newest that ended. The map owns a run's scope, collisions and
              evidence.
            </div>
          </div>
          <a class="btn btn-sm" href={`/app/agents?team=${encodeURIComponent(team.slug)}`}>
            Agent map
          </a>
        </div>
        {runs.length === 0 ? (
          <div class="card-pad muted small">
            Nothing has run here under this name. A run starts when one of their agents calls{' '}
            <code>start_run</code>.
          </div>
        ) : (
          <table class="tbl">
            <thead>
              <tr>
                <th>Run</th>
                <th>Agent</th>
                <th>Project</th>
                <th>Branch</th>
                <th>State</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr style={run.live ? '' : 'color:var(--mut-2)'}>
                  <td class="name">
                    <a
                      href={`/app/agents?run=${run.runId}&team=${encodeURIComponent(team.slug)}${run.project ? `&project=${encodeURIComponent(run.project.slug)}` : ''}`}
                    >
                      {run.name ?? 'untitled run'}
                    </a>
                  </td>
                  <td class="mono muted">{run.agent ?? '—'}</td>
                  <td class="muted">{run.project?.name ?? '—'}</td>
                  <td class="mono muted">{run.branch ?? '—'}</td>
                  <td>
                    <span class={`pill ${run.live ? 'pill-active' : 'pill-muted'}`}>
                      {run.live ? run.status : (ENDED[run.status] ?? run.status)}
                    </span>
                  </td>
                  <td class="muted">
                    {run.live
                      ? `heartbeat ${timeAgo(run.lastHeartbeatAt)}`
                      : `ended ${timeAgo(run.endedAt ?? run.lastHeartbeatAt)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="card scroll-x" style="margin:16px">
        <div class="card-head">
          <div>
            <div class="card-title">Work</div>
            <div class="card-note">
              Assignments and handoffs {person.username} sent, or that were given to them and their
              agents. Completion is an agent's report.
            </div>
          </div>
          <a class="btn btn-sm" href={`/app/handoffs?team=${encodeURIComponent(team.slug)}`}>
            All work
          </a>
        </div>
        {work.length === 0 ? (
          <div class="card-pad muted small">
            Nothing dispatched to or by them here. Assign work names one agent; only that agent can
            accept it.
          </div>
        ) : (
          <table class="tbl">
            <thead>
              <tr>
                <th>Task</th>
                <th>Direction</th>
                <th>Project</th>
                <th>State</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {work.map((item) => (
                <tr>
                  <td class="name">
                    <a href={`/app/sessions/${item.sessionId}`}>{workTitle(item.title)}</a>
                  </td>
                  <td class="small muted">
                    {item.side === 'sent'
                      ? `${item.kind === 'assignment' ? 'assigned to' : 'handed to'} ${item.agent ?? 'the team'}`
                      : `given to ${item.agent ?? 'them'}`}
                  </td>
                  <td class="muted">{item.project ?? 'Workspace'}</td>
                  <td>
                    <span
                      class={`pill ${['completed', 'cancelled', 'declined'].includes(item.state) ? 'pill-muted' : 'pill-active'}`}
                    >
                      {STATE[item.state] ?? item.state}
                    </span>
                  </td>
                  <td class="muted">{timeAgo(item.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="card scroll-x" style="margin:16px">
        <div class="card-head">
          <div>
            <div class="card-title">Sessions</div>
            <div class="card-note">
              Open threads {person.username} opened or wrote in — their agents write under their
              account, so that counts too. The same filter Sessions applies, read through the same
              query, so this slice and the full list there are the same rows. Assignments and
              handoffs are work, not conversation, and are in the card above.
            </div>
          </div>
          <a class="btn btn-sm" href={sessionsHref}>
            Open in Sessions
          </a>
        </div>
        {threads.items.length === 0 ? (
          <div class="card-pad muted small">
            Nothing they opened or wrote in is open here. Resolved threads stay searchable under{' '}
            <a href={`${sessionsHref}&status=resolved`}>the same filter</a>.
          </div>
        ) : (
          <table class="tbl">
            <thead>
              <tr>
                <th>Thread</th>
                <th>Their part</th>
                <th>Project</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {threads.items.map(({ s, projectName }) => (
                <tr>
                  <td class="name">
                    <a href={`/app/sessions/${s.id}`}>{s.title}</a>
                  </td>
                  {/* The definition, visible on the row rather than only in the
                      note above it: this is the whole of what the filter asks. */}
                  <td class="small muted">{s.openedBy === person.id ? 'opened it' : 'wrote in it'}</td>
                  <td class="muted">{projectName ?? 'Workspace'}</td>
                  <td class="muted">{timeAgo(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {threads.hasMore ? (
          <div class="card-pad muted small">
            Showing the newest {SESSIONS_SHOWN}; older ones are on{' '}
            <a href={sessionsHref}>Sessions</a>.
          </div>
        ) : null}
      </div>

      <div class="card scroll-x" style="margin:16px">
        <div class="card-head">
          <div>
            <div class="card-title">Trail</div>
            <div class="card-note">
              The workspace log under the same <code>actor</code> filter Activity applies, so this
              slice and the full log there are the same rows. Activity owns the other filters, the
              export and the retention.
            </div>
          </div>
          <a class="btn btn-sm" href={activityHref}>
            Open in Activity
          </a>
        </div>
        {trail.items.length === 0 ? (
          <div class="card-pad muted small">Nothing logged under this name in this workspace.</div>
        ) : (
          <table class="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Action</th>
                <th>Project</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {trail.items.map((row) => (
                <tr>
                  <td class="muted" style="white-space:nowrap">
                    {timeAgo(row.a.createdAt)}
                  </td>
                  <td class="mono">{row.tokenName ?? '—'}</td>
                  <td>
                    <span class="pill pill-member">{row.a.action}</span>
                  </td>
                  <td class="muted">{row.projectName ?? '—'}</td>
                  <td class="muted">{row.a.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager
          path={home}
          window={win}
          page={trail}
          noun="events"
          note={`purged after ${c.get('env').activityRetentionDays} days`}
        />
      </div>
    </AppLayout>,
  );
});
