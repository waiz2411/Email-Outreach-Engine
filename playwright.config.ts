import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  webServer: {
    command: 'npx tsx e2e/e2eServer.mts',
    url: 'http://127.0.0.1:4199/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4199',
    trace: 'on-first-retry',
    headless: true,
  },
});
