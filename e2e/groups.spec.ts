// Text in GWD groups: GWD keeps a group's elements in a <template> and styles them through
// '[data-gwd-group="Name"] .<group class>.<own class>'. Here the stand-in fills the groups, as the
// ad loads groups_runtime*.js without including it.
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { mockAdHtml, mockZip } from './mock-ad';

const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);

const PERKS = `<template id="gwd-group-definitions">
    <div data-gwd-group-def="Perks" data-gwd-group-class="gwd-grp-k" style="display: none;"><span class="gwd-span-perk gwd-grp-k" data-gwd-grp-id="perk">Ships in a day</span></div>
  </template>`;
const PERKS_CSS = `<style>
    .gwd-div-perks { position: absolute; left: 10px; top: 150px; width: 200px; height: 30px; opacity: 0; }
    [data-gwd-group="Perks"] .gwd-grp-k.gwd-span-perk { position: absolute; left: 0px; top: 0px; font-family: Arial; font-size: 12px; line-height: 14px; opacity: 0; }
  </style>`;

test("fixes the text in a GWD group through the group's own rules, without moving it", async ({ page }) => {
  const html = mockAdHtml('Headline', ['mock-gwd.js', 'groups_runtime.min.1.0.js'])
    .replace('</head>', `  ${PERKS_CSS}\n</head>`)
    .replace('<body>', `<body>\n  ${PERKS}`)
    .replace('<button class="gwd-button-b"', '<div id="SA_perks_1" class="gwd-div-perks" data-gwd-group="Perks"></div>\n        <button class="gwd-button-b"');
  await page.goto('./');
  await page.locator('#file').setInputFiles({ name: 'perks.zip', mimeType: 'application/zip', buffer: mockZip(html) });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });

  const margin = row(page, 'marginBlock');
  await margin.locator('summary').click();
  await expect(margin).toContainText('span.gwd-span-perk.gwd-grp-k');
  const fade = row(page, 'textFade');
  await fade.locator('summary').click();
  // The group's text, and the group it is copied into, start at opacity 0.
  await expect(fade).toContainText('div#SA_perks_1: .gwd-div-perks starts it at opacity 0.');
  await expect(fade).toContainText('span.gwd-span-perk.gwd-grp-k: [data-gwd-group="Perks"] .gwd-grp-k.gwd-span-perk starts it at opacity 0.');
  await expect(page.locator('#fixes .fixlist li', { hasText: 'Add margin-block: 0px auto' })).toContainText('.gwd-span-perk');
  await expect(page.locator('#fixes .manual')).not.toContainText('gwd-span-perk');
  await expect(page.locator('#copy')).toContainText('Ships in a day');

  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toContainText('exactly where they were', { timeout: 90_000 });
  await expect(page.locator('#fixes .banner.ok')).toBeVisible();
  await expect(margin.locator('summary .pill')).toHaveText('Pass');
  await expect(fade.locator('summary .pill')).toHaveText('Pass');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`).exec(fixed)?.[0] ?? '';
  expect(rule('[data-gwd-group="Perks"] .gwd-grp-k.gwd-span-perk')).toMatch(/opacity: 0\.001;[\s\S]*margin-block: 0px auto;/);
  expect(rule('.gwd-div-perks')).toContain('opacity: 0.001;');
});
