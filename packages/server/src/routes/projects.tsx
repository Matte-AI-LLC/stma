import {
  areAttemptSiblings,
  detectClaimConflicts,
  type ConflictClaim,
  type ConflictSeverity,
} from '@bridge/shared';
import { and, count, countDistinct, desc, eq, gt, inArray, isNull, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { loginRedirect } from '../auth/session';
import type { Db } from '../db';
import {
  activity,
  agentInstallations,
  debugSessions,
  deliveryFlows,
  environmentBaselines,
  handoffs,
  policyBundles,
  projects,
  snapshots,
} from '../db/schema';
import { projectForTeam, teamForUser } from '../domain/access';
import { activeRunsForMember, claimsForRuns } from '../domain/agents';
import { recentAgentEvents } from '../domain/fleetReaders';
import {
  announceAssignment,
  assignableAgents,
  handoffAllowance,
  writeAssignment,
  type AssignmentDraft,
} from '../domain/assignments';
import { agentsHeardIn } from '../domain/companions';
import {
  briefWithTicket,
  JIRA_PICK_NOTE,
  listTicketsFor,
  pickableTrackers,
  readNamedTicket,
  searchTicketsFor,
  ticketExamples,
  ticketPlaceholder,
  TICKET_SEARCH_MAX,
  trackersFor,
  TRACKER_NAMES,
  type Tracker,
} from '../domain/tickets';
import { activeBaselines, recentEnvironmentChecks } from '../domain/environments';
import { effectivePolicy, policyDocumentsFor, recentPolicyReceipts } from '../domain/policies';
import { knowledgeReachingProject } from '../domain/knowledge';
import { activeFlowFor } from '../domain/delivery';
import { policyOrigins } from '../lib/policyOrigin';
import { timeAgo } from '../lib/format';
import { logLine } from '../lib/log';
import { findOrCreateProject } from '../lib/projects';
import { authorizeSecurity } from '../lib/securityHooks';
import { track } from '../lib/track';
import type { AppEnv } from '../types';
import { sectionHref, type SectionKey } from '../lib/scope';
import { Band, Field, Lead, PageHead, teamTrail, Vr } from '../ui/Console';
import { AppLayout } from '../ui/Layout';
import { ProjectCreateBar } from '../ui/ProjectCreate';

/**
 * The project, as a place.
 *
 * Everything here already existed, scattered: runs on the agent map, rules on
 * governance, machines on compare, threads on sessions, the flow on delivery.
 * That is the right shape for the person asking "what is my fleet doing", and
 * the wrong one for the far more common question — "what is going on with
 * payments-api" — which made somebody visit five screens and hold the answer in
 * their head.
 *
 * So this composes rather than computes: every number below is read through the
 * same function the page that owns it uses, and every card carries the way to
 * that page. A second implementation of "is the policy confirmed" would be a
 * second answer to it.
 */
export const projectsRoutes = new Hono<AppEnv>();

const RUNS_SHOWN = 6;
const SESSIONS_SHOWN = 5;
/** Dispatched work shown on the project it was dispatched from; the full ledger is /app/handoffs. */
const ASSIGNED_SHOWN = 8;
const HANDOFF_STAGE: Record<string, string> = {
  offered: 'waiting for the agent',
  accepted: 'accepted',
  in_progress: 'in progress',
  completed: 'completed — reported',
  cancelled: 'cancelled',
  declined: 'declined',
  needs_attention: 'needs attention',
};
const TRAIL_SHOWN = 8;
const WEEK = 7 * 24 * 60 * 60 * 1000;

const rank: Record<ConflictSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

type Row = Awaited<ReturnType<typeof activeRunsForMember>>[number];

const attemptId = (row: Row) => ({
  ownerId: row.owner.id,
  attemptGroup: row.run.attemptGroup,
  taskKey: row.run.taskKey,
  worktree: row.run.worktree ?? null,
});

/**
 * Collision severity per run, by the same rule the map and the tools apply.
 *
 * Imported rather than reimplemented: `areAttemptSiblings` decides whether two
 * overlapping runs are a fan-out or a clash, and if this page answered that
 * question its own way the badge here and the band on the map would eventually
 * disagree about the same two runs.
 */
async function severityByRun(
  db: AppEnv['Variables']['db'],
  rows: Row[],
): Promise<Map<string, ConflictSeverity>> {
  const out = new Map<string, ConflictSeverity>();
  if (rows.length === 0) return out;
  const claims = await claimsForRuns(
    db,
    rows.map((row) => row.run.id),
  );
  const byRun = new Map(rows.map((row) => [row.run.id, row]));
  const asConflictClaims: ConflictClaim[] = claims.map((claim) => {
    const row = byRun.get(claim.runId)!;
    return {
      runId: claim.runId,
      owner: row.owner.username,
      agentName: row.installation.name,
      taskKey: row.run.taskKey,
      resourceType: claim.resourceType as ConflictClaim['resourceType'],
      resourceKey: claim.resourceKey,
      access: claim.access as ConflictClaim['access'],
    };
  });
  for (const row of rows) {
    const mine = asConflictClaims.filter((claim) => claim.runId === row.run.id);
    const others = asConflictClaims.filter((claim) => {
      if (claim.runId === row.run.id) return false;
      const other = byRun.get(claim.runId);
      if (!other) return false;
      // Same project only: two agents that name one repository differently are
      // already kept apart everywhere else, and this page is scoped to a project.
      if (other.run.projectId !== row.run.projectId) return false;
      return !areAttemptSiblings(attemptId(row), attemptId(other));
    });
    for (const conflict of detectClaimConflicts(mine, others)) {
      const seen = out.get(row.run.id);
      if (!seen || rank[conflict.severity] < rank[seen]) out.set(row.run.id, conflict.severity);
    }
  }
  return out;
}

const claimLabel = (type: string, key: string, access: string) =>
  `${access === 'write' ? 'w' : 'r'}:${type}:${key}`;

const ProjectBanner = ({ kind, text }: { kind: 'error' | 'success'; text: string }) => (
  <div class={`banner banner-${kind}`}>
    <span class="ic">{kind === 'error' ? '!' : '✓'}</span>
    <span>{text}</span>
    <button class="x" type="button" data-dismiss="t">
      ×
    </button>
  </div>
);

const projectCreateRedirect = (
  teamSlug: string,
  returnTo: string,
  kind: 'error' | 'ok',
  message: string,
  project?: { slug: string },
) => {
  const params = new URLSearchParams({ team: teamSlug, [kind]: message });
  if (project) params.set('project', project.slug);
  return returnTo === 'tokens'
    ? `/app/tokens?${params}`
    : `/app/teams/${encodeURIComponent(teamSlug)}/projects?${params}`;
};

projectsRoutes.post('/app/projects', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const body = await c.req.parseBody();
  const teamSlug = typeof body.team === 'string' ? body.team.trim() : '';
  const input = typeof body.project === 'string' ? body.project.trim() : '';
  const returnTo = body.return_to === 'tokens' ? 'tokens' : 'projects';
  const access = teamSlug ? await teamForUser(db, user.id, teamSlug) : undefined;
  if (!access || access.role !== 'owner') return c.notFound();

  // /app/projects is intentionally team-agnostic so Agent connections can offer
  // one workspace picker. Re-run the EE browser guard with the submitted team:
  // the outer session middleware cannot infer a workspace from this URL alone.
  const denied = await authorizeSecurity(db, 'browser', { team: teamSlug });
  if (denied) return c.text(denied, 403);
  if (!input || input.length > 500) {
    return c.redirect(
      projectCreateRedirect(
        teamSlug,
        returnTo,
        'error',
        'Enter a project name or repository identifier (500 characters maximum).',
      ),
    );
  }

  const result = await findOrCreateProject(db, access.team, input, user.id);
  if ('error' in result) {
    return c.redirect(projectCreateRedirect(teamSlug, returnTo, 'error', result.error));
  }
  if (result.created) {
    await track(db, {
      teamId: access.team.id,
      projectId: result.project.id,
      userId: user.id,
      action: 'project_created',
      detail: result.project.slug,
    });
    logLine({
      evt: 'project',
      a: 'created',
      u: user.username,
      team: access.team.slug,
      project: result.project.slug,
    });
  }
  return c.redirect(
    projectCreateRedirect(
      teamSlug,
      returnTo,
      'ok',
      result.created ? 'Project created and selected.' : 'Project already existed and is selected.',
      result.project,
    ),
  );
});

// ---------------------------------------------------------------- list

projectsRoutes.get('/app/teams/:slug/projects', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const team = access.team;

  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name);
  const ids = rows.map((p) => p.id);

  const openSessions = new Map<string, number>();
  const lastSnapshot = new Map<string, Date | null>();
  const baseline = new Set<string>();
  const policyVersion = new Map<string, number>();
  const flowName = new Map<string, string>();
  if (ids.length > 0) {
    for (const r of await db
      .select({ pid: debugSessions.projectId, n: count() })
      .from(debugSessions)
      .leftJoin(handoffs, eq(handoffs.sessionId, debugSessions.id))
      .where(and(inArray(debugSessions.projectId, ids), eq(debugSessions.status, 'open'), isNull(handoffs.id)))
      .groupBy(debugSessions.projectId)) {
      if (r.pid) openSessions.set(r.pid, r.n);
    }
    for (const r of await db
      .select({ pid: snapshots.projectId, last: max(snapshots.createdAt) })
      .from(snapshots)
      .where(inArray(snapshots.projectId, ids))
      .groupBy(snapshots.projectId)) {
      if (r.pid) lastSnapshot.set(r.pid, r.last);
    }
    for (const r of await db
      .select({ pid: environmentBaselines.projectId })
      .from(environmentBaselines)
      .where(
        and(
          inArray(environmentBaselines.projectId, ids),
          eq(environmentBaselines.active, true),
        ),
      )) {
      if (r.pid) baseline.add(r.pid);
    }
    for (const r of await db
      .select({ scope: policyBundles.scopeKey, version: max(policyBundles.version) })
      .from(policyBundles)
      .where(eq(policyBundles.teamId, team.id))
      .groupBy(policyBundles.scopeKey)) {
      const id = r.scope.startsWith('project:') ? r.scope.slice('project:'.length) : null;
      if (id && r.version) policyVersion.set(id, r.version);
    }
    for (const r of await db
      .select({ pid: deliveryFlows.projectId, name: deliveryFlows.name })
      .from(deliveryFlows)
      .where(and(eq(deliveryFlows.teamId, team.id), eq(deliveryFlows.status, 'active')))) {
      if (r.pid) flowName.set(r.pid, r.name);
    }
  }
  const teamFlow = (
    await db
      .select({ name: deliveryFlows.name })
      .from(deliveryFlows)
      .where(and(eq(deliveryFlows.teamId, team.id), eq(deliveryFlows.status, 'active')))
      .limit(5)
  ).length;

  const live = (await activeRunsForMember(db, user.id, team.slug)).filter((r) => r.run.projectId);
  const severity = await severityByRun(db, live);
  const runsByProject = new Map<string, Row[]>();
  for (const row of live) {
    const key = row.run.projectId!;
    runsByProject.set(key, [...(runsByProject.get(key) ?? []), row]);
  }
  const totalOpen = [...openSessions.values()].reduce((a, b) => a + b, 0);

  return c.html(
    <AppLayout
      user={user}
      active="projects"
      title={`Projects — ${team.name}`}
      strip={
        <>
          <Lead text={`${rows.length} ${rows.length === 1 ? 'project' : 'projects'}`} live={rows.length > 0} />
          <Vr />
          <span>{live.length} running now</span>
          <Vr />
          <span>{totalOpen} open sessions</span>
        </>
      }
      scope={<span class="mono muted">team {team.slug}</span>}
      head={
        <PageHead
          trail={teamTrail(team, { label: 'Projects' })}
          title="Projects"
          sub="Create a project before connecting a scoped agent, or let an agent discover one from its repository identifier. Each project owns its policy, baseline, flow and sessions."
        />
      }
      keys={[{ k: 'G', label: 'agent map' }]}
      keysNote="repository identifiers keep the project your agent discovers aligned with the one you create"
    >
      {c.req.query('error') ? <ProjectBanner kind="error" text={c.req.query('error')!} /> : null}
      {c.req.query('ok') ? <ProjectBanner kind="success" text={c.req.query('ok')!} /> : null}
      {access.role === 'owner' ? (
        <ProjectCreateBar
          workspaces={[{ name: team.name, slug: team.slug }]}
          selectedWorkspace={team.slug}
          returnTo="projects"
          open={rows.length === 0 || Boolean(c.req.query('error'))}
        />
      ) : null}
      {rows.length === 0 ? (
        <div class="card card-pad muted small">
          No projects yet. A workspace owner can create one above before connecting an agent. A
          project can also appear when an agent first names its repository through{' '}
          <code>start_run</code>, a snapshot, or a session.
        </div>
      ) : (
        <div class="card scroll-x">
          <table class="tbl">
            <tr>
              <th>Project</th>
              <th>Runs now</th>
              <th>Open sessions</th>
              <th>Baseline</th>
              <th>Policy</th>
              <th>Flow</th>
              <th>Last snapshot</th>
              <th></th>
            </tr>
            {rows.map((p) => {
              const mine = runsByProject.get(p.id) ?? [];
              const worst = mine
                .map((r) => severity.get(r.run.id))
                .filter(Boolean)
                .sort((a, b) => rank[a!] - rank[b!])[0];
              return (
                <tr>
                  <td class="name">
                    <a href={`/app/teams/${team.slug}/projects/${encodeURIComponent(p.slug)}`}>
                      {p.name}
                    </a>
                    {rows.some((other) => other.id !== p.id && other.name === p.name) ? (
                      <div class="mono muted small">
                        {p.repositoryIdentity ? 'repository-bound' : p.slug}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {mine.length}
                    {worst ? (
                      <>
                        {' '}
                        <span class={`pill ${worst === 'critical' ? 'pill-danger' : 'pill-warn'}`}>
                          overlap
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>{openSessions.get(p.id) ?? 0}</td>
                  <td>
                    {baseline.has(p.id) ? (
                      <span class="mono">
                        <span class="dot"></span> set
                      </span>
                    ) : (
                      <span class="muted">none</span>
                    )}
                  </td>
                  <td class="mono">
                    {policyVersion.has(p.id) ? (
                      `v${policyVersion.get(p.id)}`
                    ) : (
                      <span class="muted">team only</span>
                    )}
                  </td>
                  <td class="mono">
                    {flowName.get(p.id) ?? (teamFlow > 0 ? <span class="muted">team-wide</span> : <span class="muted">—</span>)}
                  </td>
                  <td class="muted">{timeAgo(lastSnapshot.get(p.id) ?? null) ?? '—'}</td>
                  <td class="chev">›</td>
                </tr>
              );
            })}
          </table>
        </div>
      )}
    </AppLayout>,
  );
});

// -------------------------------------------------------------- detail

projectsRoutes.get('/app/teams/:slug/projects/:project', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const team = access.team;
  // The list links by slug — the one handle two same-named projects cannot
  // share — and older links carry the name. Looking up by name alone answered
  // 404 for every project whose slug differs from its name, and picked either
  // one of a repository-bound project and its same-named legacy sibling.
  const project = await projectForTeam(db, team.id, c.req.param('project'));
  if (!project) return c.notFound();

  const live = (await activeRunsForMember(db, user.id, team.slug)).filter(
    (r) => r.run.projectId === project.id,
  );
  const severity = await severityByRun(db, live);
  const worst = live
    .map((r) => severity.get(r.run.id))
    .filter(Boolean)
    .sort((a, b) => rank[a!] - rank[b!])[0];
  const claims = await claimsForRuns(
    db,
    live.map((r) => r.run.id),
  );

  // A thread that carries an assignment or a handoff is dispatched work, listed
  // below with its own state. Counted as an "open session" it never closed:
  // cancelling or completing the work leaves the thread open, so a lead who
  // cancelled a mistaken assignment still read "open" beside it (2026-09-19).
  const threads = and(eq(debugSessions.projectId, project.id), eq(debugSessions.status, 'open'), isNull(handoffs.id));
  const sessions = await db
    .select({ session: debugSessions })
    .from(debugSessions)
    .leftJoin(handoffs, eq(handoffs.sessionId, debugSessions.id))
    .where(threads)
    .orderBy(desc(debugSessions.createdAt))
    .limit(SESSIONS_SHOWN);
  const openCount = (
    await db
      .select({ n: count() })
      .from(debugSessions)
      .leftJoin(handoffs, eq(handoffs.sessionId, debugSessions.id))
      .where(threads)
  )[0]?.n ?? 0;
  const dispatched = await db
    .select({ offer: handoffs, title: debugSessions.title, agent: agentInstallations.name, device: agentInstallations.deviceLabel })
    .from(handoffs)
    .innerJoin(debugSessions, eq(handoffs.sessionId, debugSessions.id))
    .leftJoin(agentInstallations, eq(agentInstallations.id, handoffs.targetInstallationId))
    .where(eq(debugSessions.projectId, project.id))
    .orderBy(desc(handoffs.createdAt))
    .limit(ASSIGNED_SHOWN);
  /** `?team=…&project=…`: how the agent map opens in this scope — it has no address of its own under a project. */
  const inProject = `?team=${encodeURIComponent(team.slug)}&project=${encodeURIComponent(project.slug)}`;
  /** One of this project's sections, at its own address. */
  const section = (key: SectionKey) => sectionHref(team.slug, project.slug, key);
  // What the last form post on this page did, named back to the person who did it.
  const noticeFor = (key: 'assigned' | 'cancelled') => {
    const id = c.req.query(key);
    return id ? dispatched.find((row) => row.offer.sessionId === id) : undefined;
  };
  const justAssigned = noticeFor('assigned');
  const justCancelled = noticeFor('cancelled');
  const whom = (row: (typeof dispatched)[number]) =>
    row.agent ? `${row.agent}${row.device ? ` on ${row.device}` : ''}` : 'the team';

  const agents7d =
    (
      await db
        .select({ n: countDistinct(activity.tokenId) })
        .from(activity)
        .where(
          and(
            eq(activity.projectId, project.id),
            gt(activity.createdAt, new Date(Date.now() - WEEK)),
          ),
        )
    )[0]?.n ?? 0;

  const snap = (
    await db
      .select({ last: max(snapshots.createdAt) })
      .from(snapshots)
      .where(eq(snapshots.projectId, project.id))
  )[0]?.last;

  const policy = await effectivePolicy(db, user.id, {
    team: team.slug,
    project: project.name,
    projectId: project.id,
  });
  const baselines = await activeBaselines(db, team.id, 1, project.id);
  const checks = await recentEnvironmentChecks(db, team.id, 5, project.id);
  const criticalChecks = checks.filter((row) => row.check.status === 'critical').length;
  const trail = await recentAgentEvents(db, team.id, TRAIL_SHOWN, project.id);
  // "Confirmed" means a run answered with the hash the server served — never
  // that nobody objected. Read from the same receipts governance counts.
  const receipts = await recentPolicyReceipts(db, team.id, 10, project.id);
  const confirmed =
    receipts.length > 0
      ? {
          total: receipts.length,
          answered: receipts.filter((row) => row.receipt.reportedHash && !row.receipt.drift).length,
        }
      : null;

  // Who work can be assigned to from here. The same list assign_work resolves a
  // name against, so the form and the tool cannot disagree about who exists.
  const assignable = await assignableAgents(db, team.id);
  // "Adapter paired" on this page means a hook that hears work filed *here* —
  // the same answer assign_work gives as hookWillAnnounce for this project.
  const heardHere = await agentsHeardIn(
    db,
    assignable.map((a) => a.installationId),
    team.id,
    project.id,
  );
  const assignError = c.req.query('assign_error') ?? null;
  // Which trackers can pull a ticket into an assignment at all. Only the
  // connections are read here — no issue is fetched to draw the page, because a
  // tracker being slow must not make the project page slow.
  const trackers = await trackersFor(db, team.id, project.id);
  const pickable = pickableTrackers(trackers);
  /**
   * The picker is a link, like `?run=` on the map and `?tab=` on the team page:
   * it survives a refresh, the back button undoes it, and no script is needed
   * to draw a list. The alternative considered was a submit button with
   * `formmethod="get"`, which would carry everything already typed into the
   * dialog — it lost because a `maxlength=8000` brief through a query string is
   * a 431 from Node's 16 KiB header cap, and the Ticket field is the *first*
   * field: the order here is pick, then write.
   */
  const asked = c.req.query('pick');
  const picking = pickable.find((t) => t === asked) ?? null;
  /**
   * The words typed into the search box, which is a form of its own inside the
   * dialog: a GET form writes a query string and nothing else, so `q` joins
   * `pick` and `ticket` in the address and every one of them survives a
   * refresh. It cannot be a submit button on the assignment form — that would
   * carry the `maxlength=8000` brief through Node's 16 KiB header cap — which
   * is why the controls sit inside that form and belong to this one.
   */
  const searchText = (c.req.query('q') ?? '').slice(0, TICKET_SEARCH_MAX);
  /** Which tracker the box searches when there is more than one to choose. */
  const searchTracker = picking ?? pickable[0] ?? null;
  // The one fetch on this page, and only because somebody asked for it: a
  // click on Browse, or a search. Drawing the page reads the connections and
  // nothing else.
  const listed = picking
    ? searchText.trim()
      ? await searchTicketsFor(db, env, team.id, project.id, picking, searchText)
      : await listTicketsFor(db, env, team.id, project.id, picking)
    : null;
  /**
   * The reference in the Ticket field: what the picker just chose, or what a
   * refused assignment was carrying. Without the second, a lead who picked a
   * ticket and then mistyped the agent lost the pick as well as the answer.
   */
  const ticketField = (c.req.query('ticket') ?? '').slice(0, 200);
  // Open, because a person who clicked Browse or hit a refusal must not have to
  // find the dialog again. An empty `pick` counts: that is what **Close list**
  // links to, and closing the list must not also close the dialog around it.
  // `data-auto-open` alongside it upgrades this to a real modal where there is
  // script; showModal() refuses an already-open element, so client.ts closes it
  // first.
  const assignOpen =
    asked !== undefined || c.req.query('q') !== undefined || Boolean(ticketField || assignError);
  /** The address this page and its picker forms are written to. */
  const projectHref = `/app/teams/${team.slug}/projects/${encodeURIComponent(project.slug)}`;
  /** This page, plus the picker's own selection. */
  const pickHref = (query: { pick?: Tracker | null; ticket?: string; q?: string }) => {
    const parts = [`pick=${query.pick ?? ''}`];
    if (query.ticket) parts.push(`ticket=${encodeURIComponent(query.ticket)}`);
    // Carried through a choice, so picking a result does not throw away the
    // search that found it and leave somebody typing it again.
    if (query.q?.trim()) parts.push(`q=${encodeURIComponent(query.q)}`);
    return `${projectHref}?${parts.join('&')}#assign-work`;
  };

  const policyDoc = 'error' in policy ? null : policy;
  // The merged document, read the way get_policy serves it — so the card and the
  // agent are quoting one answer rather than two summaries of it.
  const projectScope = policyDoc?.sources.find((source) => source.scope.startsWith('project:'));
  // Where each rule comes from, derived from the two published documents. What
  // this project adds leads: it is what is different here, and the workspace's
  // rules are one click away on the page that owns them.
  const documents = await policyDocumentsFor(db, team.id, project.id);
  const origins = policyOrigins(documents.workspace, documents.project);
  const PREFIX: Record<string, string> = {
    autonomy: 'Needs a person',
    approval: 'Requires approval',
    env: 'Required env var',
    checks: 'Check',
    paths: 'Protected',
    deny: 'Denied',
    runtimes: 'Runtime',
    budget: 'Budget',
  };
  const rules = origins.sections
    .filter((section) => PREFIX[section.key])
    .flatMap((section) => section.rules.map((rule) => ({ ...rule, text: `${PREFIX[section.key]}: ${rule.text}` })))
    .sort((a, b) => (a.origin === b.origin ? 0 : a.origin === 'project' ? -1 : 1));
  // Six lines, and both origins get a say: a project that adds ten rules must not
  // push the workspace's off the card, or the card reads as if nothing is inherited.
  const RULES_SHOWN = 6;
  const ownRules = rules.filter((rule) => rule.origin === 'project');
  const inheritedRules = rules.filter((rule) => rule.origin === 'workspace');
  const shownRules = [
    ...ownRules.slice(0, Math.max(4, RULES_SHOWN - inheritedRules.length)),
    ...inheritedRules.slice(0, Math.max(2, RULES_SHOWN - ownRules.length)),
  ].slice(0, RULES_SHOWN);
  // The other two things in effect here, each with the same question answered.
  const knowledgeHere = await knowledgeReachingProject(db, team.id, project.id);
  const flowHere = await activeFlowFor(db, team.id, project.id);
  /** Governance twice, at two anchors: same address, different place on it. */
  const governanceHere = section('governance');

  return c.html(
    <AppLayout
      user={user}
      active="projects"
      title={`${project.name} — ${team.name}`}
      strip={
        <>
          <Lead
            text={`${live.length} ${live.length === 1 ? 'run' : 'runs'} on this project`}
            live={live.length > 0}
          />
          {worst ? (
            <>
              <Vr />
              <span style="color:var(--red)">{worst} overlap</span>
            </>
          ) : null}
          <Vr />
          <span>{openCount} open sessions</span>
        </>
      }
      scope={
        <>
          <a class="linklike" href={`/app/teams/${team.slug}/projects`}>
            ← all projects
          </a>
          <Vr />
          <span class="mono muted">project {project.name}</span>
        </>
      }
      head={
        <PageHead
          trail={teamTrail(team, { label: 'Projects', href: `/app/teams/${team.slug}/projects` }, { label: project.name })}
          title={project.name}
          sub="Everything about this project on one page: live runs, sessions, policy, environment and delivery — with the way to change each."
          actions={
            <>
              <a
                class="btn btn-sm"
                href={`/app/tokens?team=${encodeURIComponent(team.slug)}&project=${encodeURIComponent(project.slug)}`}
              >
                Connect agent
              </a>
              <a
                class="btn btn-sm"
                href={section('environments')}
              >
                Compare machines
              </a>
              <a
                class="btn btn-sm"
                href={`/app/sessions?new=1&team=${encodeURIComponent(team.slug)}&project=${encodeURIComponent(project.id)}`}
              >
                Open a session
              </a>
              <button class="btn btn-sm" type="button" data-open-dialog="#assign-work">
                Assign work
              </button>
              <a class="btn btn-sm btn-primary" href={`/app/agents${inProject}`}>
                View on agent map
              </a>
            </>
          }
        />
      }
      band={
        assignError ? (
          <Band kind="danger" tag="not assigned">
            {assignError}
          </Band>
        ) : justAssigned ? (
          <Band
            kind="info"
            tag="assigned"
            actions={
              <>
                <a class="btn btn-sm" href={`/app/sessions/${justAssigned.offer.sessionId}`}>
                  Open the brief
                </a>
                <button class="btn btn-sm" type="button" data-open-dialog="#assign-work">
                  Assign another
                </button>
              </>
            }
          >
            “{justAssigned.title}” went to <b>{whom(justAssigned)}</b>. It hears it the next time
            somebody types to it. Wrong agent? Cancel it under Assigned work below.
          </Band>
        ) : justCancelled ? (
          <Band kind="info" tag="cancelled">
            “{justCancelled.title}” is cancelled: <b>{whom(justCancelled)}</b> will not be told about
            it and can no longer accept it. The brief stays readable.
          </Band>
        ) : worst === 'critical' ? (
          <Band
            kind="danger"
            tag="critical"
            actions={
              <a class="btn btn-sm" href={`/app/agents${inProject}`}>
                Open in inspector
              </a>
            }
          >
            Two live runs hold the same ground on this project. Claims are advisory — STMA warns
            the agents, it does not lock the file.
          </Band>
        ) : undefined
      }
      keys={[{ k: 'G', label: 'agent map' }]}
      keysNote="every number here is read from the page that owns it — the links go there"
    >
      <div class="stat3">
        <div>
          <span class="overline">Active runs</span>
          <span class={`n${worst === 'critical' ? ' bad' : ''}`}>{live.length}</span>
        </div>
        <div>
          <span class="overline">Open sessions</span>
          <span class="n">{openCount}</span>
        </div>
        <div>
          <span class="overline">Agents (7d)</span>
          <span class="n">{agents7d}</span>
        </div>
        <div>
          <span class="overline">Preflight</span>
          <span class={`n${criticalChecks > 0 ? ' bad' : ' ok'}`}>
            {criticalChecks > 0 ? `${criticalChecks} critical` : checks.length > 0 ? 'ok' : '—'}
          </span>
        </div>
        <div>
          <span class="overline">Last snapshot</span>
          <span class="n">{timeAgo(snap ?? null) ?? '—'}</span>
        </div>
      </div>

      <div class="edgrid" style="margin-top:16px">
        <div class="col">
          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">Active runs</div>
                <div class="card-note">This project only — the same rows as the agent map.</div>
              </div>
              <a class="btn btn-sm" href={`/app/agents${inProject}`}>
                Agent map
              </a>
            </div>
            {live.length === 0 ? (
              <div class="card-pad muted small">
                Nothing running here right now. The map is presence, not history — what these runs
                did is on Activity and the governance timeline.
              </div>
            ) : (
              live.slice(0, RUNS_SHOWN).map((row) => {
                const held = claims
                  .filter((claim) => claim.runId === row.run.id)
                  .map((claim) => claimLabel(claim.resourceType, claim.resourceKey, claim.access));
                const sev = severity.get(row.run.id);
                return (
                  <div class="introw">
                    <span class={`dot${sev === 'critical' ? ' red' : ''}`}></span>
                    <div class="who">
                      <div class="t">{row.run.taskKey ?? 'no task key'}</div>
                      <div class="s">
                        {row.owner.username} · {row.installation.name}
                        {row.run.branch ? ` · ${row.run.branch}` : ''}
                      </div>
                    </div>
                    <span class="mono small muted hide-sm">{held.join(', ') || 'no claims'}</span>
                    {sev ? (
                      <span class={`pill ${sev === 'critical' ? 'pill-danger' : 'pill-warn'}`}>
                        {sev}
                      </span>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <div class="card" id="assigned-work">
            <div class="card-head">
              <div>
                <div class="card-title">Assigned work</div>
                <div class="card-note">
                  What was dispatched on {project.name}, to whom, and where it stands.
                </div>
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-sm" type="button" data-open-dialog="#assign-work">
                  Assign work
                </button>
                <a class="btn btn-sm" href={section('work')}>
                  All handoffs
                </a>
              </div>
            </div>
            {dispatched.length === 0 ? (
              <div class="card-pad muted small">
                Nothing dispatched on this project yet. Assign work names an agent; only that agent
                can accept it.
              </div>
            ) : (
              dispatched.map((row) => {
                const live = !['completed', 'cancelled', 'declined'].includes(row.offer.state);
                return (
                  <div class="introw">
                    <div class="who">
                      <div class="t">
                        <a href={`/app/sessions/${row.offer.sessionId}`}>{row.title}</a>
                      </div>
                      <div class="s">
                        {row.offer.kind === 'assignment' ? 'assigned to' : 'handed to'} {whom(row)} ·{' '}
                        {timeAgo(row.offer.createdAt) ?? 'just now'}
                      </div>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center">
                      <span class={`pill ${live ? 'pill-active' : 'pill-muted'}`}>
                        {HANDOFF_STAGE[row.offer.state] ?? row.offer.state}
                      </span>
                      {live && row.offer.offeredBy === user.id ? (
                        <form method="post" action={`/app/sessions/${row.offer.sessionId}/handoff/cancel`}>
                          <input type="hidden" name="return_to" value="project" />
                          <button
                            class="btn btn-sm"
                            type="submit"
                            data-confirm={`Cancel “${row.title}”? ${whom(row)} will not be told about it. This does not stop work an agent already started.`}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">Open sessions</div>
                <div class="card-note">Debug threads tagged {project.name}.</div>
              </div>
              <a class="btn btn-sm" href={section('sessions')}>
                All sessions
              </a>
            </div>
            {sessions.length === 0 ? (
              <div class="card-pad muted small">
                No open thread on this project. Resolved ones stay searchable — agents read them
                through <code>search_past_issues</code>.
              </div>
            ) : (
              sessions.map(({ session }) => (
                <div class="introw">
                  <div class="who">
                    <div class="t">
                      <a href={`/app/sessions/${session.id}`}>{session.title}</a>
                    </div>
                    <div class="s">opened {timeAgo(session.createdAt) ?? 'just now'}</div>
                  </div>
                  <span class="pill pill-open">open</span>
                </div>
              ))
            )}
          </div>

          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">Recent activity</div>
                <div class="card-note">The run trail for this project, newest first.</div>
              </div>
              <a class="btn btn-sm" href={section('activity')}>
                Activity
              </a>
            </div>
            {trail.length === 0 ? (
              <div class="card-pad muted small">Nothing recorded for this project yet.</div>
            ) : (
              <table class="tbl">
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Run</th>
                  <th>Owner</th>
                </tr>
                {trail.map((row) => (
                  <tr>
                    <td class="muted">{timeAgo(row.event.createdAt) ?? 'just now'}</td>
                    <td>
                      <span class="pill pill-member">{row.event.type.replaceAll('_', ' ')}</span>
                    </td>
                    <td class="mono">{row.run.taskKey ?? '—'}</td>
                    <td>{row.owner}</td>
                  </tr>
                ))}
              </table>
            )}
          </div>
        </div>

        <div class="col">
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
            <div class="row" style="justify-content:space-between">
              <div>
                <div class="card-title">Rules in effect here</div>
                <div class="card-note">
                  {origins.inherited} from the workspace · {origins.own} this project adds. A project can
                  add a rule or tighten one, never remove one.
                </div>
              </div>
              {projectScope ? (
                <span class="pill pill-active">
                  v{projectScope.version}
                  {confirmed !== null ? ' · confirmed' : ''}
                </span>
              ) : (
                <span class="pill">workspace only</span>
              )}
            </div>
            {rules.length === 0 ? (
              <p class="m0 small muted">
                No policy rule is in force for {project.name}: neither the workspace nor this project
                has published one.
              </p>
            ) : (
              <>
                {shownRules.map((rule) => (
                  <div class="factrow">
                    <span class="y">✓</span>
                    <span style="flex:1">{rule.text}</span>
                    <span class={`origin origin-${rule.origin}`} style="flex:0 0 auto">
                      {rule.origin === 'project' ? 'this project' : 'workspace'}
                    </span>
                  </div>
                ))}
                {rules.length > shownRules.length ? (
                  <a class="small" href={`${governanceHere}#effective-policy`}>
                    +{rules.length - shownRules.length} more, each with where it comes from
                  </a>
                ) : null}
              </>
            )}
            <div class="factrow" id="knowledge-here">
              <span class={knowledgeHere.workspace + knowledgeHere.project > 0 ? 'y' : 'n'}>
                {knowledgeHere.workspace + knowledgeHere.project > 0 ? '✓' : '·'}
              </span>
              <span style="flex:1">
                <a href={section('knowledge')}>Knowledge</a>:{' '}
                {knowledgeHere.workspace + knowledgeHere.project === 0
                  ? 'no record reaches this project yet'
                  : `${knowledgeHere.workspace} from the workspace · ${knowledgeHere.project} addressed to this project`}
              </span>
            </div>
            <div class="factrow" id="delivery-here">
              <span class={flowHere ? 'y' : 'n'}>{flowHere ? '✓' : '·'}</span>
              <span style="flex:1">
                <a href={section('delivery')}>Delivery</a>:{' '}
                {flowHere ? `${flowHere.flow.name} v${flowHere.flow.version}` : 'no flow published'}
              </span>
              {flowHere ? (
                <span class={`origin origin-${flowHere.projectName ? 'project' : 'workspace'}`} style="flex:0 0 auto">
                  {flowHere.projectName ? 'this project' : 'workspace'}
                </span>
              ) : null}
            </div>
            {policyDoc ? (
              <div class="factrow">
                {/* Silence is not agreement: a receipt nobody answered is unconfirmed,
                    the same distinction governance and the evidence pack make. */}
                <span class={confirmed && confirmed.answered > 0 ? 'y' : 'n'}>
                  {confirmed && confirmed.answered > 0 ? '✓' : '!'}
                </span>
                <span>
                  Effective hash <span class="mono">{policyDoc.hash.slice(0, 12)}</span>
                  {confirmed
                    ? ` — ${confirmed.answered} of ${confirmed.total} recent runs confirmed it.`
                    : ' — no run has reported which rules it applied.'}
                </span>
              </div>
            ) : null}
            <div class="row" style="gap:8px">
              <a class="btn btn-sm" href={`${governanceHere}#effective-policy`}>
                Where each rule comes from
              </a>
              <a class="btn btn-sm" href={`${governanceHere}#policy-receipts`}>
                Receipts
              </a>
            </div>
          </div>

          <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
            <div class="row" style="justify-content:space-between">
              <div>
                <div class="card-title">Environment</div>
                <div class="card-note">Baseline and what preflight told the machines.</div>
              </div>
              {criticalChecks > 0 ? (
                <span class="pill pill-danger">{criticalChecks} critical</span>
              ) : null}
            </div>
            {baselines[0] ? (
              <div class="factrow">
                <span class="y">✓</span>
                <span>
                  Baseline{' '}
                  <span class="mono">{baselines[0].baseline.fingerprint.slice(0, 12)}</span> from{' '}
                  <b>{baselines[0].author ?? 'unknown'}</b>,{' '}
                  {timeAgo(baselines[0].baseline.createdAt) ?? 'just now'}.
                </span>
              </div>
            ) : (
              <div class="factrow">
                <span class="n">!</span>
                <span>
                  No baseline recorded. Preflight can only report what a baseline claims, so
                  without one an agent is told nothing about its machine.
                </span>
              </div>
            )}
            {checks.slice(0, 2).map((row) => (
              <div class="factrow">
                <span class={row.check.status === 'ok' ? 'y' : 'n'}>
                  {row.check.status === 'ok' ? '✓' : '!'}
                </span>
                <span>
                  <b>{row.username ?? 'a machine'}</b>: {row.check.summary}
                </span>
              </div>
            ))}
            <div class="row" style="gap:8px">
              <a
                class="btn btn-sm"
                href={section('environments')}
              >
                Compare machines
              </a>
              {/* A baseline belongs to one project, so the page it is recorded on
                  opens in this one rather than across the workspace. */}
              <a class="btn btn-sm" href={governanceHere}>
                Update baseline
              </a>
            </div>
          </div>
        </div>
      </div>

      <dialog
        id="assign-work"
        class="formdlg wide"
        open={assignOpen}
        data-auto-open={assignOpen ? 't' : undefined}
      >
        <h3>Assign work to an agent</h3>
        <p class="dlgsub">
          Name the agent and say what to do. It picks the task up from its own inbox, and only
          the agent you name can accept it. An agent marked <b>adapter paired</b> has a local
          adapter in this project, so its own prompt hook tells it the next time anyone types to
          it; for any other, one sentence on its machine is enough — "read your STMA inbox and do
          what is assigned to you". Local adapters are not listed: they are a checkout's ears and
          cannot accept work.
        </p>
        {/* Also inside the dialog, because a modal covers the page's own band:
            the lead reopened on a refusal and would otherwise read a filled-in
            form with nothing saying why it came back. */}
        {assignError ? <div class="banner banner-error">{assignError}</div> : null}
        {/* The picker's own form, and it has to be a separate element: assigning
            is a POST and HTML forms do not nest. Its controls still sit where
            they belong — beside the list they filter — through the `form`
            attribute, which associates a control with a form it is not inside.
            Measured in a browser rather than assumed: submitting this carries
            exactly `ticket`, `q` and `pick` and keeps the `#assign-work`
            fragment, so the `maxlength=8000` brief stays out of the query
            string (the reason a `formmethod="get"` button was rejected the
            first time round) and `q` stays out of the assignment body. No
            script: pressing Enter in the box submits this form, not the POST.
            It sits outside the branch below so that branch stays one element. */}
        {assignable.length && trackers.length && searchTracker ? (
          <form id="ticket-search" method="get" action={`${projectHref}#assign-work`}>
            <input type="hidden" name="ticket" value={ticketField} />
          </form>
        ) : null}
        {assignable.length === 0 ? (
          <>
            <p class="m0 sub">
              No agents are connected to this workspace yet. Connect one first; the name you give
              it at consent is the name you assign work to.
            </p>
            <div class="dialog-actions">
              <a
                class="btn"
                href={`/app/tokens?team=${encodeURIComponent(team.slug)}&project=${encodeURIComponent(project.slug)}`}
              >
                Connect agent
              </a>
              <button class="btn" type="button" data-close-dialog="t">
                Close
              </button>
            </div>
          </>
        ) : (
          <form
            method="post"
            action={`/app/teams/${team.slug}/projects/${encodeURIComponent(project.slug)}/assign`}
          >
            {trackers.length ? (
              <>
                <Field
                  id="assign-ticket"
                  label="Ticket"
                  help={`${ticketExamples(trackers)}. STMA reads it and fills anything you leave empty below, and the brief carries the link. Leave it blank to write the task yourself.`}
                >
                  <input
                    class="in"
                    id="assign-ticket"
                    name="ticket"
                    maxlength={200}
                    value={ticketField}
                    placeholder={ticketPlaceholder(trackers)}
                    aria-describedby="assign-ticket-help"
                  />
                </Field>
                {searchTracker ? (
                  <Field
                    id="ticket-q"
                    label="Search tickets"
                    help={
                      pickable.includes('clickup') && !pickable.includes('github')
                        ? "A few words from the title or the key. ClickUp's API cannot search tasks, so STMA matches a window of the mapped List and says how far it read."
                        : 'A few words from the title or the key. Punctuation is dropped — this is a search box, not a query language.'
                    }
                  >
                    <div class="row" style="flex-wrap:wrap;gap:8px">
                      <input
                        class="in"
                        id="ticket-q"
                        name="q"
                        form="ticket-search"
                        value={searchText}
                        maxlength={TICKET_SEARCH_MAX}
                        placeholder="label printer"
                        aria-describedby="ticket-q-help"
                        style="flex:1;min-width:180px"
                      />
                      {/* With one tracker there is nothing to choose and a
                          select would be a control with a single option; with
                          two the box has to say which one it is asking. */}
                      {pickable.length > 1 ? (
                        <select
                          class="in"
                          name="pick"
                          form="ticket-search"
                          aria-label="Tracker to search"
                          style="width:auto;flex:0 0 auto"
                        >
                          {pickable.map((tracker) => (
                            <option value={tracker} selected={searchTracker === tracker}>
                              {TRACKER_NAMES[tracker]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input type="hidden" name="pick" value={searchTracker} form="ticket-search" />
                      )}
                      <button class="btn btn-sm" type="submit" form="ticket-search">
                        Search
                      </button>
                    </div>
                  </Field>
                ) : null}
                <div class="row" style="flex-wrap:wrap;gap:8px">
                  {pickable.map((tracker) => (
                    // `aria-controls` only while the list is on the page: a
                    // control pointing at an id that is not there is worse than
                    // no pointer at all. No `q`: Browse means "show me what is
                    // open", which is the question a search is not asking.
                    <a
                      class="btn btn-sm"
                      href={pickHref({ pick: tracker, ticket: ticketField })}
                      aria-expanded={picking === tracker ? 'true' : 'false'}
                      aria-controls={listed ? 'ticket-list' : undefined}
                    >
                      Browse {TRACKER_NAMES[tracker]}
                    </a>
                  ))}
                  {trackers.includes('jira') ? (
                    <span class="card-note" style="margin:0">
                      {JIRA_PICK_NOTE}
                    </span>
                  ) : null}
                </div>
                {listed ? (
                  <div id="ticket-list" style="display:flex;flex-direction:column;gap:10px">
                    {!listed.ok ? (
                      // Named, the way the paste path names a refusal: an empty
                      // list and no explanation reads as "nothing to do here".
                      <div class="banner banner-error">{listed.error}</div>
                    ) : listed.value.options.length === 0 ? (
                      // "Nothing matched" and "nothing is open" are different
                      // answers and a person acts differently on each: one says
                      // try other words, the other says there is no work here.
                      <p class="m0 sub">
                        {searchText.trim()
                          ? `Nothing open in ${TRACKER_NAMES[picking!]} matches “${searchText.trim()}”. Try fewer words, browse what is open, or paste a reference above.`
                          : `Nothing open in ${TRACKER_NAMES[picking!]} right now. Paste a reference above if you know one.`}
                      </p>
                    ) : (
                      <div class="tickets">
                        {listed.value.options.map((row) =>
                          row.ref === ticketField ? (
                            <div class="introw" aria-current="true">
                              <div class="who">
                                <div class="t">{row.summary}</div>
                                <div class="s">
                                  {row.key} · {row.status}
                                  {timeAgo(row.updatedAt) ? ` · ${timeAgo(row.updatedAt)}` : ''}
                                </div>
                              </div>
                              <span class="pill pill-active">chosen</span>
                            </div>
                          ) : (
                            <a
                              class="introw"
                              href={pickHref({ pick: picking, ticket: row.ref, q: searchText })}
                            >
                              <div class="who">
                                <div class="t">{row.summary}</div>
                                <div class="s">
                                  {row.key} · {row.status}
                                  {timeAgo(row.updatedAt) ? ` · ${timeAgo(row.updatedAt)}` : ''}
                                </div>
                              </div>
                              <span class="chev">›</span>
                            </a>
                          ),
                        )}
                      </div>
                    )}
                    {/* Outside the three cases above, so a refusing tracker and
                        an empty list have the way back that a full one has. */}
                    <div class="row" style="flex-wrap:wrap;gap:8px">
                      {/* Written where the bound is decided, because browsing,
                          a GitHub search and a ClickUp search reach three
                          different distances and one sentence covering all
                          three would be untrue about two of them. */}
                      {listed.ok && listed.value.options.length ? (
                        <span class="card-note" style="margin:0">
                          {listed.value.bound}
                        </span>
                      ) : null}
                      {/* Drops `q` as well as the list: this closes the picker,
                          and a search box still full beside no results reads as
                          a search that found nothing. */}
                      <a
                        class="btn btn-sm"
                        style="margin-left:auto"
                        href={pickHref({ ticket: ticketField })}
                      >
                        Close list
                      </a>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
            <Field
              id="assign-agent"
              label="Agent"
              required
              help="Every agent connected to this workspace, newest-seen first. One connected to a different project only cannot take work here."
            >
              <select
                class="in"
                id="assign-agent"
                name="agent"
                aria-describedby="assign-agent-help"
                required
              >
                <option value="" selected disabled>
                  Choose an agent…
                </option>
                {assignable.map((a) => (
                  <option
                    value={a.installationId}
                    disabled={a.projectId !== null && a.projectId !== project.id}
                  >
                    {a.name} · {a.owner}
                    {a.device ? `@${a.device}` : ''} · {a.client} · seen {timeAgo(a.lastSeenAt)}
                    {heardHere.has(a.installationId) ? ' · adapter paired' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="assign-task"
              label="Task"
              required={!trackers.length}
              help={
                trackers.length
                  ? 'A short title or task key. It becomes the run task and the ledger line. Leave it empty to use the ticket above.'
                  : 'A short title or task key. It becomes the run task and the ledger line.'
              }
            >
              <input
                class="in"
                id="assign-task"
                name="task"
                maxlength={120}
                required={!trackers.length}
                aria-describedby="assign-task-help"
              />
            </Field>
            <Field
              id="assign-brief"
              label="Brief"
              required={!trackers.length}
              help={
                trackers.length
                  ? "What to do and why, in your words. The first line becomes the run intent. Leave it empty to use the ticket's own summary. Never put a credential here."
                  : 'What to do and why, in your words. The first line becomes the run intent. Never put a credential here.'
              }
            >
              <textarea
                class="in"
                id="assign-brief"
                name="brief"
                rows={6}
                maxlength={8000}
                required={!trackers.length}
                aria-describedby="assign-brief-help"
              ></textarea>
            </Field>
            <Field id="assign-steps" label="Steps" help="One per line, in order.">
              <textarea
                class="in"
                id="assign-steps"
                name="steps"
                rows={4}
                aria-describedby="assign-steps-help"
              ></textarea>
            </Field>
            <Field
              id="assign-branch"
              label="Branch"
              help="Only if you already have one in mind; otherwise the agent starts from the default branch."
            >
              <input
                class="in"
                id="assign-branch"
                name="branch"
                maxlength={300}
                aria-describedby="assign-branch-help"
              />
            </Field>
            <div class="dialog-actions">
              <button class="btn" type="button" data-close-dialog="t">
                Cancel
              </button>
              <button class="btn btn-primary" type="submit">
                Assign
              </button>
            </div>
          </form>
        )}
      </dialog>
    </AppLayout>,
  );
});

/**
 * The browser half of assign_work. Same draft, same record, same rules — a
 * lead at a browser and a lead's agent create indistinguishable assignments,
 * which is what lets the receiving agent treat both the same way.
 */
projectsRoutes.post('/app/teams/:slug/projects/:project/assign', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const team = access.team;
  // The same lookup as the page the form sits on, so the assignment is filed
  // under the project the lead is looking at — never a same-named sibling.
  const project = await projectForTeam(db, team.id, c.req.param('project'));
  if (!project) return c.notFound();

  const body = await c.req.parseBody();
  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '');
  const back = `/app/teams/${team.slug}/projects/${encodeURIComponent(project.slug)}`;
  // The reference comes back with the refusal: picking a ticket and then
  // mistyping the agent used to cost the pick as well as the answer, and the
  // field the picker fills is the one it would be most annoying to lose.
  const refuse = (message: string) => {
    const ticket = str('ticket');
    return c.redirect(
      `${back}?assign_error=${encodeURIComponent(message)}${ticket ? `&ticket=${encodeURIComponent(ticket)}` : ''}#assign-work`,
    );
  };

  let task = str('task');
  let brief = str('brief');
  const branch = str('branch');

  /**
   * A ticket the lead named, pulled in before anything is validated. Which
   * tracker it belongs to is read off the shape they typed; `guessTracker`
   * also decides what the refusal is able to say.
   */
  const typedTicket = str('ticket');
  if (typedTicket) {
    const ticket = await readNamedTicket(db, env, team.id, project.id, typedTicket);
    if (!ticket.ok) return refuse(ticket.error);
    // The tracker's own reference becomes the task so the run, the ledger line
    // and the ticket all say the same thing, and the link rides in the brief,
    // which is the part the receiving agent is given to read. The *reference*
    // rather than the key: for ClickUp they differ, and the reference is the
    // form `commentOnRunTracker` can route back to — an assignment made from a
    // picked ClickUp ticket used to finish in silence because the human-facing
    // key was what got stored.
    if (!task) task = ticket.value.reference;
    brief = briefWithTicket(brief, ticket.value);
  }

  if (task.length < 3 || task.length > 120) return refuse('The task needs 3 to 120 characters.');
  if (brief.length < 10 || brief.length > 8000) {
    return refuse('The brief needs 10 to 8000 characters.');
  }
  if (branch.length > 300) return refuse('The branch name is too long.');
  const steps = str('steps')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
  const agent = (await assignableAgents(db, team.id)).find(
    (a) => a.installationId === str('agent'),
  );
  if (!agent) return refuse('Choose an agent that is connected to this workspace.');
  if (agent.projectId && agent.projectId !== project.id) {
    return refuse(`${agent.name} is connected to a different project only and cannot take work here.`);
  }
  const allowance = await handoffAllowance(db, env, team);
  if ('error' in allowance) return refuse(allowance.error);

  const draft: AssignmentDraft = {
    team: { id: team.id, slug: team.slug },
    project: { id: project.id, name: project.name, repositoryIdentity: project.repositoryIdentity },
    agent,
    assignedBy: { id: user.id, username: user.username, tokenId: null, via: null },
    task,
    brief,
    steps,
    branch: branch || null,
    scope: [],
  };
  const ids = { sessionId: randomUUID(), handoffId: randomUUID() };
  const created = await db.transaction(async (tx) =>
    writeAssignment(tx as unknown as Db, env, draft, ids),
  );
  try {
    await announceAssignment(db, env, team, draft, created);
  } catch {
    logLine({ evt: 'handoff', a: 'external_notification_failed' });
  }
  logLine({
    evt: 'handoff',
    a: 'assigned',
    session: created.sessionId,
    handoff: created.handoffId,
    team: team.slug,
    via: 'browser',
  });
  // Back to the project, not into the thread: the lead is dispatching, the next
  // thing they do is assign again or check whom this one went to, and the thread
  // lives under another part of the console with no way back here.
  return c.redirect(`${back}?assigned=${created.sessionId}#assigned-work`);
});
