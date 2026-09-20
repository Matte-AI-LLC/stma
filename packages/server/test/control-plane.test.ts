import { describe, expect, it } from 'vitest';
import {
  areAttemptSiblings,
  detectClaimConflicts,
  mergePolicyDocuments,
  pathClaimsOverlap,
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

  it('uses glob semantics rather than comparing only static directory prefixes', () => {
    expect(pathClaimsOverlap('src/foo*.ts', 'src/foobar.ts')).toBe(true);
    expect(pathClaimsOverlap('src/file?.ts', 'src/file1.ts')).toBe(true);
    expect(pathClaimsOverlap('src/[ab].ts', 'src/b.ts')).toBe(true);
    expect(pathClaimsOverlap('src/[!ab].ts', 'src/c.ts')).toBe(true);
    expect(pathClaimsOverlap('src/**/index.ts', 'src/index.ts')).toBe(true);
    expect(pathClaimsOverlap('src/**/index.ts', 'src/a/b/index.ts')).toBe(true);

    expect(pathClaimsOverlap('src/a*.ts', 'src/b*.ts')).toBe(false);
    expect(pathClaimsOverlap('src/[ab].ts', 'src/c.ts')).toBe(false);
    expect(pathClaimsOverlap('src/[!ab].ts', 'src/a.ts')).toBe(false);
    expect(pathClaimsOverlap('src/*.ts', 'src/*.js')).toBe(false);
  });

  it('keeps literal directory scopes covering their descendants', () => {
    expect(pathClaimsOverlap('src/payments', 'src/payments/refund.ts')).toBe(true);
    expect(pathClaimsOverlap('src/payments', 'src/catalog/refund.ts')).toBe(false);
  });

  it('only exempts a same-owner attempt when both worktrees are present and distinct', () => {
    const base = { ownerId: 'alice', attemptGroup: 'PAY-1-fanout', taskKey: 'PAY-1' };
    expect(areAttemptSiblings(
      { ...base, attemptGroup: null, worktree: '/worktrees/a' },
      { ...base, attemptGroup: null, worktree: '/worktrees/b' },
    )).toBe(false);
    expect(
      areAttemptSiblings(
        { ...base, worktree: '/worktrees/pay-1-a' },
        { ...base, worktree: '/worktrees/pay-1-b' },
      ),
    ).toBe(true);
    expect(
      areAttemptSiblings(
        { ...base, worktree: '/worktrees/pay-1-a/' },
        { ...base, worktree: '/worktrees/./pay-1-a' },
      ),
    ).toBe(false);
    expect(
      areAttemptSiblings({ ...base, worktree: null }, { ...base, worktree: '/worktrees/pay-1-b' }),
    ).toBe(false);
    expect(
      areAttemptSiblings(
        { ...base, ownerId: 'alice', worktree: '/worktrees/pay-1-a' },
        { ...base, ownerId: 'bob', worktree: '/worktrees/pay-1-b' },
      ),
    ).toBe(false);
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
