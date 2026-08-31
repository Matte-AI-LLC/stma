import type { PolicyDocument } from './policy';
import type { WorkClaim } from './agents';

/**
 * What a run should be told before it starts touching things.
 *
 * All three checks here are pure and run against what the run *declared*, which
 * is the only thing known at that moment — and the only moment where the answer
 * is still cheap to act on. None of them refuse the work: STMA warns agents, it
 * does not hold locks, and a gate an agent can route around is worse than a
 * sentence it can read.
 */

export interface ApprovalNeed {
  resourceType: string;
  resourceKey: string;
}

/**
 * Ground this team decided a person has to agree to.
 *
 * Per claim type rather than per agent, because the risk belongs to the work:
 * the same agent that should freely edit a test should not quietly rewrite a
 * migration chain.
 */
export function approvalsNeeded(
  policy: Pick<PolicyDocument, 'autonomy'>,
  claims: readonly WorkClaim[],
): ApprovalNeed[] {
  const gated = new Set(policy.autonomy.requireApprovalFor);
  if (gated.size === 0) return [];
  return claims
    .filter((claim) => claim.access === 'write' && gated.has(claim.resourceType))
    .map((claim) => ({ resourceType: claim.resourceType, resourceKey: claim.resourceKey }));
}

export interface BudgetVerdict {
  /** Which limit was passed, and by how much. Empty when the run is inside budget. */
  over: Array<{ limit: 'scope' | 'paths'; declared: number; budget: number }>;
}

/** Whether the declared scope is bigger than the team said one change should be. */
export function budgetVerdict(
  policy: Pick<PolicyDocument, 'changeBudget'>,
  claims: readonly WorkClaim[],
): BudgetVerdict {
  const over: BudgetVerdict['over'] = [];
  const { maxScopeItems, maxPaths } = policy.changeBudget;
  const paths = claims.filter((claim) => claim.resourceType === 'path').length;
  if (maxScopeItems > 0 && claims.length > maxScopeItems) {
    over.push({ limit: 'scope', declared: claims.length, budget: maxScopeItems });
  }
  if (maxPaths > 0 && paths > maxPaths) {
    over.push({ limit: 'paths', declared: paths, budget: maxPaths });
  }
  return { over };
}

export interface DuplicateCandidate {
  runId: string;
  owner: string;
  agentName: string;
  taskKey?: string | null;
  issue?: number | null;
  intent?: string | null;
}

export interface DuplicateFinding extends DuplicateCandidate {
  /** Why we think this is the same work. */
  reason: 'same issue' | 'same task key' | 'similar intent';
}

/** Words too common to make two intents "the same work". */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'add', 'fix',
  'update', 'change', 'make', 'use', 'is', 'are', 'be', 'it', 'this', 'that', 'we',
]);

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word)),
  );

/** Jaccard overlap of the meaningful words in two intents. */
export function intentOverlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Above this, two intents are similar enough to be worth mentioning. */
export const INTENT_OVERLAP_THRESHOLD = 0.5;

/**
 * Work somebody else already started.
 *
 * Deliberately three cheap signals rather than embeddings: the same issue and
 * the same task key are facts, and word overlap catches the honest case of two
 * people describing one job. It is a prompt to go and look, not a verdict —
 * being wrong here costs a sentence, and staying silent costs two agents
 * building the same thing.
 *
 * Attempt siblings are already excluded by the caller: deliberately racing two
 * attempts at one task is a pattern this product supports, not a mistake.
 */
export function findDuplicates(
  mine: { taskKey?: string | null; issue?: number | null; intent?: string | null },
  others: readonly DuplicateCandidate[],
): DuplicateFinding[] {
  const out: DuplicateFinding[] = [];
  for (const other of others) {
    if (mine.issue != null && other.issue != null && mine.issue === other.issue) {
      out.push({ ...other, reason: 'same issue' });
      continue;
    }
    const mineTask = mine.taskKey?.trim().toLowerCase();
    const otherTask = other.taskKey?.trim().toLowerCase();
    if (mineTask && otherTask && mineTask === otherTask) {
      out.push({ ...other, reason: 'same task key' });
      continue;
    }
    if (
      mine.intent &&
      other.intent &&
      intentOverlap(mine.intent, other.intent) >= INTENT_OVERLAP_THRESHOLD
    ) {
      out.push({ ...other, reason: 'similar intent' });
    }
  }
  return out;
}

/** `#42` in a task key is a GitHub issue number — the convention start_run sets. */
export function issueFromTaskKey(taskKey: string | null | undefined): number | null {
  const match = /^#(\d{1,9})$/.exec((taskKey ?? '').trim());
  return match ? Number(match[1]) : null;
}
