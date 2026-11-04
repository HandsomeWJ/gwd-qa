// Keyframes values are deleted only where the ad looks the same without them: a value the first and last
// keyframes share, left out by a keyframe between them, equal to the element's own; one apart from the
// element's own only by rounding; a button's background that StackAdapt's param.js could set. Values that
// look different from the element's own stay notes, wherever the element sits, and on an element with two
// animations as well as on one.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_RUNTIME, mockAdHtml } from './mock-ad';

const CSS = `    .gwd-div-photo {
      position: absolute;
      left: 0px;
      top: 0px;
      width: 300px;
      height: 100px;
      background-color: rgb(120, 160, 220);
    }
    @keyframes kf-photo {
      0% {
        height: 120px;
        transform: translate3d(0px, 0px, 0px);
      }
      100% {
        height: 120px;
        transform: translate3d(0px, 4px, 0px);
      }
    }
    .gwd-play-animation .gwd-div-photo {
      animation: 0.5s linear 0s 1 normal forwards kf-photo;
    }
    .gwd-div-veil {
      position: absolute;
      left: 0px;
      top: 0px;
      width: 300px;
      height: 40px;
      background-color: rgba(0, 0, 0, 0.2);
    }
    @keyframes kf-veil {
      0% {
        opacity: 0.5;
        transform: translate3d(0px, 0px, 0px);
      }
      100% {
        opacity: 0.5;
        transform: translate3d(2px, 0px, 0px);
      }
    }
    .gwd-play-animation .gwd-div-veil {
      animation: 0.5s linear 0s 1 normal forwards kf-veil;
    }
    .gwd-div-band {
      position: absolute;
      left: 0px;
      top: 220px;
      width: 300px;
      height: 20px;
      background-color: rgb(0, 120, 0);
    }
    @keyframes kf-band {
      0% {
        width: 300px;
        transform: translate3d(0px, 0px, 0px);
      }
      50% {
        transform: translate3d(5px, 0px, 0px);
      }
      100% {
        width: 300px;
        transform: translate3d(0px, 0px, 0px);
      }
    }
    .gwd-play-animation .gwd-div-band {
      animation: 0.5s linear 0s 1 normal forwards kf-band;
    }
    .gwd-div-round {
      position: absolute;
      left: 0px;
      top: 190px;
      width: 300px;
      height: 51.3482px;
      background-color: rgb(200, 0, 0);
    }
    @keyframes kf-round {
      0% {
        height: 51.36px;
        transform: translate3d(0px, 0px, 0px);
      }
      100% {
        height: 51.36px;
        transform: translate3d(3px, 0px, 0px);
      }
    }
    .gwd-play-animation .gwd-div-round {
      animation: 0.5s linear 0s 1 normal forwards kf-round;
    }
    .gwd-div-twin {
      position: absolute;
      left: 0px;
      top: 150px;
      width: 300px;
      height: 20px;
      background-color: rgb(0, 0, 200);
    }
    @keyframes kf-twin-a {
      0% {
        width: 300px;
        transform: translate3d(0px, 0px, 0px);
      }
      100% {
        width: 300px;
        transform: translate3d(2px, 0px, 0px);
      }
    }
    @keyframes kf-twin-b {
      0% {
        height: 30px;
        opacity: 0.9;
      }
      100% {
        height: 30px;
        opacity: 1;
      }
    }
    .gwd-play-animation .gwd-div-twin {
      animation: 0.5s linear 0s 1 normal forwards kf-twin-a, 0.5s linear 0s 1 normal forwards kf-twin-b;
    }
    .gwd-button-b {
      background-color: rgb(255, 200, 0);
    }
    @keyframes kf-cta {
      0% {
        background-color: rgb(255, 200, 0);
        transform: scale3d(1, 1, 1);
      }
      100% {
        background-color: rgb(255, 200, 0);
        transform: scale3d(1.05, 1.05, 1);
      }
    }
    .gwd-play-animation .gwd-button-b {
      animation: 0.5s linear 0s 1 normal forwards kf-cta;
    }
`;

/** The mock ad on one page in one size, with the photo under its texts and the veil over them. */
function looksAd(): string {
  return mockAdHtml()
    .replace('["300x250", "300x250:320x480"]', '["300x250"]')
    .replace(/ {6}<gwd-page id="page2">[\s\S]*?<\/gwd-page>\n/, '')
    .replace('<script src="mock-gwd.js"></script>', '<script src="gwdmock_min.js"></script>')
    .replace('  </style>', `${CSS}  </style>`)
    .replace('<p class="gwd-p-a" id="SA_headline_1">', '<div class="gwd-div-photo" id="SA_photo_1"></div>\n        <p class="gwd-p-a" id="SA_headline_1">')
    .replace('<div id="SA_dot_1"></div>', '<div id="SA_dot_1"></div>\n        <div class="gwd-div-veil" id="SA_veil_1"></div>\n        <div class="gwd-div-band" id="SA_band_1"></div>\n        <div class="gwd-div-round" id="SA_round_1"></div>\n        <div class="gwd-div-twin" id="SA_twin_1"></div>');
}

async function load(page: Page, html: string) {
  await page.goto('./');
  const zip = Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/gwdmock_min.js': strToU8(MOCK_RUNTIME) }));
  await page.locator('#file').setInputFiles({ name: 'looks.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

const keyframesFix = (page: Page) => page.locator('#fixes .fixlist li', { hasText: 'Delete keyframe properties that never change' });
const block = (html: string, name: string) => new RegExp(`@keyframes ${name} \\{[^@]*?\\n {4}\\}\\n`).exec(html)?.[0] ?? '';

test('deletes keyframe values only where the ad looks the same without them', async ({ page }) => {
  await load(page, looksAd());
  // kf-in (the mock's own), kf-band, kf-cta, kf-round and kf-twin-a
  await expect(keyframesFix(page).locator('.detail')).toHaveText('10 declarations in 5 keyframes blocks');
  for (const [name, prop] of [['kf-photo', 'height'], ['kf-veil', 'opacity'], ['kf-twin-b', 'height']]) {
    await expect(page.locator('#fixes .manual')).toContainText(`${name}: deleting ${prop} would change how it looks, because those values differ from the element's own style.`);
  }
  for (const name of ['kf-band', 'kf-cta', 'kf-round', 'kf-twin-a']) await expect(page.locator('#fixes .manual')).not.toContainText(`${name}:`);

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner.ok')).toContainText('exactly where they were', { timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  expect(block(fixed, 'kf-band')).toBe('@keyframes kf-band {\n      0% {\n        transform: translate3d(0px, 0px, 0px);\n      }\n      50% {\n        transform: translate3d(5px, 0px, 0px);\n      }\n      100% {\n        transform: translate3d(0px, 0px, 0px);\n      }\n    }\n');
  expect(block(fixed, 'kf-cta')).not.toContain('background-color');
  expect(block(fixed, 'kf-round')).not.toContain('height');
  expect(block(fixed, 'kf-twin-a')).not.toContain('width');
  expect(block(fixed, 'kf-photo')).toContain('height: 120px;');
  expect(block(fixed, 'kf-veil')).toContain('opacity: 0.5;');
  expect(block(fixed, 'kf-twin-b')).toContain('height: 30px;');
});
