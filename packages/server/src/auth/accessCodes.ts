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
  /**
   * A configured code was submitted and matched.
   *
   * Separate from `ok`, which is also true when no code was required at all.
   * That difference is the whole distinction between "arrived through the beta
   * door" and "there was no door", and collapsing the two would file every
   * self-hosted and pre-beta account into the same bucket as a cohort.
   */
  matched: boolean;
  /** The cohort this code names, for the log. Never the code itself. */
  label?: string;
}

/**
 * A code matched, but the operator named no cohort for it.
 *
 * Deliberately a value `parseAccessCodes` cannot produce: it turns `CODE:` into
 * no label rather than an empty one, so this can only ever have been written
 * here. A sentinel word would have collided with a cohort somebody could
 * actually name.
 */
export const UNNAMED_COHORT = '';

/** What to store on the account. Null when nobody was asked for a code. */
export function cohortOf(verdict: AccessCodeVerdict): string | null {
  return verdict.matched ? (verdict.label ?? UNNAMED_COHORT) : null;
}

/**
 * The stored value as a person reads it.
 *
 * One function because the operator console groups by the raw value and prints
 * this, and a page that spelled the three states its own way would quietly
 * start disagreeing with the grouping beside it.
 */
export function describeCohort(cohort: string | null | undefined): string {
  if (cohort === null || cohort === undefined) return 'No access code';
  if (cohort === UNNAMED_COHORT) return 'Unnamed code';
  return cohort;
}

export function accessCodeRequired(env: Pick<Env, 'signupAccessCodes'>): boolean {
  return env.signupAccessCodes.length > 0;
}

export function matchAccessCode(
  env: Pick<Env, 'signupAccessCodes'>,
  submitted: string,
): AccessCodeVerdict {
  if (!accessCodeRequired(env)) return { ok: true, matched: false };
  const given = digest(submitted.trim());
  let found: { code: string; label?: string } | undefined;
  for (const entry of env.signupAccessCodes) {
    // Every candidate is compared, with no early exit: returning on the first
    // match would make the response time report which code was given.
    if (timingSafeEqual(given, digest(entry.code))) found = entry;
  }
  return found ? { ok: true, matched: true, label: found.label } : { ok: false, matched: false };
}
