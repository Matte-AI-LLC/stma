import { expect, it } from 'vitest';
import {
  approvalsNeeded,
  budgetVerdict,
  findDuplicates,
  intentOverlap,
  issueFromTaskKey,
  mergePolicyDocuments,
  policyDocumentSchema,
} from '@bridge/shared';

/**
 * The three checks a run gets before it touches anything, as pure rules.
 *
 * They are in `shared` because the server and the CLI must agree about them;
 * they are tested here because getting them subtly wrong is how a governance
 * feature becomes noise people turn off.
 */

const policy = (over: Record<string, unknown> = {}) => policyDocumentSchema.parse(over);
const claim = (type: string, key: string, access: 'read' | 'write' = 'write') =>
  ({ resourceType: type, resourceKey: key, access }) as never;

it('defaults to no gate and no budget, so nothing starts warning unasked', () => {
  const doc = policy();
  expect(doc.autonomy.requireApprovalFor).toEqual([]);
  expect(doc.changeBudget).toEqual({ maxScopeItems: 0, maxPaths: 0 });
  expect(approvalsNeeded(doc, [claim('migration', 'refunds')])).toEqual([]);
  expect(budgetVerdict(doc, [claim('path', 'a'), claim('path', 'b')]).over).toEqual([]);
});

it('asks for a person on the ground the team named, and only for writes', () => {
  const doc = policy({ autonomy: { requireApprovalFor: ['migration', 'contract'] } });
  const needs = approvalsNeeded(doc, [
    claim('migration', 'refunds-ledger'),
    claim('path', 'src/a.ts'),
    // Reading a contract is not changing it.
    claim('contract', 'CheckoutService', 'read'),
  ]);
  expect(needs).toEqual([{ resourceType: 'migration', resourceKey: 'refunds-ledger' }]);
});

it('counts the declared scope against the budget, paths separately', () => {
  const doc = policy({ changeBudget: { maxScopeItems: 3, maxPaths: 2 } });
  const inside = budgetVerdict(doc, [claim('path', 'a'), claim('migration', 'm')]);
  expect(inside.over).toEqual([]);

  const over = budgetVerdict(doc, [
    claim('path', 'a'),
    claim('path', 'b'),
    claim('path', 'c'),
    claim('migration', 'm'),
  ]);
  expect(over.over).toEqual([
    { limit: 'scope', declared: 4, budget: 3 },
    { limit: 'paths', declared: 3, budget: 2 },
  ]);
});

it('merges a project policy without letting it loosen the team', () => {
  const team = policy({
    autonomy: { requireApprovalFor: ['migration'] },
    changeBudget: { maxScopeItems: 10, maxPaths: 0 },
  });
  const project = policy({
    autonomy: { requireApprovalFor: ['contract'] },
    changeBudget: { maxScopeItems: 4, maxPaths: 3 },
  });
  const merged = mergePolicyDocuments(team, project);
  // Union: a project may add ground that needs a person, never remove it.
  expect(merged.autonomy.requireApprovalFor.sort()).toEqual(['contract', 'migration']);
  // Tighter wins, and an unset (0) budget must not read as "nothing allowed".
  expect(merged.changeBudget).toEqual({ maxScopeItems: 4, maxPaths: 3 });

  const loosen = mergePolicyDocuments(project, policy({ changeBudget: { maxScopeItems: 99, maxPaths: 0 } }));
  expect(loosen.changeBudget.maxScopeItems).toBe(4);
  expect(loosen.changeBudget.maxPaths).toBe(3);
});

it('reads the issue number out of the task key convention', () => {
  expect(issueFromTaskKey('#42')).toBe(42);
  expect(issueFromTaskKey(' #7 ')).toBe(7);
  expect(issueFromTaskKey('PAY-421')).toBeNull();
  expect(issueFromTaskKey(null)).toBeNull();
  // Not an issue reference — a bare number could be anything.
  expect(issueFromTaskKey('421')).toBeNull();
});

it('spots the same work by issue, by key, and by what it is described as', () => {
  const others = [
    { runId: 'r1', owner: 'ayse', agentName: 'ayse-claude', taskKey: '#42', issue: 42, intent: null },
    { runId: 'r2', owner: 'mert', agentName: 'mert-cursor', taskKey: 'PAY-9', issue: null, intent: null },
    {
      runId: 'r3',
      owner: 'deniz',
      agentName: 'deniz-codex',
      taskKey: 'INFRA-1',
      issue: null,
      intent: 'Rewrite the refund ledger read model for partial refunds',
    },
  ];
  expect(findDuplicates({ issue: 42, taskKey: '#42', intent: null }, others)[0]).toMatchObject({
    runId: 'r1',
    reason: 'same issue',
  });
  expect(findDuplicates({ taskKey: 'pay-9', issue: null, intent: null }, others)[0]).toMatchObject({
    runId: 'r2',
    reason: 'same task key',
  });
  expect(
    findDuplicates(
      { taskKey: 'X-1', issue: null, intent: 'Rewrite refund ledger read model, partial refunds' },
      others,
    )[0],
  ).toMatchObject({ runId: 'r3', reason: 'similar intent' });
});

it('does not call two different jobs the same work', () => {
  const others = [
    { runId: 'r1', owner: 'a', agentName: 'x', taskKey: 'A-1', issue: null, intent: 'Add a dark mode toggle to settings' },
  ];
  expect(
    findDuplicates({ taskKey: 'B-2', issue: null, intent: 'Fix the refund rounding bug' }, others),
  ).toEqual([]);
  // Common words alone must not be enough — otherwise every ticket matches.
  expect(intentOverlap('update the config for the service', 'update the docs for the release')).toBeLessThan(
    0.5,
  );
  expect(intentOverlap('refund ledger partial amounts', 'partial amounts refund ledger')).toBe(1);
});
