import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { mockAdZip } from './mock-ad';

async function load(page: Page, zip: Buffer, name = 'mock-ad.zip') {
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name, mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

const adCaches = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('gwdqa-ad-')));
const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);
const frame = (page: Page, label: string) => page.frameLocator(`#frames iframe[title="${label} ad"]`);

test('checks every page and both ends of a range, then fixes without moving text', async ({ page }) => {
  await load(page, mockAdZip());

  await expect(page.locator('#frames .frame header span')).toHaveText([
    '300x250',
    '300x250 (range 300x250 to 320x480)',
    '320x480 (range 300x250 to 320x480)',
  ]);
  await expect(page.locator('#checklist .sub')).toContainText('on each of its 2 pages');

  // Page two is out of the DOM until GWD shows it, so finding it proves every page was visited.
  const lineHeight = row(page, 'lineHeight');
  await lineHeight.locator('summary').click();
  await expect(lineHeight.locator('li', { hasText: 'p#SA_headline_2' })).toContainText('on page2');

  // The disclaimer is exempt by its id; the other small text fails until it is marked too.
  const type = row(page, 'type');
  await expect(type.locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');
  await type.locator('summary').click();
  await type.locator('input[data-disclaimer="p#SA_note_1"]').first().check();
  await expect(type.locator('summary .pill')).toHaveText('Pass');
  await expect(type.locator('summary .count')).toHaveText('2 disclaimers exempt');

  // Each fix shows its edits before it is applied.
  const lhFix = page.locator('#fixes .fixlist li', { hasText: 'Declare line-height' });
  await lhFix.locator('details.edits summary').click();
  await expect(lhFix.locator('.diff .add').first()).toContainText('line-height:');
  await expect(lhFix).toContainText('.gwd-p-c in 300x250 to 320x480');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were, in every size and on every page', { timeout: 90_000 });
  await expect(page.locator('#summary')).toContainText('Every check passes', { timeout: 90_000 });
  await expect(page.locator('#summary details.edits summary')).toContainText('Review the changes to Responsive.html');

  const zipOf = async (button: string) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button, exact: true }).click()]);
    return { name: download.suggestedFilename(), files: unzipSync(new Uint8Array(readFileSync((await download.path())!))) };
  };
  const full = await zipOf('Download fixed zip');
  expect(full.name).toBe('mock-ad.zip');
  expect(Object.keys(full.files)).toContain('Mock Ad/_revision/Responsive.html');
  const upload = await zipOf('Download for upload');
  expect(upload.name).toBe('mock-ad-upload.zip');
  expect(Object.keys(upload.files)).toEqual(['Mock Ad/', 'Mock Ad/Responsive.html', 'Mock Ad/mock-gwd.js']);
  expect(strFromU8(upload.files['Mock Ad/Responsive.html'])).toContain('margin-block: 0px auto;');
});

test('blocks the ad\'s requests to other sites unless they are allowed', async ({ page }) => {
  await load(page, mockAdZip());
  await expect(page.locator('#net')).toContainText('pixel.invalid');
  await expect(frame(page, '300x250').locator('html')).toHaveAttribute('data-blocked', 'yes');

  await page.getByLabel('Let the ad contact other sites').check();
  await expect(page.locator('#status')).toBeEmpty({ timeout: 90_000 });
  await expect(frame(page, '300x250').locator('#SA_cta_1')).toBeVisible();
  await expect(frame(page, '300x250').locator('html')).not.toHaveAttribute('data-blocked', 'yes');
});

test('two tabs keep their own ad', async ({ context }) => {
  const first = await context.newPage();
  await load(first, mockAdZip('First'));
  const second = await context.newPage();
  await load(second, mockAdZip('Second'));
  expect(await adCaches(second)).toHaveLength(2);

  await first.bringToFront();
  await first.locator('#frames .frame', { hasText: '300x250' }).first().getByRole('button', { name: 'Replay' }).click();
  await expect(frame(first, '300x250').locator('#SA_headline_1')).toContainText('First');

  // Closing a tab frees its cache for the next load to sweep; "Check another ad" deletes its own at once.
  await second.close();
  await first.getByRole('button', { name: 'Check another ad' }).click();
  await expect.poll(() => adCaches(first)).toHaveLength(1);
  await first.locator('#file').setInputFiles({ name: 'third.zip', mimeType: 'application/zip', buffer: mockAdZip('Third') });
  await expect(first.locator('#summary')).toBeVisible({ timeout: 90_000 });
  const id = await first.evaluate(() => (window as unknown as { gwdqa: { session: { id: string } } }).gwdqa.session.id);
  expect(await adCaches(first)).toEqual([`gwdqa-ad-${id}`]);
});
