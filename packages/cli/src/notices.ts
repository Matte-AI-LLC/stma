/** Only status/counts cross this boundary: never echo snapshot values or server prose. */
export function environmentNotice(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return 'STMA environment: unknown (no verdict received).';
  const status = (result as { status?: unknown }).status;
  if (status === 'ok') return undefined;
  if (status === 'critical') return 'STMA environment: CRITICAL. Required environment checks failed. Review the project environment report before proceeding; do not copy or expose credential values.';
  if (status === 'no_baseline') return 'STMA environment: no baseline. Environment compatibility has not been verified.';
  if (status === 'warning') return 'STMA environment: warning. Review the project environment report before proceeding.';
  return 'STMA environment: unknown. Environment compatibility has not been verified.';
}
