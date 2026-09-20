/**
 * The private beta's front door.
 *
 * A cohort code, deliberately not a one-use invite. An invite already exists
 * and it does a different job — it adds a human to an existing workspace. This
 * is the door before that one: somebody who has no account and no workspace
 * yet, holding a code we handed out.
 *
 * Codes come only from configuration, never from the database, so the form can
 * refuse and the page can explain without either of them ever having to look
 * something up. Unset, this file answers yes to everything and signup behaves
 * exactly as it did — a self-hosted instance is not running our beta.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Env } from '../env';

/**
 * Compare digests rather than the codes themselves: `timingSafeEqual` throws on
 * a length mismatch, and guarding it with a length check would answer "how long
 * is the code" to anyone willing to ask a few hundred times.
 */
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export interface AccessCodeVerdict {
  ok: boolean;
  /** The cohort this code names, for the log. Never the code itself. */
  label?: string;
}

export function accessCodeRequired(env: Pick<Env, 'signupAccessCodes'>): boolean {
  return env.signupAccessCodes.length > 0;
}

export function matchAccessCode(
  env: Pick<Env, 'signupAccessCodes'>,
  submitted: string,
): AccessCodeVerdict {
  if (!accessCodeRequired(env)) return { ok: true };
  const given = digest(submitted.trim());
  let found: { code: string; label?: string } | undefined;
  for (const entry of env.signupAccessCodes) {
    // Every candidate is compared, with no early exit: returning on the first
    // match would make the response time report which code was given.
    if (timingSafeEqual(given, digest(entry.code))) found = entry;
  }
  return found ? { ok: true, label: found.label } : { ok: false };
}
