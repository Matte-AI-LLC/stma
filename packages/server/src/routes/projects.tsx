import {
  areAttemptSiblings,
  detectClaimConflicts,
  type ConflictClaim,
  type ConflictSeverity,
} from '@bridge/shared';
import { and, count, countDistinct, desc, eq, gt, inArray, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import {
  activity,
  agentRuns,
  debugSessions,
  deliveryFlows,
  environmentBaselines,
  policyBundles,
  projects,
  snapshots,
} from '../db/schema';
import { teamForUser } from '../domain/access';
import { activeRunsForMember, claimsForRuns, recentAgentEvents } from '../domain/agents';
import { activeBaselines, recentEnvironmentChecks } from '../domain/environments';
import { effectivePolicy, recentPolicyReceipts } from '../domain/policies';
import { timeAgo } from '../lib/format';
import type { AppEnv } from '../types';
import { Band, Lead, PageHead, Vr } from '../ui/Console';
import { AppLayout } from '../ui/Layout';

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
      .where(and(inArray(debugSessions.projectId, ids), eq(debugSessions.status, 'open')))
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
          crumb={`/ ${team.slug} / projects`}
          title="Projects"
          sub="Born automatically from the repo identifier agents send. Each one owns its policy, baseline, flow and sessions."
        />
      }
      keys={[{ k: 'G', label: 'agent map' }]}
      keysNote="a project appears the first time an agent names its repo — there is nothing to create"
    >
      {rows.length === 0 ? (
        <div class="card card-pad muted small">
          No projects yet. One appears the first time an agent names its repository — through{' '}
          <code>start_run</code>, a snapshot, or a session opened with a repo name. Nothing to
          create here.
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
                    <a href={`/app/teams/${team.slug}/projects/${encodeURIComponent(p.name)}`}>
                      {p.name}
                    </a>
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
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const team = access.team;
  const name = c.req.param('project');

  const found = await db
    .select()
    .from(projects)
    .where(and(eq(projects.teamId, team.id), eq(projects.name, name)))
    .limit(1);
  const project = found[0];
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

  const sessions = await db
    .select({ session: debugSessions })
    .from(debugSessions)
    .where(and(eq(debugSessions.projectId, project.id), eq(debugSessions.status, 'open')))
    .orderBy(desc(debugSessions.createdAt))
    .limit(SESSIONS_SHOWN);
  const openCount = (
    await db
      .select({ n: count() })
      .from(debugSessions)
      .where(and(eq(debugSessions.projectId, project.id), eq(debugSessions.status, 'open')))
  )[0]?.n ?? 0;

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

  const policy = await effectivePolicy(db, user.id, { team: team.slug, project: project.name });
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

  const policyDoc = 'error' in policy ? null : policy;
  // The merged document, read the way get_policy serves it — so the card and the
  // agent are quoting one answer rather than two summaries of it.
  const rules: string[] = [];
  const projectScope = policyDoc?.sources.find((source) => source.scope.startsWith('project:'));
  if (policyDoc) {
    const doc = policyDoc.document;
    for (const rule of doc.autonomy?.requireApprovalFor ?? []) rules.push(`Needs a person: ${rule}`);
    for (const rule of doc.permissions?.requireApproval ?? []) rules.push(`Requires approval: ${rule}`);
    for (const key of doc.environment?.requiredEnvVarNames ?? []) rules.push(`Required env var: ${key}`);
    for (const check of doc.requiredChecks ?? []) rules.push(`Check: ${check}`);
    for (const path of doc.protectedPaths ?? []) rules.push(`Protected: ${path}`);
    for (const line of doc.permissions?.deny ?? []) rules.push(`Denied: ${line}`);
  }

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
          crumb={`/ ${team.slug} / projects / ${project.name}`}
          title={project.name}
          sub="Everything about this project on one page: live runs, sessions, policy, environment and delivery — with the way to change each."
          actions={
            <>
              <a
                class="btn btn-sm"
                href={`/app/teams/${team.slug}/compare?project=${encodeURIComponent(project.name)}`}
              >
                Compare machines
              </a>
              <a class="btn btn-sm" href="/app/sessions">
                Open a session
              </a>
              <a class="btn btn-sm btn-primary" href="/app/agents">
                View on agent map
              </a>
            </>
          }
        />
      }
      band={
        worst === 'critical' ? (
          <Band
            kind="danger"
            tag="critical"
            actions={
              <a class="btn btn-sm" href="/app/agents">
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
              <a class="btn btn-sm" href="/app/agents">
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

          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">Open sessions</div>
                <div class="card-note">Debug threads tagged {project.name}.</div>
              </div>
              <a class="btn btn-sm" href="/app/sessions">
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
                  <span class="pill pill-ok">open</span>
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
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/activity?project=${encodeURIComponent(project.name)}`}>
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
                    <td class="mono">{row.event.type}</td>
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
                <div class="card-title">Policy</div>
                <div class="card-note">This project's additions, merged onto team rules.</div>
              </div>
              {projectScope ? (
                <span class="pill pill-active">
                  v{projectScope.version}
                  {confirmed !== null ? ' · confirmed' : ''}
                </span>
              ) : (
                <span class="pill">team only</span>
              )}
            </div>
            {rules.length === 0 ? (
              <p class="m0 small muted">
                No rules in force for {project.name} beyond the team's. A project policy adds to
                the team document; it never replaces it.
              </p>
            ) : (
              rules.slice(0, 5).map((rule) => (
                <div class="factrow">
                  <span class="y">✓</span>
                  <span>{rule}</span>
                </div>
              ))
            )}
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
              <a
                class="btn btn-sm"
                href={`/app/teams/${team.slug}/governance?project=${encodeURIComponent(project.name)}`}
              >
                Edit policy
              </a>
              <a
                class="btn btn-sm"
                href={`/app/teams/${team.slug}/governance?project=${encodeURIComponent(project.name)}`}
              >
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
                href={`/app/teams/${team.slug}/compare?project=${encodeURIComponent(project.name)}`}
              >
                Compare machines
              </a>
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/governance`}>
                Update baseline
              </a>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>,
  );
});
