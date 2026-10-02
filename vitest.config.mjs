import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // src/generated is ts-proto's output, which CI proves matches the pinned tag rather than tests.
      exclude: ['src/generated/**', 'src/**/*.test.ts'],
      reporter: ['text'],
      skipFull: true,
      // A floor just under what the suite covers today, so coverage cannot slip unnoticed. Raise it when coverage rises.
      thresholds: {
        statements: 97,
        branches: 94,
        functions: 96,
        lines: 98,
      },
    },
  },
});
