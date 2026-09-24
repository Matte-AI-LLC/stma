import type { Env } from '../env';
import { reviewAccessActive } from './reviewAccess';

/**
 * Who the operator is, answered from something the person holding the session
 * proved rather than something they typed.
 *
 * An operator can add any account to any workspace at any role and overwrite
 * any account's sign-in address, so this is the one question in the product
 * whose wrong answer is every tenant's data. The 2026-09-21 audit found three
 * ways to type one's way into it, all confirmed:
 *
 *   A. Sign up with an address on `ADMIN_EMAILS`. Signup issues the session
 *      before the address is proved — a deliberate choice for everybody else
 *      (`routes/auth.tsx`) — and the confirmation mail goes to the real
 *      operator, who never opens it. So an address counts only once a code
 *      mailed to it has come back: `emailVerifiedAt`, which every writer of
 *      `users.email` now clears or sets from a code bound to that address.
 *   B. Sign up as a listed *username* nobody holds yet: usernames are derived
 *      from the email's local part, so `rootops@anywhere` became `rootops`.
 *   C. A GitHub login keeps its case (`RootOps`) beside an existing `rootops`,
 *      the unique index is case-sensitive and this check is not.
 *
 * B and C are closed where accounts are created rather than here: a new account
 * is never given a name the operator list reserves, or one that differs from an
 * existing name only in case (`reservedUsername` and its callers). The account
 * that held the name before it was listed keeps it, which is the one an
 * operator lists.
 */
export interface OperatorCandidate {
  username: string;
  email?: string | null;
  /** When a code mailed to `email` came back. Null or absent proves nothing. */
  emailVerifiedAt: Date | null;
  /** While it runs the account signs in with a password alone, so it is never an operator. */
  reviewAccessUntil?: Date | null;
}

/** Whether a username is listed in ADMIN_USERNAMES (trimmed + case-insensitive). */
export function isAdminUsername(env: Pick<Env, 'adminUsernames'>, username: string): boolean {
  return env.adminUsernames.includes(username.toLowerCase());
}

/**
 * Whether an address is listed in ADMIN_EMAILS (trimmed + case-insensitive).
 * On its own this says nothing about who holds the session; `isAdminUser` is
 * the gate, and it asks for the address to be confirmed as well.
 */
export function isAdminEmail(env: Pick<Env, 'adminEmails'>, email: string | null | undefined): boolean {
  return !!email && env.adminEmails.includes(email.trim().toLowerCase());
}

/**
 * Operator check: a listed username, or a listed address the account has
 * confirmed. With both lists empty nobody is an admin and the /admin area does
 * not exist. An instance with no mail transport can never confirm an address,
 * so there only ADMIN_USERNAMES opens the door — which README says.
 */
export function isAdminUser(env: Pick<Env, 'adminUsernames' | 'adminEmails'>, user: OperatorCandidate): boolean {
  // Review access skips the second factor; the admin page refuses to give it to
  // a listed account, and this holds if the lists change while it runs.
  if (reviewAccessActive(user)) return false;
  return (
    isAdminUsername(env, user.username) ||
    (Boolean(user.emailVerifiedAt) && isAdminEmail(env, user.email))
  );
}

/**
 * Whether a brand-new account may take this name. Case-insensitive on purpose:
 * `RootOps` must not be creatable while `rootops` is listed, held or not.
 */
export function reservedUsername(env: Pick<Env, 'adminUsernames'>, candidate: string): boolean {
  return isAdminUsername(env, candidate);
}

/** True when this instance has an operator list at all. */
export function adminConfigured(env: Env): boolean {
  return env.adminUsernames.length > 0 || env.adminEmails.length > 0;
}
