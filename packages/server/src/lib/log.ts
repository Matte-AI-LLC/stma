/**
 * Structured single-line JSON logging to stdout. Azure Container Apps (and any
 * container host) captures stdout, so these lines are queryable via
 * `az containerapp logs show` / Log Analytics without extra infrastructure.
 */
export function logLine(fields: Record<string, unknown>): void {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  console.log(JSON.stringify({ t: new Date().toISOString(), ...clean }));
}
