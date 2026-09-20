import { policyDocumentSchema, mergePolicyDocuments } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { policyOrigins } from '../src/lib/policyOrigin';

// Where a rule comes from is derived from the two published documents, so the
// derivation must agree with the merge an agent is actually served.
const workspace = policyDocumentSchema.parse({
  guidance: ['Ship behind a feature flag.'],
  permissions: { deny: ['push to main'], requireApproval: ['production changes'] },
  requiredChecks: ['npm test'],
  environment: { requiredEnvVarNames: ['CI'], runtimes: { node: '22.14.0', python: '3.12.4' } },
  autonomy: { requireApprovalFor: ['migration'] },
  changeBudget: { maxScopeItems: 10, maxPaths: 0 },
});
const project = policyDocumentSchema.parse({
  guidance: ['Never edit a released invoice migration.', 'Ship behind a feature flag.', 'ship behind a feature flag.'],
  permissions: { deny: ['read secret values'] },
  requiredChecks: ['npm test', 'npm run lint'],
  protectedPaths: ['db/migrations/**'],
  environment: { runtimes: { node: '24.1.0', go: '1.23' } },
  changeBudget: { maxScopeItems: 4, maxPaths: 25 },
});

const rules = (key: string, doc = policyOrigins(workspace, project)) =>
  doc.sections.find((section) => section.key === key)!.rules;

describe('policyOrigins', () => {
  it('lists exactly the rules the merge serves, no more and no fewer', () => {
    const merged = mergePolicyDocuments(workspace, project);
    const text = (key: string) => rules(key).map((rule) => rule.text);
    expect(text('guidance')).toEqual(merged.guidance);
    expect(text('deny')).toEqual(merged.permissions.deny);
    expect(text('approval')).toEqual(merged.permissions.requireApproval);
    expect(text('checks')).toEqual(merged.requiredChecks);
    expect(text('paths')).toEqual(merged.protectedPaths);
    expect(text('env')).toEqual(merged.environment.requiredEnvVarNames);
    expect(text('autonomy')).toEqual(merged.autonomy.requireApprovalFor);
    expect(text('runtimes').sort()).toEqual(
      Object.entries(merged.environment.runtimes).map(([runtime, version]) => `${runtime} ${version}`).sort(),
    );
  });

  it('files a rule the project repeats under the workspace, because removing the copy changes nothing', () => {
    expect(rules('guidance')).toEqual([
      { text: 'Ship behind a feature flag.', origin: 'workspace' },
      { text: 'Never edit a released invoice migration.', origin: 'project' },
      // A near-copy is a different string to the merge, so the agent is served both and the page shows both.
      { text: 'ship behind a feature flag.', origin: 'project' },
    ]);
    expect(rules('checks')).toEqual([
      { text: 'npm test', origin: 'workspace' },
      { text: 'npm run lint', origin: 'project' },
    ]);
  });

  it('names what a project runtime replaced, the one place a project overrides', () => {
    expect(rules('runtimes')).toEqual([
      { text: 'node 24.1.0', origin: 'project', note: "replaces the workspace's node 22.14.0" },
      { text: 'python 3.12.4', origin: 'workspace' },
      { text: 'go 1.23', origin: 'project' },
    ]);
  });

  it('credits the budget to whoever set the number that wins, and 0 is unset', () => {
    expect(rules('budget')).toEqual([
      { text: 'max claims per run: 4', origin: 'project', note: "tighter than the workspace's 10" },
      { text: 'max paths per run: 25', origin: 'project' },
    ]);
    // A looser project number does not win, so it is not shown as the project's.
    const loose = policyDocumentSchema.parse({ changeBudget: { maxScopeItems: 40 } });
    expect(rules('budget', policyOrigins(workspace, loose))).toEqual([
      { text: 'max claims per run: 10', origin: 'workspace' },
    ]);
  });

  it('counts both sides, and a project with no document inherits everything', () => {
    const both = policyOrigins(workspace, project);
    expect(both.own).toBe(9);
    expect(both.inherited).toBe(7);
    const inherited = policyOrigins(workspace);
    expect(inherited.own).toBe(0);
    expect(inherited.inherited).toBe(9);
    expect(inherited.sections.flatMap((section) => section.rules).every((rule) => rule.origin === 'workspace')).toBe(true);
  });
});
