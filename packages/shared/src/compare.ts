import type { Snapshot } from './snapshot';

export type DiffKind = 'only_a' | 'only_b' | 'mismatch';

export interface DiffEntry {
  key: string;
  a?: string;
  b?: string;
  kind: DiffKind;
}

export interface DiffSection {
  section: string;
  entries: DiffEntry[];
}

export interface CompareResult {
  identical: boolean;
  totalDifferences: number;
  /** Total number of keys examined across both snapshots (union). */
  comparedKeys: number;
  /** comparedKeys - totalDifferences */
  identicalKeys: number;
  sections: DiffSection[];
  /** Human-readable one-liners, capped. */
  summary: string[];
}

function defined(obj: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function diffRecords(
  a: Record<string, string>,
  b: Record<string, string>,
): { entries: DiffEntry[]; union: number } {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const entries: DiffEntry[] = [];
  for (const key of keys) {
    const va = a[key];
    const vb = b[key];
    if (va === undefined) entries.push({ key, b: vb, kind: 'only_b' });
    else if (vb === undefined) entries.push({ key, a: va, kind: 'only_a' });
    else if (va !== vb) entries.push({ key, a: va, b: vb, kind: 'mismatch' });
  }
  return { entries, union: keys.length };
}

function diffSets(a: string[], b: string[]): { entries: DiffEntry[]; union: number } {
  const sa = new Set(a);
  const sb = new Set(b);
  const entries: DiffEntry[] = [];
  for (const key of [...sa].filter((x) => !sb.has(x)).sort()) entries.push({ key, kind: 'only_a' });
  for (const key of [...sb].filter((x) => !sa.has(x)).sort()) entries.push({ key, kind: 'only_b' });
  return { entries, union: new Set([...sa, ...sb]).size };
}

const SUMMARY_CAP = 80;

/**
 * Mechanical diff between two environment snapshots. Pure and deterministic —
 * this is the "works on my machine" detector.
 */
export function compareSnapshots(
  a: Snapshot,
  b: Snapshot,
  labels: { a: string; b: string } = { a: 'A', b: 'B' },
): CompareResult {
  const sections: DiffSection[] = [];
  let comparedKeys = 0;
  const push = (section: string, diff: { entries: DiffEntry[]; union: number }) => {
    comparedKeys += diff.union;
    if (diff.entries.length > 0) sections.push({ section, entries: diff.entries });
  };

  push(
    'os',
    diffRecords(
      defined({ platform: a.os.platform, arch: a.os.arch, release: a.os.release }),
      defined({ platform: b.os.platform, arch: b.os.arch, release: b.os.release }),
    ),
  );
  push('runtimes', diffRecords(a.runtimes, b.runtimes));
  push('packageManagers', diffRecords(a.packageManagers, b.packageManagers));
  push(
    'lockfiles',
    diffRecords(
      Object.fromEntries(a.lockfiles.map((l) => [l.path, l.hash])),
      Object.fromEntries(b.lockfiles.map((l) => [l.path, l.hash])),
    ),
  );
  // An unreported list compares as empty here on purpose: the diff's job is to
  // show what the two snapshots say, and one of them says nothing.
  push('envVarNames', diffSets(a.envVarNames ?? [], b.envVarNames ?? []));

  const gitA = a.git;
  const gitB = b.git;
  const gitRecords = diffRecords(
    defined({ branch: gitA?.branch, sha: gitA?.sha, aheadBehind: gitA?.aheadBehind }),
    defined({ branch: gitB?.branch, sha: gitB?.sha, aheadBehind: gitB?.aheadBehind }),
  );
  const gitDirty = diffSets(gitA?.dirtyFiles ?? [], gitB?.dirtyFiles ?? []);
  push('git', {
    entries: [...gitRecords.entries, ...gitDirty.entries.map((e) => ({ ...e, key: `dirty:${e.key}` }))],
    union: gitRecords.union + gitDirty.union,
  });
  push(
    'system',
    diffRecords(
      defined({ shell: a.shell, locale: a.locale, timezone: a.timezone }),
      defined({ shell: b.shell, locale: b.locale, timezone: b.timezone }),
    ),
  );

  const lines: string[] = [];
  for (const sec of sections) {
    for (const e of sec.entries) {
      const path = `${sec.section}.${e.key}`;
      if (e.kind === 'mismatch') {
        lines.push(`${path}: ${labels.a}=${e.a} vs ${labels.b}=${e.b}`);
      } else if (e.kind === 'only_a') {
        lines.push(`${path}: only on ${labels.a}${e.a ? ` (${e.a})` : ''}`);
      } else {
        lines.push(`${path}: only on ${labels.b}${e.b ? ` (${e.b})` : ''}`);
      }
    }
  }
  const totalDifferences = lines.length;
  const summary =
    lines.length > SUMMARY_CAP
      ? [...lines.slice(0, SUMMARY_CAP), `… and ${lines.length - SUMMARY_CAP} more`]
      : lines;

  return {
    identical: totalDifferences === 0,
    totalDifferences,
    comparedKeys,
    identicalKeys: comparedKeys - totalDifferences,
    sections,
    summary,
  };
}
