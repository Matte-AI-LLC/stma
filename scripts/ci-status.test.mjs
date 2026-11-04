import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregatePassed, exportRequired } from './ci-status.mjs';

test('layout requires an exporter whenever private directories exist', () => {
  assert.equal(exportRequired({ exporter: false, ee: false, acceptance: false }), false);
  assert.equal(exportRequired({ exporter: true, ee: false, acceptance: false }), true);
  for (const ee of [false, true]) for (const acceptance of [false, true]) {
    assert.equal(exportRequired({ exporter: true, ee, acceptance }), true);
    if (ee || acceptance) assert.throws(() => exportRequired({ exporter: false, ee, acceptance }));
  }
});

test('aggregate accepts only complete success or the deliberate public-source skip', () => {
  const accepted = new Set([
    'success|success|success|true',
    'success|success|skipped|false',
  ]);
  const results = ['success', 'failure', 'cancelled', 'skipped', '', undefined];
  for (const layout of results) for (const core of results) for (const publicSource of results) {
    for (const required of ['true', 'false', '', undefined]) {
      const expected = accepted.has([layout, core, publicSource, required].join('|'));
      assert.equal(aggregatePassed({ layout, core, publicSource, required }), expected);
    }
  }
});
