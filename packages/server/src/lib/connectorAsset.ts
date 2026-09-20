import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Same artifact in source tests, the core bundle and the hosted bundle. No
// runtime compiler, remote dependency or generated helper is involved.
export function connectorAsset(kind: 'connector' | 'agent-runtime' = 'connector') {
  const candidates = [new URL(`./${kind}.js`, import.meta.url), new URL(`../../dist/${kind}.js`, import.meta.url)];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error('Connector artifact missing; run the connector build before starting STMA.');
  const source = readFileSync(file, 'utf8');
  const sha256 = createHash('sha256').update(source).digest('hex');
  return { source, sha256, path: `/connect/${kind}-${sha256}.mjs` };
}
