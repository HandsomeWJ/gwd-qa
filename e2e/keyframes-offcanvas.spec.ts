// Keyframes that hold values differing from the element's own style, on an element measured wholly
// outside the ad with either value: deleting them changes nothing anyone sees, unless something in the
// ad could bring the element in.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_RUNTIME, mockAdHtml } from './mock-ad';

// Below the 250px-tall ad with its own style, above it with the value its animation holds. The page
// clips to the ad, as GWD's does.
const OFF_CSS = `    #page1 {
      position: absolute;
      width: 300px;
      height: 250px;
      overflow: hidden;
    }
    .gwd-div-off {
      position: absolute;
      left: 10px;
      top: 300px;
      width: 100px;
      height: 20px;
    }
    .gwd-p-off {
      position: absolute;
      margin: 0px;
      font-family: Arial;
      font-size: 12px;
      line-height: 14px;
    }
    @keyframes kf-off {
      0% {
        transform: translate3d(0px, -400px, 0px);
        opacity: 0.001;
      }
      100% {
        transform: translate3d(0px, -400px, 0px);
        opacity: 1;
      }
    }
    .gwd-play-animation .gwd-div-off {
      animation: 0.5s linear 0s 1 normal forwards kf-off;
    }
`;

/**
 * The mock ad on one page in one size, with the element outside it; `css` and `handler` add what may
 * bring it in. Its runtime is named as GWD's are, so its own class changes count as GWD's.
 */
function offAd(more: { css?: string; handler?: string } = {}): string {
  let html = mockAdHtml()
    .replace('["300x250", "300x250:320x480"]', '["300x250"]')
    .replace(/ {6}<gwd-page id="page2">[\s\S]*?<\/gwd-page>\n/, '')
    .replace('<script src="mock-gwd.js"></script>', '<script src="gwdmock_min.js"></script>')
    .replace('  </style>', `${OFF_CSS}${more.css ?? ''}  </style>`)
    .replace('<button class="gwd-button-b"', '<div class="gwd-div-off" id="SA_off_1"><p class="gwd-p-off" id="SA_off_2">Off</p></div>\n        <button class="gwd-button-b"');
  if (more.handler) html = html.replace('    gwd.framechange_savings = function(event) {', `    gwd.auto_click = function(event) {\n      ${more.handler}\n    };\n    gwd.framechange_savings = function(event) {`);
  return html;
}

async function load(page: Page, html: string) {
  await page.goto('./');
  const zip = Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/gwdmock_min.js': strToU8(MOCK_RUNTIME) }));
  await page.locator('#file').setInputFiles({ name: 'off.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

const keyframesFix = (page: Page) => page.locator('#fixes .fixlist li', { hasText: 'Delete keyframe properties that never change' });
const note = "kf-off: deleting transform would change how it looks, because those values differ from the element's own style.";

test('deletes keyframe values on an element measured outside the ad, without changing anything', async ({ page }) => {
  await load(page, offAd());
  await expect(keyframesFix(page).locator('.detail')).toHaveText('4 declarations in 2 keyframes blocks, 1 of them on elements that never show');
  await expect(page.locator('#fixes .manual li', { hasText: 'kf-off' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  // Its own text moves with it, from above the ad to below it, where nobody sees it.
  await expect(page.locator('#fixes .banner.ok')).toContainText('exactly where they were', { timeout: 90_000 });
  await expect(page.locator('#fixes .banner.ok')).toContainText('One text inside elements that never show moved with its element, where nobody sees it.');
  await expect(page.locator('#checklist details[data-check="keyframes"] summary .pill')).toHaveText('Pass');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  expect(/@keyframes kf-off \{[^@]*?\n {4}\}\n/.exec(fixed)?.[0]).toBe('@keyframes kf-off {\n      0% {\n        opacity: 0.001;\n      }\n      100% {\n        opacity: 1;\n      }\n    }\n');
});

test('leaves them to you where the element would show, or something could bring it in', async ({ page }) => {
  const cases: [string, string][] = [
    ['its own position is on the ad', offAd().replace('      top: 300px;', '      top: 100px;')],
    ['the page does not clip it', offAd().replace('      overflow: hidden;\n', '')],
    ['a shadow paints beyond its box', offAd({ css: '    .gwd-div-off {\n      box-shadow: 0px -200px 10px red;\n    }\n' })],
    ['a hover rule moves it', offAd({ css: '    .gwd-div-off:hover {\n      top: 10px;\n    }\n' })],
    ['a GWD event moves it', offAd({ handler: "gwd.actions.events.setInlineStyle('SA_off_1', 'top: 10px;');" })],
  ];
  for (const [why, html] of cases) {
    await load(page, html);
    await expect(page.locator('#fixes .manual'), why).toContainText(note);
  }
});
