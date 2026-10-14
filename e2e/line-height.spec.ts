import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { GWD_RUNTIME, MOCK_RUNTIME, mockAdHtml, mockAdZip, mockZip } from './mock-ad';

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

test('leaves a class to you where a size no frame shows gives what it sits in a line-height', async ({ page, browser }) => {
  // Only the range block gives the wrapper its line-height, and at both of its ends an exact size's block
  // wins, so its frames measure 30px while the base size measures normal: a value in the text's base
  // rule would replace the 30px inside the range, where no frame shows it.
  const html = shadowedRange('font-size: 10px;')
    .replace('    @keyframes kf-in {', '    .gwd-div-w {\n      position: absolute;\n      left: 0px;\n      top: 120px;\n      width: 300px;\n      height: 120px;\n    }\n    .gwd-p-t {\n      position: absolute;\n      left: 10px;\n      top: 0px;\n      width: 140px;\n      margin: 0px;\n      font-family: Arial;\n      font-size: 16px;\n    }\n    @keyframes kf-in {')
    .replace(/(@media \(min-width[^{]*\{)/, '$1\n      .gwd-div-w {\n        line-height: 30px;\n      }')
    .replace('<button class="gwd-button-b"', '<div class="gwd-div-w" id="SA_wrap_1"><p class="gwd-p-t" id="SA_t_1">Some longer text that wraps onto several lines</p></div>\n        <button class="gwd-button-b"');
  await load(page, 'wrapper.zip', mockZip(html));
  await expect(page.locator('#fixes .manual')).toContainText('.gwd-p-t');
  // The class is left out alone: the others keep their values.
  await expect(lineHeightFix(page).locator('.detail').first()).not.toContainText(/\.gwd-p-t: /);
  await expect(lineHeightFix(page).locator('.detail').first()).toContainText('.gwd-p-c in 300x250 to 320x480:');
  await expect(lineHeightFix(page).locator('input[type="checkbox"]')).toBeChecked();

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were, and every line spacing is unchanged', { timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  expect(fixed).not.toBe(html);
  for (const [w, h] of [[310, 400], [305, 300], [300, 600], [300, 250], [320, 480]]) {
    expect(await spacing(browser, fixed, w, h), `${w}x${h}`).toEqual(await spacing(browser, html, w, h));
  }
});

test('leaves a class to you whose line-height would change the spacing in a size no frame shows, as laid out without scripts', async ({ page, browser }) => {
  // A media query of the designer's own makes page two's text smaller up to 310px wide: inside the range,
  // where no frame shows it, the range block's value would then space 10px type.
  const html = mockAdHtml().replace('  </style>', '    @media (max-width: 310px) {\n      .gwd-p-c {\n        font-size: 10px;\n      }\n    }\n  </style>');
  await load(page, 'query.zip', mockZip(html));
  await expect(page.locator('#fixes .manual')).toContainText(/\.gwd-p-c: its line-height would change the spacing at \d+x\d+, which no preview shows; set it in GWD\./);
  await expect(lineHeightFix(page).locator('.detail').first()).not.toContainText('.gwd-p-c');
  await expect(lineHeightFix(page).locator('.detail').first()).toContainText('.gwd-p-a');
  await expect(lineHeightFix(page).locator('input[type="checkbox"]')).toBeChecked();

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were, and every line spacing is unchanged', { timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  for (const [w, h] of [[305, 300], [310, 400], [300, 250], [320, 480]]) {
    expect(await spacing(browser, fixed, w, h), `${w}x${h}`).toEqual(await spacing(browser, html, w, h));
  }
});

test('lays out the texts in GWD groups too, where only the layout without scripts would see a change', async ({ page }) => {
  // The same media query, on text that GWD's groups runtime (here its stand-in) copies into the page.
  const html = mockAdHtml('Headline', ['mock-gwd.js', 'groups_runtime.min.1.0.js'])
    .replace('<body>', '<body>\n  <template id="gwd-group-definitions">\n    <div data-gwd-group-def="Note" data-gwd-group-class="gwd-grp-n" style="display: none;">\n      <p data-gwd-grp-id="text" class="gwd-grp-n gwd-p-g">Grouped text</p>\n    </div>\n  </template>')
    .replace('  </style>', '    .gwd-p-g {\n      position: absolute;\n      left: 0px;\n      top: 0px;\n      margin: 0px;\n      font-family: Arial;\n      font-size: 16px;\n    }\n    .gwd-div-n {\n      position: absolute;\n      left: 10px;\n      top: 200px;\n      width: 200px;\n      height: 40px;\n    }\n    @media (max-width: 310px) {\n      .gwd-p-g {\n        font-size: 10px;\n      }\n    }\n  </style>')
    .replace('<button class="gwd-button-b"', '<div id="SA_note_g" class="gwd-div-n" data-gwd-group="Note"></div>\n        <button class="gwd-button-b"')
    .replace(/(@media \(min-width[^{]*\{)/, '$1\n      .gwd-p-g {\n        font-size: 12px;\n      }');
  await load(page, 'group.zip', mockZip(html));
  await expect(page.frameLocator('#frames iframe[title="300x250 ad"]').locator('#SA_note_g .gwd-p-g')).toHaveText('Grouped text');
  await expect(page.locator('#fixes .manual')).toContainText(/\.gwd-p-g: its line-height would change the spacing at \d+x\d+, which no preview shows; set it in GWD\./);
  await expect(lineHeightFix(page).locator('.detail').first()).not.toContainText('.gwd-p-g');
});

test('runs none of the ad\'s own scripts in the frames that lay the fixes out', async ({ page }) => {
  // Only those frames are srcdoc documents; the previews load the ad from its own URL.
  const html = mockAdHtml().replace('</head>', '  <script src="probe.js"></script>\n</head>');
  const probe = 'if (location.href === "about:srcdoc") parent.document.documentElement.dataset.layoutRan = "yes";';
  await load(page, 'scripted.zip', Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/mock-gwd.js': strToU8(MOCK_RUNTIME), 'Mock Ad/probe.js': strToU8(probe) })));
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('html')).not.toHaveAttribute('data-layout-ran', 'yes');
});

test('offers another fix unticked where, laid out without scripts, it moves text in a size no frame shows', async ({ page }) => {
  // Only inside the range does a paragraph whose class sets no margin get one, from a rule for every <p>;
  // margin-block on its class would take it away there.
  const html = shadowedRange('font-size: 10px;')
    .replace('    @keyframes kf-in {', '    .gwd-p-z {\n      position: absolute;\n      left: 10px;\n      top: 150px;\n      font-family: Arial;\n      font-size: 12px;\n    }\n    @keyframes kf-in {')
    .replace('  <style type="text/css">', '  <style type="text/css" id="gwd-text-style">\n    p {\n      margin: 0px;\n    }\n  </style>\n  <style type="text/css">')
    .replace(/(@media \(min-width[^{]*\{)/, '$1\n      p {\n        margin-top: 10px;\n      }')
    .replace(/(@media \(width: (300px\) and \(height: 250|320px\) and \(height: 480)px\) \{)/g, '$1\n      p {\n        margin-top: 0px;\n      }')
    .replace('<button class="gwd-button-b"', '<p class="gwd-p-z" id="SA_z_1">Margin text</p>\n        <button class="gwd-button-b"');
  await load(page, 'margin.zip', mockZip(html));
  const margin = page.locator('#fixes .fixlist li', { hasText: 'Add margin-block: 0px auto' });
  await expect(margin).toContainText('.gwd-p-z');
  await expect(margin).toContainText('Laid out without scripts, it moves p#SA_z_1 at 310x365, which no preview shows. Check that size in GWD.');
  await expect(margin.locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(lineHeightFix(page).locator('input[type="checkbox"]')).toBeChecked();
});

/** A web font to test with: a Latin font this machine has (macOS or CI's Linux), never copied into this repo. */
function latinFont(): Buffer {
  const paths = [
    '/System/Library/Fonts/Supplemental/Georgia.ttf',
    '/System/Library/Fonts/Supplemental/Courier New.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  const path = paths.find((p) => existsSync(p));
  if (!path) throw new Error('No Latin TrueType font found to test with');
  return readFileSync(path);
}

test('lays each fix out in the ad\'s own web fonts, once they have loaded', async ({ page }) => {
  // Only 300x250 draws this text in the web font, so nothing loads it until that size is laid out; a
  // fallback font would space it otherwise than the frames measured.
  const html = mockAdHtml()
    .replace('    @keyframes kf-in {', '    @font-face {\n      font-family: Brand;\n      src: url("assets/brand.ttf");\n    }\n    .gwd-p-i {\n      position: absolute;\n      left: 10px;\n      top: 150px;\n      margin: 0px;\n      font-family: Arial;\n      font-size: 30px;\n    }\n    @keyframes kf-in {')
    .replace(/(@media \(width: 300px\) and \(height: 250px\) \{)/, '$1\n      .gwd-p-i {\n        font-family: Brand;\n      }')
    .replace('<button class="gwd-button-b"', '<p class="gwd-p-i" id="SA_brand_1">Brand gap</p>\n        <button class="gwd-button-b"');
  const zip = Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/mock-gwd.js': strToU8(MOCK_RUNTIME), 'Mock Ad/assets/brand.ttf': new Uint8Array(latinFont()) }));
  await load(page, 'brand.zip', zip);
  await expect(lineHeightFix(page).locator('.detail').first()).toContainText(/\.gwd-p-i in 300x250: \d/);
  await expect(page.locator('#fixes .manual')).not.toContainText('.gwd-p-i');
  await expect(lineHeightFix(page).locator('input[type="checkbox"]')).toBeChecked();
});

test('measures every span of a class where it sits in different paragraphs, in a size no frame shows', async ({ page, browser }) => {
  // Two id-less spans of one class take their font from different paragraphs, which the range block sizes differently.
  const css = (cls: string, top: number) => `    .${cls} {\n      position: absolute;\n      left: 10px;\n      top: ${top}px;\n      margin: 0px;\n      font-family: Arial;\n      font-size: 16px;\n    }\n`;
  const block = (media: string, a: number, b: number) => `    @media ${media} {\n      .gwd-p-ka {\n        font-size: ${a}px;\n      }\n      .gwd-p-kb {\n        font-size: ${b}px;\n      }\n    }\n`;
  const html = mockAdHtml()
    .replace('["300x250", "300x250:320x480"]', '["300x600", "300x250:320x480", "300x250", "320x480"]')
    .replace('  </style>', `${css('gwd-p-ka', 120)}${css('gwd-p-kb', 170)}    .gwd-span-kx {\n      color: rgb(0, 0, 200);\n    }\n${block('(min-width: 300px) and (max-width: 320px) and (min-height: 250px) and (max-height: 480px)', 30, 10)}${block('(width: 300px) and (height: 250px)', 12, 12)}${block('(width: 320px) and (height: 480px)', 14, 14)}  </style>`)
    .replace('<button class="gwd-button-b"', '<p class="gwd-p-ka" id="SA_ka_1">Alpha <span class="gwd-span-kx">one</span></p>\n        <p class="gwd-p-kb" id="SA_kb_1">Beta <span class="gwd-span-kx">two</span></p>\n        <button class="gwd-button-b"');
  await load(page, 'spans.zip', mockZip(html));
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were', { timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
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

test('leaves text to you whose font a blocked script would load', async ({ page }) => {
  // A web font loader adds the font from another site; with those requests blocked, a fallback draws the text.
  const html = mockAdHtml()
    .replace('  </style>', '    .gwd-p-c {\n      font-family: "Lobster Loaded By Script", serif;\n    }\n  </style>\n  <script src="https://fonts.invalid/webfont.js"></script>');
  await load(page, 'loader.zip', mockZip(html));
  await expect(page.locator('#fixes .manual')).toContainText('.gwd-p-c: its font had not loaded when it was measured');
  await expect(lineHeightFix(page).locator('.detail').first()).not.toContainText('.gwd-p-c');
  await expect(lineHeightFix(page).locator('.detail').first()).toContainText('.gwd-p-a');
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
  // With the mock's own small print marked as a disclaimer, only the fitted text is left: not a pass.
  await type.locator('input[data-disclaimer="p#SA_note_1"]').first().check();
  await expect(type.locator('summary .pill')).toHaveText('Review');
  await expect(page.locator('#summary .meta')).not.toContainText('Every check passes');
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
