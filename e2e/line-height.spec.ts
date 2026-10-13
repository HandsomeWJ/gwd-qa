import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { GWD_RUNTIME, mockAdHtml, mockAdZip, mockZip } from './mock-ad';

const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);
const lineHeightFix = (page: Page) => page.locator('#fixes .fixlist li', { hasText: 'Declare line-height' });

async function load(page: Page, name: string, buffer: Buffer, mimeType = 'application/zip') {
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name, mimeType, buffer });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

/** Each <p>, <span> and <button>'s line-height in px as the HTML lays out at this size, every page in place. */
async function spacing(browser: Browser, html: string, width: number, height: number): Promise<string[]> {
  const page = await browser.newPage({ viewport: { width, height }, javaScriptEnabled: false });
  await page.setContent(html);
  const out = await page.evaluate(() => [...document.querySelectorAll('p, span, button')].map((el) => {
    const cs = getComputedStyle(el);
    let px = parseFloat(cs.lineHeight);
    if (cs.lineHeight === 'normal') {
      const probe = document.createElement('div');
      probe.style.cssText = `position:absolute;white-space:nowrap;font:${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily};line-height:normal`;
      probe.textContent = el.textContent || 'Xg';
      document.body.append(probe);
      px = probe.getBoundingClientRect().height;
      probe.remove();
    }
    return `${el.id || el.className} ${Math.round(px * 100) / 100}px`;
  }));
  await page.close();
  return out;
}

// At both ends of the range an exact size's block wins, so no frame shows what the range block does.
const shadowedRange = (rangeFont: string) => mockAdHtml()
  .replace('["300x250", "300x250:320x480"]', '["300x600", "300x250:320x480", "300x250", "320x480"]')
  .replace(/(@media \(min-width[^{]*\{\s*\.gwd-p-c \{\s*)font-size: 12px;/, `$1${rangeFont}`)
  .replace('  </style>', '    @media (width: 320px) and (height: 480px) {\n      .gwd-p-c {\n        font-size: 13px;\n      }\n    }\n  </style>');

test('keeps the spacing between the ends of a range whose two ends are exact sizes', async ({ page, browser }) => {
  const html = shadowedRange('font-size: 10px;');
  await load(page, 'range.zip', mockZip(html));
  await expect(lineHeightFix(page)).toContainText('.gwd-p-c in 300x250 to 320x480:');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were', { timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  expect(fixed).not.toBe(html);
  // 310x400 lies inside the range, where only the range block applies.
  for (const [w, h] of [[310, 400], [300, 600], [300, 250], [320, 480]]) {
    expect(await spacing(browser, fixed, w, h), `${w}x${h}`).toEqual(await spacing(browser, html, w, h));
  }
});

test('leaves the base size to you where a size no frame shows sets a font it cannot measure', async ({ page }) => {
  await load(page, 'range.zip', mockZip(shadowedRange('font-weight: inherit;')));
  await expect(page.locator('#fixes .manual')).toContainText('.gwd-p-c in 300x250 to 320x480 was not measured, and a value in its base rule would reach it there, so its base size gets none');
  await expect(lineHeightFix(page)).toContainText('.gwd-p-c in 300x250:');
  await expect(lineHeightFix(page).locator('.detail').first()).not.toContainText(/\.gwd-p-c: /);
});

test('leaves a text to you where its line-height would reach text inside it that has none of its own', async ({ page }) => {
  // A <sup> renders smaller type, so its normal line-height is not the paragraph's.
  await load(page, 'sup.zip', mockAdZip('Brand<sup>®</sup> deals'));
  await expect(page.locator('#fixes .manual')).toContainText('.gwd-p-a: sup inside it takes its line-height and would go from');
  await expect(lineHeightFix(page).locator('.detail').first()).not.toContainText('.gwd-p-a');
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were', { timeout: 90_000 });
});

// GWD's text helper, as GWD writes it, and a text it fits to a box too small for it.
const HELPER = '<gwd-text-helper id="gwd-text-helper_1" fit-font-size-for-selector="[data-gwd-fit-font-size],[gwd-fitting-truncate]" data-gwd-fit-font-size="false"></gwd-text-helper>';
const FIT = '<p class="gwd-p-fit" id="SA_fit_1" data-gwd-fit-font-size="" gwd-min-font-size-px="4">Fit this rather long sentence into the box</p>';
const FIT_CSS = '    .gwd-p-fit {\n      position: absolute;\n      left: 10px;\n      top: 200px;\n      width: 60px;\n      height: 14px;\n      margin: 0px;\n      font-family: Arial;\n      font-size: 12px;\n    }\n';

function fittingAd(runtime: string[], head = '') {
  return mockAdHtml('Headline', runtime)
    .replace('  </style>', `${FIT_CSS}  </style>${head}`)
    .replace('<gwd-genericad id="gwd-ad">', `${HELPER}\n  <gwd-genericad id="gwd-ad">`)
    .replace('<button class="gwd-button-b"', `${FIT}\n        <button class="gwd-button-b"`);
}

test('leaves text GWD fits to its box out of the size check and the line-height fix when its fitting cannot run', async ({ page }) => {
  await load(page, 'Responsive.html', Buffer.from(fittingAd([...GWD_RUNTIME, 'gwdtexthelper_min.js', 'gwd-text-fitting.js'])), 'text/html');
  await expect(page.locator('#summary .banner.standin')).toContainText('the preview uses a stand-in');
  const type = row(page, 'type');
  await type.locator('summary').click();
  await expect(type.locator('li', { hasText: 'p#SA_fit_1' })).toContainText('GWD fits this text to its box when the ad runs, which needs its gwd-text-fitting.js');
  await expect(page.locator('#fixes .manual')).toContainText('.gwd-p-fit: GWD fits this text when the ad runs, which needs its gwd-text-fitting.js; check the whole folder or zip.');
  await expect(lineHeightFix(page).locator('.detail').first()).not.toContainText('.gwd-p-fit');
});

test('leaves text GWD fits to its box out of the line-height fix when its fitting runs', async ({ page }) => {
  // Stands in for GWD's text fitting: once it runs, a fixed line-height would change how it fits.
  const runtime = '\n  <script>window.gwd = window.gwd || {}; gwd.textfitting = { fit() {} }; customElements.define("gwd-text-helper", class extends HTMLElement { fit() {} });</script>';
  await load(page, 'fit.zip', mockZip(fittingAd(['mock-gwd.js'], runtime)));
  await expect(page.locator('#fixes .manual')).toContainText('.gwd-p-fit: GWD fits this text to its box when the ad runs, and a fixed line-height would change how it fits');
  await expect(lineHeightFix(page).locator('.detail').first()).not.toContainText('.gwd-p-fit');
  await expect(row(page, 'type')).not.toContainText('as written');
});
