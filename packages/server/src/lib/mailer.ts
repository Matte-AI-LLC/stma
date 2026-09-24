/**
 * Outgoing transactional mail — sign-in codes, password-change codes, the
 * "your password was changed" notice and the activity notifications.
 *
 * Two transports, no dependencies: Resend over plain fetch when RESEND_API_KEY is
 * configured, otherwise an in-memory outbox that records the message and logs a
 * structured line (self-host and tests). Sending never throws into a request
 * handler; callers get a result and decide what to do — a login whose code cannot
 * be delivered must fail rather than silently succeed.
 */
import type { Env } from '../env';
import { maskEmail } from './email';
import { logLine } from './log';

/**
 * What a message is for — a stable label, so the operator log never has to
 * carry the subject line to say which mail this was.
 *
 * Every code email puts its six digits in the subject on purpose: that is what
 * shows in a phone's notification preview, and it is the difference between
 * reading the code and opening the mail. But `sendMail` logged `subject` on
 * every send, so `123456 is your STMA sign-in code` went to stdout, and in
 * production stdout is Log Analytics with thirty-day retention — a second
 * factor readable by anybody with log access, and by the operator console if
 * this label had not been introduced before the mail card was. The subject
 * stays as it is; the log carries this instead, and it is the better field to
 * query by anyway, because it does not vary per code.
 */
export type MailKind =
  | 'login_code'
  | 'password_change_code'
  | 'password_reset_code'
  | 'email_verify_code'
  | 'email_change_code'
  | 'email_changed_notice'
  | 'password_changed'
  | 'failed_sign_ins'
  | 'review_sign_in'
  | 'activity'
  | 'workspace_invite'
  | 'billing';

export interface MailMessage {
  to: string;
  kind: MailKind;
  subject: string;
  text: string;
  html: string;
}

export interface SentMail extends MailMessage {
  at: Date;
  transport: MailTransport;
}

export type MailTransport = 'resend' | 'memory';

export type MailResult =
  | { ok: true; transport: MailTransport }
  | { ok: false; transport: MailTransport; error: string };

/** Bounded so a burst (or a long-running self-host) can never grow the process. */
const OUTBOX_CAP = 200;
const outbox: SentMail[] = [];

/** In-memory transport contents — the delivery record for self-host and tests. */
export const mailOutbox = {
  all(): readonly SentMail[] {
    return outbox;
  },
  /** Newest message sent to this address, or undefined. */
  latest(to: string): SentMail | undefined {
    const wanted = to.trim().toLowerCase();
    for (let i = outbox.length - 1; i >= 0; i--) {
      if (outbox[i]!.to.toLowerCase() === wanted) return outbox[i];
    }
    return undefined;
  },
  clear(): void {
    outbox.length = 0;
  },
};

function record(msg: MailMessage, transport: MailTransport): void {
  outbox.push({ ...msg, at: new Date(), transport });
  if (outbox.length > OUTBOX_CAP) outbox.splice(0, outbox.length - OUTBOX_CAP);
}

export function mailTransport(env: Env): MailTransport {
  return env.resendApiKey ? 'resend' : 'memory';
}

// ------------------------------------------------------------- what went wrong

/**
 * Recent send failures, for the operator console.
 *
 * A failed send never throws and never reaches `recordErrorEvent`, which is
 * only wired to the Hono error handler and the process monitor — so until this
 * existed, a provider refusing every message left `/admin/ops` completely
 * green. That is the exact shape of a launch-night outage: the sending domain
 * is not verified, Resend answers 403 to all of it, sign-in codes and password
 * resets silently do not arrive, and the person who could fix it has nothing
 * on any screen to look at.
 *
 * In process and bounded, like `lib/metrics.ts` and for the same reason: it
 * describes one process rather than the tenant, it needs no database (error
 * handling that writes to a database is one more thing that can fail at the
 * moment everything else is failing), and the structured `evt=mail` line
 * remains the durable record. Production runs one replica, so one process is
 * the whole service.
 *
 * `reason` is the provider's own words, which for an unverified domain names
 * the problem outright. The subject is deliberately absent: it carries the
 * code (see `MailKind`), and this is rendered on a page.
 */
export interface MailFailure {
  at: Date;
  kind: MailKind;
  /** Masked — enough to tell one person's failures from another's. */
  to: string;
  reason: string;
}

const FAILURE_CAP = 20;
const failures: MailFailure[] = [];
let sentCount = 0;
let failedCount = 0;

export const mailHealth = {
  /** Newest first, bounded by FAILURE_CAP. */
  failures(): readonly MailFailure[] {
    return [...failures].reverse();
  },
  counts(): { sent: number; failed: number } {
    return { sent: sentCount, failed: failedCount };
  },
  reset(): void {
    failures.length = 0;
    sentCount = 0;
    failedCount = 0;
  },
};

function recordFailure(msg: MailMessage, to: string, reason: string): void {
  failedCount += 1;
  failures.push({ at: new Date(), kind: msg.kind, to, reason: reason.slice(0, 300) });
  if (failures.length > FAILURE_CAP) failures.splice(0, failures.length - FAILURE_CAP);
}

/**
 * Deliver one message. Returns a result instead of throwing: every caller is in a
 * request path where a mail provider hiccup must not become a 500.
 */
export async function sendMail(env: Env, msg: MailMessage): Promise<MailResult> {
  const transport = mailTransport(env);
  const to = maskEmail(msg.to);
  // `kind`, never `subject`: the subject of every code email contains the code.
  if (transport === 'memory') {
    record(msg, transport);
    sentCount += 1;
    logLine({ evt: 'mail', a: 'send', transport, to, kind: msg.kind, ok: true });
    return { ok: true, transport };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.mailFrom,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      logLine({
        evt: 'mail',
        a: 'send',
        transport,
        to,
        kind: msg.kind,
        ok: false,
        s: res.status,
        why: detail,
      });
      // The provider's own words, kept verbatim: an unverified sending domain
      // says so here and nowhere else the operator can see.
      recordFailure(msg, to, `${res.status} ${detail}`.trim());
      return { ok: false, transport, error: `provider responded ${res.status}` };
    }
    record(msg, transport);
    sentCount += 1;
    logLine({ evt: 'mail', a: 'send', transport, to, kind: msg.kind, ok: true });
    return { ok: true, transport };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logLine({ evt: 'mail', a: 'send', transport, to, kind: msg.kind, ok: false, why: error });
    recordFailure(msg, to, error);
    return { ok: false, transport, error };
  }
}

// ------------------------------------------------------------------- templates

const SIGNOFF = 'If you did not request this, ignore this email — nothing has changed.';

/** Minimal, readable HTML. No images, no tracking, no external assets. */
function wrap(lines: string[]): string {
  const body = lines
    .map((l) => `<p style="margin:0 0 14px">${l}</p>`)
    .join('\n      ');
  return `<div style="font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:520px">
      ${body}
    </div>`;
}

function codeBlock(code: string): string {
  return `<span style="font:600 26px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px">${code}</span>`;
}

/** Everything interpolated into the HTML part goes through this first. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function loginCodeEmail(code: string, minutes: number): Omit<MailMessage, 'to'> {
  return {
    kind: 'login_code',
    subject: `${code} is your STMA sign-in code`,
    text: [
      `Your STMA sign-in code is ${code}.`,
      `It expires in ${minutes} minutes and can be used once.`,
      SIGNOFF,
    ].join('\n\n'),
    html: wrap([
      'Your STMA sign-in code:',
      codeBlock(code),
      `It expires in ${minutes} minutes and can be used once.`,
      SIGNOFF,
    ]),
  };
}

export function passwordChangeCodeEmail(code: string, minutes: number): Omit<MailMessage, 'to'> {
  return {
    kind: 'password_change_code',
    subject: `${code} confirms your STMA password change`,
    text: [
      `Enter ${code} in STMA to confirm your new password.`,
      `It expires in ${minutes} minutes and can be used once.`,
      SIGNOFF,
    ].join('\n\n'),
    html: wrap([
      'Enter this code in STMA to confirm your new password:',
      codeBlock(code),
      `It expires in ${minutes} minutes and can be used once.`,
      SIGNOFF,
    ]),
  };
}

/**
 * The reset code, and the link that lets it be used where it is read.
 *
 * The pending challenge lived only in the asking browser's cookie, so opening
 * this mail on a phone and typing the code there was answered "that code is not
 * right", which is false and sends the person round the loop. The link carries
 * the challenge id, not the code: whoever follows it still has to type the six
 * digits that are in the same message, so it is exactly as strong as the cookie
 * and works on the device the mail was actually opened on.
 */
export function passwordResetCodeEmail(
  code: string,
  minutes: number,
  link?: string,
): Omit<MailMessage, 'to'> {
  const terms = `It expires in ${minutes} minutes and can be used once. Setting a new password signs you out of every browser; your agent connections keep working.`;
  const here = link ? 'Reading this on another device? Open this link there and enter the code:' : '';
  return {
    kind: 'password_reset_code',
    subject: `${code} is your STMA password reset code`,
    text: [
      `Enter ${code} in STMA to choose a new password.`,
      terms,
      link ? `${here}\n${link}` : '',
      SIGNOFF,
    ]
      .filter(Boolean)
      .join('\n\n'),
    html: wrap(
      [
        'Enter this code in STMA to choose a new password:',
        codeBlock(code),
        terms,
        link
          ? `<span style="color:#6b7075;font-size:13px">${here} <a href="${esc(link)}">${esc(link)}</a></span>`
          : '',
        SIGNOFF,
      ].filter(Boolean),
    ),
  };
}

export function emailVerifyCodeEmail(code: string, minutes: number): Omit<MailMessage, 'to'> {
  const why =
    'Confirming it matters more than it sounds: with sign-in codes on, this address is where your second factor and any password reset go. An address nobody has proved is an account nobody can get back into.';
  return {
    kind: 'email_verify_code',
    subject: `${code} confirms your STMA email address`,
    text: [`Enter ${code} in STMA to confirm this address.`, why, `It expires in ${minutes} minutes.`, SIGNOFF].join(
      '\n\n',
    ),
    html: wrap([
      'Enter this code in STMA to confirm this address:',
      codeBlock(code),
      why,
      `It expires in ${minutes} minutes.`,
      SIGNOFF,
    ]),
  };
}

/** Sent to the address somebody wants to move TO, so only its owner can finish. */
export function emailChangeCodeEmail(code: string, minutes: number): Omit<MailMessage, 'to'> {
  const why =
    'Somebody asked to move an STMA account to this address. If that was not you, ignore this — nothing changes until the code is entered.';
  return {
    kind: 'email_change_code',
    subject: `${code} confirms your new STMA email address`,
    text: [`Enter ${code} in STMA to finish moving the account to this address.`, why, `It expires in ${minutes} minutes.`, SIGNOFF].join(
      '\n\n',
    ),
    html: wrap([
      'Enter this code in STMA to finish moving the account to this address:',
      codeBlock(code),
      why,
      `It expires in ${minutes} minutes.`,
      SIGNOFF,
    ]),
  };
}

/** Sent to the address being left behind, which is the only warning it will get. */
export function emailChangedNotice(next: string, baseUrl: string): Omit<MailMessage, 'to'> {
  const line = `Your STMA account now signs in as ${next}. This address will no longer receive its sign-in codes or password resets.`;
  const act = `If this was not you, act from the new address or write to support immediately — whoever holds ${next} now controls recovery for this account.`;
  return {
    kind: 'email_changed_notice',
    subject: 'Your STMA email address was changed',
    text: [line, act, `${baseUrl}/login`, SIGNOFF].join('\n\n'),
    html: wrap([line, act, `<a href="${esc(`${baseUrl}/login`)}">${esc(`${baseUrl}/login`)}</a>`, SIGNOFF]),
  };
}

/**
 * An owner of a workspace asked us to invite this address.
 *
 * The only mail STMA sends to somebody who may have no account and never asked
 * for anything, so it is written for that reader. Nothing a user typed reaches
 * the subject: a workspace name is sixty characters of anybody's choosing, and
 * a subject line is exactly where a message pretending to be something else
 * would put it. In the body the name is quoted as a name, the inviter is the
 * display name every member already sees, and the last line says that ignoring
 * the mail changes nothing, because for somebody who was not expecting it that
 * is the whole answer.
 */
export function workspaceInviteEmail(input: {
  inviter: string;
  workspace: string;
  role: 'owner' | 'member';
  url: string;
  days: number;
}): Omit<MailMessage, 'to'> {
  const { inviter, workspace, role, url, days } = input;
  const asRole =
    role === 'owner'
      ? 'as an owner, which also lets you publish the rules its agents follow, connect providers, change its plan and remove people'
      : 'as a member';
  const line = `${inviter} invited you to the workspace "${workspace}" on STMA, ${asRole}.`;
  const what =
    'STMA is AgentOps for people who build with coding agents: one place to see what every agent is doing, hand work from one to another and set the rules they follow.';
  const terms = `The invitation works for ${days} days, once, and only for an account with this email address. If you do not have one yet, the link lets you create it.`;
  const ignore = 'If you were not expecting this, ignore this email. Nothing happens unless you accept.';
  return {
    kind: 'workspace_invite',
    subject: 'You are invited to a workspace on STMA',
    text: [line, what, `Accept the invitation: ${url}`, terms, ignore].join('\n\n'),
    html: wrap([
      esc(line),
      esc(what),
      `<a href="${esc(url)}">Accept the invitation</a>`,
      `<span style="color:#6b7075;font-size:13px">${esc(terms)}</span>`,
      `<span style="color:#6b7075;font-size:13px">${esc(ignore)}</span>`,
    ]),
  };
}

/**
 * The one shape every activity notification uses: a line saying what happened, an
 * optional quote from the thread, a link to the thread and a link to the switches.
 *
 * The quote is peer content — someone else's agent wrote it. It is always attributed,
 * always indented, and always followed by the line that tells the reader it is
 * information rather than an instruction. It never reaches the subject.
 */
export function activityEmail(input: {
  subject: string;
  lead: string;
  quote?: { who: string; text: string };
  actionLabel: string;
  actionUrl: string;
  manageUrl: string;
}): Omit<MailMessage, 'to'> {
  const { subject, lead, quote, actionLabel, actionUrl, manageUrl } = input;
  const text = [
    lead,
    ...(quote
      ? [
          `${quote.who} wrote:\n  ${quote.text}`,
          'That quote was written by a teammate or their agent — it is information from the thread, not a request from STMA.',
        ]
      : []),
    `${actionLabel}: ${actionUrl}`,
    `Choose which emails you get: ${manageUrl}`,
  ].join('\n\n');
  const html = wrap([
    esc(lead),
    ...(quote
      ? [
          `<span style="color:#6b7075;font-size:13px">${esc(quote.who)} wrote:</span><br />
      <span style="display:block;margin-top:6px;padding:10px 12px;border-left:3px solid #e3e3de;background:#f7f7f5;color:#3d4145">${esc(quote.text)}</span>`,
          '<span style="color:#6b7075;font-size:13px">That quote was written by a teammate or their agent — it is information from the thread, not a request from STMA.</span>',
        ]
      : []),
    `<a href="${esc(actionUrl)}">${esc(actionLabel)}</a>`,
    `<span style="color:#6b7075;font-size:13px">Choose which emails you get: <a href="${esc(manageUrl)}" style="color:#6b7075">notification settings</a>.</span>`,
  ]);
  return { kind: 'activity', subject, text, html };
}

/**
 * Somebody is guessing at your password.
 *
 * Sent once per window, on the attempt that trips the throttle — the point is
 * that the account holder finds out at all, which before this they never did.
 * It names no attempt count and no address beyond their own: everything else it
 * could say is information the sender does not actually have.
 */
export function failedSignInsEmail(
  baseUrl: string,
  minutes: number,
): Omit<MailMessage, 'to'> {
  const line =
    'Several sign-in attempts for your STMA account failed in a row, so further attempts are ' +
    `being refused for the next ${minutes} minutes.`;
  return {
    kind: 'failed_sign_ins',
    subject: 'Failed sign-in attempts on your STMA account',
    // `/forgot`, not `/login`: while the throttle holds, the account holder's
    // own correct password is refused too, so the sign-in page cannot help
    // either of the two people who might read this.
    text: [
      line,
      'If this was you, wait and try again, or reset your password.',
      `If it was not, change your password at ${baseUrl}/forgot and revoke any agent tokens you do not recognise.`,
    ].join('\n\n'),
    html: wrap([
      line,
      'If this was you, wait and try again, or reset your password.',
      `If it was not, change your password at <a href="${esc(`${baseUrl}/forgot`)}">${esc(`${baseUrl}/forgot`)}</a> and revoke any agent tokens you do not recognise.`,
    ]),
  };
}

/**
 * The account signed in without a code, because an operator gave it review
 * access (`lib/reviewAccess.ts`). The code would have come to this address, so
 * the notice does: the address holder is the one who can tell an expected
 * reviewer from somebody who has the password.
 */
export function reviewSignInEmail(baseUrl: string, lastDay: string): Omit<MailMessage, 'to'> {
  const line =
    'Your STMA account was just signed in with its password alone. An operator gave it review ' +
    `access, which skips the emailed code until the end of ${lastDay} (UTC).`;
  const ask =
    'If you did not expect this sign-in, ask the operator to turn review access off, and sign out ' +
    'the other browsers from Account.';
  return {
    kind: 'review_sign_in',
    subject: 'Review sign-in on your STMA account',
    text: [line, ask, `${baseUrl}/app/account`].join('\n\n'),
    html: wrap([line, ask, `<a href="${esc(`${baseUrl}/app/account`)}">${esc(`${baseUrl}/app/account`)}</a>`]),
  };
}

/**
 * Your password was just changed.
 *
 * The one email here whose reader may be locked out of the account it is about,
 * so it must not send them to the sign-in page: if somebody else made this
 * change, the old password no longer works and `/login` is a wall. `/forgot` is
 * the door that still opens, because it proves the mailbox rather than the
 * password, and this message is already in that mailbox.
 *
 * The text and HTML parts said different things until 2026-09-20 — one "reset
 * it immediately", the other "sign in" — and both pointed at `/login`. Say one
 * thing, in one place, and let both parts render it.
 */
export function passwordChangedEmail(
  baseUrl: string,
  supportEmail = '',
): Omit<MailMessage, 'to'> {
  // "Every *other*" was true of the account page's change and wrong of a reset,
  // which ends all of them; one string served both. And a password never
  // reached an agent credential, so saying "signed out everywhere" told somebody
  // whose account was taken over that the incident was closed while the
  // attacker's agent kept full access. Both parts say what actually happened.
  const line =
    'Your STMA password was changed, and every browser session was signed out. Agent connections are not affected by a password change.';
  const act =
    'If this was not you, reset your password now, then open Agent connections and revoke anything you do not recognise.';
  const reset = `${baseUrl}/forgot`;
  const connections = `${baseUrl}/app/tokens`;
  const help = supportEmail
    ? `If you cannot get back in, write to ${supportEmail} from this address.`
    : '';
  return {
    kind: 'password_changed',
    subject: 'Your STMA password was changed',
    text: [line, act, reset, connections, help].filter(Boolean).join('\n\n'),
    html: wrap(
      [
        line,
        act,
        `<a href="${esc(reset)}">${esc(reset)}</a>`,
        `<a href="${esc(connections)}">${esc(connections)}</a>`,
        help
          ? `<span style="color:#6b7075;font-size:13px">If you cannot get back in, write to <a href="mailto:${esc(supportEmail)}" style="color:#6b7075">${esc(supportEmail)}</a> from this address.</span>`
          : '',
      ].filter(Boolean),
    ),
  };
}
