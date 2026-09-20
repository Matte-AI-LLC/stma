import {
  areAttemptSiblings,
  describeHolder,
  detectClaimConflicts,
  holderNeedsAPerson,
  quotaStateFor,
  type ClaimConflict,
  type ConflictClaim,
  type ConflictSeverity,
} from '@bridge/shared';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import { policyReceipts } from '../db/schema';
import { activeRunsForMember, claimsForRuns, revokeAgentInstallation } from '../domain/agents';
import {
  pastGroundForRuns,
  recentRunsForMember,
  RECENT_RUN_HOURS,
  eventsForRun,
  installationsForMember,
} from '../domain/fleetReaders';
import { evidenceForRun } from '../domain/evidence';
import { cheapestWith, effectiveLimits } from '../lib/entitlements';
import { teamsOf } from '../mcp/shared';
import { initials, timeAgo } from '../lib/format';
import { track } from '../lib/track';
import type { AppEnv } from '../types';
import { Band, Inspector, InspectorEmpty, Lead, PageHead, teamTrail, Vr } from '../ui/Console';
import { AppLayout } from '../ui/Layout';
import {
  ScopeGraph,
  graphOverflow,
  type GraphRun,
  type GraphScope,
  type GraphSelection,
} from '../ui/ScopeGraph';

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
  // The map has a scope, like every other page: a workspace, or a project inside
  // it. It used to pour every workspace the person belongs to into one ledger,
  // which answers no question anybody has (the owner's words, 2026-09-20). The
  // unscoped address still works and still shows everything.
  const scopeTeam = (c.req.query('team') ?? '').trim() || undefined;
  const scopeProject = scopeTeam && user.rail?.team === scopeTeam ? (user.rail.project ?? undefined) : undefined;
  const scopeName = user.rail?.list.find((entry) => entry.slug === scopeTeam)?.name ?? scopeTeam;
  const rows = await activeRunsForMember(db, user.id, scopeTeam, scopeProject?.id);
  // The map remembers a little: agents with no live run keep their newest ended
  // one for a day, and every drawn run keeps the ground it let go of. Presence
  // alone forgot both the moment work was done (asked for 2026-09-19).
  const recent = await recentRunsForMember(db, user.id, rows.map((row) => row.installation.id), scopeTeam, scopeProject?.id);
  const pastGround = await pastGroundForRuns(db, [...rows, ...recent].map((row) => row.run.id));
  const installations = await installationsForMember(db, user.id);
  // Inventory is an operations surface, not a registration ledger. Put agents
  // that are holding live work first, then keep every group newest-first. The
  // domain query happens to return lastSeen order today, but shared/owned IDs
  // are assembled separately and that implementation detail is not a UI sort
  // contract.
  const installationSeenAt = (entry: (typeof installations)[number]) =>
    Math.max(
      entry.installation.lastSeenAt.getTime(),
      entry.activeRun?.run.lastHeartbeatAt.getTime() ??
        entry.latestRun?.run.lastHeartbeatAt.getTime() ??
        0,
    );
  const sortedInstallations = [...installations].sort((a, b) => {
    const aActive = Boolean(a.activeRun && !a.installation.revokedAt);
    const bActive = Boolean(b.activeRun && !b.installation.revokedAt);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return installationSeenAt(b) - installationSeenAt(a);
  });
  // Whether *any* team this person is in can claim ground. The map is not gated
  // — the read-only view is the reason to upgrade, and hiding it hides that —
  // but the empty state must not send them at a tool that will refuse them.
  const teams = await teamsOf(db, user.id);
  const readOnlyFleet =
    teams.length > 0 &&
    (await Promise.all(teams.map((t) => effectiveLimits(db, t.team, c.get('env').hosted)))).every((l) => l.fleet !== 'full');
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
      // The inspector is where somebody decides who to go and talk to, so it
      // carries the same two facts the tools now answer with: what the holding
      // run is doing, and when its hold lapses.
      runState: row.run.status as ConflictClaim['runState'],
      leaseEndsAt: claim.leaseExpiresAt.toISOString(),
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

  // What each drawn run held and no longer holds, one entry per piece of ground,
  // minus anything it holds again right now.
  const pastByRun = new Map<string, Claim[]>();
  for (const claim of pastGround) {
    const live = (claimsByRun.get(claim.runId) ?? []).some(
      (held) => held.resourceType === claim.resourceType && held.resourceKey.toLowerCase() === claim.resourceKey.toLowerCase(),
    );
    const list = pastByRun.get(claim.runId) ?? [];
    if (live || list.some((held) => held.resourceType === claim.resourceType && held.resourceKey.toLowerCase() === claim.resourceKey.toLowerCase())) continue;
    list.push(claim);
    pastByRun.set(claim.runId, list);
  }

  // Two tabs, both links: the inventory used to sit below the ledger, where a
  // reader scrolled past every live run to reach an idle identity.
  const tab = c.req.query('tab') === 'identities' ? 'identities' : 'map';
  // A filter, not a separate screen. `critical` is the one state somebody wants
  // the rest of the map out of the way for. It narrows what is drawn and listed
  // and nothing else — the counts in the status strip keep describing the team.
  const criticalOnly = c.req.query('only') === 'critical';
  const visibleRows = criticalOnly
    ? rows.filter((row) => severityByRun.get(row.run.id) === 'critical')
    : rows;

  // ---- the same facts, drawn ----
  // Every input below is read from a map the ledger already built. The graph is
  // a second rendering, never a second source: recomputing "contested" here is
  // how a red box and a green badge start describing one claim differently.
  const scopeId = (type: string, key: string) => `${type}:${key.toLowerCase()}`;
  const contestedScopes = new Set<string>();
  for (const clash of clashes) {
    for (const side of [clash.current, clash.existing]) {
      contestedScopes.add(scopeId(side.resourceType, side.resourceKey));
    }
  }
  const holdersOf = new Map<string, Set<string>>();
  for (const claim of claims) {
    const id = scopeId(claim.resourceType, claim.resourceKey);
    holdersOf.set(id, (holdersOf.get(id) ?? new Set()).add(claim.runId));
  }
  const graphScopes: GraphScope[] = [...holdersOf.keys()]
    .map((id) => {
      const claim = claims.find((entry) => scopeId(entry.resourceType, entry.resourceKey) === id)!;
      return {
        id,
        kind: claim.resourceType,
        label: claim.resourceKey,
        contested: contestedScopes.has(id),
        holders: holdersOf.get(id)?.size ?? 0,
      };
    })
    // Contested ground first: the thing somebody opened this page for should not
    // be the box they have to scroll the graph to find.
    .sort((a, b) => Number(b.contested) - Number(a.contested) || a.label.localeCompare(b.label));
  // Then ground nobody holds any more. Never contested and no holder count: it is
  // a record of where an agent was, not a claim on anything.
  for (const claim of criticalOnly ? [] : pastGround) {
    const id = scopeId(claim.resourceType, claim.resourceKey);
    if (graphScopes.some((scope) => scope.id === id) || !pastByRun.get(claim.runId)?.includes(claim)) continue;
    graphScopes.push({ id, kind: claim.resourceType, label: claim.resourceKey, contested: false, holders: 0, past: true });
  }

  // A receipt per drawn run, for the glyph's policy badge. Silence is `unknown`
  // and never `ok` — the same rule the receipts table renders.
  const receipts = rows.length + recent.length
    ? await db
        .select()
        .from(policyReceipts)
        .where(inArray(policyReceipts.runId, [...rows, ...recent].map((row) => row.run.id)))
    : [];
  const receiptByRun = new Map(receipts.map((entry) => [entry.runId, entry]));
  const policyOf = (runId: string): GraphRun['policy'] => {
    const entry = receiptByRun.get(runId);
    if (!entry?.reportedHash) return 'unknown';
    return entry.drift ? 'drift' : 'ok';
  };

  const heldEarlier = (runId: string) =>
    (pastByRun.get(runId) ?? []).map((claim) => ({
      scope: scopeId(claim.resourceType, claim.resourceKey),
      access: claim.access === 'write' ? ('write' as const) : ('read' as const),
    }));
  const graphRuns: GraphRun[] = visibleRows.map((row) => ({
    id: row.run.id,
    task: row.run.taskKey ?? row.run.intent ?? 'untitled run',
    who: `${row.owner.username} · ${row.installation.name}`,
    initials: initials(row.owner.username),
    fresh: Date.now() - row.run.lastHeartbeatAt.getTime() < FRESH_MS,
    quotaPct: row.run.quotaPct,
    quotaMeasured: row.run.quotaSource === 'measured',
    policy: policyOf(row.run.id),
    contested: (clashesByRun.get(row.run.id) ?? []).length > 0,
    // Only when this run actually has a sibling. A declared group of one is a
    // label, not a fan-out, and drawing a frame around it would claim otherwise.
    attemptGroup: (siblingsOf.get(row.run.id) ?? []).length > 0 ? row.run.attemptGroup : null,
    holds: (claimsByRun.get(row.run.id) ?? []).map((claim) => ({
      scope: scopeId(claim.resourceType, claim.resourceKey),
      access: claim.access === 'write' ? ('write' as const) : ('read' as const),
    })),
    held: criticalOnly ? [] : heldEarlier(row.run.id),
  }));
  // Live runs first: on a bounded graph what is happening must never be pushed
  // out by what happened.
  for (const row of criticalOnly ? [] : recent) {
    graphRuns.push({
      id: row.run.id,
      task: row.run.taskKey ?? row.run.intent ?? 'untitled run',
      who: `${row.owner.username} · ${row.installation.name}`,
      initials: initials(row.owner.username),
      fresh: false,
      quotaPct: null,
      quotaMeasured: false,
      policy: policyOf(row.run.id),
      contested: false,
      attemptGroup: null,
      holds: [],
      held: heldEarlier(row.run.id),
      ended: true,
    });
  }

  // The inspector follows the ledger: selection is a query parameter, so it
  // survives the 30s reload and can be linked to.
  const wanted = c.req.query('run');
  const wantedRun = wanted ? [...rows, ...recent].find((row) => row.run.id === wanted) : undefined;
  const endedIds = new Set(recent.map((row) => row.run.id));
  // An exact deep link must never silently turn into an unrelated run. If its
  // target finished between the inbox render and the click, keep the inspector
  // empty and explain where the history lives.
  // A piece of scope can be selected too — that is the other half of "click a
  // run or a piece of ground". It answers a different question (who is holding
  // this, and is anybody else) so it takes the inspector rather than sharing it.
  const wantedScope = c.req.query('scope');
  const selectedScope = wantedScope
    ? graphScopes.find((scope) => scope.id === wantedScope)
    : undefined;
  const selected = selectedScope
    ? undefined
    : wanted
      ? wantedRun
      : // Default to the run that most needs attention, then to the newest.
        visibleRows.find((row) => severityByRun.get(row.run.id) === 'critical') ?? visibleRows[0];
  const missingWantedRun = Boolean(wanted && !wantedRun);
  const selection: GraphSelection = selectedScope
    ? { type: 'scope', id: selectedScope.id }
    : selected
      ? { type: 'run', id: selected.run.id }
      : null;
  /** Keep the tab and the filter while selection changes, so a link is one click back. */
  const keep = [
    scopeTeam ? `team=${encodeURIComponent(scopeTeam)}` : '',
    scopeProject ? `project=${encodeURIComponent(scopeProject.slug)}` : '',
    tab === 'identities' ? 'tab=identities' : '',
    criticalOnly ? 'only=critical' : '',
  ].filter(Boolean);
  /** The map's own address in the current scope, for the links that change tab or filter. */
  const scopeParams = keep.filter((param) => param.startsWith('team=') || param.startsWith('project='));
  const scopedHref = (params: string[]) => {
    const all = [...scopeParams, ...params].filter(Boolean);
    return `/app/agents${all.length ? `?${all.join('&')}` : ''}`;
  };
  const mapHref = (params: string[]) => {
    const all = [...params, ...keep].filter(Boolean);
    return `/app/agents${all.length ? `?${all.join('&')}` : ''}`;
  };

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
      <span class="dim">·</span>
      <span>
        {installations.length} {installations.length === 1 ? 'agent identity' : 'agent identities'}
      </span>
      {critical.length > 0 ? (
        <>
          <span class="dim">·</span>
          {/* The one count somebody wants the rest of the map out of the way for,
              so it is the control as well as the number. A link, so the filtered
              view is a URL a teammate can be sent. */}
          <a
            class={`stripfilter${criticalOnly ? ' on' : ''}`}
            href={scopedHref([criticalOnly ? '' : 'only=critical', tab === 'identities' ? 'tab=identities' : ''])}
          >
            <span class="d"></span>
            {critical.length} critical{criticalOnly ? ' · showing only' : ''}
          </a>
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
        active projects <b>{projects.size}</b>
      </span>
    </>
  );

  const head = (
    <PageHead
      trail={
        scopeTeam && scopeProject
          ? teamTrail(
              { slug: scopeTeam, name: scopeName },
              { label: 'Projects', href: `/app/teams/${scopeTeam}/projects` },
              { label: scopeProject.name, href: `/app/teams/${scopeTeam}/projects/${encodeURIComponent(scopeProject.slug)}` },
              { label: 'Agents' },
            )
          : scopeTeam
            ? teamTrail({ slug: scopeTeam, name: scopeName }, { label: 'Agent map' })
            : [{ label: 'All workspaces', href: '/app' }, { label: 'Agent map' }]
      }
      title="Live agent map"
      sub="Active work first, then every known agent identity — including idle or stale devices that would otherwise disappear."
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
          <a class="btn btn-sm" href={mapHref([`run=${critical[0]!.current.runId}`])}>
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
          <a class="btn btn-sm" href={mapHref([`run=${runningOut[0]!.run.id}`])}>
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

  const inspector = selectedScope ? (
    (() => {
      // Every holder, not just the ones the filter left on screen: "who else is
      // on this ground" is exactly the question a filtered-out run answers.
      const holders = rows
        .map((row) => ({
          row,
          claim: (claimsByRun.get(row.run.id) ?? []).find(
            (entry) => scopeId(entry.resourceType, entry.resourceKey) === selectedScope.id,
          ),
        }))
        .filter((entry) => entry.claim);
      return (
        <Inspector>
          <div class="ins-head">
            <span class="ins-kicker">{selectedScope.kind}</span>
            <div class="ins-title mono">{selectedScope.label}</div>
            <div class="ins-meta">
              <span>
                {holders.length} {holders.length === 1 ? 'live run' : 'live runs'} holding
              </span>
            </div>
          </div>
          <div class="ins-acts">
            <a class="btn btn-sm" href={mapHref([])}>
              Clear selection
            </a>
          </div>
          <div class="ins-sec">
            <span class="ins-label">Held by</span>
            {holders.map(({ row, claim }) => (
              <a
                class={`holds${claim!.access === 'write' && selectedScope.contested ? ' hot' : ''}`}
                href={mapHref([`run=${row.run.id}`])}
              >
                <span class="k">{claim!.access === 'write' ? 'w' : 'r'}</span>
                <span style="min-width:0">
                  {row.owner.username} · {row.run.taskKey ?? row.installation.name}
                </span>
              </a>
            ))}
          </div>
          <div class="ins-sec">
            <span class="ins-label">Verdict</span>
            <div class="check">
              <span class={selectedScope.contested ? 'n' : 'y'}>
                {selectedScope.contested ? '!' : '✓'}
              </span>
              <span>
                {selectedScope.contested
                  ? 'Held for write by more than one live run. Claims are advisory — both agents were warned, nothing is locked.'
                  : 'No competing write claim on this ground right now.'}
              </span>
            </div>
          </div>
        </Inspector>
      );
    })()
  ) : selected ? (
    (() => {
      const held = claimsByRun.get(selected.run.id) ?? [];
      const severity = severityByRun.get(selected.run.id);
      const worst = (clashesByRun.get(selected.run.id) ?? [])[0];
      const others = (clashesByRun.get(selected.run.id) ?? []).length - 1;
      // Who was on the contested ground first: the same fact the guard and the
      // agents' replies use, read from the same rows.
      const firstOn = (side: { runId: string; resourceType: string; resourceKey: string }) =>
        claims.find(
          (claim) =>
            claim.runId === side.runId &&
            claim.resourceType === side.resourceType &&
            claim.resourceKey.toLowerCase() === side.resourceKey.toLowerCase(),
        )?.firstDeclaredAt ?? null;
      const mineFirst = worst ? firstOn(worst.current) : null;
      const theirsFirst = worst ? firstOn(worst.existing) : null;
      const rightOfWay = mineFirst && theirsFirst ? (mineFirst < theirsFirst ? 'mine' : 'theirs') : null;
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
            {endedIds.has(selected.run.id) ? (
              <span class="muted small">
                This run ended {timeAgo(selected.run.endedAt ?? selected.run.lastHeartbeatAt)} and holds
                nothing. It stays on the map for {RECENT_RUN_HOURS} hours; its trail is below and on
                Governance.
              </span>
            ) : held.length === 0 ? (
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

          {(pastByRun.get(selected.run.id) ?? []).length > 0 ? (
            <div class="ins-sec">
              <span class="ins-label">Held earlier</span>
              <span class="muted small">
                Let go when the work was reported complete or the run ended. Nobody is stopped by it
                now; an agent that began before then is told the ground moved.
              </span>
              {(pastByRun.get(selected.run.id) ?? []).slice(0, 12).map((claim) => (
                <Hold claim={claim} hot={false} />
              ))}
            </div>
          ) : null}

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
                    {/* What the other run is doing and how long it holds the
                        ground for. Same sentence the tool replies and the hook
                        carry, from the same describeHolder. */}
                    <span class="muted small" style="display:block">
                      {describeHolder(worst.existing)}
                      {holderNeedsAPerson(worst.existing.runState)
                        ? ' — it will not free the ground by itself.'
                        : ''}
                    </span>
                    {rightOfWay ? (
                      <span class="muted small" style="display:block">
                        {rightOfWay === 'mine'
                          ? 'This run declared it first and keeps the right of way; the other was told to wait.'
                          : 'The other run declared it first; this one was told to wait.'}
                      </span>
                    ) : null}
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
                    ? `Reported hash matches the served policy (${receipt.expectedHash.slice(0, 12)}).`
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
                  <span>{check.detail}<small class="muted" style="display:block">{check.source} · {check.coverage} · {check.observedAt ?? 'observation time unknown'}{check.limitations?.map((limit) => <span style="display:block">{limit}</span>)}</small></span>
                </div>
              ))}
              <span class="muted small">
                {pack.blocking.length > 0
                  ? `Fix first: ${pack.blocking.join(', ')}.`
                  : pack.unconfirmed.length > 0
                    ? `Nothing failing, but unconfirmed: ${pack.unconfirmed.join(', ')}. Unconfirmed is not the same as fine.`
                    : 'No recorded failure in the checks shown. Missing evidence is not approval.'}
              </span>
              <details><summary>Exact-commit provider observations ({pack.providerFacts.length})</summary><p class="small muted">{pack.providerCoverage}</p>{pack.providerFacts.map((row) => <p>{row.fullName} · {row.fact.commitSha.slice(0, 12)} · {row.fact.subjectId} attempt {row.fact.attempt}: {row.fact.state}</p>)}</details>
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
      {c.req.query('error') ? (
        <div class="banner banner-error">
          <span class="ic">!</span>
          <span>{c.req.query('error')}</span>
        </div>
      ) : null}
      {c.req.query('ok') ? (
        <div class="banner banner-success">
          <span class="ic">✓</span>
          <span>{c.req.query('ok')}</span>
        </div>
      ) : null}
      {missingWantedRun ? (
        <div class="banner banner-warn">
          <span class="ic">!</span>
          <span>
            That exact run is no longer active. STMA did not substitute another agent. Its
            retained history remains in the workspace Activity and Governance pages.
          </span>
        </div>
      ) : null}
      <div data-autorefresh="30" style="display:none"></div>
      {/* Links, not script — the tab is in the URL and survives the 30s reload. */}
      <div class="pagetabs">
        <a
          class={`tab${tab === 'map' ? ' active' : ''}`}
          href={scopedHref([criticalOnly ? 'only=critical' : ''])}
        >
          Live map
        </a>
        <a
          class={`tab${tab === 'identities' ? ' active' : ''}`}
          href={scopedHref(['tab=identities', criticalOnly ? 'only=critical' : ''])}
        >
          Identities <span class="tab-n">{installations.length}</span>
        </a>
      </div>
      {tab === 'identities' ? null : rows.length === 0 && recent.length === 0 ? (
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
      ) : visibleRows.length === 0 && criticalOnly ? (
        <div class="empty">
          <h2>Nothing critical right now</h2>
          <p>
            {rows.length} {rows.length === 1 ? 'run is' : 'runs are'} live and none of them holds
            ground another live run is also writing to.
          </p>
          <p class="m0">
            <a class="btn btn-sm" href={scopedHref([])}>
              Show every run
            </a>
          </p>
        </div>
      ) : (
        <div class={`map-split${graphRuns.length > 0 ? '' : ' solo'}`}>
        {graphRuns.length > 0 ? (
          <div class="sg-wrap">
            <div class="sg-head">
              <span class="sg-cap">
                Scope graph{criticalOnly ? ' · critical only' : ''}
              </span>
              <div class="sg-key">
                <span>
                  <i class="w"></i>write
                </span>
                <span>
                  <i class="r"></i>read
                </span>
                <span>
                  <i class="c"></i>contested
                </span>
                <span>
                  <i class="g"></i>attempt group
                </span>
                <span>
                  <i class="p"></i>earlier
                </span>
              </div>
            </div>
            <div class="sg-scroll">
              <ScopeGraph
                runs={graphRuns}
                scopes={graphScopes}
                selection={selection}
                runHref={(id) => mapHref([`run=${id}`])}
                scopeHref={(id) => mapHref([`scope=${encodeURIComponent(id)}`])}
              />
            </div>
            {graphOverflow(graphRuns.length, graphScopes.length) ? (
              <div class="sg-over">{graphOverflow(graphRuns.length, graphScopes.length)}</div>
            ) : null}
          </div>
        ) : null}
        <div class="ledger">
          <div class="lhead grid-runs">
            <span></span>
            <span>Run / owner</span>
            <span class="hide-sm">Scope held</span>
            <span class="hide-sm">Project · branch</span>
            <span class="hide-sm">Heartbeat</span>
            <span>Conflict</span>
          </div>
          {visibleRows.map((row) => {
            const held = claimsByRun.get(row.run.id) ?? [];
            const severity = severityByRun.get(row.run.id);
            const fresh = Date.now() - row.run.lastHeartbeatAt.getTime() < FRESH_MS;
            return (
              <a
                class={`lrow grid-runs${selected?.run.id === row.run.id ? ' sel' : ''}`}
                href={mapHref([`run=${row.run.id}`])}
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
            — end of active runs · {visibleRows.length} shown
            {criticalOnly && rows.length !== visibleRows.length
              ? ` of ${rows.length} · filtered to critical`
              : ''}{' '}
            · a run leaves this list when it finishes or stops sending heartbeats
          </div>
          {!criticalOnly && recent.length > 0 ? (
            <>
              <div class="lend">
                Not working right now · the newest run of each agent that ended in the last{' '}
                {RECENT_RUN_HOURS} hours, with the ground it held
              </div>
              {recent.map((row) => {
                const was = pastByRun.get(row.run.id) ?? [];
                return (
                  <a
                    class={`lrow grid-runs ended${selected?.run.id === row.run.id ? ' sel' : ''}`}
                    href={mapHref([`run=${row.run.id}`])}
                  >
                    <span class="dot gray"></span>
                    <div class="lcell">
                      <div class="t">{row.run.taskKey ?? row.run.intent?.slice(0, 70) ?? 'untitled run'}</div>
                      <div class="s">
                        {row.owner.username} · {row.installation.name}
                        {row.installation.role ? ` · ${row.installation.role}` : ''}
                      </div>
                    </div>
                    <div class="lmono hide-sm">
                      {was.length === 0
                        ? 'held nothing'
                        : `held ${was
                            .slice(0, MAX_CLAIM_TAGS)
                            .map((claim) => `${claim.resourceType}:${claim.resourceKey}`)
                            .join(', ')}`}
                      {was.length > MAX_CLAIM_TAGS ? ` +${was.length - MAX_CLAIM_TAGS}` : ''}
                    </div>
                    <div class="lmono hide-sm">
                      <span class="l2">{row.projectName ?? row.run.repo ?? '—'}</span>
                      <span class="l2">{row.run.branch ?? 'no branch'}</span>
                    </div>
                    <span class="lwhen hide-sm old">{timeAgo(row.run.endedAt ?? row.run.lastHeartbeatAt)}</span>
                    <span class="lwhen old">{row.run.status === 'completed' ? 'finished' : row.run.status}</span>
                  </a>
                );
              })}
            </>
          ) : null}
        </div>
        </div>
      )}

      {tab === 'identities' && installations.length > 0 ? (
        <div class="card scroll-x" style="margin:16px">
          <div class="card-head">
            <div>
              <div class="card-title">Agent inventory</div>
              <div class="card-note">
                Durable identities across your teams. Idle agents stay visible after their run
                leaves the live map; only an identity you own can be disabled here.
              </div>
            </div>
            <span class="mono muted">{installations.length}</span>
          </div>
          <table class="tbl">
            <tr>
              <th>Agent / owner</th>
              <th>Client / role</th>
              <th>Last context</th>
              <th>Last seen</th>
              <th>Status</th>
              <th></th>
            </tr>
            {sortedInstallations.map((entry) => {
              const context = entry.activeRun ?? entry.latestRun;
              const active = entry.activeRun;
              const heartbeatFresh = active
                ? Date.now() - active.run.lastHeartbeatAt.getTime() < FRESH_MS
                : false;
              const seenAt = new Date(
                Math.max(
                  entry.installation.lastSeenAt.getTime(),
                  context?.run.lastHeartbeatAt.getTime() ?? 0,
                ),
              );
              return (
                <tr style={entry.installation.revokedAt ? 'color:var(--mut-2)' : undefined}>
                  <td>
                    <div class="name">{entry.installation.name}</div>
                    <div class="muted small">
                      {entry.owner.username} · <span class="mono">{entry.installation.id.slice(0, 8)}</span>
                    </div>
                  </td>
                  <td>
                    <div>{entry.installation.clientType}</div>
                    <div class="muted small">
                      {entry.installation.role ?? 'no role'}
                      {entry.installation.clientVersion
                        ? ` · v${entry.installation.clientVersion}`
                        : ''}
                    </div>
                  </td>
                  <td>
                    {context ? (
                      <>
                        <div>{context.team.slug} · {context.projectName ?? context.run.repo ?? 'team-wide'}</div>
                        <div class="muted small">
                          {context.run.taskKey ?? context.run.intent?.slice(0, 70) ?? context.run.status}
                        </div>
                      </>
                    ) : (
                      <span class="muted">Registered; no run yet</span>
                    )}
                  </td>
                  <td class="muted">{timeAgo(seenAt) ?? '—'}</td>
                  <td>
                    {entry.installation.revokedAt ? (
                      <span class="pill pill-muted"><span class="dot gray" />disabled</span>
                    ) : active ? (
                      <span class={`pill ${heartbeatFresh ? 'pill-active' : 'pill-owner'}`}>
                        <span class={`dot${heartbeatFresh ? '' : ' gray'}`} />
                        {heartbeatFresh ? active.run.status : 'heartbeat overdue'}
                      </span>
                    ) : (
                      <span class="pill pill-muted"><span class="dot gray" />idle</span>
                    )}
                  </td>
                  <td style="text-align:right">
                    {entry.owner.id === user.id && !entry.installation.revokedAt ? (
                      <form
                        class="m0"
                        method="post"
                        action={`/app/agents/installations/${entry.installation.id}/revoke`}
                        data-confirm={`This disables the run identity “${entry.installation.name}” and ends any active runs holding scope. Its one-to-one enrollment credential is revoked too; legacy manually registered identities still keep their separate token control.`}
                        data-confirm-title={`Disable ${entry.installation.name}?`}
                        data-confirm-action="Disable identity"
                      >
                        <button class="linklike" type="submit">Disable</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </table>
        </div>
      ) : null}
    </AppLayout>,
  );
});

agentsRoutes.post('/app/agents/installations/:id/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const result = await revokeAgentInstallation(c.get('db'), user.id, c.req.param('id'));
  if ('error' in result && result.error) {
    return c.redirect(`/app/agents?error=${encodeURIComponent(result.error)}`);
  }
  const teams = new Map(
    result.affected.map((run) => [run.teamId, run]),
  );
  for (const run of teams.values()) {
    await track(c.get('db'), {
      teamId: run.teamId,
      projectId: run.projectId,
      userId: user.id,
      action: 'agent_installation_revoked',
      detail: `${result.installation.name}${result.affected.length > 0 ? `; ended ${result.affected.length} active run(s)` : ''}`,
    });
  }
  return c.redirect(
    `/app/agents?ok=${encodeURIComponent(`Disabled ${result.installation.name}. Its identity cannot register itself again.`)}`,
  );
});
