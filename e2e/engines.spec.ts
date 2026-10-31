// The site in Chrome's, Safari's and Firefox's engines: each shows the ad as it draws it, and only
// Chrome's offers fixes, as a fix keeps the ad exactly as the browser that measured it draws it.
import { expect, test } from '@playwright/test';
import { mockAdZip } from './mock-ad';
import { PROXY_PORTS, refusedBy } from './proxy';

const NAMES = { chromium: 'Chrome', webkit: 'Safari', firefox: 'Firefox' } as const;
const GOOGLE = /^https:\/\/script\.google(usercontent)?\.com\//;

test('previews and checks the ad in this browser, and fixes it only in Chrome', async ({ page, browserName }) => {
  const name = NAMES[browserName];
  await page.goto('./');
  await expect(page.locator('#drop')).toContainText('Works in Chrome, Safari and Firefox');
  await page.locator('#file').setInputFiles({ name: 'mock.zip', mimeType: 'application/zip', buffer: mockAdZip() });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 120_000 });

  await expect(page.locator('#summary')).toContainText(`checked in ${name}`);
  await expect(page.locator('#preview .sub').first()).toContainText(`running as it would live in ${name}.`);
  // Every size runs: the ad's own text is in each frame.
  const frames = page.locator('#frames iframe');
  await expect(frames).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(frames.nth(i).contentFrame().locator('#SA_headline_1')).toContainText('Headline');
  await expect(page.locator('#checklist details[data-check="lineHeight"] summary .pill')).toHaveText('Fail');

  const apply = page.getByRole('button', { name: 'Apply selected fixes' });
  if (browserName === 'chromium') {
    await expect(apply).toBeVisible();
    await expect(page.locator('#checklist')).toContainText('auto-fix ready');
  } else {
    await expect(page.locator('#fixes')).toContainText(`Fixes are made in Chrome only. Each one keeps the ad exactly as the browser that measured it draws it, and GWD previews ads in Chrome's engine, so a fix measured in ${name} could move text in Chrome.`);
    await expect(apply).toHaveCount(0);
    await expect(page.locator('#checklist')).not.toContainText('auto-fix ready');
  }
});

test('a copy that no test answers is stopped before it leaves this computer', async ({ page, browserName }) => {
  // The page an ad is picked in is controlled by the preview's service worker, and WebKit offers
  // none of such a page's requests to page.route(), so nothing here answers the copy: the
  // browser's own network settings (playwright.config.ts) must stop it.
  const since = Date.now();
  const failed: string[] = [];
  const finished: string[] = [];
  page.on('requestfailed', (request) => {
    if (GOOGLE.test(request.url())) failed.push(request.failure()?.errorText ?? '');
  });
  page.on('requestfinished', (request) => {
    if (GOOGLE.test(request.url())) finished.push(request.url());
  });
  await page.goto('./');
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15_000 }).toBe(true);
  await page.locator('#file').setInputFiles({ name: 'mock.zip', mimeType: 'application/zip', buffer: mockAdZip() });
  if (browserName === 'chromium') {
    // Its host-resolver rules leave Google's addresses unresolved.
    await expect.poll(() => failed, { timeout: 30_000 }).toContain('net::ERR_NAME_NOT_RESOLVED');
  } else {
    // Its proxy refused to open the connection to Google, so nothing was sent.
    const refused = async () => (await refusedBy(PROXY_PORTS[browserName])).filter((r) => r.at >= since).map((r) => `${r.method} ${r.url}`);
    await expect.poll(refused, { timeout: 30_000 }).toContain('CONNECT script.google.com:443');
  }
  expect(finished).toEqual([]);
});
