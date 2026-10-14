import { strFromU8, unzipSync } from 'fflate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type FileChooser, type Page } from '@playwright/test';
import { GWD_RUNTIME, mockAdHtml, mockAdZip } from './mock-ad';

const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);
const frame = (page: Page, label: string) => page.frameLocator(`#frames iframe[title="${label} ad"]`);

async function choose(page: Page, button: string, files: Parameters<FileChooser['setFiles']>[0]) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: button }).click()]);
  await chooser.setFiles(files);
}

async function downloaded(page: Page, button: string) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button, exact: true }).click()]);
  return { name: download.suggestedFilename(), bytes: new Uint8Array(readFileSync((await download.path())!)) };
}

// Per-size text, as GWD writes it: an exact size wins over a range that also fits.
const OVERRIDE = JSON.stringify({
  '300x250': { 'data-gwd-text': JSON.stringify({ content: 'Exact <span class="gwd-span-x">size</span>', isPlainText: false }) },
  '300x250:320x480': { 'data-gwd-text': JSON.stringify({ content: 'Range <span class="gwd-span-x">size</span>', isPlainText: false }) },
}).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// GWD's page sizing: each page fills the frame through percentage heights. Page two's text uses a
// web font whose file is not in the upload.
const PAGE_CSS = '<style>html, body { width: 100%; height: 100%; margin: 0px; } .gwd-page-container { position: relative; width: 100%; height: 100%; } .gwd-page-size { position: absolute; width: 100%; height: 100%; } @font-face { font-family: "Brand Missing"; src: url("fonts/brand.woff") format("woff"); } .gwd-p-c { font-family: "Brand Missing", Arial; }</style>';

/** The mock ad's HTML as GWD saves it: loading GWD's runtime by name, with page sizing, per-size text and an image. */
function loneHtml(): string {
  return mockAdHtml('Headline', GWD_RUNTIME)
    .replace('</head>', `  ${PAGE_CSS}\n</head>`)
    .replace('<gwd-page id="page1">', '<gwd-page id="page1" class="gwd-page-size">')
    .replace('id="SA_headline_1"', `id="SA_headline_1" data-gwd-media-override="${OVERRIDE}"`)
    .replace('<button class="gwd-button-b"', '<gwd-image id="SA_logo_1" source="assets/logo.png" scaling="contain" style="position: absolute; left: 200px; top: 10px; width: 60px; height: 40px;"></gwd-image>\n        <button class="gwd-button-b"');
}

test('checks an ad from just its HTML, with a stand-in for GWD\'s runtime', async ({ page }) => {
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name: 'Responsive.html', mimeType: 'text/html', buffer: Buffer.from(loneHtml()) });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });

  await expect(page.locator('#summary .banner.standin')).toContainText('the preview uses a stand-in');
  await expect(page.locator('#summary .banner.standin')).toContainText('images are missing');
  await expect(page.locator('#frames .frame header span')).toHaveText([
    '300x250',
    '300x250 (range 300x250 to 320x480)',
    '320x480 (range 300x250 to 320x480)',
  ]);

  // The stand-in shows each page and applies the per-size text; a missing image is a placeholder.
  await expect(frame(page, '300x250').locator('#page1')).toHaveJSProperty('offsetHeight', 250);
  await expect(frame(page, '300x250').locator('#SA_headline_1')).toHaveText('Exact size');
  await expect(frame(page, '300x250 (range 300x250 to 320x480)').locator('#SA_headline_1')).toHaveText('Exact size');
  await expect(frame(page, '320x480 (range 300x250 to 320x480)').locator('#SA_headline_1')).toHaveText('Range size');
  await expect(frame(page, '300x250').locator('#SA_logo_1 img')).toHaveAttribute('src', /^data:image\/svg\+xml,/);
  const lineHeight = row(page, 'lineHeight');
  await lineHeight.locator('summary').click();
  await expect(lineHeight.locator('li', { hasText: 'p#SA_headline_2' })).toContainText('on page2');
  await expect(row(page, 'type').locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');

  // Measured in a fallback font, its line-height would change once the real font loads: no value is written.
  await expect(page.locator('#fixes .manual')).toContainText('.gwd-p-c: its font had not loaded');
  await expect(page.locator('#fixes .fixlist li', { hasText: 'Declare line-height' }).locator('.detail').first()).not.toContainText('.gwd-p-c');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('texts are exactly where they were, and every line spacing is unchanged, in every size and on every page', { timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Download for upload' })).toHaveCount(0);

  const file = await downloaded(page, 'Download fixed HTML');
  expect(file.name).toBe('Responsive.html');
  const html = strFromU8(file.bytes);
  expect(html).toContain('margin-block: 0px auto;');
  expect(html).toContain('<script src="gwdpage_min.js"></script>');
  expect(html).not.toContain('gwdStandin');
});

test('checks a folder like its zip, and several loose files', async ({ page }, testInfo) => {
  const root = testInfo.outputPath('folder');
  for (const [name, data] of Object.entries(unzipSync(new Uint8Array(mockAdZip())))) {
    if (name.endsWith('/')) continue;
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), data);
  }
  await page.goto('./');
  await choose(page, 'Choose a folder', join(root, 'Mock Ad'));
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#summary .meta strong')).toHaveText('Mock Ad.zip');
  await expect(page.locator('#summary .banner.standin')).toHaveCount(0);
  await expect(row(page, 'type').locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');

  const full = await downloaded(page, 'Download zip');
  expect(full.name).toBe('Mock Ad.zip');
  expect(Object.keys(unzipSync(full.bytes))).toEqual(['Mock Ad/', 'Mock Ad/Responsive.html', 'Mock Ad/_revision/', 'Mock Ad/_revision/Responsive.html', 'Mock Ad/mock-gwd.js']);
  const upload = await downloaded(page, 'Download for upload');
  expect(upload.name).toBe('Mock Ad-upload.zip');
  expect(Object.keys(unzipSync(upload.bytes))).toEqual(['Mock Ad/', 'Mock Ad/Responsive.html', 'Mock Ad/mock-gwd.js']);

  await page.getByRole('button', { name: 'Check another ad' }).click();
  await choose(page, 'Choose a zip', [join(root, 'Mock Ad/Responsive.html'), join(root, 'Mock Ad/mock-gwd.js')]);
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#summary .meta strong')).toHaveText('Responsive.zip');
  await expect(frame(page, '300x250').locator('#SA_headline_1')).toContainText('Headline');
  const loose = await downloaded(page, 'Download zip');
  expect(Object.keys(unzipSync(loose.bytes))).toEqual(['Responsive.html', 'mock-gwd.js']);
});

test('takes a dropped file', async ({ page }) => {
  await page.goto('./');
  const dataTransfer = await page.evaluateHandle((html) => {
    const dt = new DataTransfer();
    dt.items.add(new File([html], 'Responsive.html', { type: 'text/html' }));
    return dt;
  }, loneHtml());
  await page.dispatchEvent('#drop', 'drop', { dataTransfer });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#summary .meta strong')).toHaveText('Responsive.html');
  await expect(frame(page, '300x250').locator('#SA_headline_1')).toHaveText('Exact size');
});

test('refuses two files of the same name in one drop, such as two ads\' HTML from search results', async ({ page }) => {
  await page.goto('./');
  const dataTransfer = await page.evaluateHandle(([a, b]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([a], 'Responsive.html', { type: 'text/html' }));
    dt.items.add(new File([b], 'Responsive.html', { type: 'text/html' }));
    return dt;
  }, [mockAdHtml('Alpha', GWD_RUNTIME), mockAdHtml('Beta', GWD_RUNTIME)]);
  await page.dispatchEvent('#drop', 'drop', { dataTransfer });
  await expect(page.locator('#status .banner.err')).toHaveText('Files with the same name came from different folders: Responsive.html. They may be different ads. Check one ad at a time: its zip, its folder, or just its HTML.');
  await expect(page.locator('#drop')).toBeVisible();
  await expect(page.locator('#summary')).toBeHidden();
});
