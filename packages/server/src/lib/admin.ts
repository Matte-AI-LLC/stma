import type { Env } from '../env';

/**
 * Whether a username is listed in ADMIN_USERNAMES (trimmed + case-insensitive).
 */
export function isAdminUsername(env: Env, username: string): boolean {
  return env.adminUsernames.includes(username.toLowerCase());
}

/** Whether an address is listed in ADMIN_EMAILS (trimmed + case-insensitive). */
export function isAdminEmail(env: Env, email: string | null | undefined): boolean {
  return !!email && env.adminEmails.includes(email.trim().toLowerCase());
}

/**
 * Operator check: either list grants access. With both lists empty nobody is an
 * admin and the /admin area does not exist.
 */
export function isAdminUser(
  env: Env,
  user: { username: string; email?: string | null },
): boolean {
  return isAdminUsername(env, user.username) || isAdminEmail(env, user.email);
}

/** True when this instance has an operator list at all. */
export function adminConfigured(env: Env): boolean {
  return env.adminUsernames.length > 0 || env.adminEmails.length > 0;
}
