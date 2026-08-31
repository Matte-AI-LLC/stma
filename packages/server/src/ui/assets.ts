import { createHash } from 'node:crypto';
import { clientJs } from './client';
import { css } from './styles';

/**
 * Content-addressed URLs for the stylesheet and the client script.
 *
 * Found the hard way: stma.ai sits behind Cloudflare, which caches `.css` by
 * extension for four hours whether or not the origin asked it to. A UI deploy
 * therefore served new markup against the previous stylesheet — the console's
 * rail rendered as an unstyled list — and there was no way to tell from the
 * origin, which was serving the right bytes the whole time.
 *
 * A URL that changes when the bytes change removes the question: the new HTML
 * asks for a file no cache has ever seen, and the old HTML keeps working
 * against the old one. The plain paths stay, uncached, for any page already in
 * a browser when a deploy lands.
 */
const digest = (body: string): string =>
  createHash('sha256').update(body).digest('hex').slice(0, 10);

/**
 * The browser-tab mark: the 32px tile from the logo sheet — dark ground, white
 * mark, spokes knocked out by the hub's background-coloured fill (safe here
 * because a favicon's background is its own). Kept as a string, not a file, for
 * the same reason the stylesheet is: one process, no asset pipeline.
 */
export const faviconSvg = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" fill="#141414"/><path d="M16 16 L16 4.5 M16 16 L26.94 12.45 M16 16 L22.76 25.3 M16 16 L9.24 25.3 M16 16 L5.06 12.45" fill="none" stroke="#ffffff" stroke-width="0.5" opacity="0.45"/><circle cx="16" cy="16" r="3.7" fill="#141414" stroke="#ffffff" stroke-width="0.55" opacity="0.9"/><circle cx="16" cy="16" r="1.15" fill="#ffffff"/><circle cx="16" cy="4.5" r="1.5" fill="#ffffff" opacity="0.8"/><circle cx="26.94" cy="12.45" r="1.6" fill="#ffffff"/><circle cx="22.76" cy="25.3" r="1.5" fill="#ffffff" opacity="0.92"/><circle cx="9.24" cy="25.3" r="1.4" fill="#ffffff" opacity="0.62"/><circle cx="5.06" cy="12.45" r="1.35" fill="#ffffff" opacity="0.52"/></svg>`;

export const cssHash = digest(css);
export const jsHash = digest(clientJs);

export const CSS_URL = `/style.${cssHash}.css`;
export const JS_URL = `/app.${jsHash}.js`;
/** Hashed like the stylesheet — Cloudflare caches `.svg` by extension too. */
export const FAVICON_URL = `/icon.${digest(faviconSvg)}.svg`;

/** Immutable: the URL changes when the content does, so it can never be stale. */
export const ASSET_CACHE = 'public, max-age=31536000, immutable';
/** The unhashed paths are a compatibility shim and must never be held anywhere. */
export const LEGACY_CACHE = 'no-cache';

/** Paths the access log skips — assets are noise once they are working. */
export const ASSET_PATHS = new Set([CSS_URL, JS_URL, FAVICON_URL, '/style.css', '/app.js', '/favicon.svg']);
