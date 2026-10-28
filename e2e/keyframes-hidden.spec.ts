// Keyframes that hold values differing from the element's own style, on an element that never shows:
// deleting them changes nothing anyone sees, unless something in the ad could show the element.
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { mockAdHtml, mockZip } from './mock-ad';

const GHOST_CSS = `    .gwd-div-ghost {
      position: absolute;
      left: 10px;
      top: 200px;
      width: 100px;
      height: 20px;
      visibility: hidden;
    }
    .gwd-p-ghost {
      position: absolute;
      margin: 0px;
      font-family: Arial;
      font-size: 12px;
    }
    @keyframes kf-ghost {
      0% {
        left: 40px;
        width: 150px;
        opacity: 0.001;
      }
      100% {
        left: 40px;
        width: 150px;
        opacity: 1;
      }
    }
    .gwd-play-animation .gwd-div-ghost {
      animation: 0.5s linear 0s 1 normal forwards kf-ghost;
    }
`;

/** The mock ad with a hidden group that runs kf-ghost; `css`, `handler` and `inner` add what may show it. */
function ghostAd(more: { css?: string; handler?: string; inner?: string } = {}): string {
  let html = mockAdHtml()
    .replace('  </style>', `${GHOST_CSS}${more.css ?? ''}  </style>`)
    .replace('<button class="gwd-button-b"', `<div class="gwd-div-ghost" id="SA_ghost_1"><p class="gwd-p-ghost" id="SA_ghost_2"${more.inner ?? ''}>Ghost</p></div>\n        <button class="gwd-button-b"`);
  if (more.handler) html = html.replace('    gwd.framechange_savings = function(event) {', `    gwd.auto_click = function(event) {\n      ${more.handler}\n    };\n    gwd.framechange_savings = function(event) {`);
  return html;
}

async function load(page: Page, html: string) {
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name: 'ghost.zip', mimeType: 'application/zip', buffer: mockZip(html) });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

const keyframesFix = (page: Page) => page.locator('#fixes .fixlist li', { hasText: 'Delete keyframe properties that never change' });

test('deletes keyframe values on an element that never shows, without changing anything', async ({ page }) => {
  await load(page, ghostAd());
  await expect(keyframesFix(page).locator('.detail')).toHaveText('6 declarations in 2 keyframes blocks, 1 of them on elements that never show');
  await expect(page.locator('#fixes .manual')).not.toContainText('kf-ghost');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  // The hidden group's own text moves with it, where nobody sees it; every other text stays put.
  await expect(page.locator('#fixes .banner.ok')).toContainText('exactly where they were', { timeout: 90_000 });
  await expect(page.locator('#fixes .banner.ok')).toContainText('3 texts inside elements that never show moved with them, where nobody sees them.');
  await expect(page.locator('#checklist details[data-check="keyframes"] summary .pill')).toHaveText('Pass');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  expect(/@keyframes kf-ghost \{[^@]*?\n    \}\n/.exec(fixed)?.[0]).toBe('@keyframes kf-ghost {\n      0% {\n        opacity: 0.001;\n      }\n      100% {\n        opacity: 1;\n      }\n    }\n');
});

test('leaves them to you where the ad could show the element, or it could push what shows', async ({ page }) => {
  const note = "kf-ghost: deleting left, width would change how it looks, because those values differ from the element's own style.";
  const cases: [string, string][] = [
    ['a GWD event shows it', ghostAd({ handler: "gwd.actions.events.setInlineStyle('SA_ghost_1', 'visibility: visible;');" })],
    ['a hover rule shows it', ghostAd({ css: '    .gwd-div-ghost:hover {\n      visibility: visible;\n    }\n' })],
    ['text in it is visible', ghostAd({ inner: ' style="visibility: visible;"' })],
    ['it sits in the flow', ghostAd().replace('    .gwd-div-ghost {\n      position: absolute;', '    .gwd-div-ghost {\n      position: relative;')],
  ];
  for (const [why, html] of cases) {
    await load(page, html);
    await expect(page.locator('#fixes .manual'), why).toContainText(note);
    await expect(keyframesFix(page).locator('.detail'), why).toHaveText('2 declarations in 1 keyframes blocks');
  }
});
