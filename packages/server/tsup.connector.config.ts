import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

export default defineConfig({
  entry: { connector: 'src/connector/installer.ts', 'agent-runtime': '../cli/src/index.ts' },
  format: ['esm'], platform: 'node', target: 'node20', splitting: false,
  noExternal: [/.*/],
  define: { STMA_BUNDLED_VERSION: JSON.stringify(JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url), 'utf8')).version) },
});
