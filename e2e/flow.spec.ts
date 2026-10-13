import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { GWD_RUNTIME, mockAdHtml, mockAdZip } from './mock-ad';

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
  expect(fixed).toContain("setInlineStyle('SA_cta_1', 'opacity: 0.3;')");
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

test('disclaimer marks on just the HTML stay with that HTML; a zip keeps them by its name', async ({ page }) => {
  await page.goto('./');
  // Marks an older version saved under a zip's name still apply.
  await page.evaluate(() => localStorage.setItem('gwdqa.disclaimers', JSON.stringify({ 'mock-ad.zip': { 'p#SA_note_1': true } })));
  await load(page, 'mock-ad.zip', mockAdZip());
  await expect(row(page, 'type').locator('summary .count')).toHaveText('2 disclaimers exempt');
  await page.getByRole('button', { name: 'Check another ad' }).click();

  // GWD names every ad's HTML Responsive.html, so the name alone cannot tell two ads apart.
  const markNote = async () => {
    const type = row(page, 'type');
    await type.locator('summary').click();
    await type.locator('input[data-disclaimer="p#SA_note_1"]').first().check();
    await expect(type.locator('summary .count')).toHaveText('2 disclaimers exempt');
    await page.getByRole('button', { name: 'Check another ad' }).click();
  };
  await load(page, 'Responsive.html', mockAdHtml('Alpha', GWD_RUNTIME));
  await expect(row(page, 'type').locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');
  await markNote();

  await load(page, 'Responsive.html', mockAdHtml('Beta', GWD_RUNTIME));
  await expect(row(page, 'type').locator('summary .count')).toHaveText('1 item · 1 disclaimer exempt');
  await page.getByRole('button', { name: 'Check another ad' }).click();

  await load(page, 'Responsive.html', mockAdHtml('Alpha', GWD_RUNTIME));
  await expect(row(page, 'type').locator('summary .count')).toHaveText('2 disclaimers exempt');
  expect((await gwdqa(page))!.key).toMatch(/^Responsive\.html#[0-9a-f]{8}$/);
});
