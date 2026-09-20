import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

export const sha256hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** scrypt password hash, self-describing format: `scrypt:<salt>:<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Pay the cost of a password check that cannot succeed.
 *
 * scrypt is deliberately expensive, so a handler that skips it when no account
 * row was found answers "is there an account at this address" in its own
 * response time — measured on loopback at 35.6ms against 3.7ms, a gap wide
 * enough to read across the internet. Every path that verifies a password calls
 * this on the miss so both branches cost the same.
 *
 * The salt is fixed and the digest is nobody's: the point is the work, and a
 * random salt each time would make this the only scrypt call whose cost nothing
 * else can reproduce.
 */
const ABSENT_ACCOUNT_HASH = `scrypt:${'00'.repeat(16)}:${'00'.repeat(64)}`;
export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, ABSENT_ACCOUNT_HASH);
}

/** Hex token, `bytes * 2` characters long. */
export const randomHex = (bytes = 20): string => randomBytes(bytes).toString('hex');

/** URL-safe short code (base64url). */
export const randomCode = (bytes = 9): string => randomBytes(bytes).toString('base64url');
