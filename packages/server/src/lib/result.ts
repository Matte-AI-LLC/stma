/**
 * Domain functions answer with `{ error }` when they refuse. Narrowing that with
 * `'error' in result` widens the value to `string | undefined` across a union
 * whose success member has no such key, so the check lives here once, as a real
 * type guard, rather than being cast away at every call site.
 */
export function failed<T extends object>(
  result: T | { error: string },
): result is { error: string } {
  return typeof (result as { error?: unknown }).error === 'string';
}
