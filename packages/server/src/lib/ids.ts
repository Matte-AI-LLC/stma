/**
 * Ids as this server writes them, and every other spelling of one.
 *
 * PostgreSQL's uuid input takes more than the one form STMA hands out: upper
 * case, braces, no dashes, dashes after any group of four digits. The scope
 * guards compared ids only when they matched the canonical pattern and let
 * anything else through to the query — which found the same row. A
 * project-scoped credential was refused another project's session in the
 * canonical spelling and served it without the dashes (audit 2026-09-21,
 * confirmed at the guard and the database). So a guard refuses any spelling it
 * does not check, and a resolver that has to find a workspace from an id
 * canonicalizes first, so the spelling cannot choose whether it is found.
 */

export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isCanonicalUuid = (value: unknown): value is string =>
  typeof value === 'string' && CANONICAL_UUID.test(value);

/**
 * The canonical, lower-case spelling of anything that could name a uuid row,
 * or undefined. Deliberately more lenient than PostgreSQL about where dashes
 * may sit: this only ever decides which row to *look up* for an authorization
 * question, and the lenient reading can only find the row the database would.
 */
export function canonicalUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const braced = /^\{(.*)\}$/.exec(value.trim());
  const hex = (braced ? braced[1]! : value.trim()).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
