import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scenarioUrl = new URL('../scenario/agent-claims.json', import.meta.url);

test('the demo fixture models two writers on the same critical surfaces', async () => {
  const scenario = JSON.parse(await readFile(scenarioUrl, 'utf8'));
  const [first, second] = scenario.runs;

  const key = (claim) => `${claim.resourceType}:${claim.resourceKey}:${claim.access}`;
  const firstClaims = new Set(first.claims.map(key));
  const overlaps = second.claims.filter((claim) => firstClaims.has(key(claim)));

  assert.equal(scenario.project, 'payments-api');
  assert.equal(overlaps.length, 2);
  assert.ok(overlaps.some((claim) => claim.resourceType === 'migration'));
  assert.equal(scenario.expected.highestSeverity, 'critical');
});
