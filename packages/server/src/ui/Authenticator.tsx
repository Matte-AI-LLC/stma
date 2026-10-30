import { raw } from 'hono/html';
import type { AuthenticatorStatus } from '../auth/secondFactor';
import { ENROLLMENT_TTL_MINUTES } from '../auth/secondFactor';
import { groupedSecret } from '../auth/totp';
import { fmtDate } from '../lib/format';
import type { User } from '../types';
import { Field, PageHead } from './Console';
import { AppLayout } from './Layout';

/**
 * The account page's authenticator card and the two pages that hang off it.
 *
 * Nothing on these pages reaches a log or a mail, and the two that carry a
 * secret (the QR code and manual key, the recovery codes) are answered to a
 * POST that re-checked who is asking, under the console's `no-store`.
 */

/**
 * True everywhere but one place: an organization that requires an
 * authenticator refuses a person's credentials older than their last change
 * here (`tokenFactorCurrent` in the hosted identity layer), so this says so.
 */
export const AGENT_CONNECTIONS_UNCHANGED =
  'Agent connections are separate credentials and nothing here changes them, the same as a password change. ' +
  'The exception is an organization that requires an authenticator app: there, connections approved before ' +
  'this change stop working and must be approved again.';

const ReauthFields = ({ id, passwordless, recent }: { id: string; passwordless: boolean; recent: boolean }) =>
  passwordless ? (
    <p class="m0 small muted">
      {recent
        ? 'You signed in less than 10 minutes ago, which is what this needs instead of a password.'
        : 'This needs a sign-in from the last 10 minutes. Sign out, sign back in, and come straight here.'}
    </p>
  ) : (
    <Field id={`${id}-password`} label="Current password" required>
      <input
        class="in"
        id={`${id}-password`}
        type="password"
        name="current_password"
        autocomplete="current-password"
        required
      />
    </Field>
  );

const CodeField = ({ id }: { id: string }) => (
  <Field id={`${id}-code`} label="Code from your authenticator app, or a recovery code" required>
    <input
      class="in"
      id={`${id}-code`}
      type="text"
      name="code"
      autocomplete="one-time-code"
      autocapitalize="off"
      spellcheck={false}
      maxlength={32}
      placeholder="000000"
      required
    />
  </Field>
);

export const AuthenticatorCard = (props: {
  status: AuthenticatorStatus;
  keysAvailable: boolean;
  passwordless: boolean;
  recentSignIn: boolean;
}) => {
  const { status, keysAvailable, passwordless, recentSignIn } = props;
  const active = status.state === 'active' ? status : undefined;
  const blocked = passwordless && !recentSignIn;
  return (
    <div class="card card-pad" id="security" style="display:flex;flex-direction:column;gap:14px">
      <div>
        <div class="card-title">
          Authenticator app{' '}
          <span class={`pill ${active ? 'pill-active' : 'pill-open'}`}>{active ? 'on' : 'off'}</span>
        </div>
        <div class="card-note">
          A 6-digit code from an app on your phone, asked for every time this account signs in to a
          browser, whichever way you sign in. It replaces the emailed sign-in code; there is no
          fallback to email. {AGENT_CONNECTIONS_UNCHANGED}
        </div>
      </div>
      {active ? (
        <>
          <p class="m0">
            On since {fmtDate(active.enabledAt)}.{' '}
            <b>
              {active.recoveryCodesLeft} recovery code{active.recoveryCodesLeft === 1 ? '' : 's'} left.
            </b>
            {active.recoveryCodesLeft <= 2
              ? ' Make new ones now: without the phone and without a code, only an STMA operator can let you back in.'
              : ''}
          </p>
          {!keysAvailable ? (
            <p class="m0 small muted">
              This server cannot check authenticator codes right now because its encryption key is
              missing. Your recovery codes still work.
            </p>
          ) : null}
          <details>
            <summary class="small">Make new recovery codes</summary>
            <form
              method="post"
              action="/app/account/security/recovery-codes"
              style="display:flex;flex-direction:column;gap:12px;margin-top:12px;max-width:360px"
            >
              <ReauthFields id="regen" passwordless={passwordless} recent={recentSignIn} />
              <CodeField id="regen" />
              <button class="btn" type="submit" style="align-self:flex-start" disabled={blocked}>
                Replace my recovery codes
              </button>
            </form>
          </details>
          <details>
            <summary class="small">Turn off the authenticator app</summary>
            <form
              method="post"
              action="/app/account/security/disable"
              style="display:flex;flex-direction:column;gap:12px;margin-top:12px;max-width:360px"
              data-confirm="Signing in stops asking for a code from your app, your recovery codes stop working and every other browser is signed out."
              data-confirm-title="Turn off the authenticator app?"
              data-confirm-action="Turn it off"
            >
              <ReauthFields id="disable" passwordless={passwordless} recent={recentSignIn} />
              <CodeField id="disable" />
              <button class="btn btn-danger" type="submit" style="align-self:flex-start" disabled={blocked}>
                Turn off
              </button>
            </form>
          </details>
        </>
      ) : !keysAvailable ? (
        <p class="m0 small muted">
          This server cannot store authenticator secrets, so it does not offer authenticator apps.
          Its operator turns them on by configuring an encryption key.{' '}
          <a href="/help#signin">What this means</a>.
        </p>
      ) : (
        <form
          method="post"
          action="/app/account/security/start"
          style="display:flex;flex-direction:column;gap:12px;max-width:360px"
        >
          <ReauthFields id="enroll" passwordless={passwordless} recent={recentSignIn} />
          <button class="btn btn-primary" type="submit" style="align-self:flex-start" disabled={blocked}>
            Set up an authenticator app
          </button>
        </form>
      )}
      {blocked ? (
        <form class="m0" method="post" action="/logout">
          <button class="btn btn-sm" type="submit">
            Sign out to sign in again
          </button>
        </form>
      ) : null}
    </div>
  );
};

/**
 * Step two of enrollment: scan, then prove the app works. With `secret` absent
 * (a code that did not match) the page asks for a code again without showing
 * the secret a second time, because whoever holds this session only passed the
 * re-authentication once.
 */
export const EnrollPage = (props: {
  user: User;
  secret?: string;
  qr?: string;
  uri?: string;
  error?: string;
}) => (
  <AppLayout user={props.user} active="account" title="Add an authenticator app">
    {props.error ? (
      <div class="banner banner-error">
        <span class="ic">!</span>
        <span>{props.error}</span>
      </div>
    ) : null}
    <PageHead
      trail={[
        { label: 'All workspaces', href: '/app' },
        { label: 'Account', href: '/app/account' },
        { label: 'Authenticator app' },
      ]}
      title="Add an authenticator app"
      sub={`Nothing changes until you enter a code below. This setup expires in ${ENROLLMENT_TTL_MINUTES} minutes.`}
    />
    <div class="card card-pad" style="display:flex;flex-direction:column;gap:14px;max-width:640px">
      {props.secret ? (
        <>
          <div>
            <div class="card-title">1. Add STMA to your app</div>
            <div class="card-note">
              Scan this with Google Authenticator, Microsoft Authenticator, 1Password or any app that
              shows 6-digit codes. Nobody else should see this screen.
            </div>
          </div>
          {props.qr ? (
            <div style="width:220px;max-width:100%;background:#fff;padding:6px;border-radius:6px">
              {raw(props.qr)}
            </div>
          ) : null}
          <div>
            <div class="small muted">Or type this key into the app (time-based, 6 digits, 30 seconds):</div>
            <div class="mono" style="font-size:16px;letter-spacing:1px;word-break:break-all">
              {groupedSecret(props.secret)}
            </div>
            {props.uri ? (
              <p class="m0 small">
                <a href={props.uri}>Open in an authenticator app on this device</a>
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <p class="m0">
          If STMA is already in your app, enter the code it shows now. If it is not,{' '}
          <a href="/app/account#security">start again</a>.
        </p>
      )}
      <form
        method="post"
        action="/app/account/security/confirm"
        style="display:flex;flex-direction:column;gap:12px;max-width:360px"
      >
        <div class="card-title">{props.secret ? '2. ' : ''}Enter the code it shows</div>
        <Field id="enroll-code" label="6-digit code" required>
          <input
            class="in"
            id="enroll-code"
            type="text"
            name="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxlength={7}
            placeholder="000000"
            required
          />
        </Field>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">
          Turn on
        </button>
      </form>
      <p class="m0 small muted">
        <a href="/app/account#security">Cancel</a>. {AGENT_CONNECTIONS_UNCHANGED}
      </p>
    </div>
  </AppLayout>
);

/** Shown once, straight after the codes were made. Never stored in plain text. */
export const RecoveryCodesPage = (props: { user: User; codes: string[]; title: string; lead: string }) => (
  <AppLayout user={props.user} active="account" title={props.title}>
    <div class="banner banner-success">
      <span class="ic">✓</span>
      <span>{props.lead}</span>
    </div>
    <PageHead
      trail={[
        { label: 'All workspaces', href: '/app' },
        { label: 'Account', href: '/app/account' },
        { label: 'Recovery codes' },
      ]}
      title={props.title}
      sub="Save these somewhere other than your phone. Each one signs you in once if the phone is lost. This is the only time they are shown."
    />
    <div class="card card-pad" style="display:flex;flex-direction:column;gap:14px;max-width:640px">
      <ol class="mono" style="margin:0;padding-left:24px;line-height:1.9;font-size:15px">
        {props.codes.map((code) => (
          <li>{code}</li>
        ))}
      </ol>
      <div class="inline" style="gap:10px;flex-wrap:wrap">
        <button class="copybtn solid" type="button" data-copy={props.codes.join('\n')}>
          Copy codes
        </button>
        <a class="btn" href="/app/account#security">
          I saved them
        </a>
      </div>
      <p class="m0 small muted">
        Lost the phone and these codes too? An STMA operator can reset the authenticator after
        checking it is you. {AGENT_CONNECTIONS_UNCHANGED}
      </p>
    </div>
  </AppLayout>
);
