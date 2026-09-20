import type { PolicyDocument } from '@bridge/shared';

/**
 * Where each rule of an effective policy comes from.
 *
 * A project is handed the workspace's rules merged with its own additions
 * (`mergePolicyDocuments`: lists are a union, a runtime the project names wins,
 * the tighter budget wins). The merged document is what an agent receives and
 * says nothing about origin, which is the question a person has on a project
 * page: "is this ours, or everybody's?" — and the one that decides where to go
 * to change it (the owner, 2026-09-20: "bunlar across workspace bir şey mi,
 * proje bazlı mı, belli değil").
 *
 * Derived on read from the two published documents, never stored: origin is a
 * relationship between two versions, and a column would be a cached answer
 * waiting to rot. A rule the project repeats is the workspace's — removing the
 * project's copy would change nothing, and the label must say so.
 */
export type RuleOrigin = 'workspace' | 'project';

export interface OriginRule {
  text: string;
  origin: RuleOrigin;
  /** What the project's line replaced or tightened, when it did. */
  note?: string;
}

export interface OriginSection {
  key: string;
  label: string;
  rules: OriginRule[];
}

export interface PolicyOrigins {
  sections: OriginSection[];
  /** Rules only this project adds. */
  own: number;
  /** Rules that reach this project from the workspace. */
  inherited: number;
}

/**
 * Exactly the merge's notion of a duplicate (`unique` is a Set, so: the same string).
 * A friendlier comparison here would list fewer rules than an agent is served, and
 * a page that disagrees with `get_policy` is worse than one that shows a near-copy twice.
 */
function list(base: readonly string[], added: readonly string[] | undefined): OriginRule[] {
  const seen = new Set<string>();
  const rules: OriginRule[] = [];
  for (const text of base) {
    if (seen.has(text)) continue;
    seen.add(text);
    rules.push({ text, origin: 'workspace' });
  }
  for (const text of added ?? []) {
    if (seen.has(text)) continue;
    seen.add(text);
    rules.push({ text, origin: 'project' });
  }
  return rules;
}

/** 0 means unset, never "nothing allowed" — the same reading `changeBudget` has everywhere. */
function budget(label: string, base: number, added: number | undefined): OriginRule[] {
  const own = added ?? 0;
  if (base === 0 && own === 0) return [];
  if (own !== 0 && (base === 0 || own < base)) {
    return [{
      text: `${label}: ${own}`,
      origin: 'project',
      note: base === 0 ? undefined : `tighter than the workspace's ${base}`,
    }];
  }
  return [{ text: `${label}: ${base}`, origin: 'workspace' }];
}

export function policyOrigins(workspace: PolicyDocument, project?: PolicyDocument): PolicyOrigins {
  const runtimes: OriginRule[] = [];
  const projectRuntimes = project?.environment.runtimes ?? {};
  for (const [runtime, version] of Object.entries(workspace.environment.runtimes)) {
    const replaced = projectRuntimes[runtime];
    if (replaced !== undefined && replaced !== version) {
      runtimes.push({
        text: `${runtime} ${replaced}`,
        origin: 'project',
        note: `replaces the workspace's ${runtime} ${version}`,
      });
    } else {
      runtimes.push({ text: `${runtime} ${version}`, origin: 'workspace' });
    }
  }
  for (const [runtime, version] of Object.entries(projectRuntimes)) {
    if (runtime in workspace.environment.runtimes) continue;
    runtimes.push({ text: `${runtime} ${version}`, origin: 'project' });
  }

  const sections: OriginSection[] = [
    { key: 'guidance', label: 'Guidance', rules: list(workspace.guidance, project?.guidance) },
    { key: 'deny', label: 'Denied', rules: list(workspace.permissions.deny, project?.permissions.deny) },
    {
      key: 'approval',
      label: 'Requires approval',
      rules: list(workspace.permissions.requireApproval, project?.permissions.requireApproval),
    },
    { key: 'checks', label: 'Required checks', rules: list(workspace.requiredChecks, project?.requiredChecks) },
    { key: 'paths', label: 'Protected paths', rules: list(workspace.protectedPaths, project?.protectedPaths) },
    {
      key: 'env',
      label: 'Required env vars',
      rules: list(workspace.environment.requiredEnvVarNames, project?.environment.requiredEnvVarNames),
    },
    { key: 'runtimes', label: 'Runtimes', rules: runtimes },
    {
      key: 'autonomy',
      label: 'A person must approve',
      rules: list(workspace.autonomy.requireApprovalFor, project?.autonomy.requireApprovalFor),
    },
    {
      key: 'budget',
      label: 'Change budget',
      rules: [
        ...budget('max claims per run', workspace.changeBudget.maxScopeItems, project?.changeBudget.maxScopeItems),
        ...budget('max paths per run', workspace.changeBudget.maxPaths, project?.changeBudget.maxPaths),
      ],
    },
  ];
  const all = sections.flatMap((section) => section.rules);
  return {
    sections,
    own: all.filter((rule) => rule.origin === 'project').length,
    inherited: all.filter((rule) => rule.origin === 'workspace').length,
  };
}
