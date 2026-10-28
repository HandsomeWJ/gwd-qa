// The site in Chrome's, Safari's and Firefox's engines: each shows the ad as it draws it, and only
// Chrome's offers fixes, as a fix keeps the ad exactly as the browser that measured it draws it.
import { expect, test } from '@playwright/test';
import { mockAdZip } from './mock-ad';

const NAMES = { chromium: 'Chrome', webkit: 'Safari', firefox: 'Firefox' } as const;

test('previews and checks the ad in this browser, and fixes it only in Chrome', async ({ page, browserName }) => {
  // Outside Chromium the host-resolver rules do not apply: copies are refused here instead.
  const google: string[] = [];
  await page.route(/^https:\/\/script\.google(usercontent)?\.com\//, (route) => {
    google.push(route.request().url());
    return route.abort();
  });
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
  expect(google.every((u) => u.startsWith('https://script.google.com/macros/s/e2e-test/'))).toBe(true);
});
