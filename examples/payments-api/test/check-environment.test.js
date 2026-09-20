import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-environment.mjs', import.meta.url));
const check = (env) => spawnSync(process.execPath, [script], { env, encoding: 'utf8' });

test('environment fixture exits nonzero before smoke when the required name is absent', () => {
  const result = check({});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required environment variable name: STMA_HUMAN_LAB/);
  assert.equal(result.stdout, '');
});

test('environment fixture runs the payment smoke without echoing the supplied value', () => {
  const value = 'synthetic-lab-value-must-never-be-echoed';
  const result = check({ STMA_HUMAN_LAB: value });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /create\/authorize\/capture smoke passed/);
  assert.equal(result.stderr, '');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
});

test('environment fixture checks the name, not whether its value is nonempty', () => {
  const result = check({ STMA_HUMAN_LAB: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Environment fixture gate passed/);
});
