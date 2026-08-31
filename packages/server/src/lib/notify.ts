import type { Env } from '../env';

/**
 * Allow only sane webhook targets. In production: https only, no
 * localhost/private ranges (SSRF guard). In dev/test anything http(s) goes,
 * so local receivers can be used.
 */
export function isSafeWebhookUrl(url: string, production: boolean): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (!production) return true;
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    if (
      h === 'localhost' ||
      h === '::1' ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h)
    ) {
      return false;
    }
    return true;
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
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatPayload(url, message)),
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
  if (!url || !isSafeWebhookUrl(url, env.nodeEnv === 'production')) return;
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatPayload(url, message)),
    signal: AbortSignal.timeout(5000),
  }).catch((e: unknown) => {
    console.warn(
      `[stma] webhook delivery failed for team ${team.slug}:`,
      e instanceof Error ? e.message : e,
    );
  });
}
