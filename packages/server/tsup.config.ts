import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

export default defineConfig({
  entry: { index: 'src/index.ts', connector: 'src/connector/installer.ts', 'agent-runtime': '../cli/src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  splitting: false,
  define: { STMA_BUNDLED_VERSION: JSON.stringify(JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url), 'utf8')).version) },
  // Published with a bin entry, so the bundle has to be directly executable.
  banner: { js: '#!/usr/bin/env node' },
  // otpauth and uqr are devDependencies bundled here, so the published
  // package's dependency list does not change. otpauth's node build uses
  // node:crypto, so nothing of @noble/hashes reaches the bundle.
  noExternal: [/^@bridge\//, 'smol-toml', 'zod', 'otpauth', 'uqr'],
});
