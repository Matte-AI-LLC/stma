export class PaymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}
