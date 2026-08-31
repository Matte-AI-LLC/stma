import type { ClaimAccessMode, ClaimResourceType, WorkClaim } from './agents';

export type ConflictSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ConflictClaim extends WorkClaim {
  runId: string;
  owner: string;
  agentName: string;
  taskKey?: string | null;
}

export interface ClaimConflict {
  severity: ConflictSeverity;
  reason: string;
  current: ConflictClaim;
  existing: ConflictClaim;
}

const SPECIAL_PATH_RE =
  /(^|\/)(?:[^/]*lock(?:\.[^/]*)?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*migration.*|schema\.(?:sql|prisma)|(?:terraform|k8s|kubernetes)(?:\/|$))/i;

function normalizeKey(type: ClaimResourceType, key: string): string {
  const normalized = key.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  // Paths are lowercased too. Windows and default macOS treat src/DB/Schema.ts
  // and src/db/schema.ts as one file, and both spellings arise naturally — one
  // typed into --scope by hand, the other read out of git status. Comparing them
  // case-sensitively meant two agents editing the same file saw no conflict. The
  // cost is a rare false positive on a case-sensitive filesystem, which is the
  // safe direction for a collision warning.
  return normalized.toLowerCase();
}

function staticPrefix(pattern: string): string {
  const wildcard = pattern.search(/[?*[]/);
  return (wildcard === -1 ? pattern : pattern.slice(0, wildcard)).replace(/\/+$/, '');
}

function pathClaimsOverlap(a: string, b: string): boolean {
  const na = normalizeKey('path', a);
  const nb = normalizeKey('path', b);
  if (na === nb) return true;
  const pa = staticPrefix(na);
  const pb = staticPrefix(nb);
  if (!pa || !pb) return true;
  return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

function claimsOverlap(a: WorkClaim, b: WorkClaim): boolean {
  if (a.resourceType !== b.resourceType) return false;
  if (a.resourceType === 'path') return pathClaimsOverlap(a.resourceKey, b.resourceKey);
  return normalizeKey(a.resourceType, a.resourceKey) === normalizeKey(b.resourceType, b.resourceKey);
}

function severityFor(type: ClaimResourceType, a: string, b: string): ConflictSeverity {
  if (type === 'migration' || type === 'contract') return 'critical';
  if (type === 'config') return 'high';
  if (type === 'component') return 'medium';
  if (SPECIAL_PATH_RE.test(a) || SPECIAL_PATH_RE.test(b)) return 'critical';
  return 'high';
}

function reasonFor(type: ClaimResourceType, access: ClaimAccessMode): string {
  if (type === 'migration') return 'Both runs may change the same migration chain.';
  if (type === 'contract') return 'Both runs may change the same shared contract.';
  if (type === 'config') return 'The runs overlap on shared configuration.';
  if (type === 'component') return 'The runs overlap in the same component.';
  return access === 'write'
    ? 'The runs may write to the same path.'
    : 'One run may read files while the other changes them.';
}

/** Everything needed to tell a parallel attempt from a genuine collision. */
export interface AttemptIdentity {
  /** The human who owns the agent — siblings are always one person's own runs. */
  ownerId: string;
  attemptGroup?: string | null;
  taskKey?: string | null;
  worktree?: string | null;
}

const trimmed = (v: string | null | undefined): string | null => {
  const s = v?.trim();
  return s ? s : null;
};

/**
 * Two runs that are deliberately attacking the same task in parallel.
 *
 * Fanning one prompt across several worktrees is the ordinary way to use a
 * coding agent now, and every such fan-out used to arrive as N collisions on
 * the same files — the loudest possible warning about the one thing that was
 * not a problem. Siblings are exempt from each other's warnings; everyone
 * else's overlap still reports.
 *
 * Two ways to be siblings, and both require the same owner:
 *  - the runs named the same `attemptGroup` — an explicit "these are attempts";
 *  - they carry the same task key from *different* worktrees, which is what a
 *    fan-out looks like when nobody named the group. Same task in the same
 *    worktree stays a conflict: that is two agents in one checkout, which is
 *    the real accident.
 */
export function areAttemptSiblings(a: AttemptIdentity, b: AttemptIdentity): boolean {
  if (a.ownerId !== b.ownerId) return false;
  const groupA = trimmed(a.attemptGroup);
  const groupB = trimmed(b.attemptGroup);
  if (groupA && groupB) return groupA === groupB;
  const taskA = trimmed(a.taskKey);
  const taskB = trimmed(b.taskKey);
  if (!taskA || !taskB || taskA !== taskB) return false;
  const treeA = trimmed(a.worktree);
  const treeB = trimmed(b.worktree);
  return Boolean(treeA && treeB && treeA !== treeB);
}

/** Pure, deterministic conflict detection for active work claims. */
export function detectClaimConflicts(
  current: ConflictClaim[],
  existing: ConflictClaim[],
): ClaimConflict[] {
  const out: ClaimConflict[] = [];
  for (const a of current) {
    for (const b of existing) {
      if (a.runId === b.runId || (a.access === 'read' && b.access === 'read')) continue;
      if (!claimsOverlap(a, b)) continue;
      const writeAccess: ClaimAccessMode =
        a.access === 'write' || b.access === 'write' ? 'write' : 'read';
      out.push({
        severity: severityFor(a.resourceType, a.resourceKey, b.resourceKey),
        reason: reasonFor(a.resourceType, writeAccess),
        current: a,
        existing: b,
      });
    }
  }
  const rank: Record<ConflictSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.current.resourceKey.localeCompare(b.current.resourceKey) ||
      a.existing.runId.localeCompare(b.existing.runId),
  );
}

