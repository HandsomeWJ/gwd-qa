import { defineConfig } from '@playwright/test';
import { PROXY_PORTS } from './e2e/proxy';

// The web app the tests' build posts copies and bug reports to (src/record.ts), locally and in CI: a
// stand-in that does not exist. The tests answer for it (e2e/record.spec.ts), and e2e/global-setup.ts
// refuses a site that posts anywhere else, so no test can reach the owner's web app.
export const TEST_RECORD_URL = 'https://script.google.com/macros/s/e2e-test/exec';

const refusingProxy = (port: number) => ({ server: `http://127.0.0.1:${port}`, bypass: 'localhost,127.0.0.1' });

// Browser tests against the built site, served the way GitHub Pages serves it: under /gwd-qa/.
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:4174/gwd-qa/',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // A copy or report a test does not answer itself fails here instead of reaching Google, and the
      // mock ad's StackAdapt scripts never reach StackAdapt when a test lets the ad contact other sites.
      use: { browserName: 'chromium', launchOptions: { args: ['--host-resolver-rules=MAP script.google.com ~NOTFOUND, MAP script.googleusercontent.com ~NOTFOUND, MAP creative.stackadapt.com ~NOTFOUND'] } },
    },
    // The preview in Safari's and Firefox's engines. Every request they make for another site, with a
    // page.route() or without, goes to a local proxy that refuses it (e2e/proxy.ts).
    { name: 'webkit', use: { browserName: 'webkit', launchOptions: { proxy: refusingProxy(PROXY_PORTS.webkit) } }, testMatch: /engines\.spec\.ts/ },
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { proxy: refusingProxy(PROXY_PORTS.firefox) } }, testMatch: /engines\.spec\.ts/ },
  ],
  webServer: {
    // The tests' own build, in CI too: the site CI deploys is built after them with the owner's web app.
    command: 'npm run build -- --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4174 --strictPort',
    url: 'http://localhost:4174/gwd-qa/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { VITE_RECORD_URL: TEST_RECORD_URL },
  },
});
