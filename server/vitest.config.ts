import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: [
        'src/auth.ts',
        'src/db/index.ts',
        'src/routes/user-state.ts',
        'src/services/cli-command.ts',
        'src/services/session-identity.ts',
      ],
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 80,
        lines: 75,
      },
    },
  },
});
