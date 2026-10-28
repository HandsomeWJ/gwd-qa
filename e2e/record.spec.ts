// The copies of checked ads and the bug reports the site posts to its owner's web app (src/record.ts,
// src/report.ts). The tests answer for the web app; whatever they do not answer is blocked
// (playwright.config.ts), so nothing reaches Google.
import { strFromU8, unzipSync } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mockAdZip } from './mock-ad';

interface SentFile { name: string; type: string; data: string }
interface Post { kind: string; name?: string; description?: string; email?: string; about: string; file: SentFile | null; fixed?: SentFile | null }

/** Answers the web app's posts with what `reply` gives (a success by default), and collects them. */
async function webApp(page: Page, reply: (post: Post) => object | 'abort' = () => ({ ok: true })) {
  const posts: Post[] = [];
  await page.route('https://script.google.com/macros/s/*/exec', async (route) => {
    const post = JSON.parse(route.request().postData() ?? '{}') as Post;
    posts.push(post);
    const answer = reply(post);
    if (answer === 'abort') return route.abort();
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  return posts;
}

const decoded = (file: SentFile) => Buffer.from(file.data, 'base64');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Report a bug' });

async function load(page: Page, name: string, data: Buffer) {
  await page.locator('#file').setInputFiles({ name, mimeType: 'application/zip', buffer: data });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

test('keeps a copy of each ad picked, a folder as its zip', async ({ page }, testInfo) => {
  const posts = await webApp(page);
  await page.goto('./');
  await expect(page.locator('header.top')).toContainText('a copy of each ad you check is kept for 7 days');

  const zip = mockAdZip();
  await load(page, 'mock-ad.zip', zip);
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ kind: 'upload', name: 'mock-ad.zip', file: { name: 'mock-ad.zip', type: 'application/zip' } });
  expect(decoded(posts[0].file!).equals(zip)).toBe(true);
  expect(posts[0].about).toContain('Picked: a zip');

  const root = testInfo.outputPath('folder');
  const files = Object.entries(unzipSync(new Uint8Array(zip))).filter(([path]) => !path.endsWith('/'));
  for (const [path, data] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  }
  await page.locator('#folder').setInputFiles(join(root, 'Mock Ad'));
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ kind: 'upload', name: 'Mock Ad.zip', file: { name: 'Mock Ad.zip', type: 'application/zip' } });
  const kept = unzipSync(new Uint8Array(decoded(posts[1].file!)));
  expect(Object.keys(kept).sort()).toEqual(files.map(([path]) => path).sort());
  expect(posts[1].about).toContain(`Picked: a folder of ${files.length} files`);
});

test('a copy that fails does not get in the way of the check', async ({ page }) => {
  const posts = await webApp(page, () => 'abort');
  await page.goto('./');
  await load(page, 'mock-ad.zip', mockAdZip());
  await expect.poll(() => posts.length).toBe(1);
  await expect(page.locator('#status .banner.err')).toHaveCount(0);
  await expect(page.locator('#checklist')).toBeVisible();
});

test('sends a bug report with the ad, its fixed HTML and the results', async ({ page }) => {
  const posts = await webApp(page);
  await page.goto('./');
  await load(page, 'mock-ad.zip', mockAdZip());
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were', { timeout: 90_000 });

  await page.getByRole('button', { name: 'Report a bug' }).click();
  await expect(dialog(page)).toContainText('Include the ad: mock-ad.zip');
  await dialog(page).getByLabel('What went wrong?').fill('The headline moved after the fixes.\nIn the 300x250.');
  await dialog(page).getByLabel("Your email, if you'd like a reply").fill('reporter@example.com');
  await dialog(page).getByRole('button', { name: 'Send report' }).click();
  await expect(dialog(page)).toContainText('Thanks: your report was sent.');

  const bug = posts.find((p) => p.kind === 'bug')!;
  expect(bug).toMatchObject({
    description: 'The headline moved after the fixes.\nIn the 300x250.',
    email: 'reporter@example.com',
    file: { name: 'mock-ad.zip', type: 'application/zip' },
    fixed: { name: 'Responsive (after fixes).html', type: 'text/html' },
  });
  const html = await page.evaluate(() => (window as unknown as { gwdqa: { session: { html: string } } }).gwdqa.session.html);
  expect(strFromU8(new Uint8Array(decoded(bug.fixed!)))).toBe(html);
  expect(bug.about).toContain('Ad: mock-ad.zip, a zip');
  expect(bug.about).toMatch(/Checklist:\n {2}\w+ +Type size/);
  expect(bug.about).toContain('Fixes applied: yes');

  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toBeHidden();
});

test('a report that does not go through says so and keeps what was typed', async ({ page }) => {
  const posts = await webApp(page, () => ({ ok: false, error: 'Too many reports today. Try again tomorrow.' }));
  await page.goto('./');
  await page.getByRole('button', { name: 'Report a bug' }).click();
  await expect(dialog(page).getByRole('checkbox')).toBeHidden(); // no ad was picked

  await dialog(page).getByLabel('What went wrong?').fill('The page stays blank.');
  await dialog(page).getByRole('button', { name: 'Send report' }).click();
  await expect(dialog(page)).toContainText('The report was not sent. Too many reports today. Try again tomorrow.');
  await expect(dialog(page).getByLabel('What went wrong?')).toHaveValue('The page stays blank.');
  await expect(dialog(page).getByRole('button', { name: 'Send report' })).toBeEnabled();
  expect(posts[0]).toMatchObject({ kind: 'bug', file: null, fixed: null });
  expect(posts[0].about).toContain('Ad: none picked');
});

test('an error on the page offers a report, which carries the error and the file', async ({ page }) => {
  const posts = await webApp(page);
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Meeting notes') });
  await expect(page.locator('#status .banner.err')).toContainText('notes.txt is not a zip or an HTML file');

  await page.locator('#status').getByRole('button', { name: 'Report it' }).click();
  await dialog(page).getByLabel('What went wrong?').fill('My ad was refused.');
  await dialog(page).getByRole('button', { name: 'Send report' }).click();
  await expect(dialog(page)).toContainText('Thanks: your report was sent.');

  expect(posts.filter((p) => p.kind === 'upload').map((p) => p.name)).toEqual(['notes.txt']);
  const bug = posts.find((p) => p.kind === 'bug')!;
  expect(bug.file?.name).toBe('notes.txt');
  expect(decoded(bug.file!).toString()).toBe('Meeting notes');
  expect(bug.about).toMatch(/Errors:\n\d\d:\d\d:\d\d UTC notes\.txt is not a zip or an HTML file/);
  expect(bug.about).toContain('Status: notes.txt is not a zip or an HTML file.');
  expect(bug.about).not.toContain('Report it');
});
