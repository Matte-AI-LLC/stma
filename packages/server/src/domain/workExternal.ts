import { createHash } from 'node:crypto';
import {
  WORK_LIMITS,
  fingerprintJson,
  missingForReady,
  safeUri,
  type WorkCreateInput,
  type WorkExternalMode,
  type WorkExternalSource,
  type WorkReconcileExternalPayload,
  type WorkState,
} from '@bridge/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { teamIntegrations, workExternalRefs, workItems } from '../db/schema';
import type { Env } from '../env';
import { getIssue, type GithubIssue } from '../lib/github';
import { redactSecrets } from '../lib/redact';
import { revealIntegrationSecret } from '../lib/secretStore';
import { integrationFor } from './integrations';
import { hasContractAuthority, workAccess } from './workAccess';
import { activeExecution } from './workRead';
import { applyContractPatch, changedContractFields, loadRevision, revisionContentHash, writeRevision } from './workRevisions';
import {
  refuse,
  workError,
  WorkRefusal,
  type WorkEventDraft,
  type WorkItemRow,
  type WorkOpContext,
  type WorkOpResult,
  type WorkPrincipal,
  type WorkRefusalError,
} from './workTypes';

/**
 * Tracker records tied to a work item, and who owns which field.
 *
 * One provider in this release: a GitHub issue, read through the workspace's
 * existing GitHub connection. Three modes, fixed per record:
 *
 *  - `reference`: the issue sits beside the work for context. STMA owns every
 *    field; a refresh records what GitHub says now and changes nothing else.
 *  - `external_authoritative`: the issue owns the title and the goal. A local
 *    edit of either is refused; a newer issue becomes a new contract revision,
 *    except on accepted or cancelled work, where it waits for a person.
 *  - `imported_native`: a native copy made once, at create. Nothing follows it.
 *
 * Nothing here ever writes to GitHub. A closed issue is a fact about GitHub,
 * shown beside the work; it is never an STMA acceptance, and an STMA acceptance
 * never closes the issue. The read happens before the command's transaction
 * (no provider call ever holds a Work lock), and the transaction compares what
 * was read with what is stored: an older update never replaces a newer one,
 * and the same update time with different content is a conflict a person
 * resolves, never a guess.
 */

/**
 * The fields a source-of-truth record owns. GitHub issues have no priority and
 * no due date of their own, so those stay STMA's even here: owning a field the
 * tracker cannot carry would freeze it with nothing to follow.
 */
export const EXTERNALLY_OWNED_FIELDS = ['contract.title', 'contract.goal'] as const;

const PROVIDER_NAME: Record<string, string> = { github: 'GitHub' };

/** What STMA keeps of one issue: enough to show it and to tell two versions apart. Never a credential. */
export interface IssueSnapshot {
  provider: 'github';
  repo: string;
  number: number;
  url: string;
  title: string;
  title_truncated: boolean;
  body: string;
  body_truncated: boolean;
  /** Of the whole body, so a change past the cut is still a change. */
  body_sha256: string;
  state: 'open' | 'closed' | 'unknown';
  labels: string[];
  assignees: string[];
  /** GitHub's update time, the record's ordering token. */
  updated_at: string;
}

type RefRow = typeof workExternalRefs.$inferSelect;

// ---------------------------------------------------------------------------
// Reading a record off the tracker, before any transaction.
// ---------------------------------------------------------------------------

const REPO = '[A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+';
const NUMBER = '([1-9][0-9]{0,9})';
const ISSUE_URL = new RegExp(`^https?://(?:www\\.)?github\\.com/(${REPO})/issues/${NUMBER}(?:[/?#].*)?$`, 'i');
const ISSUE_QUALIFIED = new RegExp(`^(${REPO})#${NUMBER}$`);
const ISSUE_SHORT = new RegExp(`^#${NUMBER}$`);

/**
 * An issue the way people paste one, anchored at both ends: `#42`, `owner/repo#42`
 * or the issue's address. A bare number names nothing (it reads as any ticket
 * id), and an address merely mentioned inside a sentence is not a reference.
 */
export function parseGithubIssueRef(text: string): { repo: string | null; number: number } | null {
  const value = text.trim();
  const url = ISSUE_URL.exec(value);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  const qualified = ISSUE_QUALIFIED.exec(value);
  if (qualified) return { repo: qualified[1]!, number: Number(qualified[2]) };
  const short = ISSUE_SHORT.exec(value);
  if (short) return { repo: null, number: Number(short[1]) };
  return null;
}

/** The key a record is unique on in its workspace: one issue, however it was spelled. */
const remoteIdOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

interface Connection {
  id: string;
  /** The repository the connection was made for, as stored. */
  locator: string;
  token: string;
}

const failed = (error: WorkRefusalError) => ({ kind: 'failed' as const, error });

/**
 * The workspace's GitHub connection for this repository, or for the project
 * when the reference was `#42`. One connection reads one repository, the rule
 * a finished run's comment already follows: a token that could read another
 * repository is still not the connection made for it.
 */
async function connectionFor(
  db: Db,
  teamId: string,
  projectId: string,
  repo: string | null,
  field: string,
): Promise<Connection | WorkRefusalError> {
  let row: { id: string; repo: string; token: string } | undefined;
  try {
    if (repo) {
      const rows = await db
        .select({ id: teamIntegrations.id, repo: teamIntegrations.repo, token: teamIntegrations.token })
        .from(teamIntegrations)
        .where(and(eq(teamIntegrations.teamId, teamId), eq(teamIntegrations.provider, 'github')));
      row = rows.find((candidate) => candidate.repo.toLowerCase() === repo.toLowerCase());
      if (!row) {
        return workError('INVALID_INPUT', `This workspace has no GitHub connection for ${repo}.`, {
          fields: [field],
          next_action: "A workspace owner connects the repository on the workspace's Integrations tab, then attach it again.",
        });
      }
      return { id: row.id, locator: row.repo, token: await revealIntegrationSecret(row.token, `${teamId}:github:${row.repo}`) };
    }
    // `#42` means the project's own repository: the one connection the
    // project's binding (or its single legacy connection) resolves to.
    const bound = await integrationFor(db, teamId, 'github', undefined, projectId);
    if (!bound) {
      return workError('INVALID_INPUT', 'No GitHub repository is connected to this project, so a bare #number names nothing.', {
        fields: [field],
        next_action: 'Write it as owner/repo#42, or as the issue address.',
      });
    }
    const [own] = await db
      .select({ repo: teamIntegrations.repo })
      .from(teamIntegrations)
      .where(eq(teamIntegrations.id, bound.id))
      .limit(1);
    return { id: bound.id, locator: own?.repo ?? bound.repo, token: bound.token };
  } catch {
    // A sealed credential whose key this server does not hold. The message
    // names the fact, never the credential or the key.
    return workError('SOURCE_UNAVAILABLE', "The GitHub connection's credential cannot be opened on this server.", {
      next_action: 'An operator restores the integration key, or a workspace owner connects the repository again.',
    });
  }
}

/** The connection a stored record was read through, while it still exists. */
async function connectionOfRef(db: Db, ref: RefRow): Promise<Connection | WorkRefusalError> {
  const removed = workError(
    'SOURCE_UNAVAILABLE',
    `The GitHub connection ${ref.remoteId} was read through has been removed. The last snapshot stays readable, as of when it was read.`,
    { next_action: 'Detach this record, then attach the issue again through the connection the workspace has now.' },
  );
  if (!ref.connectionId) return removed;
  const [row] = await db
    .select({ id: teamIntegrations.id, repo: teamIntegrations.repo, token: teamIntegrations.token })
    .from(teamIntegrations)
    .where(and(eq(teamIntegrations.id, ref.connectionId), eq(teamIntegrations.teamId, ref.teamId)))
    .limit(1);
  if (!row) return removed;
  try {
    return { id: row.id, locator: row.repo, token: await revealIntegrationSecret(row.token, `${ref.teamId}:github:${row.repo}`) };
  } catch {
    return workError('SOURCE_UNAVAILABLE', "The GitHub connection's credential cannot be opened on this server.", {
      next_action: 'An operator restores the integration key, or a workspace owner connects the repository again.',
    });
  }
}

/** Text from the tracker, as STMA keeps it: secrets scrubbed, line breaks plain, trimmed, bounded. */
function keptText(raw: string, max: number): { text: string; truncated: boolean; full: string } {
  const full = redactSecrets(raw.replace(/\r\n?/g, '\n')).trim();
  if (full.length <= max) return { text: full, truncated: false, full };
  return { text: full.slice(0, max).trim(), truncated: true, full };
}

/** One issue, read now. Its address is shown to people, so it passes the same check every outbound link does. */
function snapshotOf(value: GithubIssue, repo: string, number: number): IssueSnapshot {
  const title = keptText(value.title ?? '', WORK_LIMITS.titleChars);
  const body = keptText(value.body ?? '', WORK_LIMITS.goalChars);
  const fallbackUrl = `https://github.com/${repo}/issues/${number}`;
  return {
    provider: 'github',
    repo,
    number,
    url: safeUri.safeParse(value.url).success ? value.url : fallbackUrl,
    // GitHub refuses an empty title, but a title that is all scrubbed secret
    // would leave a work with none; the issue's own name stands in.
    title: title.text || `${repo}#${number}`,
    title_truncated: title.truncated,
    body: body.text,
    body_truncated: body.truncated,
    body_sha256: createHash('sha256').update(body.full).digest('hex'),
    state: value.state ?? 'unknown',
    labels: (value.labels ?? []).slice(0, 20).map((label) => label.slice(0, 60)),
    assignees: (value.assignees ?? []).slice(0, 10).map((login) => login.slice(0, 60)),
    updated_at: String(value.updatedAt ?? '').slice(0, 64),
  };
}

/** What a read before the transaction hands the command. Never a refusal on its own: see `prepare*`. */
export type ExternalPrefetch =
  | { kind: 'none' }
  | {
      kind: 'read';
      connection: { id: string; locator: string };
      remoteId: string;
      snapshot: IssueSnapshot;
      hash: string;
    }
  | { kind: 'failed'; error: WorkRefusalError };

const NOT_READ: ExternalPrefetch = { kind: 'none' };

const GITHUB_FAILURE: Record<string, string> = {
  not_found_or_no_access: 'GitHub did not return that issue: it does not exist, or the connection cannot read it.',
  http_404: 'GitHub did not return that issue: it does not exist, or the connection cannot read it.',
  bad_token: "GitHub refused the workspace connection's token.",
};

async function readIssue(env: Env, connection: Connection, repo: string, number: number): Promise<ExternalPrefetch> {
  const result = await getIssue(env, { repo: connection.locator, token: connection.token }, number, repo);
  if (!result.ok) {
    return failed(
      workError('SOURCE_UNAVAILABLE', GITHUB_FAILURE[result.error] ?? 'GitHub could not be read just now.', {
        next_action: 'Try again later; nothing was changed.',
      }),
    );
  }
  if (result.value.pullRequest) {
    return failed(workError('INVALID_INPUT', `${repo}#${number} is a pull request, not an issue.`, { fields: ['issue'] }));
  }
  const snapshot = snapshotOf(result.value, repo, number);
  return {
    kind: 'read',
    connection: { id: connection.id, locator: connection.locator },
    remoteId: remoteIdOf(repo, number),
    snapshot,
    hash: fingerprintJson(snapshot),
  };
}

/**
 * Who else holds this issue in the workspace. Named by key only when the caller
 * could open that work: a refusal must not be a way to learn that a project
 * exists or what it is working on. Exported for its test: in core every member
 * sees every project of a workspace, so only a narrower principal (a scoped
 * credential, or an organization's role filter) ever meets the nameless answer.
 */
export async function duplicateRefusal(db: Db, principal: WorkPrincipal, teamId: string, remoteId: string, field: string) {
  const [held] = await db
    .select({ key: workItems.displayKey, projectId: workItems.projectId, workId: workItems.id })
    .from(workExternalRefs)
    .innerJoin(workItems, eq(workItems.id, workExternalRefs.workId))
    .where(
      and(
        eq(workExternalRefs.teamId, teamId),
        eq(workExternalRefs.provider, 'github'),
        eq(workExternalRefs.remoteId, remoteId),
        isNull(workExternalRefs.detachedAt),
      ),
    )
    .limit(1);
  if (!held) return null;
  const visible = await workAccess(db, principal, teamId, held.projectId);
  return workError(
    'INVALID_INPUT',
    visible
      ? `GitHub issue ${remoteId} is already tied to ${held.key}; one issue is tied to one work item in a workspace.`
      : 'That GitHub issue is already tied to a work item in this workspace; one issue is tied to one work item.',
    {
      fields: [field],
      ...(visible ? { next_action: `Detach it from ${held.key} first, or work on ${held.key}.` } : {}),
    },
  );
}

/** Resolve, check for a holder, then read. Each failure is carried, not thrown. */
async function readSource(
  db: Db,
  principal: WorkPrincipal,
  place: { teamId: string; projectId: string },
  issue: string,
  field: string,
  env: Env | undefined,
): Promise<ExternalPrefetch> {
  const ref = parseGithubIssueRef(issue);
  if (!ref) {
    return failed(
      workError('INVALID_INPUT', `${field}: name an issue as #42, owner/repo#42 or its address; a bare number names nothing.`, {
        fields: [field],
      }),
    );
  }
  const connection = await connectionFor(db, place.teamId, place.projectId, ref.repo, field);
  if ('code' in connection) return failed(connection);
  const repo = ref.repo ?? connection.locator;
  const duplicate = await duplicateRefusal(db, principal, place.teamId, remoteIdOf(repo, ref.number), field);
  if (duplicate) return failed(duplicate);
  if (!env) throw new Error('Reading a tracker record needs the server environment; pass env from the door.');
  const read = await readIssue(env, connection, repo, ref.number);
  return read.kind === 'failed' && read.error.fields?.includes('issue') ? failed({ ...read.error, fields: [field] }) : read;
}

/**
 * The read a create with `external` needs, made before its transaction. It
 * never refuses by itself: a refusal belongs inside the command, after the
 * receipt is checked, so retrying a create that already succeeded is answered
 * as the replay it is even if GitHub or the connection has gone since. An agent
 * gets no read at all; the command refuses it.
 */
export async function prepareCreateExternal(
  db: Db,
  principal: WorkPrincipal,
  place: { teamId: string; projectId: string },
  source: WorkExternalSource,
  env: Env | undefined,
): Promise<ExternalPrefetch> {
  if (principal.kind !== 'human') return NOT_READ;
  return readSource(db, principal, place, source.issue, 'external.issue', env);
}

/**
 * The read a `reconcile_external` command needs, made before its transaction.
 * Only for somebody the command will let through: a person with authority over
 * the work, attaching or refreshing. Anyone else gets no outbound call, and the
 * command refuses them under its locks as it would anyway.
 */
export async function prepareReconcile(
  db: Db,
  principal: WorkPrincipal,
  workId: string,
  payload: WorkReconcileExternalPayload,
  env: Env | undefined,
): Promise<ExternalPrefetch> {
  if (principal.kind !== 'human') return NOT_READ;
  if (payload.action !== 'attach' && payload.action !== 'refresh') return NOT_READ;
  const [work] = await db.select().from(workItems).where(eq(workItems.id, workId)).limit(1);
  if (!work || work.archivedAt) return NOT_READ;
  const access = await workAccess(db, principal, work.teamId, work.projectId);
  if (!access || !hasContractAuthority(principal, access, work)) return NOT_READ;
  if (payload.action === 'attach') {
    return readSource(db, principal, { teamId: work.teamId, projectId: work.projectId }, payload.issue, 'payload.issue', env);
  }
  const [ref] = await db
    .select()
    .from(workExternalRefs)
    .where(and(eq(workExternalRefs.id, payload.ref_id), eq(workExternalRefs.workId, work.id)))
    .limit(1);
  if (!ref || ref.detachedAt || ref.mode === 'imported_native') return NOT_READ;
  const connection = await connectionOfRef(db, ref);
  if ('code' in connection) return failed(connection);
  const snapshot = ref.snapshot as IssueSnapshot | null;
  const parsed = snapshot ? { repo: snapshot.repo, number: snapshot.number } : parseGithubIssueRef(ref.remoteId);
  if (!parsed?.repo) return NOT_READ;
  if (!env) throw new Error('Reading a tracker record needs the server environment; pass env from the door.');
  return readIssue(env, connection, parsed.repo, parsed.number);
}

// ---------------------------------------------------------------------------
// Ordering two versions of one record.
// ---------------------------------------------------------------------------

/**
 * Which of two update times is newer: -1, 0 or 1, or null when either cannot
 * be read as a time. An adapter that cannot order two versions leaves them as a
 * conflict; it never guesses which one wins.
 */
export function compareRemoteRevisions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  if (!a || !b) return null;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  return left === right ? 0 : left < right ? -1 : 1;
}

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

function parts(ctx: WorkOpContext) {
  if (!ctx.principal || !ctx.access || !ctx.work) throw new Error('A Work update needs a principal and its work.');
  return { principal: ctx.principal, access: ctx.access, work: ctx.work };
}

function assertAuthority(ctx: WorkOpContext) {
  const { principal, access, work } = parts(ctx);
  if (principal.kind !== 'human') {
    throw refuse(
      'FORBIDDEN',
      "An agent cannot tie a work item to a tracker record or change how it follows one; the work's owner, its acceptor or a workspace owner does that.",
    );
  }
  if (!hasContractAuthority(principal, access, work)) {
    throw refuse(
      'FORBIDDEN',
      "Only the work's owner, its acceptor or a workspace owner may tie it to a tracker record or change how it follows one.",
    );
  }
  if (work.archivedAt) {
    throw refuse('INVALID_TRANSITION', 'Archived work is read-only.', { next_action: 'Reopen it with a reason first.' });
  }
  return { principal, access, work };
}

/** A prefetch the command can use, or the refusal it carried. */
function readOrRefuse(prefetch: ExternalPrefetch | undefined): Extract<ExternalPrefetch, { kind: 'read' }> {
  if (prefetch?.kind === 'read') return prefetch;
  if (prefetch?.kind === 'failed') throw new WorkRefusal(prefetch.error);
  // The read was skipped because the command looked refusable when it was
  // made, and something changed before the locks were taken.
  throw refuse('SOURCE_UNAVAILABLE', 'The tracker was not read for this command.', {
    next_action: 'Send the same command again.',
  });
}

async function refOfWork(tx: Db, workId: string, refId: string): Promise<RefRow> {
  const [ref] = await tx
    .select()
    .from(workExternalRefs)
    .where(and(eq(workExternalRefs.id, refId), eq(workExternalRefs.workId, workId)))
    .limit(1);
  if (!ref) throw refuse('NOT_FOUND', 'This work has no tracker record with that id.', { fields: ['payload.ref_id'] });
  if (ref.detachedAt) {
    throw refuse('INVALID_TRANSITION', `${ref.remoteId} was detached from this work.`, {
      next_action: 'Attach the issue again to follow it.',
    });
  }
  return ref;
}

async function liveRefOf(tx: Db, workId: string): Promise<RefRow | null> {
  const [ref] = await tx
    .select()
    .from(workExternalRefs)
    .where(and(eq(workExternalRefs.workId, workId), isNull(workExternalRefs.detachedAt)))
    .limit(1);
  return ref ?? null;
}

interface Followed {
  revised: boolean;
  revision?: number;
  changed: string[];
  state?: { from: WorkState; to: WorkState };
  contractChanged?: { runs: string[]; assignments: string[] };
}

/**
 * The contract the work would have if it took the record's title and goal now.
 * Equal content is no revision (design section 4): following a record that did
 * not change what the work says writes nothing.
 */
async function remoteContract(tx: Db, work: WorkItemRow, snapshot: IssueSnapshot) {
  const current = await loadRevision(tx, work.id, work.specRevision);
  if (!current) throw new Error(`Work ${work.id} has no revision ${work.specRevision}.`);
  const next = applyContractPatch(current, { title: snapshot.title, goal: snapshot.body }, undefined);
  return { current, next, differs: revisionContentHash(next) !== revisionContentHash(current) };
}

/**
 * Make the record's title and goal the work's contract: a new revision whose
 * source is `external`, with exactly the effects a person's contract change
 * has. In review goes back to in progress (a new delivery is needed), ready
 * must stay complete, and runs and assignments bound to the old revision are
 * named, never stopped. Accepted work moves only when `reopen` says a person
 * chose that, with a reason; the caller never calls this for cancelled work.
 */
async function followRemote(
  tx: Db,
  ctx: WorkOpContext,
  work: WorkItemRow,
  snapshot: IssueSnapshot,
  options: { reopenReason?: string } = {},
): Promise<Followed> {
  const { current, next, differs } = await remoteContract(tx, work, snapshot);
  if (!differs) return { revised: false, changed: [] };
  const from = work.state as WorkState;
  let to = from;
  if (from === 'in_review') to = 'in_progress';
  if (from === 'accepted') {
    if (!options.reopenReason) throw new Error('Following a record on accepted work needs a reopen reason.');
    to = 'in_progress';
  }
  if (from === 'ready') {
    const missing = missingForReady({
      goal: next.goal,
      artifactKind: next.artifactKind,
      criteria: next.criteria.length,
      ownerUserId: work.ownerUserId,
      acceptorUserId: work.acceptorUserId,
    });
    if (missing.length) {
      throw refuse('CONTRACT_INCOMPLETE', `Ready work must stay complete; the issue as it is now leaves it without: ${missing.join(', ')}.`, {
        fields: missing,
        next_action: 'Complete the issue on GitHub and refresh, or move the work back to draft first.',
      });
    }
  }
  const revision = work.specRevision + 1;
  await writeRevision(tx, {
    workId: work.id,
    revision,
    content: next,
    actor: ctx.actor,
    changeReason: options.reopenReason ?? null,
    source: 'external',
    now: ctx.now,
  });
  await tx
    .update(workItems)
    .set({
      specRevision: revision,
      ...(to !== from ? { state: to } : {}),
      ...(from === 'accepted' ? { currentAcceptanceId: null } : {}),
    })
    .where(eq(workItems.id, work.id));
  const active = await activeExecution(tx, work.id);
  const pinned = (rows: { id: string; specRevision: number | null }[]) =>
    rows.filter((row) => row.specRevision !== null && row.specRevision < revision).map((row) => row.id);
  const runs = pinned(active.runs);
  const assignments = pinned(active.assignments);
  return {
    revised: true,
    revision,
    changed: changedContractFields(current, next),
    ...(to !== from ? { state: { from, to } } : {}),
    ...(runs.length || assignments.length ? { contractChanged: { runs, assignments } } : {}),
  };
}

/**
 * What a reply says about a follow: the runs and assignments now on an older
 * contract, and the state it moved the work through, so a door can say that
 * work in review went back to in progress (its delivery no longer counts).
 */
const followedReply = (followed: Followed): Record<string, unknown> => ({
  ...(followed.contractChanged ? { contract_changed: followed.contractChanged } : {}),
  ...(followed.state ? { state_moved: followed.state } : {}),
});

const followedPayload = (followed: Followed): Record<string, unknown> => ({
  ...(followed.revised ? { revision: followed.revision, changed: followed.changed } : {}),
  ...(followed.state ? { state: followed.state } : {}),
  ...(followed.contractChanged ? { contract_changed: followed.contractChanged } : {}),
});

/** What is waiting on a record, as one patch of its columns. */
const pendingSet = (snapshot: IssueSnapshot | null, revision: string | null, syncState: string) => ({
  pendingSnapshot: snapshot,
  pendingRevision: revision,
  syncState,
});

/**
 * The `reconcile_external` operation. Every action is a person's with authority
 * over the work, and none writes to the tracker: `attach` ties an existing work
 * to an issue, `refresh` reads it again, `accept_remote` takes a version that
 * was waiting, `convert_to_reference` gives the title and goal back to STMA, and
 * `detach` ends the tie while keeping its history.
 */
export async function reconcileExternal(
  tx: Db,
  ctx: WorkOpContext,
  payload: WorkReconcileExternalPayload,
  prefetch?: ExternalPrefetch,
): Promise<WorkOpResult> {
  const { principal, work } = assertAuthority(ctx);
  switch (payload.action) {
    case 'attach':
      return attachExternal(tx, ctx, principal, work, payload.mode, prefetch);
    case 'refresh':
      return refreshExternal(tx, ctx, work, await refOfWork(tx, work.id, payload.ref_id), prefetch);
    case 'accept_remote':
      return acceptRemote(tx, ctx, work, await refOfWork(tx, work.id, payload.ref_id), payload);
    case 'convert_to_reference':
      return convertToReference(tx, work, await refOfWork(tx, work.id, payload.ref_id), payload.reason);
    case 'detach':
      return detachExternal(tx, ctx, work, await refOfWork(tx, work.id, payload.ref_id), payload.reason);
  }
}

async function attachExternal(
  tx: Db,
  ctx: WorkOpContext,
  principal: WorkPrincipal,
  work: WorkItemRow,
  mode: 'reference' | 'external_authoritative',
  prefetch: ExternalPrefetch | undefined,
): Promise<WorkOpResult> {
  if (work.state === 'cancelled') {
    throw refuse('INVALID_TRANSITION', 'Cancelled work is not tied to anything new.', { next_action: 'Reopen it with a reason first.' });
  }
  const live = await liveRefOf(tx, work.id);
  if (live) {
    throw refuse('INVALID_TRANSITION', `This work is already tied to ${live.remoteId}; a work item follows one tracker record.`, {
      next_action: 'Detach it first.',
    });
  }
  const read = readOrRefuse(prefetch);
  // A record the work already reads as its contract waits for a person when the
  // work is accepted: attaching never reopens anything by itself.
  const holds = mode === 'external_authoritative' && work.state === 'accepted' && (await remoteContract(tx, work, read.snapshot)).differs;
  const ref = await insertRef(tx, ctx, principal, {
    workId: work.id,
    mode,
    read,
    pending: holds,
    field: 'payload.issue',
  });
  let followed: Followed = { revised: false, changed: [] };
  if (mode === 'external_authoritative') {
    if (!holds) followed = await followRemote(tx, ctx, work, read.snapshot);
    await tx.update(workItems).set({ origin: 'external' }).where(eq(workItems.id, work.id));
  }
  const outcome = holds ? 'pending' : followed.revised ? 'followed' : 'recorded';
  return {
    events: [
      {
        workId: work.id,
        type: 'work_external_attached',
        payload: {
          ref_id: ref.id,
          provider: 'github',
          remote_id: ref.remoteId,
          mode,
          remote_revision: read.snapshot.updated_at,
          outcome,
          ...followedPayload(followed),
        },
      },
    ],
    resultRef: ref.id,
    response: { external: { ...describeExternalRef(ref), outcome }, ...followedReply(followed) },
  };
}

/**
 * Insert one live record. The workspace-wide unique index is the backstop
 * under every lock order: two attaches of one issue to works in different
 * projects do not share a counter lock, and exactly one of them inserts.
 */
async function insertRef(
  tx: Db,
  ctx: WorkOpContext,
  principal: WorkPrincipal,
  input: {
    workId: string;
    mode: WorkExternalMode;
    read: Extract<ExternalPrefetch, { kind: 'read' }>;
    pending: boolean;
    field: string;
  },
): Promise<RefRow> {
  const { read } = input;
  // A connection removed while GitHub was being read: refused in words rather
  // than met as a foreign key the insert below would trip over. Read `for key
  // share`, the lock that insert's own foreign key check takes, so a disconnect
  // that comes between this read and the insert waits for this command to
  // commit, then leaves the new record readable and unavailable as it leaves
  // every other. Unlocked, a
  // self-hosted disconnect (no audit hook holding the workspace row) turned the
  // insert into an unhandled foreign key violation, answered 500.
  const [connection] = await tx
    .select({ id: teamIntegrations.id })
    .from(teamIntegrations)
    .where(eq(teamIntegrations.id, read.connection.id))
    .limit(1)
    .for('key share');
  if (!connection) {
    throw refuse('SOURCE_UNAVAILABLE', 'The GitHub connection was removed while the issue was being read.', {
      next_action: 'Connect the repository again, then send the command again.',
    });
  }
  const [ref] = await tx
    .insert(workExternalRefs)
    .values({
      workId: input.workId,
      teamId: ctx.teamId,
      projectId: ctx.projectId,
      provider: 'github',
      connectionId: read.connection.id,
      connectionLocator: read.connection.locator,
      remoteId: read.remoteId,
      remoteUrl: read.snapshot.url,
      mode: input.mode,
      remoteRevision: read.snapshot.updated_at,
      lastObservedAt: ctx.now,
      snapshot: read.snapshot,
      snapshotHash: read.hash,
      ...(input.pending
        ? pendingSet(read.snapshot, read.snapshot.updated_at, 'external_change_pending')
        : pendingSet(null, null, 'current')),
      createdAt: ctx.now,
    })
    .onConflictDoNothing()
    .returning();
  if (ref) return ref;
  throw new WorkRefusal(
    (await duplicateRefusal(tx, principal, ctx.teamId, read.remoteId, input.field)) ??
      workError('INVALID_INPUT', 'That GitHub issue is already tied to a work item in this workspace.', { fields: [input.field] }),
  );
}

async function refreshExternal(
  tx: Db,
  ctx: WorkOpContext,
  work: WorkItemRow,
  ref: RefRow,
  prefetch: ExternalPrefetch | undefined,
): Promise<WorkOpResult> {
  if (ref.mode === 'imported_native') {
    throw refuse('INVALID_TRANSITION', `${ref.remoteId} was imported as a native copy; it does not follow its source.`, {
      next_action: 'Convert it to a reference to keep reading GitHub beside the work.',
    });
  }
  if (!ref.connectionId) {
    // Removed between the read and the locks: the record stays, unavailable.
    throw new WorkRefusal((await connectionOfRef(tx, ref)) as WorkRefusalError);
  }
  const read = readOrRefuse(prefetch);
  if (read.connection.id !== ref.connectionId || read.remoteId !== ref.remoteId) {
    throw refuse('SOURCE_UNAVAILABLE', 'The record changed while GitHub was being read.', { next_action: 'Send the command again.' });
  }

  const incoming = read.snapshot;
  const pending = ref.pendingSnapshot as IssueSnapshot | null;
  // The newest version STMA knows: one waiting for a person is newer than (or
  // conflicts with) the one the work follows.
  const knownRevision = ref.pendingRevision ?? ref.remoteRevision;
  const knownHash = pending ? fingerprintJson(pending) : ref.snapshotHash;
  const order = compareRemoteRevisions(incoming.updated_at, knownRevision);
  const set: Partial<typeof workExternalRefs.$inferInsert> = {};
  let outcome: string;
  let followed: Followed = { revised: false, changed: [] };

  if (order === -1) {
    // GitHub's API is eventually consistent: an answer older than what is held
    // is a stale read, never a rollback.
    outcome = 'older_ignored';
  } else if (order === null || (order === 0 && read.hash !== knownHash)) {
    Object.assign(set, pendingSet(incoming, incoming.updated_at, 'conflict'), { lastObservedAt: ctx.now });
    outcome = 'conflict';
  } else if (order === 0) {
    set.lastObservedAt = ctx.now;
    outcome = 'unchanged';
  } else if (ref.mode === 'reference') {
    Object.assign(set, recorded(incoming, read.hash, ctx.now), pendingSet(null, null, 'current'));
    outcome = 'recorded';
  } else {
    const closed = work.state === 'accepted' || work.state === 'cancelled';
    const changes = (await remoteContract(tx, work, incoming)).differs;
    if (closed && changes) {
      // Accepted work is never reopened by a tracker; it waits for a person.
      Object.assign(set, pendingSet(incoming, incoming.updated_at, 'external_change_pending'), { lastObservedAt: ctx.now });
      outcome = 'pending';
    } else {
      if (!closed) followed = await followRemote(tx, ctx, work, incoming);
      Object.assign(set, recorded(incoming, read.hash, ctx.now), pendingSet(null, null, 'current'));
      outcome = followed.revised ? 'followed' : 'recorded';
    }
  }
  if (Object.keys(set).length) await tx.update(workExternalRefs).set(set).where(eq(workExternalRefs.id, ref.id));
  const [after] = await tx.select().from(workExternalRefs).where(eq(workExternalRefs.id, ref.id));
  return {
    events: [
      {
        workId: work.id,
        type: 'work_external_refreshed',
        payload: {
          ref_id: ref.id,
          remote_id: ref.remoteId,
          outcome,
          remote_revision: incoming.updated_at,
          remote_state: incoming.state,
          ...followedPayload(followed),
        },
      },
    ],
    resultRef: ref.id,
    response: { external: { ...describeExternalRef(after!), outcome }, ...followedReply(followed) },
  };
}

/** The columns of a record that now shows this version. */
const recorded = (snapshot: IssueSnapshot, hash: string, now: Date) => ({
  snapshot,
  snapshotHash: hash,
  remoteRevision: snapshot.updated_at,
  remoteUrl: snapshot.url,
  lastObservedAt: now,
});

async function acceptRemote(
  tx: Db,
  ctx: WorkOpContext,
  work: WorkItemRow,
  ref: RefRow,
  payload: Extract<WorkReconcileExternalPayload, { action: 'accept_remote' }>,
): Promise<WorkOpResult> {
  const pending = ref.pendingSnapshot as IssueSnapshot | null;
  if (!pending || !ref.pendingRevision) {
    throw refuse('INVALID_TRANSITION', `Nothing from ${ref.remoteId} is waiting to be reconciled.`, {
      next_action: 'Refresh it to read GitHub again.',
    });
  }
  if (payload.remote_revision !== ref.pendingRevision) {
    throw refuse(
      'INVALID_INPUT',
      `The version waiting is the one GitHub updated at ${ref.pendingRevision}; this command names ${payload.remote_revision}.`,
      { fields: ['payload.remote_revision'], next_action: 'Read the work again and accept the version it shows.' },
    );
  }
  let followed: Followed = { revised: false, changed: [] };
  if (ref.mode === 'external_authoritative') {
    if (work.state === 'cancelled') {
      throw refuse('INVALID_TRANSITION', 'Cancelled work does not take a new contract.', { next_action: 'Reopen it with a reason first.' });
    }
    const changes = (await remoteContract(tx, work, pending)).differs;
    if (work.state === 'accepted' && changes && !payload.reason) {
      throw refuse('INVALID_INPUT', 'Taking the remote change reopens this accepted work; say why.', {
        fields: ['payload.reason'],
      });
    }
    followed = await followRemote(tx, ctx, work, pending, work.state === 'accepted' ? { reopenReason: payload.reason } : {});
  }
  await tx
    .update(workExternalRefs)
    .set({ ...recorded(pending, fingerprintJson(pending), ref.lastObservedAt ?? ctx.now), ...pendingSet(null, null, 'current') })
    .where(eq(workExternalRefs.id, ref.id));
  const [after] = await tx.select().from(workExternalRefs).where(eq(workExternalRefs.id, ref.id));
  return {
    events: [
      {
        workId: work.id,
        type: 'work_external_reconciled',
        payload: {
          ref_id: ref.id,
          remote_id: ref.remoteId,
          action: 'accept_remote',
          remote_revision: payload.remote_revision,
          ...(followed.state?.from === 'accepted' ? { reopened: true } : {}),
          ...(payload.reason ? { reason: payload.reason } : {}),
          ...followedPayload(followed),
        },
      },
    ],
    resultRef: ref.id,
    response: { external: describeExternalRef(after!), ...followedReply(followed) },
  };
}

async function convertToReference(tx: Db, work: WorkItemRow, ref: RefRow, reason: string | undefined): Promise<WorkOpResult> {
  if (ref.mode === 'reference') {
    throw refuse('INVALID_TRANSITION', `${ref.remoteId} is already a reference.`);
  }
  // A version waiting for a person becomes what the reference shows: nothing
  // owns the title and goal any more, so there is nothing left to reconcile.
  const pending = ref.pendingSnapshot as IssueSnapshot | null;
  await tx
    .update(workExternalRefs)
    .set({
      mode: 'reference',
      ...(pending ? recorded(pending, fingerprintJson(pending), ref.lastObservedAt ?? new Date()) : {}),
      ...pendingSet(null, null, 'current'),
    })
    .where(eq(workExternalRefs.id, ref.id));
  await tx.update(workItems).set({ origin: 'native' }).where(eq(workItems.id, work.id));
  const [after] = await tx.select().from(workExternalRefs).where(eq(workExternalRefs.id, ref.id));
  return {
    events: [
      {
        workId: work.id,
        type: 'work_external_converted',
        payload: { ref_id: ref.id, remote_id: ref.remoteId, from_mode: ref.mode, to_mode: 'reference', ...(reason ? { reason } : {}) },
      },
    ],
    resultRef: ref.id,
    response: { external: describeExternalRef(after!) },
  };
}

/**
 * End the tie, keep the record. Leaving a source of truth needs a reason, which
 * the event keeps. It writes no revision: the title and goal stay exactly what
 * they were, and a revision with unchanged content would make every delivery,
 * acceptance and pinned assignment of the work out of date for nothing (design
 * section 4: equal content is not revised). Every later change is STMA's own.
 */
async function detachExternal(
  tx: Db,
  ctx: WorkOpContext,
  work: WorkItemRow,
  ref: RefRow,
  reason: string | undefined,
): Promise<WorkOpResult> {
  if (ref.mode === 'external_authoritative' && !reason) {
    throw refuse('INVALID_INPUT', "Detaching the record that owns this work's title and goal needs a reason.", {
      fields: ['payload.reason'],
    });
  }
  await tx
    .update(workExternalRefs)
    .set({ detachedAt: ctx.now, ...pendingSet(null, null, 'detached') })
    .where(eq(workExternalRefs.id, ref.id));
  if (ref.mode === 'external_authoritative') {
    await tx.update(workItems).set({ origin: 'native' }).where(eq(workItems.id, work.id));
  }
  const [after] = await tx.select().from(workExternalRefs).where(eq(workExternalRefs.id, ref.id));
  return {
    events: [
      {
        workId: work.id,
        type: 'work_external_detached',
        payload: {
          ref_id: ref.id,
          remote_id: ref.remoteId,
          mode: ref.mode,
          ...(ref.pendingRevision ? { discarded_pending_revision: ref.pendingRevision } : {}),
          ...(reason ? { reason } : {}),
        },
      },
    ],
    resultRef: ref.id,
    response: { external: describeExternalRef(after!) },
  };
}

// ---------------------------------------------------------------------------
// Create from a record.
// ---------------------------------------------------------------------------

export interface CreateExternal {
  title: string;
  goal: string;
  origin: 'native' | 'external';
  /** The revision's source: `external` when its title and goal came from the record. */
  source: 'native' | 'external';
  /** Tie the new work to the record, once its row exists. */
  attach(tx: Db, workId: string): Promise<WorkEventDraft>;
}

/**
 * What a create with `external` files, inside its transaction. `reference` and
 * `imported_native` take what the person typed and fill a missing title or
 * goal from the issue; `external_authoritative` takes the issue's, and refuses
 * a typed title or goal that says something else, as a patch would.
 */
export function externalForCreate(
  ctx: WorkOpContext,
  principal: WorkPrincipal,
  input: WorkCreateInput,
  prefetch: ExternalPrefetch | undefined,
): CreateExternal {
  if (principal.kind !== 'human') {
    throw refuse(
      'FORBIDDEN',
      'Only a person ties new work to a tracker record. File a native draft, and ask its owner to attach the issue.',
      { fields: ['external'] },
    );
  }
  const source = input.external!;
  const read = readOrRefuse(prefetch);
  const { snapshot } = read;
  const typedTitle = input.contract.title;
  const typedGoal = input.contract.goal;
  if (source.mode === 'external_authoritative') {
    const contradicted = [
      ...(typedTitle !== undefined && typedTitle !== snapshot.title ? ['contract.title'] : []),
      ...(typedGoal !== undefined && typedGoal !== snapshot.body ? ['contract.goal'] : []),
    ];
    if (contradicted.length) {
      throw refuse('FIELD_OWNED_EXTERNALLY', `${contradicted.join(' and ')} come from ${read.remoteId}, which owns them; leave them out.`, {
        fields: contradicted,
        next_action: `Change them on GitHub (${snapshot.url}), or file the work as a reference.`,
      });
    }
  }
  const authoritative = source.mode === 'external_authoritative';
  return {
    title: authoritative ? snapshot.title : (typedTitle ?? snapshot.title),
    goal: authoritative ? snapshot.body : (typedGoal ?? snapshot.body),
    origin: authoritative ? 'external' : 'native',
    source: source.mode === 'reference' ? 'native' : 'external',
    async attach(tx, workId) {
      const ref = await insertRef(tx, ctx, principal, {
        workId,
        mode: source.mode,
        read,
        pending: false,
        field: 'external.issue',
      });
      return {
        workId,
        type: 'work_external_attached',
        payload: {
          ref_id: ref.id,
          provider: 'github',
          remote_id: ref.remoteId,
          mode: source.mode,
          remote_revision: snapshot.updated_at,
          outcome: source.mode === 'reference' ? 'recorded' : 'imported',
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Field ownership and read-side state.
// ---------------------------------------------------------------------------

/** The live tracker record that is this work's source of truth, if one is. */
export async function authoritativeRef(tx: Db, workId: string) {
  const [owner] = await tx
    .select()
    .from(workExternalRefs)
    .where(
      and(
        eq(workExternalRefs.workId, workId),
        isNull(workExternalRefs.detachedAt),
        eq(workExternalRefs.mode, 'external_authoritative'),
      ),
    )
    .limit(1);
  return owner;
}

/**
 * Refuse a local patch of a field an external tracker owns, with
 * FIELD_OWNED_EXTERNALLY. `fields` are wire names (`contract.title`,
 * `coordination.priority`). Called inside the patch's transaction, so it reads
 * the reference rows under the same locks.
 *
 * `proposed` carries the values the patch would write; a field named with the
 * value it already has is not a local change. The console's contract form
 * sends every contract field it shows, and a form that keeps the title the
 * issue gave it must not be refused for repeating it.
 */
export async function assertLocallyOwned(
  tx: Db,
  workId: string,
  fields: readonly string[],
  proposed: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const named = fields.filter((field) => (EXTERNALLY_OWNED_FIELDS as readonly string[]).includes(field));
  if (!named.length) return;
  const owner = await authoritativeRef(tx, workId);
  if (!owner) return;
  const [work] = await tx.select({ revision: workItems.specRevision }).from(workItems).where(eq(workItems.id, workId));
  const current = work ? await loadRevision(tx, workId, work.revision) : null;
  const held: Record<string, string | undefined> = { 'contract.title': current?.title, 'contract.goal': current?.goal };
  const changed = named.filter((field) => !(field in proposed) || proposed[field] !== held[field]);
  if (!changed.length) return;
  throw refuse(
    'FIELD_OWNED_EXTERNALLY',
    `${changed.join(' and ')} ${changed.length > 1 ? 'are' : 'is'} owned by GitHub issue ${owner.remoteId} while it is this work's source of truth.`,
    {
      fields: changed,
      next_action: `Change it on GitHub${owner.remoteUrl ? ` (${owner.remoteUrl})` : ''} and refresh, or convert the record to a reference to own it here.`,
    },
  );
}

export interface WorkExternalState {
  /** A newer remote snapshot is waiting for a person to reconcile it. */
  changePending: boolean;
  /** The tracker could not be read; the last snapshot is all there is. */
  unavailable: boolean;
}

export const NO_EXTERNAL: WorkExternalState = { changePending: false, unavailable: false };

/**
 * Per work id; a work missing from the map has no live record. A version
 * waiting for a person (a newer one on accepted work, or a conflict) is pending;
 * a record whose connection was removed is unavailable, derived from the
 * connection's absence rather than stored, so the removal needs no hook here.
 */
export async function externalState(db: Db, workIds: readonly string[]): Promise<Map<string, WorkExternalState>> {
  const out = new Map<string, WorkExternalState>();
  if (!workIds.length) return out;
  const rows = await db
    .select({
      workId: workExternalRefs.workId,
      pendingRevision: workExternalRefs.pendingRevision,
      connectionId: workExternalRefs.connectionId,
    })
    .from(workExternalRefs)
    .where(and(inArray(workExternalRefs.workId, [...workIds]), isNull(workExternalRefs.detachedAt)));
  for (const row of rows) {
    const held = out.get(row.workId) ?? { ...NO_EXTERNAL };
    out.set(row.workId, {
      changePending: held.changePending || row.pendingRevision !== null,
      unavailable: held.unavailable || row.connectionId === null,
    });
  }
  return out;
}

/** The body only for a live record: detached history needs to say what it was, not carry it again. */
const remoteSummary = (snapshot: IssueSnapshot, withBody: boolean) => ({
  title: snapshot.title,
  title_truncated: snapshot.title_truncated,
  ...(withBody ? { body: snapshot.body } : {}),
  body_truncated: snapshot.body_truncated,
  state: snapshot.state,
  labels: snapshot.labels,
  assignees: snapshot.assignees,
  updated_at: snapshot.updated_at,
});

/**
 * One record as every door shows it. The remote's own words (title, body,
 * labels) are data from somebody else's tracker; `state` is GitHub's, never an
 * STMA decision. `sync_state` reads `unavailable` once the connection is gone,
 * whatever was stored, because silence is not freshness.
 */
export function describeExternalRef(ref: RefRow) {
  const snapshot = ref.snapshot as IssueSnapshot | null;
  const pending = ref.pendingSnapshot as IssueSnapshot | null;
  const live = ref.detachedAt === null;
  return {
    id: ref.id,
    provider: ref.provider,
    provider_name: PROVIDER_NAME[ref.provider] ?? ref.provider,
    remote_id: ref.remoteId,
    remote_url: ref.remoteUrl,
    mode: ref.mode,
    sync_state: live && ref.connectionId === null ? 'unavailable' : ref.syncState,
    connection_available: ref.connectionId !== null,
    remote_revision: ref.remoteRevision,
    last_observed_at: ref.lastObservedAt?.toISOString() ?? null,
    remote: snapshot ? remoteSummary(snapshot, live) : null,
    pending: pending ? { remote_revision: ref.pendingRevision, ...remoteSummary(pending, live) } : null,
    owned_fields: live && ref.mode === 'external_authoritative' ? [...EXTERNALLY_OWNED_FIELDS] : [],
    created_at: ref.createdAt.toISOString(),
    detached_at: ref.detachedAt?.toISOString() ?? null,
  };
}
