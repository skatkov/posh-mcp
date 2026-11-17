import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.mjs'],
    pool: 'forks',
    restoreMocks: true,
    testTimeout: 15000,
  },
});
