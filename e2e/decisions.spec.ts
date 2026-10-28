// "Needs your decision": what is left to the designer, grouped under its checklist item in the
// checklist's order, with the element as code and what to do in GWD on a line of its own.
import { expect, test } from '@playwright/test';
import { mockAdHtml, mockZip } from './mock-ad';

test('groups what is left to you by checklist item, and opens that item', async ({ page }) => {
  const html = mockAdHtml()
    .replace('      width: 120px;\n      height: 30px;\n    }', '      width: 120px;\n      height: 30px;\n      padding: 0px;\n    }')
    .replace('    @media (width: 300px) and (height: 250px) {\n', '    @media (width: 300px) and (height: 250px) {\n      .gwd-button-b {\n        padding-top: 2px;\n      }\n')
    .replace('    .gwd-play-animation .gwd-p-a {', '    @keyframes kf-move {\n      0% {\n        top: 10px;\n      }\n      100% {\n        top: 20px;\n      }\n    }\n    .gwd-play-animation .gwd-p-c {\n      animation: 1s linear 0s 1 normal forwards kf-move;\n    }\n    .gwd-play-animation .gwd-p-a {');
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name: 'decide.zip', mimeType: 'application/zip', buffer: mockZip(html) });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 120_000 });

  const groups = page.locator('#fixes .manual > li');
  await expect(groups.locator('h4 button')).toHaveText(['Type size', 'Button padding', 'Position animation']);
  const padding = groups.filter({ has: page.locator('h4', { hasText: 'Button padding' }) });
  await expect(padding.locator('h4 .count')).toHaveText('1 item');
  await expect(padding.locator('ul li .target')).toHaveText('.gwd-button-b');
  // What to do sits on its own line, capitalised (the full stop before it is drawn by CSS); the
  // note's text is kept as written. The exact 300x250 block also wins at the range's 300x250 end.
  await expect(padding.locator('ul li .todo')).toHaveText('change it in GWD.');
  const note = '.gwd-button-b has padding 2px 0px 0px in 300x250, 300x250 (range 300x250 to 320x480), which cannot be zeroed without moving its text';
  expect(await padding.locator('ul li').innerText()).toBe(`${note}\nChange it in GWD.`);
  await expect(page.locator('#fixes .manual')).toContainText(`${note}; change it in GWD.`);

  const row = page.locator('#checklist details[data-check="buttonPadding"]');
  await expect(row).not.toHaveAttribute('open', '');
  await padding.getByRole('button', { name: 'Button padding' }).click();
  await expect(row).toHaveAttribute('open', '');
  await expect(row).toBeInViewport();
});
