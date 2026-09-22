import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { users } from '../db/schema';
import type { Env } from '../env';
import { emailIsFree, isEmail, normalizeEmail, usernameTaken } from '../lib/email';
import { logLine } from '../lib/log';

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
}

export function githubAuthorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.github!.clientId,
    redirect_uri: `${env.baseUrl}/auth/github/callback`,
    scope: 'read:user user:email',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeGithubCode(env: Env, code: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.github!.clientId,
      client_secret: env.github!.clientSecret,
      code,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`GitHub token exchange failed: ${data.error ?? res.status}`);
  }
  return data.access_token;
}

export async function fetchGithubProfile(accessToken: string): Promise<GithubProfile> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'stma',
  };
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) throw new Error(`GitHub /user failed: ${userRes.status}`);
  const profile = (await userRes.json()) as GithubProfile;

  // Only an address GitHub itself verified, read from the one endpoint that
  // says so. The profile's `email` carries no such flag, and the old fallback
  // took the first address on the list verified or not — while email is the
  // login identity here and, listed in ADMIN_EMAILS, an operator's.
  profile.email = null;
  try {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const verified = emails.filter((e) => e.verified === true);
      profile.email = (verified.find((e) => e.primary) ?? verified[0])?.email ?? null;
    }
  } catch {
    // email is optional; ignore
  }
  return profile;
}

/** Why a GitHub sign-in could not create an account. */
export class GithubSignupClosed extends Error {}

/**
 * The address GitHub verified for this profile, normalized — or null when GitHub
 * gave us none or another account already owns it (email is the login identity
 * and unique, so an OAuth login must never steal it).
 */
async function claimableEmail(db: Db, gh: GithubProfile, forUserId?: string) {
  const email = normalizeEmail(gh.email ?? '');
  if (!email || !isEmail(email)) return null;
  if (!(await emailIsFree(db, email, forUserId))) {
    logLine({ evt: 'auth', a: 'github_email_conflict', u: gh.login });
    return null;
  }
  return email;
}

export interface GithubAccountRules {
  /**
   * Whether a GitHub identity with no account yet may create one. The callback
   * passes `signupsOpen` and no access code required: this door checked
   * neither, so during an invite-only beta it created accounts for anybody.
   */
  allowCreate: boolean;
  /** Names a new account may never take — the operator list (`lib/admin`). */
  reserved: (candidate: string) => boolean;
}

export async function upsertGithubUser(db: Db, gh: GithubProfile, rules: GithubAccountRules) {
  const existing = await db.select().from(users).where(eq(users.githubId, gh.id)).limit(1);
  if (existing[0]) {
    const email = await claimableEmail(db, gh, existing[0].id);
    const nextEmail = email ?? existing[0].email;
    const updated = await db
      .update(users)
      .set({
        displayName: gh.name ?? existing[0].displayName,
        avatarUrl: gh.avatar_url ?? existing[0].avatarUrl,
        email: nextEmail,
        // `email_verified_at` means a code STMA mailed to *this* address came
        // back. GitHub moving the account to another address proves nothing of
        // the kind here, so the confirmation does not travel with it.
        ...(nextEmail !== existing[0].email ? { emailVerifiedAt: null } : {}),
      })
      .where(eq(users.id, existing[0].id))
      .returning();
    return updated[0]!;
  }

  if (!rules.allowCreate) throw new GithubSignupClosed('No STMA account is linked to that GitHub login, and this server is not creating new accounts through GitHub. Sign up with your email first.');
  const email = await claimableEmail(db, gh);
  const candidates = [gh.login, `${gh.login}-gh${String(gh.id).slice(-4)}`];
  for (const username of candidates) {
    // A name the operator list reserves, or one that differs from a held name
    // only in case, is skipped rather than inserted: the unique index would
    // accept `RootOps` beside `rootops`, and the operator gate would not tell
    // them apart. The suffixed candidate is the way through, as before.
    if (rules.reserved(username) || (await usernameTaken(db, username))) {
      if (username === candidates[candidates.length - 1]) {
        throw new Error('That GitHub login matches an existing STMA username. Sign up with your email instead.');
      }
      continue;
    }
    try {
      const inserted = await db
        .insert(users)
        .values({
          githubId: gh.id,
          username,
          displayName: gh.name,
          avatarUrl: gh.avatar_url,
          email,
        })
        .returning();
      return inserted[0]!;
    } catch (err) {
      // unique_violation on username → try the suffixed candidate
      if (username === candidates[candidates.length - 1]) throw err;
    }
  }
  throw new Error('unreachable');
}
