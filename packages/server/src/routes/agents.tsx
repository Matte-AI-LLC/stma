import {
  areAttemptSiblings,
  detectClaimConflicts,
  quotaStateFor,
  type ClaimConflict,
  type ConflictClaim,
  type ConflictSeverity,
} from '@bridge/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import { policyReceipts } from '../db/schema';
import { activeRunsForMember, claimsForRuns, eventsForRun } from '../domain/agents';
import { evidenceForRun } from '../domain/evidence';
import { cheapestWith, planLimits } from '../lib/entitlements';
import { teamsOf } from '../mcp/shared';
import { initials, timeAgo } from '../lib/format';
import type { AppEnv } from '../types';
import { Band, Inspector, InspectorEmpty, Lead, PageHead, Vr } from '../ui/Console';
import { AppLayout } from '../ui/Layout';

export const agentsRoutes = new Hono<AppEnv>();

const rank: Record<ConflictSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** A heartbeat older than this is shown as gone quiet rather than live. */
const FRESH_MS = 5 * 60_000;
const MAX_CLAIM_TAGS = 3;

type Row = Awaited<ReturnType<typeof activeRunsForMember>>[number];
type Claim = Awaited<ReturnType<typeof claimsForRuns>>[number];


const claimKey = (runId: string, type: string, key: string, access: string) =>
  `${runId}|${type}|${key.toLowerCase()}|${access}`;

/** Unordered identity of a collision, so A-vs-B and B-vs-A render as one row. */
const clashKey = (conflict: ClaimConflict) =>
  [
    [conflict.current.runId, conflict.existing.runId].sort().join('~'),
    conflict.current.resourceType,
    [conflict.current.resourceKey, conflict.existing.resourceKey]
      .map((k) => k.toLowerCase())
      .sort()
      .join('~'),
  ].join('|');

const Hold = ({ claim, hot }: { claim: Claim; hot: boolean }) => (
  <div class={`holds${hot ? ' hot' : ''}`}>
    <span class="k">
      {claim.access === 'write' ? 'w' : 'r'}:{claim.resourceType}
    </span>
    <span style="min-width:0">{claim.resourceKey}</span>
  </div>
);

/**
 * What a run last said about its own vendor allowance, or nothing when there is
 * nothing worth a column here. A guess is drawn as a guess: the ledger is where a
 * teammate decides whether to wait for this run or take the work off it, and a
 * number the agent invented must not read like one it measured.
 */
const quotaPill = (run: Row['run']) => {
  if (run.quotaPct === null) return null;
  if (run.quotaSource !== 'measured') {
    // Only once a guess is high enough to matter — a run guessing 10% is noise.
    return quotaStateFor(run.quotaPct) === 'ok' ? null : (
      <span class="pill pill-muted">{run.quotaPct}% est.</span>
    );
  }
  return run.quotaState && run.quotaState !== 'ok' ? (
    <span class={`pill ${run.quotaState === 'critical' ? 'pill-danger' : 'pill-owner'}`}>
      {run.quotaPct}% used
    </span>
  ) : null;
};

/** The identity two runs are compared on to tell attempts from collisions. */
const attemptId = (row: Row) => ({
  ownerId: row.owner.id,
  attemptGroup: row.run.attemptGroup,
  taskKey: row.run.taskKey,
  worktree: row.run.worktree,
});

agentsRoutes.get('/app/agents', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const rows = await activeRunsForMember(db, user.id);
  // Whether *any* team this person is in can claim ground. The map is not gated
  // — the read-only view is the reason to upgrade, and hiding it hides that —
  // but the empty state must not send them at a tool that will refuse them.
  const teams = await teamsOf(db, user.id);
  const readOnlyFleet =
    teams.length > 0 &&
    teams.every((t) => planLimits(t.team.plan, c.get('env').hosted).fleet !== 'full');
  const fleetFrom = readOnlyFleet ? cheapestWith((l) => l.fleet === 'full') : null;
  const claims = await claimsForRuns(
    db,
    rows.map((row) => row.run.id),
  );
  const rowByRun = new Map(rows.map((row) => [row.run.id, row]));
  const conflictClaims: ConflictClaim[] = claims.map((claim) => {
    const row = rowByRun.get(claim.runId)!;
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

  // Parallel attempts at one task are siblings, not collisions — the same rule
  // the tools apply (areAttemptSiblings), so the page and the agent agree.
  const siblingsOf = new Map<string, Row[]>();
  for (const row of rows) {
    siblingsOf.set(
      row.run.id,
      rows.filter(
        (other) =>
          other.run.id !== row.run.id && areAttemptSiblings(attemptId(row), attemptId(other)),
      ),
    );
  }

  const severityByRun = new Map<string, ConflictSeverity>();
  // Kept per run, not just their severity: the inspector is where a human
  // decides what to do about an overlap, and "high" on its own does not say who
  // to go and talk to.
  const clashesByRun = new Map<string, ClaimConflict[]>();
  const clashing = new Set<string>();
  const clashes: ClaimConflict[] = [];
  const seenClash = new Set<string>();
  for (const row of rows) {
    const current = conflictClaims.filter((claim) => claim.runId === row.run.id);
    const siblingIds = new Set((siblingsOf.get(row.run.id) ?? []).map((s) => s.run.id));
    const existing = conflictClaims.filter((claim) => {
      const other = rowByRun.get(claim.runId);
      return (
        claim.runId !== row.run.id &&
        !siblingIds.has(claim.runId) &&
        other?.team.id === row.team.id &&
        other?.run.projectId === row.run.projectId
      );
    });
    const found = detectClaimConflicts(current, existing);
    const highest = found[0]?.severity;
    if (highest) severityByRun.set(row.run.id, highest);
    if (found.length > 0) clashesByRun.set(row.run.id, found);
    for (const conflict of found) {
      for (const side of [conflict.current, conflict.existing]) {
        clashing.add(claimKey(side.runId, side.resourceType, side.resourceKey, side.access));
      }
      const key = clashKey(conflict);
      if (seenClash.has(key)) continue;
      seenClash.add(key);
      clashes.push(conflict);
    }
  }
  clashes.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const claimsByRun = new Map<string, Claim[]>();
  for (const claim of claims) {
    const list = claimsByRun.get(claim.runId) ?? [];
    list.push(claim);
    claimsByRun.set(claim.runId, list);
  }

  // The inspector follows the ledger: selection is a query parameter, so it
  // survives the 30s reload and can be linked to.
  const wanted = c.req.query('run');
  const selected =
    (wanted ? rows.find((row) => row.run.id === wanted) : undefined) ??
    // Default to the run that most needs attention, then to the newest.
    rows.find((row) => severityByRun.get(row.run.id) === 'critical') ??
    rows[0];

  const trail = selected ? await eventsForRun(db, selected.run.id) : [];
  // The same pack an agent gets from get_evidence. A reviewer and the agent
  // that asked for review must be looking at one answer, not two.
  const pack = selected ? await evidenceForRun(db, selected.run.id, user.id) : null;
  const receipt = selected
    ? (
        await db
          .select()
          .from(policyReceipts)
          .where(eq(policyReceipts.runId, selected.run.id))
          .limit(1)
      )[0]
    : undefined;

  const critical = clashes.filter((clash) => clash.severity === 'critical');
  const projects = new Set(
    rows.map((row) => `${row.team.id}/${row.projectName ?? row.run.repo ?? '-'}`),
  );
  // Only a measured figure raises the band. The band is the team's alarm, and an
  // agent's own guess is not grounds for one — it still shows in the inspector,
  // labelled as a guess.
  const runningOut = rows.filter(
    (row) => row.run.quotaState === 'critical' && row.run.quotaSource === 'measured',
  );

  /** "attempt 2 of 3" — position among this run's own siblings, oldest first. */
  const attemptLabel = (row: Row): string | null => {
    const group = [row, ...(siblingsOf.get(row.run.id) ?? [])].sort(
      (a, b) => a.run.startedAt.getTime() - b.run.startedAt.getTime(),
    );
    if (group.length < 2) return null;
    return `attempt ${group.findIndex((g) => g.run.id === row.run.id) + 1} of ${group.length}`;
  };

  const strip = (
    <>
      <Lead text={rows.length > 0 ? 'Live' : 'Idle'} live={rows.length > 0} />
      <Vr />
      <span>
        {rows.length} {rows.length === 1 ? 'run' : 'runs'}
      </span>
      <span class="dim">·</span>
      <span>
        {claims.length} {claims.length === 1 ? 'claim' : 'claims'}
      </span>
      {critical.length > 0 ? (
        <>
          <span class="dim">·</span>
          <span class="bad">{critical.length} critical</span>
        </>
      ) : null}
      {runningOut.length > 0 ? (
        <>
          <span class="dim">·</span>
          <span class="bad">{runningOut.length} out of quota</span>
        </>
      ) : null}
      <Vr />
      <span data-freeze-state="poll 30s">poll 30s</span>
    </>
  );

  const scope = (
    <>
      <span class="chip">
        teams <b>{user.rail?.teams ?? 0}</b>
      </span>
      <span class="chip">
        projects <b>{projects.size}</b>
      </span>
    </>
  );

  const head = (
    <PageHead
      title="Live agent map"
      sub="Every active run, the scope it holds, and the authority to change it."
      actions={
        <>
          <button
            class="btn btn-sm"
            type="button"
            data-freeze="t"
            data-live-label="Freeze view"
            data-frozen-label="Resume live"
          >
            Freeze view
          </button>
          <a class="btn btn-sm" href="/app/sessions">
            Open a session
          </a>
        </>
      }
    />
  );

  const band =
    critical.length > 0 ? (
      <Band
        kind="danger"
        tag="Critical"
        actions={
          <a class="btn btn-sm" href={`/app/agents?run=${critical[0]!.current.runId}`}>
            Open in inspector
          </a>
        }
      >
        <b>
          {critical[0]!.current.resourceType}:{critical[0]!.current.resourceKey}
        </b>{' '}
        is held for write by two runs — {critical[0]!.current.owner}/
        {critical[0]!.current.taskKey ?? critical[0]!.current.agentName} and{' '}
        {critical[0]!.existing.owner}/
        {critical[0]!.existing.taskKey ?? critical[0]!.existing.agentName}
        {critical.length > 1 ? `, and ${critical.length - 1} more overlap` : ''}. Claims are
        advisory — STMA warns the agents, it does not lock the file.
      </Band>
    ) : runningOut.length > 0 ? (
      <Band
        kind="danger"
        tag="Out of quota"
        actions={
          <a class="btn btn-sm" href={`/app/agents?run=${runningOut[0]!.run.id}`}>
            Open in inspector
          </a>
        }
      >
        <b>
          {runningOut[0]!.owner.username}/
          {runningOut[0]!.run.taskKey ?? runningOut[0]!.installation.name}
        </b>{' '}
        has spent {runningOut[0]!.run.quotaPct}% of its vendor allowance
        {runningOut.length > 1 ? `, and ${runningOut.length - 1} more are close` : ''}. It has been
        told to hand the work off — the branch and the brief survive the limit even though the
        agent does not.
      </Band>
    ) : null;

  const inspector = selected ? (
    (() => {
      const held = claimsByRun.get(selected.run.id) ?? [];
      const severity = severityByRun.get(selected.run.id);
      const worst = (clashesByRun.get(selected.run.id) ?? [])[0];
      const others = (clashesByRun.get(selected.run.id) ?? []).length - 1;
      const fresh = Date.now() - selected.run.lastHeartbeatAt.getTime() < FRESH_MS;
      return (
        <Inspector>
          <div class="ins-head">
            <div class="ins-title">
              {selected.run.taskKey ?? selected.run.intent?.slice(0, 90) ?? 'Untitled run'}
            </div>
            <div class="ins-meta">
              <span class="avatar light">{initials(selected.owner.username)}</span>
              <span>{selected.owner.username}</span>
              <span class="dim">·</span>
              <span>{selected.installation.name}</span>
              <span class="dim">·</span>
              <span>{selected.installation.clientType}</span>
              {selected.installation.role ? (
                <>
                  <span class="dim">·</span>
                  <span>{selected.installation.role}</span>
                </>
              ) : null}
            </div>
          </div>
          <div class="ins-acts">
            <a class="btn btn-sm" href={`/app/teams/${selected.team.slug}/governance`}>
              Governance
            </a>
            <a class="btn btn-sm" href={`/app/teams/${selected.team.slug}/activity`}>
              Activity
            </a>
            {/* The run's project, not the session list: from a selected run the
                next question is almost always "what else is happening here",
                and that page now exists. */}
            {selected.projectName ? (
              <a
                class="btn btn-sm"
                href={`/app/teams/${selected.team.slug}/projects/${encodeURIComponent(
                  selected.projectName,
                )}`}
              >
                Project
              </a>
            ) : (
              <a class="btn btn-sm" href="/app/sessions">
                Sessions
              </a>
            )}
          </div>

          <div class="ins-sec">
            <span class="ins-label">Scope held</span>
            {held.length === 0 ? (
              <span class="muted small">
                This run declared no scope, so nobody can be warned about it.
              </span>
            ) : (
              held.map((claim) => (
                <Hold
                  claim={claim}
                  hot={clashing.has(
                    claimKey(claim.runId, claim.resourceType, claim.resourceKey, claim.access),
                  )}
                />
              ))
            )}
          </div>

          <div class="ins-sec">
            <span class="ins-label">Compliance</span>
            <div class="check">
              <span class={severity ? (severity === 'critical' ? 'n' : 'w') : 'y'}>
                {severity ? '!' : '✓'}
              </span>
              <span>
                {worst ? (
                  <>
                    Overlaps{' '}
                    <b>
                      {worst.existing.owner}/{worst.existing.taskKey ?? worst.existing.agentName}
                    </b>{' '}
                    — {severity}.{' '}
                    <span class="mono small">
                      {worst.current.resourceType}:{worst.current.resourceKey}
                    </span>
                    {worst.existing.resourceKey.toLowerCase() !==
                    worst.current.resourceKey.toLowerCase() ? (
                      <>
                        {' '}
                        against <span class="mono small">{worst.existing.resourceKey}</span>
                      </>
                    ) : null}
                    {others > 0 ? <span class="muted small"> +{others} more</span> : null}
                  </>
                ) : (
                  'No other live run overlaps this scope.'
                )}
              </span>
            </div>
            <div class="check">
              {/* Three states, not two: confirmed, drifted, and not yet answered.
                  Reading silence as breakage lit this line on every run an
                  MCP-only agent ever started. */}
              <span class={receipt?.drift ? 'n' : receipt?.reportedHash ? 'y' : 'w'}>
                {receipt?.reportedHash && !receipt.drift ? '✓' : '!'}
              </span>
              <span>
                {receipt?.drift
                  ? `Policy drift: applied ${(receipt.reportedHash ?? 'nothing').slice(0, 12)}, server served ${receipt.expectedHash.slice(0, 12)}.`
                  : receipt?.reportedHash
                    ? `Applied the policy the server served (${receipt.expectedHash.slice(0, 12)}).`
                    : 'Has not confirmed which rules it applied — an agent answers with update_run {"policy_hash": …} after reading get_policy.'}
              </span>
            </div>
            <div class="check">
              <span class={fresh ? 'y' : 'w'}>{fresh ? '✓' : '!'}</span>
              <span>
                Heartbeat {timeAgo(selected.run.lastHeartbeatAt)}
                {fresh ? '' : ' — the lease on its scope may already have expired.'}
              </span>
            </div>
            <div class="check">
              {/* Three things this line can be about, and they are not the same:
                  nothing reported, a number the agent guessed, and a number it
                  read. A guess shown as a fact is worse than no number — it is
                  the number a teammate plans around. */}
              <span
                class={
                  selected.run.quotaPct === null || selected.run.quotaSource !== 'measured'
                    ? 'w'
                    : selected.run.quotaState === 'critical'
                      ? 'n'
                      : selected.run.quotaState === 'warning'
                        ? 'w'
                        : 'y'
                }
              >
                {selected.run.quotaSource === 'measured' && selected.run.quotaState === 'ok'
                  ? '✓'
                  : '!'}
              </span>
              <span>
                {selected.run.quotaPct === null
                  ? 'This agent has not reported its vendor allowance, so nobody knows how close it is to stopping.'
                  : selected.run.quotaSource !== 'measured'
                    ? `${selected.run.quotaPct}% by the agent's own estimate${selected.run.quotaLabel ? ` (${selected.run.quotaLabel})` : ''} — it could not read a real figure, so STMA recorded it and did not act on it.`
                    : selected.run.quotaState === 'critical'
                      ? `${selected.run.quotaPct}% of its allowance is gone${selected.run.quotaLabel ? ` (${selected.run.quotaLabel})` : ''} — it was told to hand the work off rather than stop inside it.`
                      : selected.run.quotaState === 'warning'
                        ? `${selected.run.quotaPct}% of its allowance is gone${selected.run.quotaLabel ? ` (${selected.run.quotaLabel})` : ''} — enough room left to finish a step and write a handoff.`
                        : `${selected.run.quotaPct}% of its allowance is gone — room to work.`}
              </span>
            </div>
            {attemptLabel(selected) ? (
              <div class="check">
                <span class="y">✓</span>
                <span>
                  {attemptLabel(selected)} at{' '}
                  {selected.run.attemptGroup ?? selected.run.taskKey ?? 'this task'} — siblings do
                  not warn each other about overlapping scope.
                </span>
              </div>
            ) : null}
          </div>

          {pack && !('error' in pack) ? (
            <div class="ins-sec">
              <span class="ins-label">Merge readiness</span>
              {pack.checks.map((check) => (
                <div class="check">
                  <span class={check.state === 'ok' ? 'y' : check.state === 'attention' ? 'n' : 'w'}>
                    {check.state === 'ok' ? '✓' : check.state === 'attention' ? '!' : '?'}
                  </span>
                  <span>{check.detail}</span>
                </div>
              ))}
              <span class="muted small">
                {pack.blocking.length > 0
                  ? `Fix first: ${pack.blocking.join(', ')}.`
                  : pack.unconfirmed.length > 0
                    ? `Nothing failing, but unconfirmed: ${pack.unconfirmed.join(', ')}. Unconfirmed is not the same as fine.`
                    : 'Everything recorded checks out.'}
              </span>
            </div>
          ) : null}

          <div class="ins-sec">
            <span class="ins-label">Trail</span>
            {trail.length === 0 ? (
              <span class="muted small">No events recorded for this run.</span>
            ) : (
              <div class="trail">
                {trail.map((event) => (
                  <div>
                    <span class="at">{timeAgo(event.at)}</span> {event.type}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Inspector>
      );
    })()
  ) : (
    <InspectorEmpty text="No run selected. Start a run from any agent — start_run over MCP, or the stma CLI — and it appears here." />
  );

  return c.html(
    <AppLayout
      user={user}
      active="agents"
      title="Agent map"
      strip={strip}
      scope={scope}
      head={head}
      band={band}
      inspector={inspector}
      keys={[
        { k: '↵', label: 'select a run' },
        { k: 'F', label: 'freeze' },
      ]}
      keysNote="claims are advisory · every run writes to the trail"
      bleed
    >
      <div data-autorefresh="30" style="display:none"></div>
      {rows.length === 0 ? (
        <div class="empty">
          <h2>No active agent runs</h2>
          {/* What to do next depends on whether the plan lets you do it. Telling a
              free team to call start_run sent them at a tool that refuses them —
              the page has to know what the gate knows. */}
          {readOnlyFleet ? (
            <p>
              This map is read-only on your plan: it shows what your team's agents are holding, but
              a run cannot claim ground yet. Claiming is included from the {fleetFrom ?? 'paid'}{' '}
              plan up — until then the map fills in only if somebody else in the team is on one.
            </p>
          ) : (
            <p>
              Ask an agent to call <code>start_run</code> — over MCP that needs nothing installed,
              and the STMA CLI does it automatically from a lifecycle hook. A run appears here the
              moment it claims its first file.
            </p>
          )}
          <p class="m0 small muted">
            The map is presence, not history: a run leaves it a few minutes after its last
            heartbeat. What it did is still in Activity and on the governance timeline.
          </p>
        </div>
      ) : (
        <div class="ledger">
          <div class="lhead grid-runs">
            <span></span>
            <span>Run / owner</span>
            <span class="hide-sm">Scope held</span>
            <span class="hide-sm">Project · branch</span>
            <span class="hide-sm">Heartbeat</span>
            <span>Conflict</span>
          </div>
          {rows.map((row) => {
            const held = claimsByRun.get(row.run.id) ?? [];
            const severity = severityByRun.get(row.run.id);
            const fresh = Date.now() - row.run.lastHeartbeatAt.getTime() < FRESH_MS;
            return (
              <a
                class={`lrow grid-runs${selected?.run.id === row.run.id ? ' sel' : ''}`}
                href={`/app/agents?run=${row.run.id}`}
              >
                <span class={`dot${fresh ? '' : ' gray'}`}></span>
                <div class="lcell">
                  <div class="t">
                    {row.run.taskKey ?? row.run.intent?.slice(0, 70) ?? 'untitled run'}
                  </div>
                  <div class="s">
                    {row.owner.username} · {row.installation.name}
                    {row.installation.role ? ` · ${row.installation.role}` : ''}
                    {attemptLabel(row) ? ` · ${attemptLabel(row)}` : ''}
                  </div>
                </div>
                <div class="lmono hide-sm">
                  {held.length === 0
                    ? 'no declared scope'
                    : held
                        .slice(0, MAX_CLAIM_TAGS)
                        .map((claim) => `${claim.resourceType}:${claim.resourceKey}`)
                        .join(', ')}
                  {held.length > MAX_CLAIM_TAGS ? ` +${held.length - MAX_CLAIM_TAGS}` : ''}
                </div>
                <div class="lmono hide-sm">
                  <span class="l2">{row.projectName ?? row.run.repo ?? '—'}</span>
                  <span class="l2">{row.run.branch ?? 'no branch'}</span>
                </div>
                <span class={`lwhen hide-sm${fresh ? '' : ' old'}`}>
                  {timeAgo(row.run.lastHeartbeatAt)}
                </span>
                {severity ? (
                  <span class={`pill ${severity === 'critical' ? 'pill-danger' : 'pill-owner'}`}>
                    {severity}
                  </span>
                ) : (
                  // Quota decides for itself whether it has anything to say — an
                  // estimate no longer sets quota_state, so gating on that field
                  // hid every guessed figure from the ledger entirely.
                  (quotaPill(row.run) ?? <span class="lwhen old">clear</span>)
                )}
              </a>
            );
          })}
          <div class="lend">
            — end of active runs · {rows.length} shown · a run leaves this list when it finishes or
            stops sending heartbeats
          </div>
        </div>
      )}
    </AppLayout>,
  );
});
