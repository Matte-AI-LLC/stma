import type { AgentRunStatus, ClaimAccessMode, ClaimResourceType, WorkClaim } from './agents';

export type ConflictSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ConflictClaim extends WorkClaim {
  runId: string;
  owner: string;
  agentName: string;
  taskKey?: string | null;
  /**
   * What the holding run is doing and when this claim lapses if nobody renews
   * it. Read from the row, present only on a claim somebody already holds —
   * the claims a caller is declaring right now have no run state yet.
   */
  runState?: AgentRunStatus;
  leaseEndsAt?: string;
}

export interface ClaimConflict {
  severity: ConflictSeverity;
  reason: string;
  current: ConflictClaim;
  existing: ConflictClaim;
}

/**
 * A run that stopped to ask a person keeps its claims for the waiting lease,
 * which is six times the active one. Reading that as work in progress is what
 * made the blocked agent in the first two-device round offer to "retry in five
 * minutes": it had no way to see the holder's state or its lease, so it guessed
 * from its own. `waiting` is the answer that changes what the reader should do.
 */
const HOLDER_STATE_WORDS: Record<AgentRunStatus, string> = {
  starting: 'starting up',
  active: 'working',
  waiting: 'stopped to ask a person',
  blocked: 'blocked',
  completed: 'completed',
  failed: 'failed',
  stale: 'gone stale',
};

/** Whether waiting for this holder to finish is likely to achieve anything. */
export const holderNeedsAPerson = (state: AgentRunStatus | undefined): boolean =>
  state === 'waiting' || state === 'blocked';

function describeHold(leaseEndsAt: string | undefined, now: Date, reading = false): string | undefined {
  if (!leaseEndsAt) return undefined;
  const ends = new Date(leaseEndsAt).getTime();
  if (!Number.isFinite(ends)) return undefined;
  const minutes = Math.round((ends - now.getTime()) / 60_000);
  if (minutes <= 0) return reading ? 'its read has run out' : 'its hold has run out';
  // A read holds nothing, so it is never called a hold: "holds it" is how a real
  // agent came to tell its human that a reviewer "holds the write lock".
  const verb = reading ? 'reading it' : 'holds it';
  if (minutes === 1) return `${verb} for about another minute`;
  return `${verb} for about another ${minutes} minutes`;
}

/**
 * One sentence naming who is on this ground, what their run is doing and when
 * their hold runs out. One function, because the agent map, the tool replies
 * and the heartbeat hook all answer this question and a person comparing two of
 * them must not be told two different stories.
 */
export function describeHolder(claim: ConflictClaim, now: Date = new Date()): string {
  const parts = [`${claim.agentName} (${claim.owner})`];
  if (claim.runState) parts.push(HOLDER_STATE_WORDS[claim.runState]);
  const hold = describeHold(claim.leaseEndsAt, now, claim.access === 'read');
  if (hold) parts.push(hold);
  return parts.join(', ');
}

/**
 * One side reads while the other writes. Two reads never collide, so a read on
 * either side is the whole test. A missing `access` is a write: that is what
 * every claim meant before reads were told apart, and what an older client sends.
 */
export const isReadOverlap = (conflict: {
  current: { access?: ClaimAccessMode };
  existing: { access?: ClaimAccessMode };
}): boolean => conflict.current.access === 'read' || conflict.existing.access === 'read';

/** A conflict as its two sides see it: my claim, their claim, and who was first. */
export interface RightOfWayConflict {
  severity?: ConflictSeverity;
  /**
   * `yours`: the other run declared it after you. `theirs`: you are the one who
   * waits. Between a read and a write the writer has it, whoever came first.
   */
  rightOfWay?: 'yours' | 'theirs';
  current: { resourceKey: string; access?: ClaimAccessMode };
  existing: ConflictClaim;
}

/** The things a collision can say to one run, each about its own ground. */
export interface ConflictReport {
  /** Ground another run declared first. This run waits for that ground. */
  blocked?: string;
  /** Ground this run declared first. The other run was told to wait for it. */
  holding?: string;
  /** Ground this run only reads while another run changes it: re-read, do not stop. */
  reading?: string;
  /** Ground this run changes while another run reads it: carry on, nobody waits. */
  readBy?: string;
  /** A holder parked on a person will not free its ground by itself. */
  needsAPerson: boolean;
}

export interface ConflictWords {
  now?: Date;
  /**
   * Agent names, usernames and resource keys are typed by people, and these
   * sentences land in another agent's context. The hook replaces any fragment
   * whose shape it does not recognise; the server, whose reply the same agent
   * reads, has always passed them through.
   */
  safe?: (text: string, kind: 'holder' | 'resource') => string;
}

const NAMED_RESOURCES = 3;
const NAMED_HOLDERS = 3;

function nameList(items: string[], limit: number): string {
  const unique = [...new Set(items)].filter(Boolean);
  const named = unique.slice(0, limit);
  const rest = unique.length - named.length;
  const head =
    named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : (named[0] ?? '');
  return rest > 0 ? `${head} and ${rest} more` : head;
}

/**
 * A collision, said once.
 *
 * Right of way splits every collision in two, and the halves call for opposite
 * things: ground somebody else declared first is ground to leave alone, ground
 * this run declared first is ground to carry on with. Both halves arrive at
 * once as soon as two runs claim the same three files in a different order —
 * and the two summaries used to be written separately and to name no ground at
 * all. Measured in the agent lab (2026-09-20): the tool reply said "narrow what
 * you touch, or coordinate", the prompt hook said "this run was first, carry
 * on", and the agent wrote down that the two contradicted each other, took the
 * cautious one and stopped over one file out of three.
 *
 * So both sentences are built here from the same rows, and each one names the
 * ground it is about. Same reason as `describeHolder`, one level up.
 *
 * A read against a write is neither half (T3 Mac round, 2026-09-23). It was
 * told as a write collision with the right of way to whoever declared first, so
 * a reviewer that declared `src/carrier.mjs` read-only was reported to the agent
 * actually changing it as the one holding it — "leave alone … which declared it
 * first" — and that agent told its human the reviewer held the write lock and
 * stopped. A read holds nothing: the writer carries on, and the reader is told
 * that what it read may change. Neither waits.
 */
export function conflictReport(
  conflicts: RightOfWayConflict[],
  { now = new Date(), safe = (text) => text }: ConflictWords = {},
): ConflictReport {
  const writes = conflicts.filter((conflict) => !isReadOverlap(conflict));
  const blocked = writes.filter((conflict) => conflict.rightOfWay !== 'yours');
  const holding = writes.filter((conflict) => conflict.rightOfWay === 'yours');
  const reading = conflicts.filter((conflict) => conflict.current.access === 'read');
  const readBy = conflicts.filter(
    (conflict) => conflict.current.access !== 'read' && conflict.existing.access === 'read',
  );
  const needsAPerson = blocked.some((conflict) => holderNeedsAPerson(conflict.existing.runState));
  const ground = (side: RightOfWayConflict[]) =>
    nameList(
      side.map((conflict) => safe(conflict.current.resourceKey, 'resource')),
      NAMED_RESOURCES,
    );
  const others = (side: RightOfWayConflict[]) =>
    nameList(
      side.map((conflict) => safe(describeHolder(conflict.existing, now), 'holder')),
      NAMED_HOLDERS,
    );
  const report: ConflictReport = { needsAPerson };

  if (reading.length > 0) {
    report.reading = `Another run is changing ground you are only reading (${ground(reading)}, changed by ${others(reading)}): what you read there may change. A read holds nothing and waits for nobody, so carry on, but re-read those files before you rely on them, and again once that run is done.`;
  }
  if (readBy.length > 0) {
    report.readBy = `Ground you are changing is also being read by ${others(readBy)} (${ground(readBy)}). A read holds nothing and does not make you wait: carry on with your change; that run was told its copy may change.`;
  }

  if (blocked.length > 0) {
    const holders = others(blocked);
    report.blocked = [
      blocked[0]?.severity === 'critical'
        ? 'STOP and tell your human before writing. Another live run holds the same migration or contract; claims are advisory, so nothing prevents you both from writing it. Coordinate through open_session or announce.'
        : 'Another live run overlaps your scope. Narrow what you touch, or coordinate through open_session before writing.',
      `The ground to leave alone is ${ground(blocked)}, held by ${holders}, which declared it first.`,
      needsAPerson
        ? 'The run holding it has stopped to ask a person, so it will not free the ground by itself — waiting will not help; say so to your human and coordinate.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (holding.length > 0) {
    report.holding = blocked.length
      ? `You were first on ${ground(holding)}, so that ground stays yours and the run that declared it after you was told to wait: carry on there, and complete, finish or release when your work there is done.`
      : `Another run declared ground you already hold (${ground(holding)}). You were first, so you keep the right of way and that run was told to wait for you: carry on, and complete, finish or release when your work is done, which is what frees the ground for it. Do not stop on its account.`;
  }
  return report;
}

const SPECIAL_PATH_RE =
  /(^|\/)(?:[^/]*lock(?:\.[^/]*)?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*migration.*|schema\.(?:sql|prisma)|(?:terraform|k8s|kubernetes)(?:\/|$))/i;

function normalizeKey(key: string): string {
  const normalized = key
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  // Paths are lowercased too. Windows and default macOS treat src/DB/Schema.ts
  // and src/db/schema.ts as one file, and both spellings arise naturally — one
  // typed into --scope by hand, the other read out of git status. Comparing them
  // case-sensitively meant two agents editing the same file saw no conflict. The
  // cost is a rare false positive on a case-sensitive filesystem, which is the
  // safe direction for a collision warning.
  return normalized.toLowerCase();
}

type CodePointRange = readonly [start: number, end: number];

interface GlobToken {
  /** Repeating tokens have both an epsilon edge and a consuming self-loop. */
  repeat: boolean;
  ranges: CodePointRange[];
}

const MAX_CODE_POINT = 0x10ffff;
const SLASH_CODE_POINT = '/'.codePointAt(0)!;
const ANY: CodePointRange[] = [[0, MAX_CODE_POINT]];
const NON_SLASH: CodePointRange[] = [
  [0, SLASH_CODE_POINT - 1],
  [SLASH_CODE_POINT + 1, MAX_CODE_POINT],
];

function mergeRanges(input: CodePointRange[]): CodePointRange[] {
  const sorted = [...input].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (!previous || start > previous[1] + 1) merged.push([start, end]);
    else previous[1] = Math.max(previous[1], end);
  }
  return merged;
}

function intersectRanges(a: CodePointRange[], b: CodePointRange[]): CodePointRange[] {
  const out: Array<[number, number]> = [];
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const left = a[ai]!;
    const right = b[bi]!;
    const start = Math.max(left[0], right[0]);
    const end = Math.min(left[1], right[1]);
    if (start <= end) out.push([start, end]);
    if (left[1] < right[1]) ai += 1;
    else bi += 1;
  }
  return out;
}

function rangesOverlap(a: CodePointRange[], b: CodePointRange[]): boolean {
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const left = a[ai]!;
    const right = b[bi]!;
    if (Math.max(left[0], right[0]) <= Math.min(left[1], right[1])) return true;
    if (left[1] < right[1]) ai += 1;
    else bi += 1;
  }
  return false;
}

function complementRanges(input: CodePointRange[]): CodePointRange[] {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (const [rangeStart, rangeEnd] of mergeRanges(input)) {
    if (start < rangeStart) out.push([start, rangeStart - 1]);
    start = Math.max(start, rangeEnd + 1);
  }
  if (start <= MAX_CODE_POINT) out.push([start, MAX_CODE_POINT]);
  return out;
}

function characterClass(
  characters: string[],
  open: number,
): { ranges: CodePointRange[]; next: number } | null {
  let cursor = open + 1;
  let negated = false;
  if (characters[cursor] === '!' || characters[cursor] === '^') {
    negated = true;
    cursor += 1;
  }

  const members: string[] = [];
  // A closing bracket is a member when it is the class's first character.
  if (characters[cursor] === ']') {
    members.push(']');
    cursor += 1;
  }
  while (cursor < characters.length && characters[cursor] !== ']') {
    members.push(characters[cursor]!);
    cursor += 1;
  }
  if (cursor >= characters.length || members.length === 0) return null;

  const ranges: CodePointRange[] = [];
  for (let i = 0; i < members.length; i += 1) {
    const member = members[i]!;
    if (i + 2 < members.length && members[i + 1] === '-') {
      const start = member.codePointAt(0)!;
      const end = members[i + 2]!.codePointAt(0)!;
      // A descending range is not part of the supported syntax. Treating the
      // opening bracket as a literal below keeps filenames containing it valid.
      if (start > end) return null;
      ranges.push([start, end]);
      i += 2;
    } else {
      const codePoint = member.codePointAt(0)!;
      ranges.push([codePoint, codePoint]);
    }
  }

  const selected = negated ? complementRanges(ranges) : mergeRanges(ranges);
  return { ranges: intersectRanges(selected, NON_SLASH), next: cursor + 1 };
}

/**
 * Compile the supported repository-relative path glob language:
 *
 * - `*` is zero or more characters except `/`;
 * - `**` is zero or more characters including `/`;
 * - `?` is exactly one character except `/`;
 * - `[abc]`, `[a-z]`, `[!abc]` and `[^abc]` are one non-`/` character;
 * - every other character is literal (an unclosed/invalid `[` is literal).
 *
 * Backslashes are normalized to `/` before compilation. Matching is
 * case-insensitive in the safe direction for Windows/default macOS checkouts.
 */
function compileGlob(pattern: string): GlobToken[] {
  const characters = Array.from(pattern);
  const tokens: GlobToken[] = [];
  for (let i = 0; i < characters.length; ) {
    const character = characters[i]!;
    if (character === '*') {
      let next = i + 1;
      while (characters[next] === '*') next += 1;
      tokens.push({ repeat: true, ranges: next - i >= 2 ? ANY : NON_SLASH });
      i = next;
      continue;
    }
    if (character === '?') {
      tokens.push({ repeat: false, ranges: NON_SLASH });
      i += 1;
      continue;
    }
    if (character === '[') {
      const parsed = characterClass(characters, i);
      if (parsed) {
        tokens.push({ repeat: false, ranges: parsed.ranges });
        i = parsed.next;
        continue;
      }
    }
    const codePoint = character.codePointAt(0)!;
    tokens.push({ repeat: false, ranges: [[codePoint, codePoint]] });
    i += 1;
  }
  return tokens;
}

function compileGlobVariants(pattern: string): GlobToken[][] | null {
  // In path glob conventions `**/` may stand for zero directories. The base
  // automaton's `**` consumes arbitrary characters and its following slash
  // covers one-or-more directories; the variant without that pair covers zero.
  // Bound expansion so adversarial 500-character inputs cannot create 2^N work.
  const parts = pattern.split(/(\*{2,}\/)/);
  let variants = [''];
  for (const part of parts) {
    if (/^\*{2,}\/$/.test(part)) {
      if (variants.length > 32) return null;
      variants = [...variants.map((prefix) => prefix + part), ...variants];
    } else {
      variants = variants.map((prefix) => prefix + part);
    }
  }
  return [...new Set(variants)].map(compileGlob);
}

/** Whether the two finite glob automata accept at least one common path. */
function globLanguagesOverlap(a: GlobToken[], b: GlobToken[]): boolean {
  const width = b.length + 1;
  const seen = new Uint8Array((a.length + 1) * width);
  const queue: number[] = [];
  const enqueue = (ai: number, bi: number) => {
    const state = ai * width + bi;
    if (seen[state]) return;
    seen[state] = 1;
    queue.push(state);
  };
  enqueue(0, 0);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor]!;
    const ai = Math.floor(state / width);
    const bi = state % width;
    if (ai === a.length && bi === b.length) return true;

    const left = a[ai];
    const right = b[bi];
    if (left?.repeat) enqueue(ai + 1, bi);
    if (right?.repeat) enqueue(ai, bi + 1);
    if (left && right && rangesOverlap(left.ranges, right.ranges)) {
      enqueue(left.repeat ? ai : ai + 1, right.repeat ? bi : bi + 1);
    }
  }
  return false;
}

function globPatternsOverlap(a: string, b: string): boolean {
  const left = compileGlobVariants(a);
  const right = compileGlobVariants(b);
  // Too many globstar-directory alternatives are treated as overlapping. A
  // noisy warning is safer than an attacker-shaped scope hiding a collision.
  if (!left || !right || left.length * right.length > 64) return true;
  return left.some((leftVariant) =>
    right.some((rightVariant) => globLanguagesOverlap(leftVariant, rightVariant)),
  );
}

/**
 * Path scopes include paths matched by the expression and their descendants.
 * Testing both descendant languages preserves the existing `src/payments`
 * directory-scope behavior while using real glob intersection instead of a
 * static-prefix guess.
 */
export function pathClaimsOverlap(a: string, b: string): boolean {
  const left = normalizeKey(a);
  const right = normalizeKey(b);
  if (left === right) return true;
  return (
    globPatternsOverlap(left, right) ||
    globPatternsOverlap(`${left}/**`, right) ||
    globPatternsOverlap(left, `${right}/**`)
  );
}

function claimsOverlap(a: WorkClaim, b: WorkClaim): boolean {
  if (a.resourceType !== b.resourceType) return false;
  if (a.resourceType === 'path') return pathClaimsOverlap(a.resourceKey, b.resourceKey);
  return normalizeKey(a.resourceKey) === normalizeKey(b.resourceKey);
}

function severityFor(type: ClaimResourceType, a: string, b: string): ConflictSeverity {
  if (type === 'migration' || type === 'contract') return 'critical';
  if (type === 'config') return 'high';
  if (type === 'component') return 'medium';
  if (SPECIAL_PATH_RE.test(a) || SPECIAL_PATH_RE.test(b)) return 'critical';
  return 'high';
}

/**
 * A read against a write is one step less severe than the same ground written
 * twice: somebody's copy may go stale, but nobody's change is at risk of being
 * overwritten. So reading a migration another run is changing is no longer the
 * team's red alarm, while two runs writing it still is.
 */
const SOFTER: Record<ConflictSeverity, ConflictSeverity> = {
  critical: 'high',
  high: 'medium',
  medium: 'low',
  low: 'low',
};

function reasonFor(type: ClaimResourceType, access: ClaimAccessMode): string {
  if (access === 'read') {
    if (type === 'migration') return 'One run reads the migration chain while the other changes it.';
    if (type === 'contract') return 'One run reads the shared contract while the other changes it.';
    if (type === 'config') return 'One run reads shared configuration while the other changes it.';
    if (type === 'component') return 'One run reads a component while the other changes it.';
    return 'One run may read files while the other changes them.';
  }
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

function normalizedWorktree(v: string | null | undefined): string | null {
  const value = trimmed(v)?.replaceAll('\\', '/').replace(/\/{2,}/g, '/').toLowerCase();
  if (!value) return null;
  const absolute = value.startsWith('/');
  const drive = /^[a-z]:\//.exec(value)?.[0] ?? '';
  const body = drive ? value.slice(drive.length) : absolute ? value.slice(1) : value;
  const parts: string[] = [];
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop();
      else if (!absolute && !drive) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  const prefix = drive || (absolute ? '/' : '');
  return `${prefix}${parts.join('/')}` || prefix || '.';
}

/**
 * Two runs that are deliberately attacking the same task in parallel.
 *
 * Fanning one prompt across several worktrees is the ordinary way to use a
 * coding agent now, and every such fan-out used to arrive as N collisions on
 * the same files — the loudest possible warning about the one thing that was
 * not a problem. Siblings are exempt from each other's warnings; everyone
 * else's overlap still reports.
 *
 * Siblings require an explicit shared attemptGroup, the same owner and two
 * present, distinct normalized worktree identities. A task key alone is not
 * consent to suppress overlap. Same group in the same worktree stays a conflict: an intent
 *    label does not make concurrent writers in one checkout safe.
 */
export function areAttemptSiblings(a: AttemptIdentity, b: AttemptIdentity): boolean {
  if (a.ownerId !== b.ownerId) return false;
  const treeA = normalizedWorktree(a.worktree);
  const treeB = normalizedWorktree(b.worktree);
  if (!treeA || !treeB || treeA === treeB) return false;
  const groupA = trimmed(a.attemptGroup);
  const groupB = trimmed(b.attemptGroup);
  return !!groupA && !!groupB && groupA === groupB;
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
      // Both sides write, or one of them only reads. This was `||` until
      // 2026-09-23, which after the read/read skip above is always true: every
      // read against a write was reported as two runs writing the same path, and
      // the sentence for a read was never reachable.
      const overlap: ClaimAccessMode = a.access === 'write' && b.access === 'write' ? 'write' : 'read';
      const severity = severityFor(a.resourceType, a.resourceKey, b.resourceKey);
      out.push({
        severity: overlap === 'write' ? severity : SOFTER[severity],
        reason: reasonFor(a.resourceType, overlap),
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
