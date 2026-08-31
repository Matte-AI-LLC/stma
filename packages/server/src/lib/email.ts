/**
 * Email is the login identity for local accounts. Everything that writes
 * `users.email` goes through `normalizeEmail` so the unique index sees one
 * canonical form; `users.username` stays the display name and is derived here.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { users } from '../db/schema';
import { slugify } from './slug';

export const MAX_EMAIL = 254;

/** Lowercase + trim. The only accepted way to build a value for `users.email`. */
export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Pragmatic address check — deliverability is proven by the code we email, not
 * by a regex, so this only rejects shapes that cannot be an address at all.
 */
export function isEmail(value: string): boolean {
  return value.length <= MAX_EMAIL && /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value);
}

/** `alice@example.com` → `a•••e@example.com`; for logs, never for pages. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at < 1) return '•••';
  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (local.length <= 2) return `${local[0]}•••${domain}`;
  return `${local[0]}•••${local[local.length - 1]}${domain}`;
}

/**
 * A free display username derived from the email local part: `ada.lovelace@x.io`
 * → `ada-lovelace`, `-2`, `-3`… on collision.
 */
export async function usernameFromEmail(db: Db, email: string): Promise<string> {
  const local = email.slice(0, Math.max(0, email.lastIndexOf('@')));
  // slugify() falls back to "team" for input without letters or digits, which
  // would be a confusing username — use a neutral base instead.
  let base = /[a-z0-9]/i.test(local) ? slugify(local).slice(0, 28) : 'user';
  if (base.length < 2) base = 'user';
  for (let i = 1; i <= 200; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const taken = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate))
      .limit(1);
    if (taken.length === 0) return candidate;
  }
  // Unreachable in practice; keeps the signature total.
  return `${base}-${Date.now().toString(36)}`;
}

/** True when no other account holds this email. */
export async function emailIsFree(db: Db, email: string, exceptUserId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(2);
  return rows.every((r) => r.id === exceptUserId);
}
