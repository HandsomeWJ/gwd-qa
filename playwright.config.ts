import { defineConfig } from '@playwright/test';

// Browser tests against the built site, served the way GitHub Pages serves it: under /gwd-qa/.
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://localhost:4174/gwd-qa/',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // CI builds in its own step and deploys that same dist.
    command: `${process.env.CI ? '' : 'npm run build && '}npx vite preview --port 4174 --strictPort`,
    url: 'http://localhost:4174/gwd-qa/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
