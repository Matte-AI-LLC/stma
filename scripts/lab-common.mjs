import { createHmac } from 'node:crypto';
import { appendFileSync } from 'node:fs';

// Shared helpers for the multi-machine lab jobs. Session-cookie plumbing plus a
// login that tolerates the staging instance having email codes switched off.

export const base = (process.env.STAGING_URL ?? process.env.STMA_URL ?? '').replace(/\/$/, '');

if (!base) {
  console.error('STAGING_URL is not set');
  process.exit(2);
}

export function jar() {
  let cookie = '';
  return {
    get header() {
      return cookie ? { cookie } : {};
    },
    absorb(res) {
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const kv = line.split(';')[0];
        if (kv.startsWith('sid=')) cookie = kv;
      }
    },
  };
}

export async function form(session, path, body, redirect = 'manual') {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: base,
      ...session.header,
    },
    body: new URLSearchParams(body),
    redirect,
  });
  session.absorb(res);
  return res;
}

export const get = (session, path) => fetch(base + path, { headers: session.header });

/** Signs in and fails loudly if the instance is asking for an email code. */
export async function signIn(session, email, password) {
  const res = await form(session, '/auth/local/login', { email, password });
  const to = res.headers.get('location') ?? '';
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
  if (to.includes('/login/verify')) {
    throw new Error('this instance requires an email sign-in code — the lab needs AUTH_2FA=0');
  }
  return res;
}

export function mask(value) {
  console.log(`::add-mask::${value}`);
}

export function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${name}=${value}\n`);
}

/**
 * Credentials every job can recompute instead of passing between them: GitHub
 * scrubs masked values out of job outputs, and a token in an unmasked output
 * would sit in the run log. Derived from a repo secret plus the run id, so the
 * account is unique per run and reproducible within it.
 */
export function labIdentity() {
  const seed = process.env.LAB_SEED;
  const run = process.env.GITHUB_RUN_ID ?? 'local';
  if (!seed) throw new Error('LAB_SEED is not set');
  const digest = createHmac('sha256', seed).update(run).digest('base64url').slice(0, 24);
  const slug = createHmac('sha256', seed).update(`team:${run}`).digest('hex').slice(0, 8);
  return {
    team: `lab-${slug}`,
    email: `lab-${slug}@test-company.dev`,
    password: `Lab-${digest}`,
  };
}

/** One token per machine, which is what the product tells people to do anyway. */
export async function mintToken(session, name) {
  const res = await fetch(`${base}/app/tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: base,
      ...session.header,
    },
    body: new URLSearchParams({ name }),
  });
  const token = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0];
  if (!token) throw new Error(`could not mint a token named ${name}`);
  mask(token);
  return token;
}
