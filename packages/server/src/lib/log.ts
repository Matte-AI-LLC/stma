import { redactSecrets } from './redact';

const SENSITIVE_FIELD =
  /api[_-]?key|secret|token|passw(?:or)?d|authorization|bearer|(?:invite|enrollment)[_-]?code/i;

function scrubLogValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_FIELD.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => scrubLogValue(item));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        scrubLogValue(child, childKey),
      ]),
    );
  }
  return value;
}

/**
 * Structured single-line JSON logging to stdout. Azure Container Apps (and any
 * container host) captures stdout, so these lines are queryable via
 * `az containerapp logs show` / Log Analytics without extra infrastructure.
 */
export function logLine(fields: Record<string, unknown>): void {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  // Scrub before serialization. Regex replacement on serialized JSON can break
  // quoting when an arbitrary secret itself contains a quote or backslash.
  console.log(JSON.stringify(scrubLogValue({ t: new Date().toISOString(), ...clean })));
}
