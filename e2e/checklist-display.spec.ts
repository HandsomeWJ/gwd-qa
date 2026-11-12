// The display checklist of 2026-11-13: clickable elements show the pointer, every file the ad loads is
// in the package at its exact name, the zip weighs under 4 MB, and type below 8px is a recommendation.
import { strToU8, zipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_RUNTIME, mockAdHtml, mockAdZip, mockZip } from './mock-ad';

const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function load(page: Page, name: string, zip: Buffer) {
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name, mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 120_000 });
}

test('gives the clickable parts the pointer where param.js makes the whole ad clickable, moving nothing', async ({ page }) => {
  // The mock loads param.js and has no tap area (class dynamicClick), so every element opens the landing page.
  await load(page, 'pointer.zip', mockZip(mockAdHtml()));
  const cursor = row(page, 'cursor');
  await expect(cursor.locator('summary .pill')).toHaveText('Fail');
  await expect(cursor.locator('summary .count')).toContainText('auto-fix ready');
  const fix = page.locator('#fixes .fixlist li', { hasText: 'Show the pointer cursor on clickable elements' });
  await expect(fix.locator('.detail')).toContainText("gwd-genericad (StackAdapt's param.js makes the whole ad clickable)");
  await expect(fix.locator('input[type="checkbox"]')).toBeChecked();

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toHaveText(/^Applied \d+ fixes\. All \d+ texts are exactly where they were, and every line spacing is unchanged, in every size and on every page\.$/, { timeout: 120_000 });
  await expect(cursor.locator('summary .pill')).toHaveText('Pass');
  const ad = page.frameLocator('#frames iframe[title="300x250 ad"]');
  await expect.poll(() => ad.locator('#SA_headline_1').evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  await expect.poll(() => ad.locator('#SA_cta_1').evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
});

test('rewrites a reference whose letter case differs from its file, and leaves a missing file to you', async ({ page }) => {
  const img = (id: string, src: string, left: number) => `<img id="${id}" src="${src}" alt="" style="position: absolute; left: ${left}px; top: 200px; width: 20px; height: 20px;">`;
  const html = mockAdHtml().replace('<div id="SA_dot_1"></div>', `<div id="SA_dot_1"></div>\n        ${img('SA_logo_1', 'assets/logo.png', 250)}\n        ${img('SA_gone_1', 'assets/gone.png', 270)}`);
  await load(page, 'files.zip', Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/mock-gwd.js': strToU8(MOCK_RUNTIME), 'Mock Ad/assets/Logo.PNG': PNG })));
  const files = row(page, 'files');
  await expect(files.locator('summary .pill')).toHaveText('Fail');
  await expect(files.locator('summary .count')).toHaveText('2 items · auto-fix ready');
  await expect(files.locator('li', { hasText: 'assets/gone.png' })).toContainText('which is not in the package');
  const fix = page.locator('#fixes .fixlist li', { hasText: "Use the files' exact names" });
  await expect(fix.locator('.detail')).toHaveText('assets/logo.png → assets/Logo.PNG');
  // The preview's server is case-sensitive, as StackAdapt's is: the image is missing until the fix.
  const ad = page.frameLocator('#frames iframe[title="300x250 ad"]');
  await expect.poll(() => ad.locator('#SA_logo_1').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(0);

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were', { timeout: 120_000 });
  await expect(files.locator('summary .count')).toHaveText('1 item');
  await expect.poll(() => ad.locator('#SA_logo_1').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
});

test('shows type below 8px as a recommendation that does not count as failing, under the display-only notice', async ({ page }) => {
  await load(page, 'advice.zip', mockAdZip());
  await expect(page.locator('.banner.scope')).toContainText('Display ads only for now.');
  // "Tiny" on page two is 6px and not marked as a disclaimer.
  await expect(row(page, 'type').locator('summary .pill')).toHaveText('Recommendation');
  const meta = page.locator('#summary .meta');
  await expect(meta).toContainText('1 recommendation');
  await expect(meta).toContainText('working package'); // GWD's _revision/ backup came with it
  await expect(row(page, 'weight').locator('summary .pill')).toHaveText('Pass');
  await expect(row(page, 'weight').locator('li')).toContainText('MB, under the 4 MB limit.');
});
