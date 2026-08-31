import { describe, expect, it } from 'vitest';
import {
  detectClaimConflicts,
  mergePolicyDocuments,
  policyDocumentSchema,
  type ConflictClaim,
} from '@bridge/shared';

const claim = (
  runId: string,
  resourceType: ConflictClaim['resourceType'],
  resourceKey: string,
  access: ConflictClaim['access'] = 'write',
): ConflictClaim => ({
  runId,
  resourceType,
  resourceKey,
  access,
  owner: runId === 'a' ? 'alice' : 'bob',
  agentName: runId === 'a' ? 'alice-claude' : 'bob-codex',
});

describe('deterministic conflict radar', () => {
  it('finds path overlap and prioritizes sensitive resources', () => {
    const conflicts = detectClaimConflicts(
      [claim('a', 'path', 'src/payments/**'), claim('a', 'migration', 'payments-db')],
      [claim('b', 'path', 'src/payments/refund.ts'), claim('b', 'migration', 'payments-db')],
    );
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]?.severity).toBe('critical');
    expect(conflicts[1]?.severity).toBe('high');
  });

  it('ignores read/read and unrelated paths', () => {
    expect(
      detectClaimConflicts(
        [claim('a', 'path', 'src/payments/**', 'read')],
        [claim('b', 'path', 'src/payments/index.ts', 'read')],
      ),
    ).toEqual([]);
    expect(
      detectClaimConflicts(
        [claim('a', 'path', 'src/payments/**')],
        [claim('b', 'path', 'src/catalog/**')],
      ),
    ).toEqual([]);
  });

  it('marks lockfile overlap critical', () => {
    const conflicts = detectClaimConflicts(
      [claim('a', 'path', 'package-lock.json')],
      [claim('b', 'path', 'package-lock.json')],
    );
    expect(conflicts[0]?.severity).toBe('critical');
  });
});

describe('policy merge', () => {
  it('adds project rules while overriding runtime expectations', () => {
    const team = policyDocumentSchema.parse({
      guidance: ['Use typed APIs.'],
      permissions: { deny: ['read secrets'], requireApproval: [] },
      environment: { requiredEnvVarNames: ['API_URL'], runtimes: { node: '22' } },
    });
    const project = policyDocumentSchema.parse({
      guidance: ['Run contract tests.'],
      requiredChecks: ['npm test'],
      environment: { requiredEnvVarNames: ['PAYMENTS_URL'], runtimes: { node: '24' } },
    });
    const merged = mergePolicyDocuments(team, project);
    expect(merged.guidance).toEqual(['Use typed APIs.', 'Run contract tests.']);
    expect(merged.requiredChecks).toEqual(['npm test']);
    expect(merged.environment.requiredEnvVarNames).toEqual(['API_URL', 'PAYMENTS_URL']);
    expect(merged.environment.runtimes.node).toBe('24');
  });
});

