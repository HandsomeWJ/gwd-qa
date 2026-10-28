import { defineConfig } from '@playwright/test';

// The web app the local build posts copies and bug reports to (src/record.ts). CI builds with the real
// one; either way the tests answer for it (e2e/record.spec.ts).
export const TEST_RECORD_URL = 'https://script.google.com/macros/s/e2e-test/exec';

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
    // A copy or report a test does not answer itself fails here instead of reaching Google.
    launchOptions: { args: ['--host-resolver-rules=MAP script.google.com ~NOTFOUND, MAP script.googleusercontent.com ~NOTFOUND'] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // CI builds in its own step and deploys that same dist.
    command: `${process.env.CI ? '' : 'npm run build && '}npx vite preview --port 4174 --strictPort`,
    url: 'http://localhost:4174/gwd-qa/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { VITE_RECORD_URL: process.env.VITE_RECORD_URL ?? TEST_RECORD_URL },
  },
});
