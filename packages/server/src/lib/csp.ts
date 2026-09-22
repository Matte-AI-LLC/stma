/**
 * Where a page's forms may be sent on to, as Content-Security-Policy sources.
 *
 * `form-action` governs the redirect that answers a form as well as the form's
 * own target, so a page whose form is answered by a redirect off this origin has
 * to name that destination (`app.tsx`). A value that ends up in a response header
 * must not be able to add a directive, so only an origin survives: an https one,
 * or a loopback http one, which is where a native client's OAuth callback
 * listens. Anything else is dropped rather than repaired.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function formTargetSource(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const loopback = parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopback) return undefined;
  return parsed.origin;
}

export function formTargetSources(targets: readonly string[] | undefined): string[] {
  const sources = (targets ?? []).map(formTargetSource).filter((s): s is string => Boolean(s));
  return [...new Set(sources)];
}
