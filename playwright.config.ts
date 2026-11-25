import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  outputDir: join(tmpdir(), 'credit-copilot-browser-results'),
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 1488, height: 1058 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node --import tsx scripts/e2e-api.ts',
      url: 'http://127.0.0.1:4304/api/v1/health',
      timeout: 90000,
      reuseExistingServer: false,
    },
    {
      command:
        'node node_modules/vite/bin/vite.js --config apps/web/vite.config.ts --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      timeout: 60000,
      reuseExistingServer: false,
      env: { API_PROXY_TARGET: 'http://127.0.0.1:4304' },
    },
  ],
});
