import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All test files share one Postgres database.
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
