import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  // Published with a bin entry, so the bundle has to be directly executable.
  banner: { js: '#!/usr/bin/env node' },
  noExternal: [/^@bridge\//],
});
