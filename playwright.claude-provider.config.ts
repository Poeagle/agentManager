import {defineConfig,devices} from '@playwright/test';

const apiPort=Number(process.env.E2E_API_PORT||43210);
const uiPort=Number(process.env.E2E_UI_PORT||43211);
Object.assign(process.env,{
  E2E_API_PORT:String(apiPort),
  E2E_UI_PORT:String(uiPort),
});

export default defineConfig({
  testDir:'./e2e',
  testMatch:'claude-provider-flow.spec.ts',
  fullyParallel:false,
  workers:1,
  retries:0,
  outputDir:'test-results/claude-provider-flow',
  timeout:90_000,
  expect:{timeout:20_000},
  use:{
    baseURL:`http://127.0.0.1:${uiPort}`,
    ...devices['Desktop Chrome'],
    channel:'chrome',
    trace:'off',
    video:'off',
  },
  webServer:[
    {
      command:'./server/node_modules/.bin/tsx scripts/start-e2e-server.mjs',
      url:`http://127.0.0.1:${apiPort}/api/health`,
      timeout:120_000,
      reuseExistingServer:false,
    },
    {
      command:`VITE_CACHE_DIR=.test-data/node_modules/.vite-claude-${uiPort} VITE_PORT=${uiPort} VITE_API_TARGET=http://127.0.0.1:${apiPort} npm --prefix dashboard run dev -- --host 127.0.0.1`,
      url:`http://127.0.0.1:${uiPort}`,
      timeout:120_000,
      reuseExistingServer:false,
    },
  ],
});
