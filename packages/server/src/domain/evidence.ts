import { and, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { Db } from '../db';
import { exactProviderEvidence } from './providerEvidence';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  environmentChecks,
  knowledgeContexts,
  knowledgeItems,
  knowledgeReceipts,
  knowledgeVersions,
  policyReceipts,
  projects,
  runCheckpoints,
  teams,
  users,
  workClaims,
} from '../db/schema';
import { fingerprintJson } from '../lib/canonical';
import { canonicalRepositoryIdentity } from '../lib/projects';

/**
 * "Why is this change mergeable?" — assembled, not collected.
 *
 * Every part of the answer is already stored: the policy receipt says whether
 * the run applied the rules it was served, preflight says whether its machine
 * could build the project at all, the claims say what ground it took, the
 * events say who it collided with, and the trail says what it did. What did not
 * exist was one place that puts them together and names what is missing.
 *
 * That distinction matters for what this is allowed to say. It reports;
 * it never re-derives. If a run never sent a policy hash, the honest answer is
 * "unconfirmed", not a guess — a merge-readiness report that quietly fills in
 * blanks is worse than no report, because somebody will trust it.
 */

export type EvidenceState = 'ok' | 'attention' | 'unknown';

export interface EvidenceCheck {
  key: string;
  state: EvidenceState;
  detail: string;
  source?: 'client_report' | 'stma_observation' | 'provider_observation' | 'human_approval';
  observedAt?: string | null;
  subject?: string;
  coverage?: 'reported' | 'bounded' | 'missing' | 'legacy' | 'exact';
  limitations?: string[];
}

const TRAIL_LIMIT = 20;

export async function evidenceForRun(db: Db, runId: string, viewerId: string) {
  const rows = await db
    .select({
      run: agentRuns,
      installation: agentInstallations,
      owner: users,
      team: teams,
      projectName: projects.name,
      projectRepositoryIdentity: projects.repositoryIdentity,
    })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .innerJoin(teams, eq(agentRuns.teamId, teams.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  const found = rows[0];
  if (!found) return { error: 'Unknown run.' } as const;

  // A mutable run head (and the branch-linked compatibility fields below) is
  // not delivery provenance. Provider results attach only to the newest
  // immutable delivery/test checkpoint. A later checkpoint therefore cannot
  // inherit an older commit's green workflow by accident.
  const checkpoint = (
    await db
      .select()
      .from(runCheckpoints)
      .where(
        and(
          eq(runCheckpoints.runId, runId),
          inArray(runCheckpoints.kind, ['delivery', 'tested']),
        ),
      )
      .orderBy(desc(runCheckpoints.createdAt), desc(runCheckpoints.id))
      .limit(1)
  )[0];
  const projectRepositoryIdentity = found.projectRepositoryIdentity
    ? canonicalRepositoryIdentity(found.projectRepositoryIdentity)
    : null;
  const checkpointRepositoryIdentity = checkpoint
    ? canonicalRepositoryIdentity(checkpoint.repositoryIdentity)
    : null;
  const checkpointRepositoryMatches = Boolean(
    checkpoint &&
      projectRepositoryIdentity &&
      checkpointRepositoryIdentity === projectRepositoryIdentity,
  );
  const providerFacts = checkpointRepositoryMatches
    ? await exactProviderEvidence(
        db,
        found.run.teamId,
        found.run.projectId,
        checkpoint!.commitSha,
      )
    : [];
  // `exactProviderEvidence` requires both sides of the immutable observation
  // to retain this project id and comes through an explicit verified binding.
  // That is the repository join: provider-specific locators (GitHub owner/name
  // and Azure org/project/repo) must not be guessed into one URL spelling here.
  // A provider may report several attempts for one workflow/PR. The query is
  // newest first, so retain one current fact per exact provider subject rather
  // than letting a superseded failure and success decide the state together.
  const seenProviderSubjects = new Set<string>();
  const currentProviderFacts = providerFacts.filter((row) => {
    const key = `${row.fact.bindingId}:${row.fact.kind}:${row.fact.subjectId}`;
    if (seenProviderSubjects.has(key)) return false;
    seenProviderSubjects.add(key);
    return true;
  });
  const providerFailures = currentProviderFacts.filter((row) =>
    ['failure', 'closed'].includes(row.fact.state),
  );
  const providerSuccesses = currentProviderFacts.filter((row) =>
    ['success', 'merged'].includes(row.fact.state),
  );

  // Membership, not ownership: a teammate's run is exactly what you want an
  // evidence pack for. `viewerId` is checked by the caller against the team.
  void viewerId;

  const claims = await db.select().from(workClaims).where(eq(workClaims.runId, runId));
  const receiptRows = await db
    .select()
    .from(policyReceipts)
    .where(eq(policyReceipts.runId, runId))
    .limit(1);
  const receipt = receiptRows[0];
  const knowledgeContext = (
    await db
      .select()
      .from(knowledgeContexts)
      .where(eq(knowledgeContexts.runId, runId))
      .orderBy(desc(knowledgeContexts.createdAt), desc(knowledgeContexts.id))
      .limit(1)
  )[0];
  const knowledgeReceipt = knowledgeContext
    ? (
        await db
          .select()
          .from(knowledgeReceipts)
          .where(
            and(
              eq(knowledgeReceipts.contextId, knowledgeContext.id),
              eq(knowledgeReceipts.runId, runId),
            ),
          )
          .orderBy(desc(knowledgeReceipts.servedAt))
          .limit(1)
      )[0]
    : undefined;
  const knowledgeManifest = knowledgeContext?.manifest as
    | { versions?: Array<{ itemId?: string; versionId?: string }> }
    | undefined;
  const knowledgeVersionIds = (knowledgeManifest?.versions ?? [])
    .map((version) => version.versionId)
    .filter((id): id is string => Boolean(id));
  const knowledgeHeads =
    knowledgeVersionIds.length > 0
      ? await db
          .select({
            versionId: knowledgeVersions.id,
            validUntil: knowledgeVersions.validUntil,
            currentVersionId: knowledgeItems.currentVersionId,
            state: knowledgeItems.state,
          })
          .from(knowledgeVersions)
          .innerJoin(knowledgeItems, eq(knowledgeVersions.itemId, knowledgeItems.id))
          .where(inArray(knowledgeVersions.id, knowledgeVersionIds))
      : [];
  const knowledgeStale =
    knowledgeHeads.length !== knowledgeVersionIds.length ||
    knowledgeHeads.some(
      (row) =>
        row.state !== 'active' ||
        row.currentVersionId !== row.versionId ||
        (row.validUntil !== null && row.validUntil <= new Date()),
    );
  const expectedKnowledgeHash = knowledgeContext
    ? fingerprintJson(knowledgeContext.manifest)
    : null;
  const knowledgeMatches = Boolean(
    knowledgeReceipt?.reportedManifestHash &&
      expectedKnowledgeHash === knowledgeReceipt.reportedManifestHash.toLowerCase(),
  );
  const checkRows = await db
    .select()
    .from(environmentChecks)
    .where(eq(environmentChecks.runId, runId))
    .orderBy(desc(environmentChecks.createdAt))
    .limit(1);
  const check = checkRows[0];
  const trail = await db
    .select({ type: agentEvents.type, detail: agentEvents.detail, at: agentEvents.createdAt })
    .from(agentEvents)
    .where(eq(agentEvents.runId, runId))
    .orderBy(desc(agentEvents.createdAt))
    .limit(TRAIL_LIMIT);
  // Overlap is written to the run that DETECTED it, which is whichever one
  // declared its scope second. Reading only this run's own events therefore
  // reports "nobody overlapped you" to the run that was overlapped — the exact
  // kind of confidently wrong line that makes a readiness pack worse than none.
  // So look both ways: what this run saw, and what saw this run.
  const seenByOthers = await db
    .select({ detail: agentEvents.detail })
    .from(agentEvents)
    .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
    .where(
      and(
        eq(agentEvents.type, 'conflicts_detected'),
        eq(agentRuns.teamId, found.run.teamId),
        found.run.projectId
          ? eq(agentRuns.projectId, found.run.projectId)
          : isNull(agentRuns.projectId),
        gte(agentEvents.createdAt, found.run.startedAt),
        found.run.endedAt ? lte(agentEvents.createdAt, found.run.endedAt) : undefined,
      ),
    )
    .orderBy(desc(agentEvents.createdAt))
    .limit(200);
  const namedElsewhere = seenByOthers.filter((row) =>
    ((row.detail as { otherRunIds?: string[] } | null)?.otherRunIds ?? []).includes(runId),
  ).length;
  const collisions = trail.filter((event) => event.type === 'conflicts_detected');
  const overlaps = collisions.length + namedElsewhere;

  const checks: EvidenceCheck[] = [
    {
      // Three states, not two, because this codebase already distinguishes a
      // deviation from a silence: start_run writes the hash the server served,
      // and `drift` only becomes true when a run answers with a different one.
      // A receipt nobody answered has drift=false — reading that as "ok" would
      // make the pack claim a rule was followed when nobody said so.
      key: 'policy',
      state: !receipt ? 'unknown' : receipt.drift ? 'attention' : receipt.reportedHash ? 'ok' : 'unknown',
      detail: !receipt
        ? 'No receipt — this run never reported a policy hash.'
        : receipt.drift
          ? `Reported ${(receipt.reportedHash ?? 'nothing').slice(0, 12)}, the server served ${receipt.expectedHash.slice(0, 12)}.`
          : receipt.reportedHash
            ? `Reported hash matches the served policy (${receipt.expectedHash.slice(0, 12)}). This does not prove compliance.`
            : `Unconfirmed — the server served ${receipt.expectedHash.slice(0, 12)} and this run never answered.`,
    },
    {
      key: 'environment',
      state: !check ? 'unknown' : check.status === 'ok' ? 'ok' : 'attention',
      detail: !check
        ? 'No preflight — nobody checked this machine against the project baseline.'
        : `${check.status}: ${check.summary}`,
    },
    {
      key: 'collisions',
      state: overlaps > 0 ? 'attention' : 'unknown',
      detail:
        overlaps === 0
          ? 'No overlap found in the retained, bounded event window. Unreported work and removed history are not covered.'
          : `Overlapped another live run ${overlaps} time(s) — see the trail, and the other run's.`,
    },
    {
      key: 'scope',
      state: claims.length === 0 ? 'unknown' : 'ok',
      detail:
        claims.length === 0
          ? 'This run declared no scope, so nobody could be warned about it.'
          : `Recorded ${claims.length} claim(s). This does not cover undeclared work.`,
    },
    {
      key: 'checkpoint',
      state: !checkpoint
        ? 'unknown'
        : !checkpointRepositoryMatches || !checkpoint.worktreeClean
          ? 'attention'
          : 'ok',
      detail: !checkpoint
        ? 'No immutable delivery/test checkpoint was reported. Run head and branch state cannot identify the delivered commit.'
        : !checkpointRepositoryMatches
          ? `Checkpoint repository ${checkpointRepositoryIdentity ?? 'unknown'} does not match the project's bound repository ${projectRepositoryIdentity ?? 'unknown'}.`
          : !checkpoint.worktreeClean
            ? `Latest ${checkpoint.kind} checkpoint ${checkpoint.commitSha.slice(0, 12)} reported a dirty worktree; uncommitted work is outside that commit.`
            : `Latest ${checkpoint.kind} checkpoint records clean commit ${checkpoint.commitSha.slice(0, 12)} in ${checkpointRepositoryIdentity}. This remains a client report.`,
    },
    {
      key: 'knowledge',
      state: !knowledgeContext
        ? 'unknown'
        : knowledgeReceipt?.reportedManifestHash && !knowledgeMatches
          ? 'attention'
          : knowledgeStale
            ? 'attention'
            : knowledgeReceipt?.reportedAt && knowledgeMatches
              ? 'ok'
              : 'unknown',
      detail: !knowledgeContext
        ? 'No Knowledge Hub context was linked to this run.'
        : !knowledgeReceipt
          ? `Context ${knowledgeContext.id} exists without its initial served receipt; delivery evidence is incomplete.`
          : knowledgeReceipt.reportedManifestHash && !knowledgeMatches
            ? `Client reported ${knowledgeReceipt.reportedManifestHash.slice(0, 12)}, but STMA served ${expectedKnowledgeHash!.slice(0, 12)}. The mismatch is retained and is not compliance.`
            : knowledgeStale
              ? `Context ${knowledgeContext.id} preserves the versions served to this run, but at least one is no longer current. Re-resolve before new work.`
              : knowledgeReceipt.reportedAt
                ? `Client reported the exact manifest ${expectedKnowledgeHash!.slice(0, 12)} served at ${knowledgeReceipt.servedAt.toISOString()}. This is provenance, not proof the text was followed.`
                : `STMA served manifest ${expectedKnowledgeHash!.slice(0, 12)} at ${knowledgeReceipt.servedAt.toISOString()}, but the client has not reported applying it.`,
    },
    {
      key: 'outcome',
      // A current provider fact is useful only when it names the exact commit
      // in the newest delivery/test checkpoint. Legacy branch-linked state is
      // still shown as a warning, but never promoted to exact verification.
      state:
        providerFailures.length > 0
          ? 'attention'
          : providerSuccesses.length > 0
            ? 'ok'
            : found.run.ciState === 'failing' || found.run.prState === 'closed'
              ? 'attention'
              : found.run.status === 'failed'
                ? 'attention'
                : 'unknown',
      detail: [
        found.run.status === 'completed'
          ? 'Agent reported completion and released its scope; completion is not provider verification.'
          : found.run.status === 'failed'
            ? 'Finished as failed.'
            : `Still ${found.run.status} — this pack describes work in progress.`,
        !checkpoint
          ? 'Provider result is unverified: no immutable delivery/test checkpoint identifies the current commit.'
          : !checkpointRepositoryMatches
            ? 'Provider result is unverified because checkpoint repository identity does not match the project.'
            : providerFailures.length > 0
              ? `Provider reported ${providerFailures.map((row) => row.fact.state).join(', ')} for exact checkpoint ${checkpoint.commitSha.slice(0, 12)}.`
              : providerSuccesses.length > 0
                ? `Provider reported ${providerSuccesses.map((row) => row.fact.state).join(', ')} for exact checkpoint ${checkpoint.commitSha.slice(0, 12)}.`
                : `No provider observation matches exact checkpoint ${checkpoint.commitSha.slice(0, 12)}.`,
        found.run.prState
          ? `Legacy branch-linked PR #${found.run.prNumber} ${found.run.prState}${found.run.prState === 'closed' ? ' without merging' : ''}; it is not exact-checkpoint evidence.`
          : null,
        found.run.ciState
          ? `Legacy branch-linked CI ${found.run.ciState}; it is not used to verify the checkpoint.`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
    },
  ];

  for (const item of checks) {
    item.subject = `run:${runId}:${item.key}`;
    item.source = ['policy', 'environment', 'scope', 'checkpoint'].includes(item.key)
      ? 'client_report' : 'stma_observation';
    item.observedAt = item.key === 'environment' ? check?.createdAt.toISOString() ?? null
      : item.key === 'checkpoint' ? checkpoint?.createdAt.toISOString() ?? null
      : item.key === 'outcome'
        ? currentProviderFacts[0]?.fact.observedAt.toISOString() ?? found.run.endedAt?.toISOString() ?? null
        : null;
    item.coverage = item.state === 'unknown' ? 'missing' : 'reported';
    item.limitations = ['No behavioral attestation or human approval is implied.'];
    if (item.key === 'collisions') {
      item.coverage = 'bounded';
      item.limitations = ['Only declared scope and retained events are visible.', `Window: ${TRAIL_LIMIT} run events and 200 peer events; older history may have been trimmed.`];
    }
    if (item.key === 'checkpoint') {
      item.limitations = [
        'Client-reported repository state is not provider verification or permission to mutate a checkout.',
      ];
    }
    if (item.key === 'knowledge') {
      item.source = 'client_report';
      item.observedAt =
        knowledgeReceipt?.reportedAt?.toISOString() ??
        knowledgeReceipt?.servedAt.toISOString() ??
        knowledgeContext?.createdAt.toISOString() ??
        null;
      item.coverage = knowledgeReceipt?.reportedAt ? 'reported' : 'missing';
      item.limitations = [
        'Server delivery and a client hash report are separate facts; neither proves compliance or behavior.',
        'A stale manifest remains immutable evidence of what was served and must not be rewritten as current.',
      ];
    }
    if (item.key === 'outcome' && currentProviderFacts.length > 0) {
      item.source = 'provider_observation';
      item.coverage = 'exact';
      item.limitations = [
        `Bound to checkpoint ${checkpoint!.id} at exact repository and commit ${checkpoint!.commitSha}.`,
        'An individual workflow or merged PR is not proof that all required checks or human approvals passed.',
      ];
    } else if (item.key === 'outcome' && (found.run.prState || found.run.ciState)) {
      item.source = 'provider_observation';
      item.coverage = 'legacy';
      item.limitations = [
        'Legacy branch association is not exact repository/commit verification.',
        'A merged PR is not proof that all required checks or human approvals passed.',
      ];
    }
  }

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    checkpoint: checkpoint
      ? {
          id: checkpoint.id,
          kind: checkpoint.kind,
          repositoryIdentity: checkpoint.repositoryIdentity,
          commitSha: checkpoint.commitSha,
          worktreeClean: checkpoint.worktreeClean,
          tests: checkpoint.tests,
          reportedAt: checkpoint.createdAt.toISOString(),
          repositoryMatchesProject: checkpointRepositoryMatches,
          provenance: 'client_report',
        }
      : null,
    providerFacts: currentProviderFacts,
    providerCoverage: checkpoint
      ? checkpointRepositoryMatches
        ? `At most 100 provider events for exact checkpoint ${checkpoint.commitSha}; current facts are deduplicated by provider subject. Individual workflow results do not establish all required checks or human approval.`
        : 'No provider evidence attached: checkpoint repository identity does not match the project binding.'
      : 'No provider evidence attached: an immutable delivery/test checkpoint is required. Mutable run head and branch-linked state are not exact commit evidence.',
    knowledge: knowledgeContext
      ? {
          contextId: knowledgeContext.id,
          purpose: knowledgeContext.purpose,
          manifestHash: expectedKnowledgeHash,
          servedAt: knowledgeReceipt?.servedAt.toISOString() ?? knowledgeContext.createdAt.toISOString(),
          clientReportedAt: knowledgeReceipt?.reportedAt?.toISOString() ?? null,
          reportedManifestHash: knowledgeReceipt?.reportedManifestHash ?? null,
          matches: knowledgeReceipt?.reportedManifestHash ? knowledgeMatches : null,
          stale: knowledgeStale,
          compliance: null,
        }
      : null,
    verdict: 'Informational evidence, not authorization to merge or deploy.',
    run: {
      id: found.run.id,
      // The task key carries the issue when there is one — "#42" is the convention.
      task: found.run.taskKey,
      intent: found.run.intent,
      branch: found.run.branch,
      baseSha: found.run.baseSha,
      headSha: found.run.headSha,
      status: found.run.status,
      startedAt: found.run.startedAt.toISOString(),
      endedAt: found.run.endedAt?.toISOString() ?? null,
      pr: found.run.prState
        ? { number: found.run.prNumber, url: found.run.prUrl, state: found.run.prState }
        : null,
      ci: found.run.ciState ?? null,
      // Cost rides with its source — a reviewer reading "$4.20 (estimate)"
      // knows exactly how much weight that number can carry.
      cost:
        found.run.costCents !== null
          ? { usd: found.run.costCents / 100, source: found.run.costSource ?? 'estimate' }
          : null,
    },
    who: {
      owner: found.owner.username,
      agent: found.installation.name,
      client: found.installation.clientType,
      team: found.team.slug,
      project: found.projectName ?? found.run.repo ?? null,
    },
    scope: claims.map((claim) => ({
      type: claim.resourceType,
      key: claim.resourceKey,
      access: claim.access,
    })),
    checks,
    trail: trail.map((event) => ({ type: event.type, at: event.at.toISOString() })),
    /** What a reviewer should look at first — nothing more, and never a verdict. */
    blocking: checks.filter((c) => c.state === 'attention').map((c) => c.key),
    unconfirmed: checks.filter((c) => c.state === 'unknown').map((c) => c.key),
  } as const;
}
