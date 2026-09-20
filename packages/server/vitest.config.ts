import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each fixture boots PostgreSQL/WASM. Bound memory instead of hiding starvation with longer timeouts.
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
