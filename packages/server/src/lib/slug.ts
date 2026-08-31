import { createHash } from 'node:crypto';

const SLUG_MAX = 40;
const DIGEST = 6;

/**
 * URL-safe identifier for a team or project name.
 *
 * Names that share a prefix, or that carry no Latin characters at all, used to
 * collapse onto the same slug — every non-Latin repository name landed on the
 * literal fallback, so unrelated projects merged into one. When the readable
 * part cannot stand on its own, a short digest of the original name keeps
 * distinct names distinct while staying stable across calls.
 */
export function slugify(name: string): string {
  const readable = name
    .toLowerCase()
    .replace(/[ıİ]/g, 'i') // Turkish dotless/dotted i
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (readable.length > 0 && readable.length <= SLUG_MAX) return readable;

  const digest = createHash('sha256').update(name.trim()).digest('hex').slice(0, DIGEST);
  if (readable.length === 0) return `p-${digest}`;
  const head = readable.slice(0, SLUG_MAX - DIGEST - 1).replace(/-+$/, '');
  return `${head}-${digest}`;
}
