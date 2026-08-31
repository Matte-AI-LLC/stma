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
import {
  LOGIN_FAIL_WINDOW_MS,
  clearLoginFailures,
  lockedMessage,
  loginGate,
  recordLoginFailure,
} from '../auth/attempts';
import { hashPassword, randomCode, verifyPassword } from '../lib/crypto';
import { emailIsFree, isEmail, maskEmail, normalizeEmail, usernameFromEmail } from '../lib/email';
import { logLine } from '../lib/log';
import {
  failedSignInsEmail,
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
            {env.demoLogins.length > 0 ? (
              // Only ever the strings in DEMO_LOGINS. Nothing is read from the
              // users table, so this cannot print a real account's details even
              // if the variable ends up somewhere it should not be.
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
  return c.html(
    <html lang="en">
      <Head title="Create account" />
      <body>
        <div class="auth-wrap">
          <div class="auth-card">
            <Logo lg />
            <div>
              <h1>Create your STMA account</h1>
              <p class="lede">One account per person — teammates join you through invite links.</p>
            </div>
            {error ? (
              <div class="banner banner-error">
                <span class="ic">!</span>
                <span>{error}</span>
              </div>
            ) : null}
            <form class="authform wide" method="post" action="/auth/local/signup">
              <input type="hidden" name="next" value={next} />
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
      })
      .returning();
    user = inserted[0]!;
  } catch {
    // Lost the race on the unique email (or username) index.
    logLine({ evt: 'auth', a: 'signup_fail', em: maskEmail(email), why: 'taken' });
    return back(taken);
  }
  await createSession(c, user.id);
  logLine({ evt: 'auth', a: 'signup', u: user.username });
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
          <p class="finenote">
            Nothing arrived? Check spam, or <a href="/login">start over</a>.
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

const ForgotPage = ({ error }: { error?: string }) => (
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
          <p class="finenote">
            No email on your account yet? Ask your STMA operator to set one — <a href="/login">back to sign in</a>.
          </p>
        </div>
      </div>
    </body>
  </html>
);

const ResetPage = ({ error, notice }: { error?: string; notice?: string }) => (
  <html lang="en">
    <Head title="Choose a new password" />
    <body>
      <div class="auth-wrap">
        <div class="auth-card">
          <Logo lg />
          <div>
            <h1>Choose a new password</h1>
            <p class="lede">
              Enter the code we emailed and your new password. Setting it signs you out on every
              device.
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
            Code expired? <a href="/forgot">Request another</a>.
          </p>
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
  return c.html(<ForgotPage error={c.req.query('error')} />);
});

authRoutes.get('/reset', (c) => {
  const env = c.get('env');
  // Self-service reset needs a mailbox to deliver to; without the email switch
  // the operator escape hatch (/admin/users) is the recovery path.
  if (!env.localAuth || !env.twoFactor) return c.notFound();
  if (c.get('user')) return c.redirect('/app');
  return c.html(<ResetPage error={c.req.query('error')} notice={c.req.query('ok')} />);
});

authRoutes.post('/auth/local/forgot', async (c) => {
  const env = c.get('env');
  // Self-service reset needs a mailbox to deliver to; without the email switch
  // the operator escape hatch (/admin/users) is the recovery path.
  if (!env.localAuth || !env.twoFactor) return c.notFound();
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  // One neutral answer for every outcome below. Unknown addresses still pay the
  // per-IP /auth/* budget, which is the only rate limit that can apply to them.
  const done = () => c.redirect(`/reset?ok=${encodeURIComponent(RESET_SENT)}`);
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
  const sent = await sendMail(env, {
    to: user.email!,
    ...passwordResetCodeEmail(issued.code, CODE_TTL_MINUTES),
  });
  if (!sent.ok) {
    logLine({ evt: 'auth', a: 'reset_send_fail', u: user.username, why: sent.error });
    return done();
  }
  setPendingChallenge(c, 'reset', issued.id);
  logLine({ evt: 'auth', a: 'reset_request', hit: true, u: user.username });
  return done();
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
  clearPendingChallenge(c, 'reset');
  logLine({ evt: 'auth', a: 'reset_done', u: user.username });
  if (user.email) {
    void sendMail(env, { to: user.email, ...passwordChangedEmail(env.baseUrl) });
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
