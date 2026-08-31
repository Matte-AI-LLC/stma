import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizePayment,
  capturePayment,
  createPayment,
} from '../src/domain/payment.js';

test('creates, authorizes and fully captures a payment without mutating prior states', () => {
  const pending = createPayment({ id: 'pay_001', amountMinor: 1_250, currency: 'try' });
  const authorized = authorizePayment(pending, 'auth_001');
  const captured = capturePayment(authorized, 1_250);

  assert.equal(pending.status, 'pending');
  assert.equal(authorized.status, 'authorized');
  assert.equal(captured.status, 'captured');
  assert.equal(captured.capturedMinor, 1_250);
  assert.equal(captured.currency, 'TRY');
});

test('supports partial capture while protecting the authorized amount', () => {
  const authorized = authorizePayment(
    createPayment({ id: 'pay_002', amountMinor: 2_000, currency: 'EUR' }),
    'auth_002',
  );
  const partial = capturePayment(authorized, 750);

  assert.equal(partial.status, 'partially_captured');
  assert.equal(partial.capturedMinor, 750);
  assert.throws(
    () => capturePayment(partial, 1_251),
    (error) => error.code === 'capture_exceeds_authorization',
  );
});

test('rejects invalid amounts and unsupported currencies', () => {
  assert.throws(
    () => createPayment({ id: 'pay_003', amountMinor: 0, currency: 'USD' }),
    (error) => error.code === 'invalid_amount',
  );
  assert.throws(
    () => createPayment({ id: 'pay_004', amountMinor: 100, currency: 'GBP' }),
    (error) => error.code === 'unsupported_currency',
  );
});
