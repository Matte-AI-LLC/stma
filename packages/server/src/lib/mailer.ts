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

export interface MailMessage {
  to: string;
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

/**
 * Deliver one message. Returns a result instead of throwing: every caller is in a
 * request path where a mail provider hiccup must not become a 500.
 */
export async function sendMail(env: Env, msg: MailMessage): Promise<MailResult> {
  const transport = mailTransport(env);
  const to = maskEmail(msg.to);
  if (transport === 'memory') {
    record(msg, transport);
    logLine({ evt: 'mail', a: 'send', transport, to, subject: msg.subject, ok: true });
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
        subject: msg.subject,
        ok: false,
        s: res.status,
        why: detail,
      });
      return { ok: false, transport, error: `provider responded ${res.status}` };
    }
    record(msg, transport);
    logLine({ evt: 'mail', a: 'send', transport, to, subject: msg.subject, ok: true });
    return { ok: true, transport };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logLine({ evt: 'mail', a: 'send', transport, to, subject: msg.subject, ok: false, why: error });
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

export function passwordResetCodeEmail(code: string, minutes: number): Omit<MailMessage, 'to'> {
  return {
    subject: `${code} is your STMA password reset code`,
    text: [
      `Enter ${code} in STMA to choose a new password.`,
      `It expires in ${minutes} minutes and can be used once. Setting a new password signs you out everywhere.`,
      SIGNOFF,
    ].join('\n\n'),
    html: wrap([
      'Enter this code in STMA to choose a new password:',
      codeBlock(code),
      `It expires in ${minutes} minutes and can be used once. Setting a new password signs you out everywhere.`,
      SIGNOFF,
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
  return { subject, text, html };
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
    subject: 'Failed sign-in attempts on your STMA account',
    text: [
      line,
      'If this was you, wait and try again, or reset your password.',
      `If it was not, change your password at ${baseUrl}/login and revoke any agent tokens you do not recognise.`,
    ].join('\n\n'),
    html: wrap([
      line,
      'If this was you, wait and try again, or reset your password.',
      `If it was not, change your password at <a href="${baseUrl}/login">${baseUrl}/login</a> and revoke any agent tokens you do not recognise.`,
    ]),
  };
}

export function passwordChangedEmail(baseUrl: string): Omit<MailMessage, 'to'> {
  const line = 'Your STMA password was changed and every other browser session was signed out.';
  return {
    subject: 'Your STMA password was changed',
    text: [
      line,
      `If this was not you, reset it immediately at ${baseUrl}/login and revoke your agent tokens.`,
    ].join('\n\n'),
    html: wrap([
      line,
      `If this was not you, sign in at <a href="${baseUrl}/login">${baseUrl}/login</a> and revoke your agent tokens.`,
    ]),
  };
}
