import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { GWD_RUNTIME, MOCK_RUNTIME, mockAdHtml, mockAdZip, mockZip } from './mock-ad';

type Gwdqa = { session: { id: string; key: string; html: string; originalHtml: string; lastApply: unknown; pkg: { zipName: string }; audit?: unknown } | null };
const gwdqa = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { gwdqa: Gwdqa }).gwdqa.session;
  return s && { id: s.id, key: s.key, zipName: s.pkg.zipName, changed: s.html !== s.originalHtml, lastApply: s.lastApply };
});
const adCaches = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('gwdqa-ad-')));
const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);

async function pick(page: Page, name: string, data: string | Buffer) {
  const mimeType = name.endsWith('.zip') ? 'application/zip' : 'text/html';
  await page.locator('#file').setInputFiles({ name, mimeType, buffer: Buffer.isBuffer(data) ? data : Buffer.from(data) });
}

async function load(page: Page, name: string, data: string | Buffer) {
  await pick(page, name, data);
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

test('a second ad that is refused leaves the loaded ad as it was', async ({ page }) => {
  await page.goto('./');
  await load(page, 'mock-ad.zip', mockAdZip());
  const first = await gwdqa(page);

  await pick(page, 'notes.html', '<!DOCTYPE html><html><body><p>Meeting notes</p></body></html>');
  await expect(page.locator('#status .banner.err')).toHaveText('No served sizes found: this does not look like a GWD ad.');
  expect(await gwdqa(page)).toMatchObject({ id: first!.id, zipName: 'mock-ad.zip' });
  expect(await adCaches(page)).toEqual([`gwdqa-ad-${first!.id}`]);
  await expect(page.locator('#summary .meta strong')).toHaveText('mock-ad.zip');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download zip', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('mock-ad.zip');
  expect(Object.keys(unzipSync(new Uint8Array(readFileSync((await download.path())!))))).toContain('Mock Ad/Responsive.html');
});

test('an ad that starts on a later check hides the drop zone again', async ({ page }) => {
  await page.goto('./');
  await load(page, 'mock-ad.zip', mockAdZip());
  // Stays still until the test lets it start, as an ad waiting on a blocked script would.
  const stuck = mockAdHtml('Late').replace('<script src="mock-gwd.js"></script>', '<script src="mock-gwd.js"></script>\n  <script>if (!sessionStorage.getItem("gwdqaLetStart")) customElements.get("gwd-genericad").prototype.initAd = () => {};</script>');
  await pick(page, 'late.zip', mockZip(stuck));
  await expect(page.locator('#status .banner.err')).toContainText('The ad did not start', { timeout: 60_000 });
  await expect(page.locator('#drop')).toBeVisible();

  await page.evaluate(() => sessionStorage.setItem('gwdqaLetStart', '1'));
  await page.getByLabel('Let the ad contact other sites').check();
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#drop')).toBeHidden();
});

test('a second ad that fails after the first is closed takes the first one\'s results off the page', async ({ page }) => {
  await page.goto('./');
  await load(page, 'mock-ad.zip', mockAdZip());

  // Its runtime is not GWD's, so nothing stands in for it and the ad never starts.
  await pick(page, 'Broken.html', mockAdHtml('Broken'));
  await expect(page.locator('#status .banner.err')).toContainText('The ad did not start', { timeout: 60_000 });
  expect(await gwdqa(page)).toMatchObject({ zipName: 'Broken.html' });
  for (const id of ['summary', 'checklist', 'fixes', 'copy']) await expect(page.locator(`#${id}`)).toBeHidden();
  await expect(page.locator('#drop')).toBeVisible();
  // The preview left is the failed ad's own, to see why it did not start.
  await expect(page.locator('#frames iframe')).toHaveCount(3);
  await expect(page.frameLocator('#frames iframe[title="300x250 ad"]').locator('#SA_headline_1')).toContainText('Broken');

  await load(page, 'mock-ad.zip', mockAdZip());
  await expect(page.locator('#drop')).toBeHidden();
  await expect(page.locator('#status')).toBeEmpty();
});

test('a failed check after applying puts the file back, so the fixes on the page still match it', async ({ page }) => {
  await page.goto('./');
  await load(page, 'mock-ad.zip', mockAdZip());
  await page.evaluate(() => {
    const s = (window as unknown as { gwdqa: Gwdqa }).gwdqa.session!;
    s.audit = async () => {
      delete s.audit; // only this once
      throw new Error('The 300x250 frame did not load.');
    };
  });

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#status .banner.err')).toHaveText('The 300x250 frame did not load. The file was put back as it was, so the results below still match it.', { timeout: 90_000 });
  expect(await gwdqa(page)).toMatchObject({ changed: false, lastApply: null });
  await expect(page.locator('#summary')).not.toContainText('Fixed, not yet downloaded');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were', { timeout: 90_000 });
  await expect(page.locator('#summary')).toContainText('1 check failing'); // the small note, not marked as a disclaimer
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  expect(fixed).toContain("setInlineStyle('SA_dot_1', 'opacity: 0.3;')");
});

test('undoing after the browser dropped the ad\'s files puts every file back', async ({ page }) => {
  await page.goto('./');
  // Its runtime goes by one of GWD's names, which the stand-in would answer for if the file went missing.
  const zip = Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(mockAdHtml('Headline', ['gwdpage_min.js'])), 'Mock Ad/gwdpage_min.js': strToU8(MOCK_RUNTIME) }));
  await load(page, 'mock-ad.zip', zip);
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were', { timeout: 90_000 });

  // As when the site's data is cleared, or the browser evicts it, while the tab is open.
  await page.evaluate(async () => {
    for (const name of await caches.keys()) if (name.startsWith('gwdqa-ad-')) await caches.delete(name);
  });
  await page.getByRole('button', { name: 'Undo fixes' }).click();
  await expect(page.locator('#summary')).not.toContainText('Fixed, not yet downloaded', { timeout: 90_000 });
  await expect(page.locator('#status .banner.err')).toHaveCount(0);
  const frames = page.frames().filter((f) => f.url().includes('/__ad/'));
  expect(frames).toHaveLength(3);
  for (const f of frames) expect(await f.evaluate(() => 'gwdStandin' in window)).toBe(false);
  await expect(page.locator('#summary .banner.standin')).toHaveCount(0);
});

test('the apply banner counts changed line spacings and moved texts apart', async ({ page }) => {
  await page.goto('./');
  await load(page, 'mock-ad.zip', mockAdZip());
  // Make the line-height fix give the headline a taller line than it renders.
  await page.evaluate(() => {
    const r = (window as unknown as { gwdqa: { result: { plan: { fixes: { edits: { text: string }[] }[] } } } }).gwdqa.result;
    for (const f of r.plan.fixes) for (const e of f.edits) e.text = e.text.replace(/(\.gwd-p-a \{\s*line-height: )18px/, '$130px');
  });
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  const banner = page.locator('#fixes .banner.warn');
  await expect(banner).toContainText('Applied 7 fixes, but 6 line spacings changed and 6 texts moved.', { timeout: 90_000 });
  await expect(banner.locator('li').first()).toHaveText('300x250 page1 p#SA_headline_1 line-height');
});

test('the apply banner also counts what moves in a size no preview shows, laid out without scripts', async ({ page }) => {
  await page.goto('./');
  await load(page, 'mock-ad.zip', mockAdZip());
  // Give the text on page two another line-height only inside the range, which neither of its frames shows.
  await page.evaluate(() => {
    const g = (window as unknown as { gwdqa: { session: { html: string }; result: { plan: { fixes: { edits: { start: number; end: number; text: string }[] }[] } } } }).gwdqa;
    const at = g.session.html.indexOf('  </style>');
    g.result.plan.fixes[0].edits.push({ start: at, end: at, text: '    @media (min-width: 305px) and (max-width: 315px) {\n      .gwd-p-c {\n        line-height: 40px;\n      }\n    }\n' });
  });
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  const banner = page.locator('#fixes .banner.warn');
  await expect(banner).toContainText('Every text in the previews is where it was, but laid out without scripts, 1 line spacing changed at 310x365. Check that size in GWD, or undo.', { timeout: 90_000 });
  await expect(banner.locator('li')).toHaveText(['310x365 p#SA_headline_2 line-height']);
});

const marks = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('gwdqa.disclaimers') ?? '{}'));

/** Ticks p#SA_note_1, the mock ad's small text that is not named a disclaimer, as one. */
async function markNote(page: Page) {
  const type = row(page, 'type');
  await type.evaluate((d) => ((d as HTMLDetailsElement).open = true)); // a row stays open from the ad before
  await type.locator('input[data-disclaimer="p#SA_note_1"]').first().check();
  await expect(type.locator('summary .count')).toHaveText(/^2 disclaimers exempt/);
}

async function downloaded(page: Page, button: string) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button, exact: true }).click()]);
  return { name: download.suggestedFilename(), data: readFileSync((await download.path())!) };
}

test('disclaimer marks stay with the ad they were made on, by its name and its HTML', async ({ page }) => {
  await page.goto('./');
  // Marks an older version saved under a zip's name alone still apply, to the first ad of that name.
  await page.evaluate(() => localStorage.setItem('gwdqa.disclaimers', JSON.stringify({ 'Archive.zip': { 'p#SA_note_1': true } })));
  await load(page, 'Archive.zip', mockAdZip('First'));
  await expect(row(page, 'type').locator('summary .count')).toHaveText('2 disclaimers exempt');
  await page.getByRole('button', { name: 'Check another ad' }).click();

  // macOS names every zip it makes Archive.zip, so the name alone cannot tell two ads apart.
  await load(page, 'Archive.zip', mockAdZip('Second'));
  await expect(row(page, 'type').locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');
  await page.getByRole('button', { name: 'Check another ad' }).click();
  await load(page, 'Archive.zip', mockAdZip('First'));
  await expect(row(page, 'type').locator('summary .count')).toHaveText('2 disclaimers exempt');
  const first = (await gwdqa(page))!.key;
  expect(first).toMatch(/^Archive\.zip#[0-9a-f]{8}$/);
  expect(await marks(page)).toEqual({ [first]: { 'p#SA_note_1': true } });
  await page.getByRole('button', { name: 'Check another ad' }).click();

  // GWD names every ad's HTML Responsive.html: the same holds for just the HTML.
  await load(page, 'Responsive.html', mockAdHtml('Alpha', GWD_RUNTIME));
  await expect(row(page, 'type').locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');
  await markNote(page);
  await page.getByRole('button', { name: 'Check another ad' }).click();

  await load(page, 'Responsive.html', mockAdHtml('Beta', GWD_RUNTIME));
  await expect(row(page, 'type').locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');
  await page.getByRole('button', { name: 'Check another ad' }).click();

  await load(page, 'Responsive.html', mockAdHtml('Alpha', GWD_RUNTIME));
  await expect(row(page, 'type').locator('summary .count')).toHaveText('2 disclaimers exempt');
  expect((await gwdqa(page))!.key).toMatch(/^Responsive\.html#[0-9a-f]{8}$/);
});

test('disclaimer marks come back when the fixed HTML is checked again', async ({ page }) => {
  await page.goto('./');
  await load(page, 'Responsive.html', mockAdHtml('Alpha', GWD_RUNTIME));
  await markNote(page);
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#summary')).toContainText('Fixed, not yet downloaded', { timeout: 90_000 });
  const html = await downloaded(page, 'Download fixed HTML');
  // Unmarked after the download: the downloaded file's marks follow too.
  await row(page, 'type').locator('input[data-disclaimer="p#SA_disclaimer_1"]').first().uncheck();
  await page.getByRole('button', { name: 'Check another ad' }).click();
  await load(page, html.name, html.data);
  await expect(row(page, 'type').locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');
  await expect(row(page, 'type').locator('input[data-disclaimer="p#SA_note_1"]').first()).toBeChecked();
  await expect(row(page, 'type').locator('input[data-disclaimer="p#SA_disclaimer_1"]').first()).not.toBeChecked();
});

test('disclaimer marks come back when the fixed zip is checked again', async ({ page }) => {
  await page.goto('./');
  await load(page, 'mock-ad.zip', mockAdZip());
  await markNote(page);
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#summary')).toContainText('Fixed, not yet downloaded', { timeout: 90_000 });
  const zip = await downloaded(page, 'Download fixed zip');
  const upload = await downloaded(page, 'Download for upload');
  for (const file of [zip, upload]) {
    await page.getByRole('button', { name: 'Check another ad' }).click();
    await load(page, file.name, file.data);
    await expect(row(page, 'type').locator('summary .count')).toHaveText('2 disclaimers exempt');
  }
});

test('disclaimer marks stay with their ad when its file has a name every object has', async ({ page }) => {
  await page.goto('./');
  // A zip saved without an extension.
  await pick(page, '__proto__', mockAdZip());
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
  await markNote(page);
  const key = (await gwdqa(page))!.key;
  expect(key).toMatch(/^__proto__#[0-9a-f]{8}$/);
  expect(await marks(page)).toEqual({ [key]: { 'p#SA_note_1': true } });
  expect(await page.evaluate(() => Object.keys(Object.prototype))).toEqual([]);
  await page.getByRole('button', { name: 'Check another ad' }).click();
  await load(page, 'other-ad.zip', mockAdZip());
  await expect(row(page, 'type').locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');
});

test('a text whose label is a name every object has is not a disclaimer until it is marked', async ({ page }) => {
  await page.goto('./');
  const html = mockAdHtml()
    .replace('<p class="gwd-p-e" id="SA_note_1">Tiny</p>', '<constructor style="position: absolute; left: 10px; top: 100px; font-size: 6px; line-height: 8px;">Only 6px</constructor>')
    .replace(/\s*<p class="gwd-p-d" id="SA_disclaimer_1">Small print<\/p>/, '');
  await load(page, 'constructor.zip', mockZip(html));
  const type = row(page, 'type');
  await expect(type.locator('summary .pill')).toHaveText('Fail');
  await expect(type.locator('summary .count')).toHaveText('1 item');
  await type.locator('summary').click();
  await expect(type.locator('input[data-disclaimer="constructor"]').first()).not.toBeChecked();
});

// The deck never shows page two in 300x250, as an ad whose own timeline moves away from it.
const NO_PAGE2_IN_300X250 = `<script>
    (() => {
      const deck = customElements.get('gwd-pagedeck').prototype;
      const goToPage = deck.goToPage;
      deck.goToPage = function (target) {
        if (innerWidth === 300 && innerHeight === 250 && (target === 1 || target === 'page2')) return;
        return goToPage.call(this, target);
      };
    })();
  </script>`;

test('a page that never showed leaves the checks of what renders to review, never a pass', async ({ page }) => {
  await page.goto('./');
  // Page two holds the 6px note, which would fail Type size if the check saw it.
  const html = mockAdHtml()
    .replace('["300x250", "300x250:320x480"]', '["300x250"]')
    .replace('<script src="mock-gwd.js"></script>', `<script src="mock-gwd.js"></script>\n  ${NO_PAGE2_IN_300X250}`);
  await load(page, 'hidden-page.zip', mockZip(html));
  await expect(page.locator('#checklist .banner.warn')).toContainText('page2 in 300x250 never showed, so it was not checked there.');
  const type = row(page, 'type');
  await expect(type.locator('summary .pill')).toHaveText('Review');
  await expect(type.locator('summary .count')).toHaveText('1 page not checked');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#summary')).toContainText('Fixed, not yet downloaded', { timeout: 120_000 });
  // Fixes for text that may sit on that page are left to you, and the banner says what it did not compare.
  await expect(page.locator('#fixes .banner.warn')).toContainText('wherever the previews showed them; 1 page not checked, so compare that in GWD.');
  const meta = page.locator('#summary .meta');
  await expect(meta).toContainText('1 page not checked');
  await expect(meta).not.toContainText('Every check passes');
  // What renders never passes; what is read from the source alone still does.
  const pills = await page.locator('#checklist details[data-check] summary .pill').allInnerTexts();
  expect(pills.slice(0, 5).filter((p) => p === 'Pass')).toEqual([]);
  expect(pills.slice(0, 5)).toContain('Review');
  expect(pills.slice(5)).toEqual(['Pass', 'Pass', 'Pass', 'Pass', 'Pass', 'Pass']);
});

test('a served size with no preview leaves the checks of what renders to review', async ({ page }) => {
  await page.goto('./');
  const html = mockAdHtml().replace('["300x250", "300x250:320x480"]', '["300x250", "300x250:320x480", "300x250:200x100"]');
  await load(page, 'no-preview.zip', mockZip(html));
  await expect(page.locator('#checklist .banner.warn')).toContainText('Served size "300x250:200x100" has no preview');
  await markNote(page);
  const type = row(page, 'type');
  await expect(type.locator('summary .pill')).toHaveText('Review');
  await expect(type.locator('summary .count')).toHaveText('2 disclaimers exempt · 1 size not checked');
  await expect(page.locator('#summary .meta')).toContainText('1 size not checked');
});
