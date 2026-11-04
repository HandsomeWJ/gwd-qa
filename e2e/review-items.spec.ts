// Items that only look as if they need a person: a top or left keyframes hold, which the keyframes fix
// deletes, so Position animation clears with it; and text below 8px only in a hidden start state,
// judged where the timeline shows it.
import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { MOCK_RUNTIME, mockAdHtml } from './mock-ad';

const CSS = `    .gwd-div-slide {
      position: absolute;
      left: 10px;
      top: 200px;
      width: 80px;
      height: 20px;
      background-color: rgb(0, 0, 200);
    }
    @keyframes kf-slide {
      0% {
        left: 10px;
        transform: translate3d(0px, 0px, 0px);
      }
      100% {
        left: 10px;
        transform: translate3d(20px, 0px, 0px);
      }
    }
    .gwd-play-animation .gwd-div-slide {
      animation: 0.5s linear 0s 1 normal forwards kf-slide;
    }
    .gwd-p-pop, .gwd-p-shy {
      position: absolute;
      left: 120px;
      margin: 0px;
      font-family: Arial;
      font-size: 8px;
      line-height: 10px;
      transform: scale3d(0.75, 0.75, 0.75);
      opacity: 0.01;
    }
    .gwd-p-pop {
      top: 200px;
    }
    .gwd-p-shy {
      top: 220px;
    }
    @keyframes kf-pop {
      0% {
        transform: scale3d(0.75, 0.75, 0.75);
        opacity: 0.01;
      }
      100% {
        transform: scale3d(1, 1, 1);
        opacity: 1;
      }
    }
    @keyframes kf-shy {
      0% {
        transform: scale3d(0.75, 0.75, 0.75);
        opacity: 0.01;
      }
      100% {
        transform: scale3d(0.9, 0.9, 0.9);
        opacity: 1;
      }
    }
    .gwd-play-animation .gwd-p-pop {
      animation: 0.4s linear 2s 1 normal forwards kf-pop;
    }
    .gwd-play-animation .gwd-p-shy {
      animation: 0.4s linear 2s 1 normal forwards kf-shy;
    }
`;

function reviewAd(): string {
  return mockAdHtml()
    .replace('["300x250", "300x250:320x480"]', '["300x250"]')
    .replace(/ {6}<gwd-page id="page2">[\s\S]*?<\/gwd-page>\n/, '')
    .replace('<script src="mock-gwd.js"></script>', '<script src="gwdmock_min.js"></script>')
    .replace('  </style>', `${CSS}  </style>`)
    .replace('<div id="SA_dot_1"></div>', '<div id="SA_dot_1"></div>\n        <div class="gwd-div-slide" id="SA_slide_1"></div>\n        <p class="gwd-p-pop" id="SA_pop_1">Learn more</p>\n        <p class="gwd-p-shy" id="SA_shy_1">Read on</p>');
}

async function load(page: Page, html: string) {
  await page.goto('./');
  const zip = Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/gwdmock_min.js': strToU8(MOCK_RUNTIME) }));
  await page.locator('#file').setInputFiles({ name: 'review.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);

test('offers a held top or left as fixed with the keyframes, and judges hidden text where it shows', async ({ page }) => {
  await load(page, reviewAd());
  // Position animation: the held left goes with the keyframes fix, so nothing is left to you.
  await expect(row(page, 'position').locator('summary .count')).toHaveText('1 item · auto-fix ready');
  await expect(page.locator('#fixes .manual')).not.toContainText('Keyframes move elements with top or left');
  await expect(page.locator('#fixes .fixlist li', { hasText: 'Delete keyframe properties that never change' }).locator('.detail')).toContainText('which also clears 1 Position animation item');
  // Type size: 6px while hidden, 8px once it pops in; the other settles at 7.20px.
  await row(page, 'type').evaluate((d) => { (d as HTMLDetailsElement).open = true; });
  await expect(row(page, 'type')).not.toContainText('SA_pop_1');
  await expect(row(page, 'type').locator('li', { hasText: 'p#SA_shy_1' })).toContainText('"Read on" renders at 7.20px when it shows.');
  await expect(row(page, 'type')).not.toContainText('hidden right now');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner.ok')).toContainText('exactly where they were', { timeout: 90_000 });
  await expect(row(page, 'position').locator('summary .pill')).toHaveText('Pass');
});
