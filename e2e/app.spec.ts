import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { mockAdHtml, mockAdZip, mockZip } from './mock-ad';

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

  // A decimal comma in an event handler and in a style attribute: browsers ignore both values.
  const cssValues = row(page, 'cssValues');
  await expect(cssValues.locator('summary .pill')).toHaveText('Fail');
  await expect(cssValues.locator('summary .count')).toHaveText('2 items · auto-fix ready');
  const cssFix = page.locator('#fixes .fixlist li', { hasText: 'Write decimal points in CSS values' });
  await expect(cssFix).toContainText('SA_cta_1 opacity: 0,3 -> 0.3 (in gwd.framechange_savings), div#SA_rule_1 opacity: 0,5 -> 0.5');
  await expect(cssFix.locator('input[type="checkbox"]')).toBeChecked();

  // Each fix shows its edits before it is applied.
  const lhFix = page.locator('#fixes .fixlist li', { hasText: 'Declare line-height' });
  await lhFix.locator('details.edits summary').click();
  await expect(lhFix.locator('.diff .add').first()).toContainText('line-height:');
  await expect(lhFix).toContainText('.gwd-p-c in 300x250 to 320x480');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  // Texts and line spacings are counted apart: 10 texts per frame (its two body scripts among them) and 8 spacings.
  await expect(page.locator('#fixes .banner')).toHaveText(/^Applied \d+ fixes\. All 24 texts are exactly where they were, and every line spacing is unchanged, in every size and on every page\.$/, { timeout: 90_000 });
  await expect(page.locator('#summary')).toContainText('Every check passes', { timeout: 90_000 });
  await expect(cssValues.locator('summary .pill')).toHaveText('Pass');
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
  const fixed = strFromU8(upload.files['Mock Ad/Responsive.html']);
  expect(fixed).toContain('margin-block: 0px auto;');
  expect(fixed).toContain("setInlineStyle('SA_cta_1', 'opacity: 0.3;')");
  expect(fixed).toContain('<div id="SA_rule_1" style="opacity: 0.5;"></div>');
});

test('checks CSS values as Chromium reads them, skipping GWD\'s runtime and styles that never apply', async ({ page }) => {
  const files = unzipSync(new Uint8Array(mockAdZip()));
  const html = strFromU8(files['Mock Ad/Responsive.html'])
    // A component inlined the way GWD can publish it: it picks a value, it does not set "none".
    .replace('  <style type="text/css">', `  <script data-source="gwdmock_min.js" data-version="1" data-exports-type="gwd-mock">
    (function () { var el = document.createElement('div'), fit = 'cover'; el.style.backgroundSize = 'none' != fit ? fit : 'auto'; })();
  </script>
  <!-- <style>.gwd-p-a { opacity: 0,1; }</style> -->
  <style type="text/css">`)
    .replace("'opacity: 0,3;');", "'opacity: 0,3;');\n      gwd.actions.events.setInlineStyle('SA_cta_1', 'box-shadow: 0px 2px 1,5px rgba(0,0,0,0.5);');")
    .replace('<gwd-genericad id="gwd-ad">', '<noscript><div style="opacity: 0,2"></div></noscript>\n  <gwd-genericad id="gwd-ad">');
  files['Mock Ad/Responsive.html'] = strToU8(html);
  await load(page, Buffer.from(zipSync(files)));

  const cssValues = row(page, 'cssValues');
  await cssValues.locator('summary').click();
  const findings = cssValues.locator('.findings');
  await expect(findings).toContainText('"box-shadow: 0px 2px 1,5px rgba(0,0,0,0.5)" is not valid CSS');
  for (const never of ['background-size', '0,1', '0,2']) await expect(findings).not.toContainText(never);
  const cssFix = page.locator('#fixes .fixlist li', { hasText: 'Write decimal points in CSS values' });
  await expect(cssFix).toContainText('SA_cta_1 box-shadow: 0px 2px 1,5px rgba(0,0,0,0.5) -> 0px 2px 1.5px rgba(0,0,0,0.5) (in gwd.framechange_savings)');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(cssValues.locator('summary .pill')).toHaveText('Pass', { timeout: 90_000 });
});

test("checks the ad's own stylesheets and scripts, and what GWD's setInlineStyle ignores, as Chromium reads them", async ({ page }) => {
  const files = unzipSync(new Uint8Array(mockAdZip()));
  const html = strFromU8(files['Mock Ad/Responsive.html'])
    .replace('  <style type="text/css">', `  <link href="extra.css" rel="stylesheet">
  <script src="js/custom.js"></script>
  <style type="text/css">
    .gwd-p-a { -webkit-text-stroke: 0,5px; }
    .gwd-div-z { background: url("hero_1,5x.png") 1,5px 1,5px no-repeat; }`)
    .replace("'opacity: 0,3;');", "'opacity: 0,3;');\n      gwd.actions.events.setInlineStyle('SA_cta_1', 'opacity: 0.4 !important;');\n      gwd.actions.events.setInlineStyle('SA_cta_1', 'opacity : 0,6');");
  files['Mock Ad/Responsive.html'] = strToU8(html);
  files['Mock Ad/extra.css'] = strToU8('.gwd-p-a { opacity: 0,7; }');
  files['Mock Ad/js/custom.js'] = strToU8("function go(el) {\n  el.style.opacity = '0,8';\n}");
  await load(page, Buffer.from(zipSync(files)));

  const cssValues = row(page, 'cssValues');
  await cssValues.locator('summary').click();
  const findings = cssValues.locator('.findings');
  await expect(findings).toContainText('"opacity: 0,7" is not valid CSS, so browsers ignore it; write 0.7. It is in Mock Ad/extra.css.');
  await expect(findings).toContainText('"opacity: 0,8" is not valid CSS, so browsers ignore it; write 0.8. style.opacity sets it in go, in Mock Ad/js/custom.js.');
  // GWD's runtime hands setProperty() the name untrimmed and !important in the value: Chromium sets neither.
  await expect(findings).toContainText('"opacity: 0.4 !important" is ignored: setInlineStyle takes !important as part of the value');
  await expect(findings).toContainText('"opacity : 0,6" is ignored: setInlineStyle takes the spaces around the name as part of it');
  // Chromium knows this vendor property, so it drops the invalid value.
  await expect(findings).toContainText('"-webkit-text-stroke: 0,5px" is not valid CSS, so browsers ignore it; write 0.5px.');
  // The ticked fix leaves the comma in the image's name.
  const cssFix = page.locator('#fixes .fixlist li', { hasText: 'Write decimal points in CSS values' }).first();
  await expect(cssFix).toContainText('.gwd-div-z background: url("hero_1,5x.png") 1,5px 1,5px no-repeat -> url("hero_1,5x.png") 1.5px 1.5px no-repeat');
  await expect(cssFix.locator('input')).toBeChecked();
  await expect(page.locator('#fixes .manual')).toContainText('opacity: 0,7 in Mock Ad/extra.css is not valid CSS, so browsers ignore it; write 0.7 in Mock Ad/extra.css.');
});

test('shows Review, not Pass, for CSS values when a stylesheet the ad loads is not among its files', async ({ page }) => {
  const html = mockAdHtml()
    .replace("'opacity: 0,3;'", "'opacity: 0.3;'")
    .replace('style="opacity: 0,5;"', 'style="opacity: 0.5;"')
    .replace('  <style type="text/css">', '  <link href="missing.css" rel="stylesheet">\n  <style type="text/css">');
  await load(page, mockZip(html));
  const cssValues = row(page, 'cssValues');
  await expect(cssValues.locator('summary .pill')).toHaveText('Review');
  await cssValues.locator('summary').click();
  await expect(cssValues.locator('.findings')).toContainText('The ad loads missing.css, which is not among the files checked, so its CSS values were not checked.');
});

test('shows the preview sharp, says when a size is cut off, and replays', async ({ page }) => {
  await load(page, mockAdZip());
  await expect(page.locator('#drop')).toBeHidden();

  // GWD's 3D-transformed pages blur between device pixels: a half-pixel shift above must be undone.
  await page.addStyleTag({ content: '#preview .bar { padding-top: 0.5px; }' });
  const offGrid = () => page.evaluate(() => [...document.querySelectorAll('#frames iframe')]
    .map((f) => f.getBoundingClientRect())
    .flatMap((r) => [r.left + scrollX, r.top + scrollY].map((v) => Math.abs(v * devicePixelRatio - Math.round(v * devicePixelRatio))))
    .filter((d) => d > 0.01).length);
  await expect.poll(offGrid).toBe(0);

  const note = page.locator('#frames .frame', { hasText: '300x250' }).first().locator('.clipped');
  await expect(note).toBeHidden();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(note).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(note).toBeHidden();

  await page.getByRole('button', { name: 'Replay all' }).click();
  await expect(page.locator('#status')).toBeEmpty({ timeout: 30_000 });
  await expect(frame(page, '300x250').locator('#SA_headline_1')).toBeVisible();
});

test('blocks the ad\'s requests to other sites unless they are allowed', async ({ page }) => {
  // Not from the previews, nor from the frames that lay each fix out without scripts: the policy stops them all.
  const sent: string[] = [];
  page.on('requestfinished', (r) => { if (r.url().includes('pixel.invalid')) sent.push(r.url()); });
  page.on('requestfailed', (r) => { if (r.url().includes('pixel.invalid') && r.failure()?.errorText !== 'csp') sent.push(r.url()); });
  await load(page, mockAdZip());
  await expect(page.locator('#net')).toContainText('pixel.invalid');
  expect(sent).toEqual([]);
  await expect(frame(page, '300x250').locator('html')).toHaveAttribute('data-blocked', 'yes');

  await page.getByLabel('Let the ad contact other sites').check();
  await expect(page.locator('#status')).toBeEmpty({ timeout: 90_000 });
  await expect(frame(page, '300x250').locator('#SA_cta_1')).toBeVisible();
  await expect(frame(page, '300x250').locator('html')).not.toHaveAttribute('data-blocked', 'yes');
});

test('the ad cannot send requests to other sites through this page either', async ({ page }) => {
  // Another site, on another port: what reaches it got out.
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // The frames share this page's origin, so the ad's code can make requests from this page.
    const html = mockAdHtml().replace('</head>', `  <script>
    new Image().src = '${site}/own.gif';
    new parent.Image().src = '${site}/via-parent.gif';
    parent.fetch('${site}/via-parent-fetch', { mode: 'no-cors' }).catch(() => {});
    parent.navigator.sendBeacon('${site}/via-parent-beacon');
  </script>
</head>`);
    await page.addInitScript(() => {
      if (window !== top) return;
      const seen: string[] = [];
      Object.assign(window, { blockedHere: seen });
      document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective));
    });
    await load(page, mockZip(html));
    await expect(page.locator('#net')).toContainText('The ad\'s requests to other sites are blocked');
    const outcome = async () => ({
      reached: [...new Set(hits)].sort(),
      blocked: await page.evaluate(() => [...new Set((window as unknown as { blockedHere: string[] }).blockedHere)].sort()),
    });
    await expect.poll(outcome).toEqual({ reached: [], blocked: ['connect-src', 'img-src'] });
  } finally {
    server.close();
  }
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
