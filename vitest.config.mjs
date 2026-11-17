import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.mjs'],
    pool: 'forks',
    restoreMocks: true,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['shared/**/*.mjs', 'opencode/**/*.mjs', 'hooks/**/*.mjs', 'evals/**/*.mjs', 'scripts/**/*.mjs'],
      autoAttachSubprocess: true,
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'reports/coverage',
    },
  },
});
