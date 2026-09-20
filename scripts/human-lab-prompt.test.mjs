import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./human-lab-prompt.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const labels = ['--team', 'acceptance-team', '--device-a', 'mac-codex', '--device-b', 'windows-claude'];

function temporary(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'stma-prompt-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('bundle supplies a consistent repeatable branch contract and starts with no accepted evidence', (t) => {
  const directory = path.join(temporary(t), 'pack');
  const result = run('bundle', ...labels, '--run', 'acceptance-01', '--out', directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readdirSync(directory).length, 10);
  const record = JSON.parse(readFileSync(path.join(directory, 'results.json'), 'utf8'));
  assert.equal(record.status, 'NOT_RUN');
  assert.equal(record.buildSha, null);
  assert.equal(record.independentUserAcceptance.status, 'NOT_RUN');
  assert.ok(record.cases.every((item) => item.status === 'NOT_RUN' && item.evidence.length === 0));
  assert.equal(record.branches.integration, 'human-lab/acceptance-01/integration');
  const a = readFileSync(path.join(directory, '02-pause-device-a.txt'), 'utf8');
  const b = readFileSync(path.join(directory, '06-pay-202-device-b.txt'), 'utf8');
  const review = readFileSync(path.join(directory, '05-review-pay-201-device-b.txt'), 'utf8');
  const decision = readFileSync(path.join(directory, '07-human-decision-pay-202.txt'), 'utf8');
  assert.ok(a.includes(record.branches.a));
  assert.ok(b.includes(record.branches.b));
  assert.ok(review.includes(record.branches.a));
  assert.ok(decision.includes(record.branches.b) && decision.includes(record.branches.integration));
  assert.match(decision, /003_refunds.sql/);
  assert.match(a, /result field is runId; pass that value as run_id/);
  assert.match(a, /waiting before the returned leaseMinutes expires/);
  assert.match(a, /"key": "test\/payment-attempts.test.js"/);
  assert.match(b, /"key": "test\/refunds.test.js"/);
  assert.match(review, /not a grant of permission/);
  assert.match(review, /head_sha/);
  assert.match(review, /get_evidence with the review's actual runId as run_id/);
  assert.match(review, /finish_run with the review's actual runId as run_id/);
});

test('two separately generated bundles choose distinct branches without editing the fixture', (t) => {
  const directory = temporary(t);
  const records = ['one', 'two'].map((name) => {
    const out = path.join(directory, name);
    const result = run('bundle', ...labels, '--out', out);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(path.join(out, 'results.json'), 'utf8'));
  });
  assert.notEqual(records[0].branches.a, records[1].branches.a);
  assert.notEqual(records[0].branches.integration, records[1].branches.integration);
  assert.match(records[0].branches.b, /^human-lab\/\d{4}-\d{2}-\d{2}-[a-f\d]{8}\/PAY-202-refunds$/);
});

test('existing output is never overwritten', (t) => {
  const directory = temporary(t);
  writeFileSync(path.join(directory, 'results.json'), 'actual human evidence');
  const result = run('bundle', ...labels, '--out', directory);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /output already exists/);
  assert.equal(readFileSync(path.join(directory, 'results.json'), 'utf8'), 'actual human evidence');
  assert.deepEqual(readdirSync(directory), ['results.json']);
});

test('credential-like labels and unsupported token flags are rejected without echoing values', () => {
  const credential = `stma_${'a'.repeat(40)}`;
  for (const args of [
    ['baseline', '--team', credential, '--device', 'mac'],
    ['baseline', '--team', 'safe', '--device', 'mac', '--token', credential],
    ['bundle', '--team', 'safe', '--device-a', credential, '--device-b', 'windows'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(credential));
  }
});

test('ambiguous or malformed arguments cannot silently change prompt scope', () => {
  for (const args of [
    ['baseline', '--team', 'one', '--team', 'two', '--device', 'mac'],
    ['baseline', '--team', 'safe', '--device'],
    ['baseline', '--team', 'safe', '--device', 'mac', '--run', '../other'],
    ['baseline', '--team', 'safe', '--device', 'mac', '--run', '.hidden'],
    ['bundle', '--team', 'safe', '--device-a', 'same', '--device-b', 'same'],
    ['validate', '--team', 'safe'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
  }
});

test('individual prompts retain compatibility and support the same run namespace', () => {
  const baseline = run('baseline', '--team', 'safe', '--device', 'mac');
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.match(baseline.stdout, /Do not start a run yet/);
  const a = run('device-a', '--team', 'safe', '--device', 'mac', '--run', 'repeat-02');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /human-lab\/repeat-02\/PAY-201-payment-attempts/);
  assert.match(a.stdout, /"project": "payments-api"/);
  assert.match(a.stdout, /Do not finish_run before handing off/);
});
