import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { users } from '../db/schema';
import {
  exchangeGithubCode,
  fetchGithubProfile,
  githubAuthorizeUrl,
  upsertGithubUser,
} from '../auth/github';
import {
  CODE_TTL_MINUTES,
  checkChallenge,
  clearPendingChallenge,
  issueAuthCode,
  pendingChallengeUser,
  readPendingChallenge,
  setPendingChallenge,
} from '../auth/codes';
import {
  createSession,
  destroySession,
  findDevUser,
  invalidateAllSessions,
  sanitizeNext,
} from '../auth/session';
import { accessCodeRequired, cohortOf, matchAccessCode } from '../auth/accessCodes';
import {
  LOGIN_FAIL_WINDOW_MS,
  clearLoginFailures,
  lockedMessage,
  loginGate,
  recordLoginFailure,
} from '../auth/attempts';
import { burnPasswordCheck, hashPassword, randomCode, verifyPassword } from '../lib/crypto';
import { emailIsFree, isEmail, maskEmail, normalizeEmail, usernameFromEmail } from '../lib/email';
import { logLine } from '../lib/log';
import {
  failedSignInsEmail,
  emailVerifyCodeEmail,
  loginCodeEmail,
  passwordChangedEmail,
  passwordResetCodeEmail,
  sendMail,
} from '../lib/mailer';
import type { AppEnv, User } from '../types';
import { Head, Logo } from '../ui/Layout';

export const authRoutes = new Hono<AppEnv>();

const USERNAME_RE = /^[a-z0-9][a-z0-9-_]{1,31}$/;

authRoutes.get('/login', (c) => {
  const env = c.get('env');
  const next = sanitizeNext(c.req.query('next'));
  const error = c.req.query('error');
  const notice = c.req.query('ok');
  if (c.get('user')) return c.redirect(next);
  return c.html(
    <html lang="en">
      <Head title="Sign in" />
      <body>
        <div class="auth-wrap">
          <div class="auth-card">
            <Logo lg />
            <div>
              <h1>Sign in to STMA</h1>
              <p class="lede">Speak to my Agent — your team's agents, debugging together.</p>
            </div>
            {error ? (
              <div class="banner banner-error">
                <span class="ic">!</span>
                <span>{error}</span>
              </div>
            ) : null}
            {notice ? (
              <div class="banner banner-success">
                <span class="ic">✓</span>
                <span>{notice}</span>
              </div>
            ) : null}
            {env.localAuth ? (
              <form class="authform wide" method="post" action="/auth/local/login">
                <input type="hidden" name="next" value={next} />
                <div class="field">
                  <label>Email</label>
                  <input class="in" type="email" name="email" autocomplete="email" required />
                </div>
                <div class="field">
                  <label>Password</label>
                  <input
                    class="in"
                    type="password"
                    name="password"
                    autocomplete="current-password"
                    required
                  />
                </div>
                <button class="btn btn-primary" style="width:100%;height:44px" type="submit">
                  Sign in
                </button>
                {env.twoFactor ? (
                  <p class="m0 small muted" style="text-align:center">
                    <a href="/forgot">Forgot your password?</a>
                  </p>
                ) : null}
                {env.signupsOpen ? (
                  <p class="m0 small muted" style="text-align:center">
                    No account yet? <a href={`/signup?next=${encodeURIComponent(next)}`}>Create one</a>
                  </p>
                ) : (
                  // Without this the page is a dead end: no account, no link, no
                  // explanation — and the invite path that does work is invisible.
                  <p class="m0 small muted" style="text-align:center">
                    No account yet? STMA is invite-only during the private beta. Ask someone on
                    your team — their agent can create an invite for you with{' '}
                    <code>create_invite</code>, and you redeem it from your terminal. The{' '}
                    <a href="/docs#terminal">guide</a> walks through it.
                  </p>
                )}
              </form>
            ) : null}
            {env.github ? (
              <>
                {env.localAuth ? <div class="divider">or</div> : null}
                <a class="btn btn-dark wide" href={`/auth/github?next=${encodeURIComponent(next)}`}>
                  Continue with GitHub
                </a>
                <p class="finenote">
                  We read your public profile and email. We never request repository access.
                </p>
              </>
            ) : null}
            {env.demoLogins.length > 0 && !env.hosted ? (
              // Only ever the strings in DEMO_LOGINS. Nothing is read from the
              // users table, so this cannot print a real account's details even
              // if the variable ends up somewhere it should not be.
              //
              // And never on the hosted service. The environment already drops
              // the variable there, but the check that matters is the one at the
              // place that renders: a list of example accounts under the
              // password box of the service people actually use is an invitation
              // to try them, whatever route put it in the configuration.
              <div class="devbox">
                <span class="overline">Demo accounts</span>
                <p class="m0 small muted">
                  Test environment. These are throwaway accounts published on purpose so nobody
                  has to go looking for them — never reuse a password you use anywhere else.
                </p>
                <div class="demolist">
                  {env.demoLogins.map((row) => (
                    <div class="demorow">
                      <div style="min-width:0">
                        <div class="mono small" style="overflow:hidden;text-overflow:ellipsis">
                          {row.email}
                        </div>
                        <div class="mono small muted">
                          {row.password}
                          {row.note ? ` · ${row.note}` : ''}
                        </div>
                      </div>
                      <button
                        class="btn btn-sm"
                        type="button"
                        data-demo-email={row.email}
                        data-demo-password={row.password}
                      >
                        Use
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {env.devMode ? (
              <div class="devbox">
                <span class="overline">Dev login</span>
                <p class="m0 small muted">
                  Development only — no password, auto-creates the user. Disabled in production.
                </p>
                <form class="inline" method="post" action="/auth/dev">
                  <input type="hidden" name="next" value={next} />
                  <input
                    class="in"
                    style="flex:1"
                    type="text"
                    name="username"
                    placeholder="username or email"
                    required
                  />
                  <button class="btn" type="submit">
                    Sign in
                  </button>
                </form>
              </div>
            ) : null}
            {!env.localAuth && !env.github && !env.devMode ? (
              <p class="finenote">
                No sign-in method configured. Enable AUTH_LOCAL or set GITHUB_CLIENT_ID and
                GITHUB_CLIENT_SECRET.
              </p>
            ) : null}
            <SupportNote support={env.supportEmail} what="Locked out and the reset is not helping?" />
          </div>
        </div>
      </body>
    </html>,
  );
});

// ---------------------------------------------------------------- local accounts

authRoutes.get('/signup', (c) => {
  const env = c.get('env');
  if (!env.localAuth || !env.signupsOpen) return c.redirect('/login');
  if (c.get('user')) return c.redirect('/app');
  const next = sanitizeNext(c.req.query('next'));
  const error = c.req.query('error');
  const needsCode = accessCodeRequired(env);
  // A link can carry the code, so a cohort email is one click rather than a
  // copy-paste. It is not a secret the URL leaks — it is the thing the email
  // was sent to hand over.
  const presetCode = (c.req.query('code') ?? '').slice(0, 64);
  return c.html(
    <html lang="en">
      <Head title="Create account" />
      <body>
        <div class="auth-wrap">
          <div class="auth-card">
            <Logo lg />
            <div>
              <h1>Create your STMA account</h1>
              <p class="lede">
                {needsCode
                  ? 'STMA is in private beta. Your access code lets you create one account; teammates join you through invite links.'
                  : 'One account per person — teammates join you through invite links.'}
              </p>
            </div>
            {error ? (
              <div class="banner banner-error">
                <span class="ic">!</span>
                <span>{error}</span>
              </div>
            ) : null}
            <form class="authform wide" method="post" action="/auth/local/signup">
              <input type="hidden" name="next" value={next} />
              {needsCode ? (
                <div class="field">
                  <label>Access code</label>
                  <input
                    class="in"
                    type="text"
                    name="access_code"
                    autocomplete="one-time-code"
                    spellcheck={false}
                    value={presetCode}
                    placeholder="the code from your invitation"
                    required
                  />
                  <span class="help">
                    From the email that invited you to the beta. One code works for everyone in
                    your group — it is not consumed when you sign up.
                  </span>
                </div>
              ) : null}
              <div class="field">
                <label>Email</label>
                <input
                  class="in"
                  type="email"
                  name="email"
                  autocomplete="email"
                  placeholder="you@company.com"
                  required
                />
                <span class="help">
                  You sign in with this address. Your teammates see a display name taken from it.
                </span>
              </div>
              <div class="field">
                <label>Password</label>
                <input
                  class="in"
                  type="password"
                  name="password"
                  autocomplete="new-password"
                  minlength={8}
                  required
                />
                <span class="help">At least 8 characters.</span>
              </div>
              <button class="btn btn-primary" style="width:100%;height:44px" type="submit">
                Create account
              </button>
              <p class="m0 small muted" style="text-align:center">
                Already have one? <a href={`/login?next=${encodeURIComponent(next)}`}>Sign in</a>
              </p>
            </form>
            {/* The access code is the first wall a beta user meets and the one
                page that could not link anywhere: a refused code is a dead end
                otherwise, and the person holding it has no account to sign into. */}
            <SupportNote
              support={env.supportEmail}
              what={needsCode ? 'Access code refused, or you have none?' : 'Cannot create an account?'}
            />
          </div>
        </div>
      </body>
    </html>,
  );
});

authRoutes.post('/auth/local/signup', async (c) => {
  const env = c.get('env');
  if (!env.localAuth || !env.signupsOpen) return c.notFound();
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const next = sanitizeNext(typeof body.next === 'string' ? body.next : undefined);
  const back = (msg: string) =>
    c.redirect(`/signup?error=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`);

  // Checked before anything else, and before the address is looked at: a beta
  // door that validates the email first would confirm whether an account exists
  // to somebody who never had a code.
  const submittedCode = typeof body.access_code === 'string' ? body.access_code : '';
  const verdict = matchAccessCode(env, submittedCode);
  if (!verdict.ok) {
    logLine({ evt: 'auth', a: 'signup_fail', why: 'access_code' });
    return back('That access code is not valid. Check the email that invited you to the beta.');
  }

  if (!isEmail(email)) return back('Enter a valid email address.');
  if (password.length < 8 || password.length > 128) {
    return back('Password must be 8-128 characters.');
  }
  const db = c.get('db');
  const taken = 'An account with that email already exists — sign in instead.';
  if (!(await emailIsFree(db, email))) {
    logLine({ evt: 'auth', a: 'signup_fail', em: maskEmail(email), why: 'taken' });
    return back(taken);
  }
  let user: User;
  try {
    const inserted = await db
      .insert(users)
      .values({
        username: await usernameFromEmail(db, email),
        email,
        passwordHash: await hashPassword(password),
        // The cohort, on the row, in the same statement that creates the
        // account. It used to reach one log line and nowhere else, and a log
        // with thirty days of retention cannot answer which wave a workspace
        // arrived in six weeks later. `cohortOf` stores the label or, for a
        // code the operator named nothing, a marker that is not a label —
        // never the code, which is the rule this whole file is built around.
        signupCohort: cohortOf(verdict),
      })
      .returning();
    user = inserted[0]!;
  } catch {
    // Lost the race on the unique email (or username) index.
    logLine({ evt: 'auth', a: 'signup_fail', em: maskEmail(email), why: 'taken' });
    return back(taken);
  }
  await createSession(c, user.id);
  /**
   * Prove the address, starting now, without standing in the way.
   *
   * A typo here used to be a permanent lockout: with sign-in codes on, both the
   * second factor and the reset go to this address and nowhere else, and the
   * only fix was an operator. So the code goes out at signup and the console
   * says, on every page, that the address is unconfirmed and how to fix it.
   *
   * It deliberately does not block. Holding the account hostage to a mail that
   * may not arrive would turn a provider outage into "nobody can sign up", and
   * the window this closes is the session the person already has — they are
   * signed in for the next month and can correct the address from Account
   * without help. If that proves too soft, making it a gate is a small change
   * from here; making it softer after a gate is not.
   */
  if (env.twoFactor) {
    const issued = await issueAuthCode(db, user.id, 'email_verify');
    if (issued.ok) {
      // Still not awaited — the paragraph above is the reason, and a mail
      // round trip does not belong on the critical path of creating an
      // account. But the result was previously dropped on the floor, so a
      // provider refusing every message left no trace at all against the one
      // signup where somebody would have wanted to know. It is silent to the
      // person on purpose: they are signed in, the console now carries the
      // unconfirmed band on every page, and Account has a Send-me-a-code
      // button that *does* report its failure. The operator is who needs to
      // hear this, and `sendMail` files it for /admin/ops either way.
      void sendMail(env, { to: email, ...emailVerifyCodeEmail(issued.code, CODE_TTL_MINUTES) }).then(
        (sent) => {
          if (!sent.ok) {
            logLine({ evt: 'auth', a: 'verify_code_fail', u: user.username, why: sent.error });
          }
        },
      );
    }
  }
  // The cohort, never the code: an operator wants to know which invitation wave
  // an account came from, and a log that carries the code itself is a log that
  // hands out beta access to anyone who can read it.
  logLine({ evt: 'auth', a: 'signup', u: user.username, ...(verdict.label ? { cohort: verdict.label } : {}) });
  return c.redirect(next);
});

/**
 * Email the sign-in code and park the browser on the code page. The pending
 * challenge lives in the database; the cookie only names it.
 */
async function startLoginChallenge(
  c: Context<AppEnv>,
  user: User,
  next: string,
  notice?: string,
): Promise<Response> {
  const env = c.get('env');
  const nextQs = `next=${encodeURIComponent(next)}`;
  const stop = (msg: string) => c.redirect(`/login?error=${encodeURIComponent(msg)}&${nextQs}`);

  const issued = await issueAuthCode(c.get('db'), user.id, 'login');
  if (!issued.ok) {
    logLine({ evt: 'auth', a: 'login_code_limited', u: user.username });
    return stop(
      'Too many sign-in codes were requested for this account. Wait a few minutes, then try again.',
    );
  }
  const sent = await sendMail(env, {
    to: user.email!,
    ...loginCodeEmail(issued.code, CODE_TTL_MINUTES),
  });
  if (!sent.ok) {
    // Never sign somebody in on an undeliverable second factor.
    logLine({ evt: 'auth', a: 'login_code_fail', u: user.username, why: sent.error });
    return stop(
      'We could not email your sign-in code right now. Try again in a minute — if it keeps failing, contact your operator.',
    );
  }
  setPendingChallenge(c, 'login', issued.id);
  logLine({ evt: 'auth', a: 'login_code', u: user.username });
  const ok = notice ? `&ok=${encodeURIComponent(notice)}` : '';
  return c.redirect(`/login/verify?${nextQs}${ok}`);
}

authRoutes.post('/auth/local/login', async (c) => {
  const env = c.get('env');
  if (!env.localAuth) return c.notFound();
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const next = sanitizeNext(typeof body.next === 'string' ? body.next : undefined);
  const fail = (message = 'Invalid email or password.') =>
    c.redirect(
      `/login?error=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`,
    );

  if (!email || !password) return fail();
  const db = c.get('db');

  // Checked before the password is, and enforced even when the password turns
  // out to be right: a throttle a correct guess walks through is not a throttle,
  // and answering differently for the right password would turn it into an
  // oracle for exactly the thing being guessed at.
  const gate = await loginGate(db, email);
  if (gate.locked) {
    logLine({ evt: 'auth', a: 'login_locked', em: maskEmail(email) });
    return fail(lockedMessage(gate.resetAt));
  }

  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNotNull(users.passwordHash)))
    .limit(1);
  const user = rows[0];
  // An address with no account must cost what one with an account costs, or the
  // response time answers the question every other line here refuses to.
  if (!user) await burnPasswordCheck(password);
  if (!user || !(await verifyPassword(password, user.passwordHash!))) {
    const failed = await recordLoginFailure(db, email);
    logLine({ evt: 'auth', a: 'login_fail', em: maskEmail(email), n: failed.attempts });
    // The account holder is the one person who can tell an attack from their own
    // bad memory, and until now they were never told it happened. Once per
    // window, and only to an address that has an account — mailing one that does
    // not would answer the question this whole path refuses to answer.
    if (failed.justLocked && user?.email) {
      void sendMail(env, {
        to: user.email,
        ...failedSignInsEmail(env.baseUrl, Math.round(LOGIN_FAIL_WINDOW_MS / 60_000)),
      });
    }
    return fail(failed.locked ? lockedMessage(failed.resetAt) : undefined);
  }
  await clearLoginFailures(db, email);
  if (env.twoFactor) return startLoginChallenge(c, user, next);
  await createSession(c, user.id);
  logLine({ evt: 'auth', a: 'login', u: user.username });
  return c.redirect(next);
});

/**
 * Second step of sign-in. Deliberately says nothing about which account is
 * pending — the page is reachable only with a live challenge cookie, and every
 * failure reads the same whether or not the address exists.
 */
const VerifyPage = ({ next, error, notice }: { next: string; error?: string; notice?: string }) => (
  <html lang="en">
    <Head title="Confirm sign-in" />
    <body>
      <div class="auth-wrap">
        <div class="auth-card">
          <Logo lg />
          <div>
            <h1>Check your email</h1>
            <p class="lede">
              We sent a 6-digit code to the address on your account. It expires in{' '}
              {CODE_TTL_MINUTES} minutes.
            </p>
          </div>
          {error ? (
            <div class="banner banner-error">
              <span class="ic">!</span>
              <span>{error}</span>
            </div>
          ) : null}
          {notice ? (
            <div class="banner banner-success">
              <span class="ic">✓</span>
              <span>{notice}</span>
            </div>
          ) : null}
          <form class="authform wide" method="post" action="/auth/local/verify">
            <input type="hidden" name="next" value={next} />
            <div class="field">
              <label>Sign-in code</label>
              <input
                class="in"
                type="text"
                name="code"
                inputmode="numeric"
                autocomplete="one-time-code"
                pattern="[0-9]{6}"
                maxlength={6}
                placeholder="000000"
                required
              />
            </div>
            <button class="btn btn-primary" style="width:100%;height:44px" type="submit">
              Confirm
            </button>
          </form>
          <form class="m0" method="post" action="/auth/local/resend" style="text-align:center">
            <input type="hidden" name="next" value={next} />
            <button class="linklike" type="submit">
              Send a new code
            </button>
          </form>
          {/* The digits are in the subject on purpose — that is what a phone's
              notification preview shows — and saying so here saves opening the
              mail at all. It was true and printed nowhere. */}
          <p class="finenote">
            The six digits are in the subject line. Nothing arrived? Check spam,{' '}
            <a href="/help#signin">see what usually causes this</a>, or{' '}
            <a href="/login">start over</a>.
          </p>
        </div>
      </div>
    </body>
  </html>
);

authRoutes.get('/login/verify', (c) => {
  const env = c.get('env');
  if (!env.localAuth) return c.notFound();
  const next = sanitizeNext(c.req.query('next'));
  if (c.get('user')) return c.redirect(next);
  if (!readPendingChallenge(c, 'login')) return c.redirect(`/login?next=${encodeURIComponent(next)}`);
  return c.html(<VerifyPage next={next} error={c.req.query('error')} notice={c.req.query('ok')} />);
});

authRoutes.post('/auth/local/verify', async (c) => {
  const env = c.get('env');
  if (!env.localAuth) return c.notFound();
  const body = await c.req.parseBody();
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const next = sanitizeNext(typeof body.next === 'string' ? body.next : undefined);
  const nextQs = `next=${encodeURIComponent(next)}`;
  const restart = (msg: string) => {
    clearPendingChallenge(c, 'login');
    return c.redirect(`/login?error=${encodeURIComponent(msg)}&${nextQs}`);
  };
  const retry = (msg: string) =>
    c.redirect(`/login/verify?error=${encodeURIComponent(msg)}&${nextQs}`);

  const id = readPendingChallenge(c, 'login');
  if (!id) return restart('Your sign-in attempt expired. Enter your email and password again.');
  if (!/^\d{6}$/.test(code)) return retry('Enter the 6-digit code from the email.');

  const db = c.get('db');
  const result = await checkChallenge(db, id, 'login', code);
  if (result.status === 'ok') {
    clearPendingChallenge(c, 'login');
    await createSession(c, result.userId);
    const rows = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, result.userId))
      .limit(1);
    logLine({ evt: 'auth', a: 'login', u: rows[0]?.username, f2: 'email' });
    return c.redirect(next);
  }
  if (result.status === 'invalid') {
    logLine({ evt: 'auth', a: 'login_code_wrong', left: result.attemptsLeft });
    return retry(
      `That code is not right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.`,
    );
  }
  if (result.status === 'exhausted') {
    logLine({ evt: 'auth', a: 'login_code_exhausted' });
    return restart('Too many wrong codes. Sign in again to get a new one.');
  }
  return restart('That code has expired or was already used. Sign in again to get a new one.');
});

authRoutes.post('/auth/local/resend', async (c) => {
  const env = c.get('env');
  if (!env.localAuth) return c.notFound();
  const body = await c.req.parseBody();
  const next = sanitizeNext(typeof body.next === 'string' ? body.next : undefined);
  const expired = () => {
    clearPendingChallenge(c, 'login');
    return c.redirect(
      `/login?error=${encodeURIComponent('Your sign-in attempt expired. Enter your email and password again.')}&next=${encodeURIComponent(next)}`,
    );
  };
  const id = readPendingChallenge(c, 'login');
  if (!id) return expired();
  const db = c.get('db');
  const userId = await pendingChallengeUser(db, id, 'login');
  if (!userId) return expired();
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user?.email) return expired();
  return startLoginChallenge(c, user, next, 'A new code is on its way.');
});

// ------------------------------------------------------------- password reset

/**
 * Forgotten-password recovery. A 6-digit code rather than a signed magic link:
 * it reuses the auth_codes row, expiry, attempt cap and single-use flag already
 * built for sign-in, and needs no new signing secret or token-in-URL (which
 * leaks through history, referrers and logs).
 *
 * Every response is identical whether or not the address exists, has a password
 * or has an email at all — the neutral confirmation is the whole point.
 */
const RESET_SENT =
  'If that address has an account with a password, a 6-digit reset code is on its way. It expires in 10 minutes.';

/**
 * The way out, on the pages somebody stuck is actually looking at.
 *
 * `SUPPORT_EMAIL` existed and appeared on exactly one page a locked-out person
 * cannot reach, plus inside an email they may never receive. Recovery answers
 * have to stay neutral — saying "we could not send it" would say it only for
 * addresses that exist — so the page, not the response, is where the honest
 * "nothing arrived?" belongs.
 *
 * `/help` comes first and always renders, because most of what goes wrong here
 * is answerable without a person: a lock that refuses the right password on
 * purpose, a code that belongs to the browser that asked, an access code that
 * is checked before the address. The mail address is the end of the page rather
 * than the whole of it, and renders only when the instance has one — the same
 * rule the access-code call to action follows.
 */
const SupportNote = ({ support, what }: { support: string; what: string }) => (
  <p class="finenote">
    {what} <a href="/help#signin">What usually causes this</a>.
    {support ? (
      <>
        {' '}
        If that does not cover it, write to <a href={`mailto:${support}`}>{support}</a> from the
        address on the account. Never put a password or a code in that mail.
      </>
    ) : null}
  </p>
);

const ForgotPage = ({ error, support }: { error?: string; support: string }) => (
  <html lang="en">
    <Head title="Reset password" />
    <body>
      <div class="auth-wrap">
        <div class="auth-card">
          <Logo lg />
          <div>
            <h1>Reset your password</h1>
            <p class="lede">
              Tell us the address you sign in with and we email you a one-time code.
            </p>
          </div>
          {error ? (
            <div class="banner banner-error">
              <span class="ic">!</span>
              <span>{error}</span>
            </div>
          ) : null}
          <form class="authform wide" method="post" action="/auth/local/forgot">
            <div class="field">
              <label>Email</label>
              <input class="in" type="email" name="email" autocomplete="email" required />
            </div>
            <button class="btn btn-primary" style="width:100%;height:44px" type="submit">
              Email me a reset code
            </button>
          </form>
          <SupportNote
            support={support}
            what="Nothing in your inbox after a few minutes, or no email on the account at all?"
          />
          <p class="finenote">
            <a href="/login">Back to sign in</a>.
          </p>
        </div>
      </div>
    </body>
  </html>
);

const ResetPage = ({
  error,
  notice,
  support,
}: {
  error?: string;
  notice?: string;
  support: string;
}) => (
  <html lang="en">
    <Head title="Choose a new password" />
    <body>
      <div class="auth-wrap">
        <div class="auth-card">
          <Logo lg />
          <div>
            <h1>Choose a new password</h1>
            <p class="lede">
              Enter the code we emailed and your new password. Finish this in the same browser you
              asked from. Setting a new password signs you out of every browser; your agent
              connections keep working.
            </p>
          </div>
          {error ? (
            <div class="banner banner-error">
              <span class="ic">!</span>
              <span>{error}</span>
            </div>
          ) : null}
          {notice ? (
            <div class="banner banner-success">
              <span class="ic">✓</span>
              <span>{notice}</span>
            </div>
          ) : null}
          <form class="authform wide" method="post" action="/auth/local/reset">
            <div class="field">
              <label>Reset code</label>
              <input
                class="in"
                type="text"
                name="code"
                inputmode="numeric"
                autocomplete="one-time-code"
                pattern="[0-9]{6}"
                maxlength={6}
                placeholder="000000"
                required
              />
            </div>
            <div class="field">
              <label>New password</label>
              <input
                class="in"
                type="password"
                name="new_password"
                autocomplete="new-password"
                minlength={8}
                required
              />
              <span class="help">At least 8 characters.</span>
            </div>
            <div class="field">
              <label>Repeat new password</label>
              <input
                class="in"
                type="password"
                name="new_password_confirm"
                autocomplete="new-password"
                minlength={8}
                required
              />
            </div>
            <button class="btn btn-primary" style="width:100%;height:44px" type="submit">
              Set new password
            </button>
          </form>
          <p class="finenote">
            Code expired, or none arrived? <a href="/forgot">Request another</a>.
          </p>
          <SupportNote support={support} what="Still stuck after a second code?" />
        </div>
      </div>
    </body>
  </html>
);

authRoutes.get('/forgot', (c) => {
  const env = c.get('env');
  // Self-service reset needs a mailbox to deliver to; without the email switch
  // the operator escape hatch (/admin/users) is the recovery path.
  if (!env.localAuth || !env.twoFactor) return c.notFound();
  if (c.get('user')) return c.redirect('/app');
  return c.html(<ForgotPage error={c.req.query('error')} support={env.supportEmail} />);
});

authRoutes.get('/reset', (c) => {
  const env = c.get('env');
  // Self-service reset needs a mailbox to deliver to; without the email switch
  // the operator escape hatch (/admin/users) is the recovery path.
  if (!env.localAuth || !env.twoFactor) return c.notFound();
  if (c.get('user')) return c.redirect('/app');
  /**
   * The link in the reset email, which is how somebody reading it on their phone
   * finishes there.
   *
   * The pending id is not the secret — the six-digit code is, and it is in the
   * same message — so carrying the id in the link is exactly as strong as the
   * cookie it replaces, and the person still has to type the code. Setting it
   * and redirecting clean keeps it out of the address bar, out of the referrer
   * and out of browser history, and means a link scanner that fetches the URL
   * has set a cookie in a browser nobody is using rather than consuming a code.
   */
  const carried = c.req.query('t');
  if (carried && /^[0-9a-f-]{36}$/.test(carried)) {
    setPendingChallenge(c, 'reset', carried);
    return c.redirect('/reset');
  }
  return c.html(
    <ResetPage error={c.req.query('error')} notice={c.req.query('ok')} support={env.supportEmail} />,
  );
});

authRoutes.post('/auth/local/forgot', async (c) => {
  const env = c.get('env');
  // Self-service reset needs a mailbox to deliver to; without the email switch
  // the operator escape hatch (/admin/users) is the recovery path.
  if (!env.localAuth || !env.twoFactor) return c.notFound();
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  /**
   * One neutral answer for every outcome below — **including the headers**.
   *
   * The status, the Location and the body were already identical, and the
   * `reset` cookie was not: it was set only where a code had actually been
   * issued, so `Set-Cookie` answered "does this address have an account" to
   * anyone reading the response instead of the page. A cookie naming an id that
   * exists nowhere fails the lookup in /auth/local/reset exactly as a stale one
   * does, so the neutral path costs a random UUID and reveals nothing.
   *
   * Unknown addresses still pay the per-IP /auth/* budget, which is the only
   * rate limit that can apply to them.
   */
  const done = (challengeId?: string) => {
    setPendingChallenge(c, 'reset', challengeId ?? randomUUID());
    return c.redirect(`/reset?ok=${encodeURIComponent(RESET_SENT)}`);
  };
  if (!isEmail(email)) return c.redirect(`/forgot?error=${encodeURIComponent('Enter a valid email address.')}`);

  const db = c.get('db');
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNotNull(users.passwordHash)))
    .limit(1);
  const user = rows[0];
  if (!user) {
    logLine({ evt: 'auth', a: 'reset_request', hit: false, em: maskEmail(email) });
    return done();
  }
  const issued = await issueAuthCode(db, user.id, 'password_reset');
  if (!issued.ok) {
    logLine({ evt: 'auth', a: 'reset_limited', u: user.username });
    return done();
  }
  /**
   * Started, not waited for, because the neutral answer has to be neutral in
   * TIME as well as in words.
   *
   * This branch awaited an HTTPS round trip to the mail provider while the "no
   * such account" branch returned after one indexed SELECT — a few
   * milliseconds against a few hundred, which answers "does this address have
   * an account" to anybody with a stopwatch. It is the same leak
   * `burnPasswordCheck` exists to close on the other door, an order of
   * magnitude wider. The memory transport used by dev and tests records before
   * it yields, so nothing there becomes timing-dependent.
   *
   * A failure still writes its line and still answers neutrally; the cookie now
   * carries the real challenge either way, which is no weaker than the random
   * one it replaces and lets a retry reuse the same throttle state.
   */
  void sendMail(env, {
    to: user.email!,
    ...passwordResetCodeEmail(
      issued.code,
      CODE_TTL_MINUTES,
      `${env.baseUrl}/reset?t=${encodeURIComponent(issued.id)}`,
    ),
  }).then((sent) => {
    if (!sent.ok) {
      logLine({ evt: 'auth', a: 'reset_send_fail', u: user.username, why: sent.error });
    }
  });
  logLine({ evt: 'auth', a: 'reset_request', hit: true, u: user.username });
  return done(issued.id);
});

authRoutes.post('/auth/local/reset', async (c) => {
  const env = c.get('env');
  // Self-service reset needs a mailbox to deliver to; without the email switch
  // the operator escape hatch (/admin/users) is the recovery path.
  if (!env.localAuth || !env.twoFactor) return c.notFound();
  const body = await c.req.parseBody();
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  const confirm = typeof body.new_password_confirm === 'string' ? body.new_password_confirm : '';
  const back = (msg: string) => c.redirect(`/reset?error=${encodeURIComponent(msg)}`);
  const dead = (msg: string) => {
    clearPendingChallenge(c, 'reset');
    return c.redirect(`/forgot?error=${encodeURIComponent(msg)}`);
  };

  // Password rules first: a typo there must not burn a code attempt.
  if (next.length < 8 || next.length > 128) return back('New password must be 8-128 characters.');
  if (next !== confirm) return back('New passwords do not match.');
  if (!/^\d{6}$/.test(code)) return back('Enter the 6-digit code from the email.');

  const id = readPendingChallenge(c, 'reset');
  const generic = 'That code is not right, or it expired. Request a new one.';
  if (!id) return dead(generic);

  const db = c.get('db');
  const result = await checkChallenge(db, id, 'password_reset', code);
  if (result.status === 'invalid') {
    return back(
      `That code is not right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.`,
    );
  }
  if (result.status !== 'ok') {
    logLine({ evt: 'auth', a: 'reset_fail', why: result.status });
    return dead(generic);
  }

  const rows = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);
  const user = rows[0];
  if (!user) return dead(generic);
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(next) })
    .where(eq(users.id, user.id));
  // Recovery path: assume the old session belongs to whoever locked them out.
  await invalidateAllSessions(db, user.id);
  // And lift the sign-in lock, because failing to sign in is *how people arrive
  // here*. Without this the product contradicts itself one screen apart:
  // "Password updated — sign in with your new password", then "Too many
  // sign-in attempts for this email address". Proving the mailbox is stronger
  // evidence than the password the counter was guarding, so clearing it is the
  // right call rather than a concession.
  await clearLoginFailures(db, user.email ?? '');
  clearPendingChallenge(c, 'reset');
  logLine({ evt: 'auth', a: 'reset_done', u: user.username });
  if (user.email) {
    void sendMail(env, { to: user.email, ...passwordChangedEmail(env.baseUrl, env.supportEmail) });
  }
  return c.redirect(
    `/login?ok=${encodeURIComponent('Password updated — sign in with your new password.')}`,
  );
});

// ---------------------------------------------------------------- dev + github

authRoutes.post('/auth/dev', async (c) => {
  const env = c.get('env');
  if (!env.devMode) return c.notFound();
  const body = await c.req.parseBody();
  // Accepts either identity: an email creates a real email-shaped dev account,
  // a bare name keeps the old shorthand. Never matches a password or GitHub
  // account (findDevUser) — dev login cannot hijack a registered one.
  const identifier = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const next = sanitizeNext(typeof body.next === 'string' ? body.next : undefined);
  const back = (msg: string) =>
    c.redirect(`/login?error=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`);

  const asEmail = isEmail(identifier);
  if (!asEmail && !USERNAME_RE.test(identifier)) {
    return back('Enter an email address, or 2-32 characters: a-z, 0-9, "-" or "_".');
  }
  const db = c.get('db');
  let user = await findDevUser(db, identifier);
  if (!user) {
    try {
      const inserted = await db
        .insert(users)
        .values(
          asEmail
            ? { username: await usernameFromEmail(db, identifier), email: identifier }
            : { username: identifier },
        )
        .returning();
      user = inserted[0]!;
    } catch {
      return back('That name belongs to a registered account.');
    }
  }
  await createSession(c, user.id);
  return c.redirect(next);
});

authRoutes.get('/auth/github', (c) => {
  const env = c.get('env');
  if (!env.github) return c.notFound();
  const state = randomCode(12);
  const next = sanitizeNext(c.req.query('next'));
  setCookie(c, 'oauth', Buffer.from(JSON.stringify({ state, next })).toString('base64url'), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
    secure: env.baseUrl.startsWith('https://'),
  });
  return c.redirect(githubAuthorizeUrl(env, state));
});

authRoutes.get('/auth/github/callback', async (c) => {
  const env = c.get('env');
  if (!env.github) return c.notFound();
  try {
    const raw = getCookie(c, 'oauth');
    deleteCookie(c, 'oauth', { path: '/' });
    const saved = raw
      ? (JSON.parse(Buffer.from(raw, 'base64url').toString()) as { state: string; next: string })
      : null;
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (!saved || !state || !code || saved.state !== state) {
      throw new Error('Authorization was cancelled or expired. Nothing was changed — try again.');
    }
    const accessToken = await exchangeGithubCode(env, code);
    const profile = await fetchGithubProfile(accessToken);
    const user = await upsertGithubUser(c.get('db'), profile);
    await createSession(c, user.id);
    logLine({ evt: 'auth', a: 'github_login', u: user.username });
    return c.redirect(sanitizeNext(saved.next));
  } catch (err) {
    logLine({ evt: 'auth', a: 'github_fail', why: (err as Error).message });
    return c.redirect(`/login?error=${encodeURIComponent((err as Error).message)}`);
  }
});

authRoutes.post('/logout', async (c) => {
  await destroySession(c);
  return c.redirect('/');
});
