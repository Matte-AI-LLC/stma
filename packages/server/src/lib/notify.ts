import { lookup } from 'node:dns/promises';
import type { Env } from '../env';

/**
 * Whether an address is one this server must never be made to talk to.
 *
 * Literal-only, and used twice: once on what somebody typed, and again on what
 * their hostname actually resolved to.
 */
export function isPrivateAddress(raw: string): boolean {
  // The WHATWG parser hands IPv6 back inside brackets, which is why the old
  // `h === '::1'` line could never match anything: `new URL('https://[::1]/')`
  // has hostname `[::1]`. It also normalizes `[0:0:0:0:0:0:0:1]` to `[::1]` and
  // `127.1` to `127.0.0.1`, so only the canonical forms need matching here.
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.includes(':')) {
    // An IPv4-mapped address is the same machine by another spelling, so it is
    // unwrapped and judged as the address it carries.
    const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
    if (mapped) {
      const dotted = mapped[1]
        ? mapped[1]
        : [
            (parseInt(mapped[2]!, 16) >> 8) & 0xff,
            parseInt(mapped[2]!, 16) & 0xff,
            (parseInt(mapped[3]!, 16) >> 8) & 0xff,
            parseInt(mapped[3]!, 16) & 0xff,
          ].join('.');
      return isPrivateAddress(dotted);
    }
    return (
      host === '::' ||
      host === '::1' ||
      /^fe[89ab]/.test(host) || // link-local
      /^f[cd]/.test(host) // unique-local
    );
  }
  // A trailing dot is the same name to a resolver and a different string here.
  const name = host.replace(/\.$/, '');
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    // Cloud instance metadata answers on names as well as on 169.254.169.254.
    name === 'metadata' ||
    name.endsWith('.internal') ||
    /^0\./.test(name) ||
    /^127\./.test(name) ||
    /^10\./.test(name) ||
    /^192\.168\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name) ||
    /^169\.254\./.test(name) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(name) // carrier-grade NAT
  );
}

/**
 * Allow only sane webhook targets. In production: https only, and never an
 * address inside our own network. In dev/test anything http(s) goes, so local
 * receivers can be used.
 *
 * This is the shape check. It cannot answer where a hostname points, which is
 * what `resolvesOutside` below is for.
 */
export function isSafeWebhookUrl(url: string, production: boolean): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (!production) return true;
    if (u.protocol !== 'https:') return false;
    return !isPrivateAddress(u.hostname);
  } catch {
    return false;
  }
}

/**
 * What the hostname actually points at, right now.
 *
 * The shape check above sees `https://webhooks.example.com` and has no way to
 * know it resolves to 169.254.169.254. This asks. It does not close the race
 * between the answer and the connection — nothing short of connecting to the
 * address ourselves would — but it turns a one-line bypass into a timing
 * attack against a five-second window, and it is paired with refusing redirects
 * so a public host cannot hand us a private one on the next hop.
 *
 * A name that will not resolve is refused rather than attempted: if we cannot
 * tell where it goes, we do not go.
 */
async function resolvesOutside(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  try {
    const found = await lookup(host, { all: true, verbatim: true });
    return found.length > 0 && found.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/** Slack takes `text`, Discord takes `content`; both ignore the other key. */
const chatPayload = (url: string, message: string) =>
  /discord\.com\/api\/webhooks/.test(url) ? { content: message } : { text: message };

/**
 * Post to one Slack/Discord incoming webhook and say whether it worked.
 *
 * The team webhook (below) is fire-and-forget because nobody is waiting on it.
 * This one is awaited: it backs the personal webhook, where the notification
 * sweep records the outcome, and the "send a test" button, whose entire job is
 * to answer whether the URL is real.
 */
export async function deliverWebhook(
  url: string,
  message: string,
  production: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isSafeWebhookUrl(url, production)) {
    return { ok: false, error: 'unsafe_url' };
  }
  if (production && !(await resolvesOutside(new URL(url).hostname))) {
    return { ok: false, error: 'unsafe_url' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatPayload(url, message)),
      // A redirect is the other half of the guard: without this, every check
      // above applies to the first hop only and a public host can send us
      // anywhere on the second.
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : 'failed' };
  }
}

/**
 * Fire-and-forget team notification to a Slack- or Discord-style incoming
 * webhook. Message bodies are never included — only event metadata.
 */
export function notifyTeam(
  env: Env,
  team: { slug: string; webhookUrl: string | null },
  message: string,
): void {
  const url = team.webhookUrl;
  const production = env.nodeEnv === 'production';
  if (!url || !isSafeWebhookUrl(url, production)) return;
  void (async () => {
    if (production && !(await resolvesOutside(new URL(url).hostname))) return;
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatPayload(url, message)),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  })().catch((e: unknown) => {
    console.warn(
      `[stma] webhook delivery failed for team ${team.slug}:`,
      e instanceof Error ? e.message : e,
    );
  });
}
