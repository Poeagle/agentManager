import { defineConfig, devices } from '@playwright/test';

const API_PORT = 43110;
const UI_PORT = 43111;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results/playwright',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: './server/node_modules/.bin/tsx scripts/start-e2e-server.mjs',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `VITE_PORT=${UI_PORT} VITE_API_TARGET=http://127.0.0.1:${API_PORT} npm --prefix dashboard run dev -- --host 127.0.0.1`,
      url: `http://127.0.0.1:${UI_PORT}`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
