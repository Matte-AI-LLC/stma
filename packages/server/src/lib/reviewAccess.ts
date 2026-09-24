/**
 * Review access: one account signs in with its password alone, until a date.
 *
 * Claude's connector directory asks for a test account and hands the reviewer
 * a username and a password. Sign-in here mails a code to the account's
 * address, which the reviewer cannot read, and giving them the mailbox too
 * would hand a third party a Google Workspace login (and Google challenges a
 * sign-in from an unknown device anyway). So an operator marks the account on
 * its admin page, with an end date, and the email-code step is skipped for it
 * until then.
 *
 * What it does not loosen: the password is still checked, the per-address
 * throttle still counts and locks, every such sign-in is mailed to the
 * account's own address, the browser session it opens lasts a day, and while
 * it lasts the account cannot change its address, delete itself or be an
 * operator (`isAdminUser` answers no). It lapses by the clock, so forgetting
 * to turn it off costs nothing after the date.
 */

/** The furthest an operator can set it, so it cannot quietly become permanent. */
export const REVIEW_ACCESS_MAX_DAYS = 60;

/** A review sign-in opens a short session; the connector itself runs on OAuth tokens. */
export const REVIEW_SESSION_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export function reviewAccessActive(
  account: { reviewAccessUntil?: Date | null },
  now: Date = new Date(),
): boolean {
  return Boolean(account.reviewAccessUntil && account.reviewAccessUntil.getTime() > now.getTime());
}

/** What the account page answers to an address change or a deletion while it runs. */
export const REVIEW_ACCOUNT_LOCKED =
  'While review access runs, this account keeps its address and cannot be deleted. The operator who set it can end it early.';

/** The last day it applies, as the operator chose it (UTC). */
export function reviewAccessLastDay(until: Date): string {
  return new Date(until.getTime() - 1).toISOString().slice(0, 10);
}

/**
 * The operator's date field: the last day included, in UTC. Stored as the
 * first instant it no longer applies, the way a plan grant's end is.
 */
export function parseReviewLastDay(
  value: unknown,
  now: Date = new Date(),
): { until: Date } | { error: string } {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const day = match ? new Date(`${text}T00:00:00.000Z`) : null;
  if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text) {
    return { error: 'Choose the last day review access applies.' };
  }
  const until = new Date(day.getTime() + DAY_MS);
  if (until.getTime() <= now.getTime()) return { error: 'That day has already ended. Choose today or a later day.' };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (until.getTime() > today + (REVIEW_ACCESS_MAX_DAYS + 1) * DAY_MS) {
    return { error: `Review access lasts at most ${REVIEW_ACCESS_MAX_DAYS} days. Choose an earlier day; it can be extended later.` };
  }
  return { until };
}

/**
 * Why this account cannot be given review access, or null when it can.
 * `operator` is the caller's verdict on the lists, read whether or not the
 * address is confirmed: a password-only door onto an account that is, or
 * could become, an operator is the one thing this must never open.
 */
export function reviewAccessRefusal(
  account: { passwordHash: string | null; email: string | null; emailVerifiedAt: Date | null },
  context: { operator: boolean; twoFactor: boolean },
): string | null {
  if (!context.twoFactor) {
    return 'This server does not send sign-in codes, so a password already signs this account in.';
  }
  if (context.operator) return 'An operator account cannot have review access.';
  if (!account.passwordHash) return 'This account has no password to sign in with.';
  if (!account.email || !account.emailVerifiedAt) {
    return 'Confirm the account\'s address first: every review sign-in is mailed there.';
  }
  return null;
}
