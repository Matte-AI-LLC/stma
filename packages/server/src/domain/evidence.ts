import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db';
import { currentProviderFacts, exactProviderEvidence } from './providerEvidence';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  debugSessions,
  environmentChecks,
  handoffs,
  knowledgeContexts,
  knowledgeItems,
  knowledgeReceipts,
  knowledgeVersions,
  policyReceipts,
  projects,
  providerObservations,
  repositoryBindings,
  runCheckpoints,
  teamIntegrations,
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

/**
 * What the provider said about the commit a checkpoint names — and only when
 * the checkpoint is of the project's own repository. `exactProviderEvidence`
 * requires both sides of the immutable observation to retain this project id
 * and comes through an explicit verified binding. That is the repository join:
 * provider-specific locators (GitHub owner/name and Azure org/project/repo) must
 * not be guessed into one URL spelling here. One current fact per provider
 * subject (`currentProviderFacts`). Used by the evidence pack and by the handoff
 * thread's "what was handed over", so a reviewer and a receiver read one answer.
 */
export async function providerFactsForCheckpoint(
  db: Db,
  run: { teamId: string; projectId: string | null },
  projectRepositoryIdentity: string | null,
  checkpoint: { repositoryIdentity: string; commitSha: string } | undefined,
) {
  const project = projectRepositoryIdentity
    ? canonicalRepositoryIdentity(projectRepositoryIdentity)
    : null;
  const reported = checkpoint ? canonicalRepositoryIdentity(checkpoint.repositoryIdentity) : null;
  const repositoryMatches = Boolean(checkpoint && project && reported === project);
  const facts = repositoryMatches
    ? currentProviderFacts(
        await exactProviderEvidence(db, run.teamId, run.projectId, checkpoint!.commitSha),
      )
    : [];
  return {
    projectRepositoryIdentity: project,
    checkpointRepositoryIdentity: reported,
    repositoryMatches,
    facts,
  };
}

/**
 * What a handoff carried, for the person on the receiving end.
 *
 * The thread used to render the brief's prose and nothing else, so the commit
 * a receiver must be on to resume, the tests the sender reported there and
 * anything a provider said about that commit were in the database and on no
 * screen. This is the checkpoint the handoff names, who reported it, and the
 * provider's word on that exact commit through the same rule the evidence pack
 * uses — so a receiver and a reviewer read one answer.
 */
export async function handoverFor(db: Db, checkpointId: string) {
  const [row] = await db
    .select({
      checkpoint: runCheckpoints,
      run: { id: agentRuns.id, teamId: agentRuns.teamId, projectId: agentRuns.projectId },
      reportedBy: agentInstallations.name,
      projectRepositoryIdentity: projects.repositoryIdentity,
    })
    .from(runCheckpoints)
    .innerJoin(agentRuns, eq(agentRuns.id, runCheckpoints.runId))
    .innerJoin(agentInstallations, eq(agentInstallations.id, runCheckpoints.installationId))
    .leftJoin(projects, eq(projects.id, agentRuns.projectId))
    .where(eq(runCheckpoints.id, checkpointId))
    .limit(1);
  if (!row) return null;
  const provider = await providerFactsForCheckpoint(db, row.run, row.projectRepositoryIdentity, row.checkpoint);
  return {
    checkpoint: row.checkpoint,
    runId: row.run.id,
    reportedBy: row.reportedBy,
    repositoryMatchesProject: provider.repositoryMatches,
    providerFacts: provider.facts,
  };
}

export type Handover = NonNullable<Awaited<ReturnType<typeof handoverFor>>>;

/**
 * Why a provider line is empty, from stored facts only.
 *
 * "No provider observation" used to cover five different situations: nothing
 * is connected, the connection's last check failed, the provider spoke about an
 * older commit of this run, the checkpoint is of another repository, or a
 * result simply has not arrived. A reviewer acts differently on each. Nothing
 * here calls a provider: a page load must not depend on one, and the stored
 * `lastCheck` is the only word on a connection's health STMA has. STMA cannot
 * tell a result still pending from one that will never come, and says so.
 */
export type ProviderState =
  | 'observed'
  | 'no_checkpoint'
  | 'repository_mismatch'
  | 'not_connected'
  | 'connection_failing'
  | 'older_commit_only'
  | 'no_observation';

const CONNECTION_LIMIT = 10;
const OLDER_CHECKPOINT_LIMIT = 10;
/** Outgoing handoffs listed in one pack. */
export const HANDOVER_LIMIT = 10;
/** Knowledge versions named in one pack; the manifest hash covers all of them. */
export const KNOWLEDGE_VERSION_LIMIT = 20;

const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  'azure-devops': 'Azure DevOps',
};
const providerLabel = (provider: string) => PROVIDER_LABELS[provider] ?? provider;

interface LastCheck {
  ok: boolean;
  at: string | null;
  error: string | null;
}

function readLastCheck(config: unknown): LastCheck | null {
  const raw = (config as { lastCheck?: unknown } | null)?.lastCheck as
    | { ok?: unknown; at?: unknown; error?: unknown }
    | undefined;
  if (!raw || typeof raw.ok !== 'boolean') return null;
  return {
    ok: raw.ok,
    at: typeof raw.at === 'string' ? raw.at : null,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 120) : null,
  };
}

async function providerStatus(
  db: Db,
  run: { id: string; teamId: string; projectId: string | null },
  checkpoint: { id: string; commitSha: string } | undefined,
  repository: { project: string | null; checkpoint: string | null; matches: boolean },
  exactFacts: number,
) {
  const connections = run.projectId
    ? (
        await db
          .select({
            provider: repositoryBindings.provider,
            fullName: repositoryBindings.fullName,
            config: teamIntegrations.config,
          })
          .from(repositoryBindings)
          .innerJoin(teamIntegrations, eq(teamIntegrations.id, repositoryBindings.connectionId))
          .where(
            and(
              eq(repositoryBindings.teamId, run.teamId),
              eq(repositoryBindings.projectId, run.projectId),
              isNotNull(repositoryBindings.verifiedAt),
            ),
          )
          .limit(CONNECTION_LIMIT)
      ).map((row) => ({
        provider: row.provider,
        fullName: row.fullName,
        lastCheck: readLastCheck(row.config),
      }))
    : [];
  const failing = connections.find((connection) => connection.lastCheck?.ok === false);
  const failingWords = failing
    ? `The ${providerLabel(failing.provider)} connection for ${failing.fullName} failed its last check${failing.lastCheck?.at ? ` at ${failing.lastCheck.at}` : ''}${failing.lastCheck?.error ? ` (${failing.lastCheck.error})` : ''}, so STMA may not be hearing from it.`
    : null;

  // Earlier delivery/tested checkpoints of this run whose commit a provider did
  // report on. Listed so a reviewer can see the green belongs to another
  // commit; never attached to the newest one. Read only when the newest commit
  // has nothing exact, because that is the only time the answer changes.
  const olderCommits: Array<{
    checkpointId: string;
    commitSha: string;
    reportedAt: string;
    facts: Array<{ provider: string; kind: string; subjectId: string; state: string; observedAt: string }>;
  }> = [];
  if (checkpoint && repository.matches && exactFacts === 0 && run.projectId && connections.length > 0) {
    const earlier = (
      await db
        .select({
          id: runCheckpoints.id,
          commitSha: runCheckpoints.commitSha,
          repositoryIdentity: runCheckpoints.repositoryIdentity,
          createdAt: runCheckpoints.createdAt,
        })
        .from(runCheckpoints)
        .where(
          and(
            eq(runCheckpoints.runId, run.id),
            inArray(runCheckpoints.kind, ['delivery', 'tested']),
            ne(runCheckpoints.commitSha, checkpoint.commitSha),
          ),
        )
        .orderBy(desc(runCheckpoints.createdAt), desc(runCheckpoints.id))
        .limit(OLDER_CHECKPOINT_LIMIT)
    ).filter((row) => canonicalRepositoryIdentity(row.repositoryIdentity) === repository.project);
    const newestBySha = new Map<string, (typeof earlier)[number]>();
    for (const row of earlier) {
      const sha = row.commitSha.toLowerCase();
      if (sha !== checkpoint.commitSha.toLowerCase() && !newestBySha.has(sha)) newestBySha.set(sha, row);
    }
    if (newestBySha.size > 0) {
      const observed = await db
        .select({
          provider: repositoryBindings.provider,
          fact: providerObservations,
        })
        .from(providerObservations)
        .innerJoin(repositoryBindings, eq(providerObservations.bindingId, repositoryBindings.id))
        .where(
          and(
            eq(repositoryBindings.teamId, run.teamId),
            eq(repositoryBindings.projectId, run.projectId),
            eq(providerObservations.projectId, run.projectId),
            inArray(providerObservations.commitSha, [...newestBySha.keys()]),
          ),
        )
        .orderBy(desc(providerObservations.observedAt))
        .limit(100);
      for (const [sha, row] of newestBySha) {
        const facts = currentProviderFacts(observed.filter((item) => item.fact.commitSha === sha));
        if (facts.length === 0) continue;
        olderCommits.push({
          checkpointId: row.id,
          commitSha: row.commitSha,
          reportedAt: row.createdAt.toISOString(),
          facts: facts.map((item) => ({
            provider: item.provider,
            kind: item.fact.kind,
            subjectId: item.fact.subjectId,
            state: item.fact.state,
            observedAt: item.fact.observedAt.toISOString(),
          })),
        });
      }
    }
  }

  const exact = 'No provider observation of this exact commit.';
  const named = connections
    .map((connection) => `${providerLabel(connection.provider)} (${connection.fullName})`)
    .join(', ');
  let state: ProviderState;
  let detail: string;
  if (!checkpoint) {
    state = 'no_checkpoint';
    detail =
      'No provider result can be attached: no delivery or tested checkpoint names a commit. A branch or a moving run head is never used instead.';
  } else if (!repository.matches) {
    state = 'repository_mismatch';
    detail = `No provider result is attached: the checkpoint names ${repository.checkpoint ?? 'an unknown repository'}, not the project's repository ${repository.project ?? '(none bound)'}.`;
  } else if (exactFacts > 0) {
    state = 'observed';
    detail = `A connected provider reported on this exact commit.${failingWords ? ` ${failingWords} A newer result may not have arrived.` : ''}`;
  } else if (connections.length === 0) {
    state = 'not_connected';
    detail = `${exact} No GitHub or Azure DevOps repository is connected and bound to this project.`;
  } else if (failingWords) {
    state = 'connection_failing';
    detail = `${exact} ${failingWords}`;
  } else if (olderCommits.length > 0) {
    state = 'older_commit_only';
    detail = `${exact} A provider reported on an older commit of this run (${olderCommits.map((row) => row.commitSha.slice(0, 12)).join(', ')}); that result belongs to that commit and is not carried to this one.`;
  } else {
    state = 'no_observation';
    detail = `${exact} ${named} ${connections.length === 1 ? 'is' : 'are'} connected; STMA cannot tell a result still pending from one that will never come.`;
  }
  return { state, detail, connections, olderCommits };
}

const receivingInstallations = alias(agentInstallations, 'evidence_receiving_installations');
const addressedInstallations = alias(agentInstallations, 'evidence_addressed_installations');

/**
 * What STMA checks before it records a resume of a handoff that carries a
 * commit. `transitionHandoff` takes either the checkout the receiver reports at
 * resume or, when only the commit has moved on, a clean checkpoint its own
 * receiving run reported at that commit (where it began, or later). Which of
 * the two applied is not stored, so the sentence names both and says so.
 */
export const RESUME_RULE =
  "STMA records a resume only when the receiving agent reports this exact repository and commit in a clean worktree, either as its checkout when it resumes or as a clean checkpoint its own run reported there, and refuses it otherwise. This pack does not record which of the two it was. Either way it is the receiver's report, not a provider check.";

/**
 * Where this run's checkpoints were handed over, and how far the receiver got.
 * Read from the handoff rows: who accepted it, and when it was accepted,
 * resumed and completed. A step with no time is a step nobody recorded.
 */
async function handoversForRun(db: Db, runId: string) {
  const rows = await db
    .select({
      sessionId: handoffs.sessionId,
      title: debugSessions.title,
      kind: handoffs.kind,
      state: handoffs.state,
      checkpointId: runCheckpoints.id,
      checkpointKind: runCheckpoints.kind,
      repositoryIdentity: runCheckpoints.repositoryIdentity,
      commitSha: runCheckpoints.commitSha,
      receiver: receivingInstallations.name,
      addressedTo: addressedInstallations.name,
      createdAt: handoffs.createdAt,
      acceptedAt: handoffs.acceptedAt,
      resumedAt: handoffs.resumedAt,
      completedAt: handoffs.completedAt,
    })
    .from(handoffs)
    .innerJoin(runCheckpoints, eq(runCheckpoints.id, handoffs.checkpointId))
    .innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
    .leftJoin(receivingInstallations, eq(receivingInstallations.id, handoffs.installationId))
    .leftJoin(addressedInstallations, eq(addressedInstallations.id, handoffs.targetInstallationId))
    .where(eq(runCheckpoints.runId, runId))
    .orderBy(desc(handoffs.createdAt))
    .limit(HANDOVER_LIMIT);
  return rows.map((row) => ({
    sessionId: row.sessionId,
    title: row.title,
    kind: row.kind,
    state: row.state,
    checkpointId: row.checkpointId,
    checkpointKind: row.checkpointKind,
    repositoryIdentity: row.repositoryIdentity,
    commitSha: row.commitSha,
    receiver: row.receiver ?? null,
    addressedTo: row.addressedTo ?? null,
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    resumedAt: row.resumedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    resumeRule: RESUME_RULE,
  }));
}

const claimKey = (type: string, key: string, access: string | null) => `${type}\0${key}\0${access ?? 'write'}`;

/**
 * The ground a controlled rotation moved (`rotateRunForWork`), read off the
 * event it wrote: the claim rows themselves move to the successor, so without
 * this the closed run read as one that declared nothing, and the successor's
 * pack listed its predecessor's ground as its own work's.
 */
async function rotatedGround(db: Db, runId: string) {
  const movedOut: { type: string; key: string; access: string | null; movedTo: string }[] = [];
  const carriedIn = new Map<string, string>();
  const rotationsOf = (ids: string[]) =>
    ids.length
      ? db
          .select({ runId: agentEvents.runId, detail: agentEvents.detail })
          .from(agentEvents)
          .where(and(inArray(agentEvents.runId, ids), eq(agentEvents.type, 'run_finished')))
      : Promise.resolve([]);
  const named = (detail: unknown) => {
    const event = detail as { reason?: unknown; rotatedTo?: unknown; movedClaims?: unknown } | null;
    if (event?.reason !== 'work_rotation' || typeof event.rotatedTo !== 'string' || !Array.isArray(event.movedClaims)) return [];
    return event.movedClaims.flatMap((claim) => {
      const { type, key, access } = (claim ?? {}) as { type?: unknown; key?: unknown; access?: unknown };
      return typeof type === 'string' && typeof key === 'string'
        ? [{ type, key, access: typeof access === 'string' ? access : null, movedTo: event.rotatedTo as string }]
        : [];
    });
  };
  for (const row of await rotationsOf([runId])) movedOut.push(...named(row.detail));
  const predecessors = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.rotatedToRunId, runId));
  for (const row of await rotationsOf(predecessors.map((run) => run.id))) {
    for (const claim of named(row.detail)) {
      if (claim.movedTo === runId) carriedIn.set(claimKey(claim.type, claim.key, claim.access), row.runId);
    }
  }
  return { movedOut, carriedIn };
}

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
  const {
    projectRepositoryIdentity,
    checkpointRepositoryIdentity,
    repositoryMatches: checkpointRepositoryMatches,
    facts: currentProviderFacts,
  } = await providerFactsForCheckpoint(
    db,
    found.run,
    found.projectRepositoryIdentity,
    checkpoint,
  );
  const repository = {
    project: projectRepositoryIdentity,
    checkpoint: checkpointRepositoryIdentity,
    matches: checkpointRepositoryMatches,
  };
  const [provider, handovers] = await Promise.all([
    providerStatus(db, found.run, checkpoint, repository, currentProviderFacts.length),
    handoversForRun(db, runId),
  ]);
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
  const rotation = await rotatedGround(db, runId);
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
  // The tests a checkpoint carries are the agent's own words about that commit.
  // They were passed through and never read, so a checkpoint whose agent said
  // "npm test failed" was drawn as a green tick beside it — the one place a
  // reviewer looks to learn what was tested (found 2026-09-26). They stay a
  // client report either way; what changes is that a reported failure is never
  // shown as fine, and a checkpoint called `tested` with no passing test in it
  // is not shown as tested.
  const reportedTests = checkpoint?.tests ?? [];
  const failedTests = reportedTests.filter((test) => test.state === 'failed');
  const passedTests = reportedTests.filter((test) => test.state === 'passed');
  const testsLine =
    reportedTests.length === 0
      ? 'No test result was reported with it.'
      : `Reported tests: ${reportedTests.map((test) => `${test.name} ${test.state.replace('_', ' ')}`).join(', ')}.`;

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
      state: claims.length + rotation.movedOut.length === 0 ? 'unknown' : 'ok',
      detail:
        claims.length + rotation.movedOut.length === 0
          ? 'This run declared no scope, so nobody could be warned about it.'
          : `Recorded ${claims.length + rotation.movedOut.length} claim(s). This does not cover undeclared work.${
              rotation.movedOut.length
                ? ` ${rotation.movedOut.length} moved to run ${rotation.movedOut[0]!.movedTo} when this run was closed for other work, and are held there.`
                : ''
            }${
              rotation.carriedIn.size
                ? ` ${claims.filter((claim) => rotation.carriedIn.has(claimKey(claim.resourceType, claim.resourceKey, claim.access))).length} came from the run before this one, which declared them for its own work.`
                : ''
            }`,
    },
    {
      key: 'checkpoint',
      state: !checkpoint
        ? 'unknown'
        : !checkpointRepositoryMatches || !checkpoint.worktreeClean || failedTests.length > 0
          ? 'attention'
          : checkpoint.kind === 'tested' && passedTests.length === 0
            ? 'unknown'
            : 'ok',
      detail: !checkpoint
        ? 'No immutable delivery/test checkpoint was reported. Run head and branch state cannot identify the delivered commit.'
        : !checkpointRepositoryMatches
          ? `Checkpoint repository ${checkpointRepositoryIdentity ?? 'unknown'} does not match the project's bound repository ${projectRepositoryIdentity ?? 'unknown'}.`
          : !checkpoint.worktreeClean
            ? `Latest ${checkpoint.kind} checkpoint ${checkpoint.commitSha.slice(0, 12)} reported a dirty worktree; uncommitted work is outside that commit.`
            : failedTests.length > 0
              ? `The agent reported failing tests at ${checkpoint.kind} checkpoint ${checkpoint.commitSha.slice(0, 12)}: ${failedTests.map((test) => test.name).join(', ')}. ${testsLine}`
              : checkpoint.kind === 'tested' && passedTests.length === 0
                ? `Checkpoint ${checkpoint.commitSha.slice(0, 12)} is marked tested, but no passing test was reported with it. ${testsLine}`
                : `Latest ${checkpoint.kind} checkpoint records clean commit ${checkpoint.commitSha.slice(0, 12)} in ${checkpointRepositoryIdentity}. ${testsLine} This remains a client report.`,
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
            ? 'The agent reported this run as failed.'
            : found.run.status === 'stale'
              ? 'STMA stopped hearing from this run and closed it as stale; no completion was reported.'
              : `Still ${found.run.status}: this pack describes work in progress.`,
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
    } else if (item.key === 'outcome') {
      // With no provider fact, what is left is the run's own status, and every
      // status but `stale` is one the agent declared (start, update, finish).
      // Calling that an STMA observation put the agent's "done" under the same
      // label as a collision STMA computed — the one distinction this pack sells.
      item.source = found.run.status === 'stale' ? 'stma_observation' : 'client_report';
      item.limitations = [
        found.run.status === 'stale'
          ? 'A stale run is one whose lease ran out; it says nothing about whether the work was finished.'
          : 'Run status is what the agent reported; no provider observed this outcome.',
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
    /** The project's bound repository beside the one the checkpoint names. */
    repository,
    providerFacts: currentProviderFacts,
    /**
     * Why the provider line says what it says. Exact facts never move between
     * commits: `olderCommits` names results that belong to earlier checkpoints
     * of this run so a reviewer can see they are not this commit's.
     */
    provider,
    /** Where this run's checkpoints were handed over, newest first. */
    handovers,
    policy: receipt
      ? {
          expectedHash: receipt.expectedHash,
          reportedHash: receipt.reportedHash,
          drift: receipt.drift,
          servedAt: receipt.createdAt.toISOString(),
          // The receipt stores the effective document's hash, not the bundle
          // versions merged into it; naming versions here would be a guess.
          versions: null,
        }
      : null,
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
          versionIds: knowledgeVersionIds.slice(0, KNOWLEDGE_VERSION_LIMIT),
          itemIds: (knowledgeManifest?.versions ?? [])
            .map((version) => version.itemId)
            .filter((id): id is string => Boolean(id))
            .slice(0, KNOWLEDGE_VERSION_LIMIT),
          versionCount: knowledgeVersionIds.length,
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
    // A claim a rotation carried says where it went or where it came from;
    // every other claim reads as it always did.
    scope: [
      ...claims.map((claim) => {
        const from = rotation.carriedIn.get(claimKey(claim.resourceType, claim.resourceKey, claim.access));
        return {
          type: claim.resourceType,
          key: claim.resourceKey,
          access: claim.access,
          ...(from ? { carriedFrom: from } : {}),
        };
      }),
      ...rotation.movedOut,
    ],
    checks,
    trail: trail.map((event) => ({ type: event.type, at: event.at.toISOString() })),
    /** What a reviewer should look at first — nothing more, and never a verdict. */
    blocking: checks.filter((c) => c.state === 'attention').map((c) => c.key),
    unconfirmed: checks.filter((c) => c.state === 'unknown').map((c) => c.key),
  } as const;
}
