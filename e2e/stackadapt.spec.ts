// StackAdapt's click scripts: a missing one goes back where StackAdapt's templates load it, and
// applying it moves no text. param.js is added only where it opens the page from tap areas alone.
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { mockAdHtml, mockZip } from './mock-ad';

const IFRAME_CT = '  <script type="text/javascript" src="https://creative.stackadapt.com/js/iframe-ct.js"></script>\n';
const PARAM = '  <script type="text/javascript" src="https://creative.stackadapt.com/js/param.js"></script>\n';
const row = (page: Page) => page.locator('#checklist details[data-check="stackAdapt"]');

async function load(page: Page, html: string) {
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name: 'sa.zip', mimeType: 'application/zip', buffer: mockZip(html) });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 120_000 });
}

test('puts both scripts back where the templates load them, moving no text', async ({ page }) => {
  // The button is the ad's tap area.
  const html = mockAdHtml().replace(IFRAME_CT, '').replace(PARAM, '').replace('class="gwd-button-b" id="SA_cta_1"', 'class="gwd-button-b dynamicClick" id="SA_cta_1"');
  await load(page, html);
  await expect(row(page).locator('summary .pill')).toHaveText('Fail');
  await expect(row(page).locator('summary .count')).toHaveText('2 items · auto-fix ready');
  const fixes = page.locator('#fixes .fixlist li', { hasText: 'Load StackAdapt' });
  await expect(fixes.locator('strong')).toHaveText(["Load StackAdapt's iframe-ct.js", "Load StackAdapt's param.js"]);
  await expect(fixes.locator('input[type="checkbox"]')).toHaveCount(2);
  for (const box of await fixes.locator('input[type="checkbox"]').all()) await expect(box).toBeChecked();

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toHaveText(/^Applied \d+ fixes\. All \d+ texts are exactly where they were, and every line spacing is unchanged, in every size and on every page\.$/, { timeout: 120_000 });
  await expect(row(page).locator('summary .pill')).toHaveText('Pass');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  expect(fixed.split('creative.stackadapt.com/js/iframe-ct.js')).toHaveLength(2);
  expect(fixed.split('creative.stackadapt.com/js/param.js')).toHaveLength(2);
  // Before the head's first script, as the templates have it before their first style.
  expect(fixed).toContain(`  <meta name="environment" content="gwd-genericad">\n${IFRAME_CT}  <script>\n`);
  expect(fixed).toContain(`  </script>\n${PARAM}</body>`);
});

test('leaves param.js to you where no element is a tap area', async ({ page }) => {
  await load(page, mockAdHtml().replace(PARAM, ''));
  await expect(row(page).locator('summary .pill')).toHaveText('Fail');
  await expect(page.locator('#fixes .fixlist li', { hasText: 'Load StackAdapt' })).toHaveCount(0);
  const group = page.locator('#fixes .manual > li').filter({ has: page.locator('h4', { hasText: 'StackAdapt scripts' }) });
  await expect(group.locator('ul li .target')).toHaveText('param.js');
  await expect(group.locator('ul li')).toContainText('no element has the class dynamicClick, so it would make every part of the ad open the landing page');
});
