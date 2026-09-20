import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scenarioUrl = new URL('../scenario/agent-claims.json', import.meta.url);

test('the demo fixture models two writers on the same critical surfaces', async () => {
  const scenario = JSON.parse(await readFile(scenarioUrl, 'utf8'));
  const [first, second] = scenario.runs;

  const key = (claim) => `${claim.type}:${claim.key}:${claim.access}`;
  const firstClaims = new Set(first.scope.map(key));
  const overlaps = second.scope.filter((claim) => firstClaims.has(key(claim)));

  assert.equal(scenario.project, 'payments-api');
  assert.equal(overlaps.length, 3);
  assert.ok(overlaps.some((claim) => claim.type === 'migration'));
  assert.equal(scenario.expected.highestSeverity, 'critical');
  assert.equal(scenario.expected.secondWriterMustStopBeforeEditing, true);
  assert.match(first.branch, /^human-lab\//);
  assert.match(second.branch, /^human-lab\//);
  assert.notEqual(first.branch, second.branch);
  assert.ok(first.acceptance.length >= 4);
  assert.ok(second.acceptance.some((line) => line.includes('migrations/003_refunds.sql')));
  const testPaths = ['test/payment-attempts.test.js', 'test/refunds.test.js'];
  for (const [index, run] of scenario.runs.entries()) {
    assert.ok(run.scope.some((claim) => claim.type === 'path' && claim.access === 'write'
      && claim.key === testPaths[index]));
    assert.ok(run.acceptance.some((line) => line.includes(testPaths[index])));
    assert.ok(!overlaps.some((claim) => claim.key === testPaths[index]));
  }
});

test('the fixture policy makes migration approval and a real preflight observable', async () => {
  const policyUrl = new URL('../.stma/policy.json', import.meta.url);
  const policy = JSON.parse(await readFile(policyUrl, 'utf8'));

  assert.deepEqual(policy.autonomy.requireApprovalFor, ['migration']);
  assert.ok(policy.protectedPaths.includes('migrations/**'));
  assert.ok(policy.environment.requiredEnvVarNames.includes('STMA_HUMAN_LAB'));
  assert.ok(policy.requiredChecks.includes('npm test'));
  assert.ok(policy.permissions.deny.some((rule) => rule.includes('secret values')));
  const scenario = JSON.parse(await readFile(scenarioUrl, 'utf8'));
  for (const run of scenario.runs) {
    assert.ok(run.scope.length <= policy.changeBudget.maxScopeItems);
    assert.ok(run.scope.filter((claim) => claim.type === 'path').length <= policy.changeBudget.maxPaths);
  }
});
