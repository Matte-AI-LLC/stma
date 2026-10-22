import type { MiddlewareHandler } from 'hono';

export const DOCTYPE = '<!DOCTYPE html>';

// `<html` as the first thing in the body, after whitespace a template may leave.
const HTML_ROOT = /^\s*<html[\s>]/i;

/**
 * Every page is `c.html(<Page />)` with an `<html>` root, and a Hono JSX root has
 * nothing before it. A browser reads a document with no doctype in quirks mode,
 * which is the 1990s box model: a line box ignores its strut when it holds only
 * inline elements, a form carries a bottom margin, a table does not inherit its
 * font size, and `document.compatMode` says `BackCompat`. The console and the
 * signed-out site were all laid out in it, so for months nothing here had a
 * doctype.
 *
 * It is added where the response leaves rather than in each of the dozen page
 * roots, so a page written next year cannot forget it, and the EE routes, the
 * not-found page and the error page get it without knowing. A body that starts
 * with its own doctype is left alone, which is what a page that already prints
 * one (the landing page) needs; anything that is not an `<html>` document
 * (JSON, CSS, a stream, a fragment) is not touched at all.
 *
 * Standards mode changes how a few things lay out, and `ui/styles.ts` says
 * which: the form margin, and the labels that stand alone in a line.
 */
export const withDoctype: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  if (!res.body || !(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) return;
  const html = await res.text();
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  c.res = new Response(HTML_ROOT.test(html) ? DOCTYPE + html : html, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
  c.res.headers.delete('content-length');
};
