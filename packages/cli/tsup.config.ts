import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  // `adapter install --pin-runtime` copies this bundle into a checkout's .stma,
  // where `../package.json` is the customer's project. Without this define the
  // pinned runtime would report their app's version as STMA's, in `stma
  // version` and in the x-stma-client header the server logs.
  define: { STMA_BUNDLED_VERSION: JSON.stringify(JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')).version) },
  noExternal: [/^@bridge\//, 'zod', 'smol-toml'],
  banner: { js: '#!/usr/bin/env node' },
});
