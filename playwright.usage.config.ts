import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:'usage-periods.spec.ts',outputDir:'test-results/usage',workers:1,retries:0,reporter:'list',use:{baseURL:'http://127.0.0.1:43211'},webServer:{command:'VITE_PORT=43211 npm --prefix dashboard run dev -- --host 127.0.0.1',url:'http://127.0.0.1:43211',reuseExistingServer:false}});
