// The line-height fix and the hover, focus and click states the previews never show: a fixed px does
// not grow with a font a hover or a click enlarges, as 'normal' did.
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { mockAdHtml, mockZip } from './mock-ad';

const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);
const lineHeightFix = (page: Page) => page.locator('#fixes .fixlist li', { hasText: 'Declare line-height' });
const detail = (page: Page) => lineHeightFix(page).locator('.detail').first();

async function load(page: Page, name: string, html: string) {
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name, mimeType: 'application/zip', buffer: mockZip(html) });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

const withCss = (css: string) => mockAdHtml().replace('  </style>', `    ${css}\n  </style>`);
const withHandler = (code: string, css = '') => mockAdHtml()
  .replace('  </style>', `    ${css}\n  </style>`)
  .replace('    gwd.framechange_savings = function(event) {', `    gwd.auto_click = function(event) {\n      ${code}\n    };\n    gwd.framechange_savings = function(event) {`);

test('leaves to you a class whose font a hover rule enlarges, and keeps the rest', async ({ page }) => {
  await load(page, 'hover.zip', withCss('.gwd-button-b:hover {\n      font-size: 24px;\n    }'));
  await expect(page.locator('#fixes .manual')).toContainText(/\.gwd-button-b: its line-height would change the spacing at \d+x\d+ in its hover, focus or click state \(\.gwd-button-b:hover\); set it in GWD\./);
  await expect(detail(page)).not.toContainText('.gwd-button-b');
  await expect(detail(page)).toContainText('.gwd-p-a');
  await expect(page.locator('#fixes .sub')).toContainText('at rest and in its hover, focus or click state (.gwd-button-b:hover)');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner.ok')).toContainText('exactly where they were', { timeout: 90_000 });
  // The button keeps 'normal', so the hover still spaces its 24px text as it did.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  expect(fixed).not.toMatch(/\.gwd-button-b \{[^}]*line-height/);
});

test('keeps a class whose hover changes only how it looks', async ({ page }) => {
  await load(page, 'color.zip', withCss('.gwd-button-b:hover {\n      color: rgb(255, 0, 0);\n    }'));
  await expect(detail(page)).toContainText('.gwd-button-b');
  await expect(page.locator('#fixes .sub')).not.toContainText('hover, focus or click state');
});

test('leaves to you a class whose font a click enlarges through GWD\'s setInlineStyle', async ({ page }) => {
  await load(page, 'click.zip', withHandler("gwd.actions.events.setInlineStyle('SA_headline_1', 'font-size: 30px;');"));
  await expect(page.locator('#fixes .manual')).toContainText(/\.gwd-p-a: its line-height would change the spacing at \d+x\d+ in its hover, focus or click state \(setInlineStyle on SA_headline_1 in gwd\.auto_click\); set it in GWD\./);
  await expect(detail(page)).not.toContainText(/\.gwd-p-a[: ]/);
  await expect(detail(page)).toContainText('.gwd-p-f');
});

test('leaves to you a class whose font a class a click puts on enlarges', async ({ page }) => {
  await load(page, 'class.zip', withHandler("document.getElementById('SA_body_1').classList.add('gwd-big');", '.gwd-big {\n      font-size: 30px;\n    }'));
  await expect(page.locator('#fixes .manual')).toContainText(/\.gwd-p-f: its line-height would change the spacing at \d+x\d+ in its hover, focus or click state \(classList\.add on SA_body_1 in gwd\.auto_click\)/);
  await expect(detail(page)).toContainText('.gwd-p-a');
});

test('leaves to you a class whose font changes in an animation a click starts', async ({ page }) => {
  await load(page, 'anim.zip', withHandler(
    "document.getElementById('SA_headline_1').classList.add('gwd-grow');",
    '@keyframes grow {\n      0% {\n        font-size: 16px;\n      }\n      100% {\n        font-size: 30px;\n      }\n    }\n    .gwd-grow {\n      animation: 1s linear 0s 1 normal forwards grow;\n    }',
  ));
  await expect(page.locator('#fixes .manual')).toContainText('.gwd-p-a: an animation changes its font while the ad runs');
  await expect(detail(page)).toContainText('.gwd-p-f');
});

test('offers no line-height ticked where a script changes a font on an element it does not name', async ({ page }) => {
  await load(page, 'unnamed.zip', withHandler("event.target.style.fontSize = '30px';"));
  await expect(lineHeightFix(page)).toContainText('A script changes a font or line-height on an element this check cannot find (style.fontSize on event.target in gwd.auto_click sets font-size)');
  await expect(lineHeightFix(page).locator('input[type="checkbox"]')).not.toBeChecked();
});

test('measures text at rest while the pointer moves over a preview', async ({ page }) => {
  // 6px type a hover enlarges to 12px: measured while hovered, it would pass the 8px rule.
  const html = mockAdHtml()
    .replace('  </style>', '    .gwd-p-tiny {\n      position: absolute;\n      left: 150px;\n      top: 100px;\n      width: 100px;\n      height: 60px;\n      margin: 0px;\n      font-family: Arial;\n      font-size: 6px;\n    }\n    .gwd-p-tiny:hover {\n      font-size: 12px;\n    }\n  </style>')
    .replace('<button class="gwd-button-b"', '<p class="gwd-p-tiny" id="SA_tiny_1">Tiny type here</p>\n        <button class="gwd-button-b"');
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name: 'pointer.zip', mimeType: 'application/zip', buffer: mockZip(html) });
  const frame = page.frameLocator('#frames iframe[title="300x250 ad"]');
  const tiny = frame.locator('#SA_tiny_1');
  const iframe = page.locator('#frames iframe[title="300x250 ad"]');
  await iframe.scrollIntoViewIfNeeded({ timeout: 60_000 });
  const box = (await iframe.boundingBox())!;
  // Someone moving the pointer over the text while the checks run: each newly loaded preview is hovered again.
  let done = false;
  const moving = (async () => {
    for (let i = 0; !done; i++) {
      await page.mouse.move(box.x + 160 + (i % 2), box.y + 104);
      await page.waitForTimeout(20);
    }
  })();
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
  done = true;
  await moving;

  const type = row(page, 'type');
  await type.locator('summary').click();
  // Hovered, the 300x250 preview would have measured 12px and left that size out of the failing ones.
  await expect(type.locator('li', { hasText: 'p#SA_tiny_1' })).toContainText(/p#SA_tiny_1 on page1 300x250, .*renders at 6\.00px/);
  // Once the checks are done, the pointer on it hovers it again.
  await iframe.scrollIntoViewIfNeeded();
  const now = (await iframe.boundingBox())!;
  await page.mouse.move(now.x + 160, now.y + 104);
  await expect.poll(() => tiny.evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px');
});
