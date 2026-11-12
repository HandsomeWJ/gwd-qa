// The package weight fix: an image far larger than it shows is resized to twice its size on screen,
// applying it moves no text and brings the zip under 4 MB, and Undo puts the image back.
import { strToU8, zipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { encodeRgbaPng } from '../src/compress/png';
import { MOCK_RUNTIME, mockAdHtml } from './mock-ad';

/** A 1300 × 1300 PNG of noise, which no deflate can shrink: about 5 MB. */
function noisePng(): Buffer {
  const size = 1300;
  const rgba = new Uint8Array(size * size * 4);
  let seed = 7;
  for (let i = 0; i < rgba.length; i++) {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    rgba[i] = (i & 3) === 3 ? 255 : seed & 0xff;
  }
  return Buffer.from(encodeRgbaPng(size, size, rgba));
}

const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);
const ad = (page: Page) => page.frameLocator('#frames iframe[title="300x250 ad"]');

test('resizes an image far larger than it shows, moving no text, and Undo puts it back', async ({ page }) => {
  test.setTimeout(300_000);
  const html = mockAdHtml().replace('<div id="SA_dot_1"></div>', '<div id="SA_dot_1"></div>\n        <img id="SA_noise_1" src="assets/noise.png" alt="" style="position: absolute; left: 180px; top: 120px; width: 100px; height: 100px;">');
  const zip = Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/mock-gwd.js': strToU8(MOCK_RUNTIME), 'Mock Ad/assets/noise.png': [noisePng(), { level: 0 }] }));
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name: 'heavy.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 120_000 });
  await expect(row(page, 'weight').locator('summary .pill')).toHaveText('Fail');

  // Every color kept: the resize is the whole change, so the image is offered ticked.
  await page.locator('#fixes details.choose summary').click();
  await page.locator('select[data-savings="colors"]').selectOption('0');
  await page.getByRole('button', { name: 'Find savings' }).click();
  const item = page.locator('.savings > li', { hasText: 'noise.png' });
  await expect(item).toContainText('1300 × 1300 → 200 × 200', { timeout: 120_000 });
  await expect(item).toContainText('shows at most 100 × 100, so 2× that is enough');
  await expect(item.locator('input[data-shrink]')).toBeChecked();
  await expect(page.locator('#savings-total')).toContainText('under the 4 MB limit');
  await item.locator('details.compare summary').click();
  await expect.poll(() => item.locator('figure img').last().evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(200);

  await page.getByRole('button', { name: 'Apply compression' }).click();
  await expect(page.locator('#fixes .banner.ok')).toContainText('exactly where they were', { timeout: 120_000 });
  await expect(row(page, 'weight').locator('summary .pill')).toHaveText('Pass');
  await expect(page.locator('#summary table.weight-result tr', { hasText: 'noise.png' })).toContainText('200 × 200');
  const shown = () => ad(page).locator('#SA_noise_1').evaluate((img) => [(img as HTMLImageElement).naturalWidth, img.getBoundingClientRect().width]);
  await expect.poll(shown).toEqual([200, 100]);

  await page.getByRole('button', { name: 'Undo fixes' }).click();
  await expect(row(page, 'weight').locator('summary .pill')).toHaveText('Fail', { timeout: 120_000 });
  await expect.poll(shown).toEqual([1300, 100]);
});

test('Fix package weight compresses as far as it takes in one press, moving no text', async ({ page }) => {
  test.setTimeout(300_000);
  const html = mockAdHtml().replace('<div id="SA_dot_1"></div>', '<div id="SA_dot_1"></div>\n        <img id="SA_noise_1" src="assets/noise.png" alt="" style="position: absolute; left: 180px; top: 120px; width: 100px; height: 100px;">');
  const zip = Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/mock-gwd.js': strToU8(MOCK_RUNTIME), 'Mock Ad/assets/noise.png': [noisePng(), { level: 0 }], 'Mock Ad/gwd_workspace.json': strToU8('{}') }));
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name: 'heavy.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 120_000 });
  // Every state the progress card shows, as it shows it.
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { progressSeen: seen });
    // Beside the button, where the progress shows.
    const beside = document.querySelector('#weight-progress')!;
    new MutationObserver(() => {
      const p = beside.querySelector('.progress');
      if (p) seen.push(p.textContent ?? '');
    }).observe(beside, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole('button', { name: 'Fix package weight' }).click();
  await expect(page.locator('#fixes .banner.ok').first()).toContainText('exactly where they were', { timeout: 180_000 });
  await expect(row(page, 'weight').locator('summary .pill')).toHaveText('Pass');
  const seen = await page.evaluate(() => (window as unknown as { progressSeen: string[] }).progressSeen);
  expect(seen.some((t) => t.includes('Measuring how large each image shows'))).toBe(true);
  expect(seen.some((t) => t.includes('Step 1 of up to 5: what nobody can see') && t.includes('Image 1 of 1: noise.png'))).toBe(true);
  expect(seen.some((t) => /Zip for upload: 5\.\d\d MB → 0\.\d\d MB so far/.test(t))).toBe(true);
  expect(seen.some((t) => t.includes('checking that no text moved'))).toBe(true);
  // What it did stays on the page: the zip before and after, and each file's.
  // Beside the button, where the progress showed: the zip before and after.
  const done = page.locator('#fixes .weight-actions .weight-done');
  await expect(done.locator('strong')).toHaveText(/^Zip for upload: 5\.\d\d MB → (\d+ KB|0\.\d\d MB)$/);
  await expect(done).toContainText(', under the 4 MB limit.');
  await expect(done.locator('.progress-meta')).toHaveText(/^1 image made smaller, 5\.\d\d MB → (\d+ KB|0\.\d\d MB) · gwd_workspace\.json left out of the zip for upload$/);
  const button = page.locator('#fixes .weight-actions').getByRole('button', { name: 'Package weight fixed' });
  await expect(button).toBeDisabled();
  const [b, d] = [(await button.boundingBox())!, (await done.boundingBox())!];
  expect(d.x).toBeGreaterThanOrEqual(b.x + b.width);
  expect(Math.abs(d.y - b.y)).toBeLessThan(2);
  const noise = page.locator('#fixes table.weight-result tr', { hasText: 'noise.png' });
  await expect(noise.locator('td').nth(1)).toHaveText(/^5\.\d\d MB1300 × 1300$/);
  await expect(noise.locator('td').nth(2)).toContainText('200 × 200');
  await expect(noise.locator('td').nth(3)).toHaveText('resized to 200 × 200, stored without loss');
  await expect(page.locator('#fixes table.weight-result tr', { hasText: 'gwd_workspace.json' })).toContainText('left out of the zip for upload');
  // Other fixes applied after it leave what it did on the page.
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner').first()).toContainText('exactly where they were', { timeout: 180_000 });
  await expect(page.locator('#fixes .weight-done')).toContainText('under the 4 MB limit');
  await expect(page.locator('#fixes .weight-actions').getByRole('button', { name: 'Package weight fixed' })).toBeDisabled();
  await expect(page.locator('#summary .weight-total')).toContainText('under the 4 MB limit');
  // The summary at the top says it too: the zip before and after, and each file's.
  await expect(page.locator('#summary .weight-total')).toHaveText(/^Zip for upload: 5\.\d\d MB → (\d+ KB|0\.\d\d MB), under the 4 MB limit\.$/);
  const top = page.locator('#summary table.weight-result tr', { hasText: 'noise.png' });
  await expect(top.locator('td').nth(1)).toHaveText(/^5\.\d\d MB1300 × 1300$/);
  await expect(top.locator('td').nth(2)).toContainText('200 × 200');
  await expect(page.locator('#summary')).toContainText('Left out of the zip for upload: gwd_workspace.json');
  await expect.poll(() => ad(page).locator('#SA_noise_1').evaluate((img) => [(img as HTMLImageElement).naturalWidth, img.getBoundingClientRect().width])).toEqual([200, 100]);
});

test("deletes a value browsers ignore from the ad's own stylesheet, or writes what it meant where you tick Fix anyway", async ({ page }) => {
  const html = mockAdHtml().replace('<script src="mock-gwd.js"></script>', '<script src="mock-gwd.js"></script>\n  <link href="carousel.css" rel="stylesheet">');
  const css = '.btn {\n  position: absolute;\n  z-index: 10px;\n}\n';
  const zip = Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/mock-gwd.js': strToU8(MOCK_RUNTIME), 'Mock Ad/carousel.css': strToU8(css) }));
  const downloaded = async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
    const { readFileSync } = await import('node:fs');
    const { strFromU8, unzipSync } = await import('fflate');
    return strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/carousel.css']);
  };
  for (const anyway of [false, true]) {
    await page.goto('./');
    await page.locator('#file').setInputFiles({ name: 'own-css.zip', mimeType: 'application/zip', buffer: zip });
    await expect(page.locator('#summary')).toBeVisible({ timeout: 120_000 });
    const fix = page.locator('#fixes .fixlist li', { hasText: 'Delete CSS values browsers ignore' });
    await expect(fix.locator('.detail')).toHaveText('.btn z-index: 10px in Mock Ad/carousel.css');
    await expect(fix.locator('details.edits summary')).toContainText('Show the edits in carousel.css');
    if (anyway) await page.locator('#fixes .manual li li', { hasText: 'write 10 in Mock Ad/carousel.css' }).locator('input[data-anyway]').check();
    await page.getByRole('button', { name: 'Apply selected fixes' }).click();
    await expect(page.locator('#fixes .banner')).toContainText('exactly where they were', { timeout: 120_000 });
    await expect(row(page, 'cssValues').locator('summary .pill')).toHaveText('Pass');
    await expect(page.locator('#summary')).toContainText('Review the changes to carousel.css');
    expect(await downloaded()).toBe(anyway ? css.replace('10px', '10') : '.btn {\n  position: absolute;\n}\n');
  }
});
