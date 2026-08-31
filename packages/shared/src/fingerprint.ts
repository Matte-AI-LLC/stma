import { createHash } from 'node:crypto';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

/** JSON with recursively sorted object keys — the canonical form both server and CLI hash. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortValue(value));

export const fingerprintJson = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
