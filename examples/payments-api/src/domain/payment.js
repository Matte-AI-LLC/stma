import { PaymentError } from './errors.js';

const SUPPORTED_CURRENCIES = new Set(['EUR', 'TRY', 'USD']);

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PaymentError('invalid_amount', `${field} must be a positive integer in minor units`);
  }
}

export function createPayment({ id, amountMinor, currency }) {
  if (!id?.trim()) throw new PaymentError('invalid_id', 'id is required');
  requirePositiveInteger(amountMinor, 'amountMinor');

  const normalizedCurrency = currency?.toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(normalizedCurrency)) {
    throw new PaymentError('unsupported_currency', `Unsupported currency: ${currency}`);
  }

  return Object.freeze({
    id,
    amountMinor,
    currency: normalizedCurrency,
    status: 'pending',
    authorizationId: null,
    capturedMinor: 0,
  });
}

export function authorizePayment(payment, authorizationId) {
  if (payment.status !== 'pending') {
    throw new PaymentError('invalid_state', 'Only pending payments can be authorized');
  }
  if (!authorizationId?.trim()) {
    throw new PaymentError('invalid_authorization', 'authorizationId is required');
  }

  return Object.freeze({ ...payment, status: 'authorized', authorizationId });
}

export function capturePayment(payment, amountMinor) {
  if (!['authorized', 'partially_captured'].includes(payment.status)) {
    throw new PaymentError('invalid_state', 'Payment must be authorized before capture');
  }
  requirePositiveInteger(amountMinor, 'amountMinor');

  const nextCapturedMinor = payment.capturedMinor + amountMinor;
  if (nextCapturedMinor > payment.amountMinor) {
    throw new PaymentError('capture_exceeds_authorization', 'Capture exceeds authorized amount');
  }

  return Object.freeze({
    ...payment,
    capturedMinor: nextCapturedMinor,
    status: nextCapturedMinor === payment.amountMinor ? 'captured' : 'partially_captured',
  });
}
