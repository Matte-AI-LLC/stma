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

/** Hex token, `bytes * 2` characters long. */
export const randomHex = (bytes = 20): string => randomBytes(bytes).toString('hex');

/** URL-safe short code (base64url). */
export const randomCode = (bytes = 9): string => randomBytes(bytes).toString('base64url');
