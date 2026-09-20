import assert from 'node:assert/strict';
import { authorizePayment, capturePayment, createPayment } from '../src/domain/payment.js';

// Deliberate lab-only environment gate. The payment domain does not require this
// variable; this command makes a reproducible cross-device failure observable.
// Check presence only, and never read or print the environment variable's value.
if (!Object.hasOwn(process.env, 'STMA_HUMAN_LAB')) {
  console.error('Missing required environment variable name: STMA_HUMAN_LAB. This fixture command cannot run its payment smoke until the name is present.');
  process.exitCode = 1;
} else {
  const pending = createPayment({ id: 'human-lab-payment', amountMinor: 1_250, currency: 'USD' });
  const authorized = authorizePayment(pending, 'human-lab-authorization');
  const captured = capturePayment(authorized, 1_250);
  assert.equal(pending.status, 'pending');
  assert.equal(authorized.status, 'authorized');
  assert.equal(captured.status, 'captured');
  assert.equal(captured.capturedMinor, 1_250);
  console.log('Environment fixture gate passed; create/authorize/capture smoke passed. No database or payment provider was contacted.');
}
