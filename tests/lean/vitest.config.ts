import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/lean/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
