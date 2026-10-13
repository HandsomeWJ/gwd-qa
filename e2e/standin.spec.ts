// The stand-in for GWD's runtime (public/gwd-standin.js) on the parts of GWD it replaces when they
// are missing: the groups runtime, the rich-text binder and the page deck.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type FileChooser, type Page, type TestInfo } from '@playwright/test';
import { GWD_RUNTIME, MOCK_RUNTIME, mockAdHtml } from './mock-ad';

const row = (page: Page, check: string) => page.locator(`#checklist details[data-check="${check}"]`);
const frame = (page: Page, label: string) => page.frameLocator(`#frames iframe[title="${label} ad"]`);

async function choose(page: Page, button: string, files: Parameters<FileChooser['setFiles']>[0]) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: button }).click()]);
  await chooser.setFiles(files);
}

/** Checks `files` as a dropped folder named Ad. */
async function checkFolder(page: Page, testInfo: TestInfo, files: Record<string, string>) {
  const root = join(testInfo.outputPath('folder'), 'Ad');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  await page.goto('./');
  await choose(page, 'Choose a folder', root);
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
}

// Groups as GWD writes them: definitions in a template, and an empty instance on page one. A Card
// holds a Badge, which holds 6px text and, by mistake, a Card again.
const GROUPS = `<template id="gwd-group-definitions">
    <div data-gwd-group-def="Card" data-gwd-group-class="gwd-grp-c" style="display: none;">
      <p data-gwd-grp-id="title" class="gwd-grp-c gwd-p-title">Card title</p>
      <div data-gwd-grp-id="badge" class="gwd-grp-c gwd-div-badge" data-gwd-group="Badge"></div>
    </div>
    <div data-gwd-group-def="Badge" data-gwd-group-class="gwd-grp-b" style="display: none;">
      <p data-gwd-grp-id="label" class="gwd-grp-b gwd-p-label">Drag me</p>
      <div data-gwd-grp-id="loop" class="gwd-grp-b" data-gwd-group="Card"></div>
    </div>
  </template>`;
const GROUP_CSS = `<style>
    .gwd-div-card { position: absolute; left: 150px; top: 120px; width: 120px; height: 60px; }
    .gwd-p-title { position: absolute; left: 0px; top: 0px; margin: 0px; font-family: Arial; font-size: 14px; }
    .gwd-div-badge { position: absolute; left: 0px; top: 30px; width: 60px; height: 20px; }
    .gwd-p-label { position: absolute; left: 0px; top: 0px; margin: 0px; font-family: Arial; font-size: 6px; }
  </style>`;

function groupedAd(runtime: string[]): string {
  return mockAdHtml('Headline', runtime)
    .replace('</head>', `  ${GROUP_CSS}\n</head>`)
    .replace('<body>', `<body>\n  ${GROUPS}`)
    .replace('<button class="gwd-button-b"', '<div id="SA_card_1" class="gwd-div-card" data-gwd-group="Card"></div>\n        <button class="gwd-button-b"');
}

async function expectGroupFilled(page: Page) {
  const card = frame(page, '300x250').locator('#SA_card_1');
  await expect(card.locator('.gwd-p-title')).toHaveText(['Card title']);
  // Filled once, however often the page is shown, and the Badge inside it too.
  await expect(card.locator('.gwd-p-label')).toHaveText(['Drag me']);
  await expect(card.locator('[data-gwd-group="Badge"] [data-gwd-group="Card"]')).toBeEmpty();
  await expect(row(page, 'type').locator('li', { hasText: '"Drag me" renders at 6.00px' })).toHaveCount(1);
}

test('fills GWD groups from their definitions in an ad checked from just its HTML', async ({ page }) => {
  await page.goto('./');
  const html = groupedAd([...GWD_RUNTIME, 'groups_runtime.min.1.0.js']);
  await page.locator('#file').setInputFiles({ name: 'Responsive.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
  await expectGroupFilled(page);
});

test('stands in for a missing groups runtime in a folder that has the rest', async ({ page }, testInfo) => {
  await checkFolder(page, testInfo, { 'Responsive.html': groupedAd(['mock-gwd.js', 'groups_runtime.min.1.0.js']), 'mock-gwd.js': MOCK_RUNTIME });
  await expect(page.locator('#summary .banner.standin')).toContainText('Not included: groups_runtime.min.1.0.js.');
  await expectGroupFilled(page);
});

// Like GWD's responsive helper: each size's text goes through gwd.binders.html, from
// gwd-dynamic-binders.js, and is shown as plain text when that is missing.
const HELPER = `
customElements.define('gwd-responsive-attributes-helper', class extends HTMLElement {});
document.addEventListener('DOMContentLoaded', () => {
  for (const el of document.querySelectorAll('[data-gwd-media-override]')) {
    for (const [size, values] of Object.entries(JSON.parse(el.getAttribute('data-gwd-media-override')))) {
      const [w, h] = size.split('x');
      if (!values['data-gwd-text'] || !matchMedia('(width: ' + w + 'px) and (height: ' + h + 'px)').matches) continue;
      const content = JSON.parse(values['data-gwd-text']).content;
      if (typeof window.gwd?.binders?.html === 'function') gwd.binders.html(el, content);
      else el.textContent = content;
    }
  }
});
`;
const OVERRIDE = JSON.stringify({
  '300x250': { 'data-gwd-text': JSON.stringify({ content: 'Exact <span class="gwd-span-x">size</span>', isPlainText: false }) },
}).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

test('gives GWD\'s responsive helper the rich-text binder when gwd-dynamic-binders.js is missing', async ({ page }, testInfo) => {
  const html = mockAdHtml('Headline', ['mock-gwd.js', 'mock-helper.js', 'gwd-dynamic-binders.js'])
    .replace('id="SA_headline_1"', `id="SA_headline_1" data-gwd-media-override="${OVERRIDE}"`);
  await checkFolder(page, testInfo, { 'Responsive.html': html, 'mock-gwd.js': MOCK_RUNTIME, 'mock-helper.js': HELPER });
  await expect(page.locator('#summary .banner.standin')).toContainText('Not included: gwd-dynamic-binders.js.');
  const headline = frame(page, '300x250').locator('#SA_headline_1');
  await expect(headline).toHaveText('Exact size');
  await expect(headline.locator('span.gwd-span-x')).toHaveText('size');
});

// Like GWD's own gwd-page holding something that loads, such as an image effect: hidden until its
// deck loads it once it is attached, and shown by gwdPresent.
const PAGE = `
customElements.define('gwd-page', class extends HTMLElement {
  connectedCallback() {
    this.style.visibility = 'hidden';
    setTimeout(() => {
      if (this.loaded) this.style.visibility = '';
      this.dispatchEvent(new CustomEvent('attached', { bubbles: true }));
    }, 1);
  }
  gwdIsLoaded() { return !!this.loaded; }
  gwdLoad() {
    setTimeout(() => {
      this.loaded = true;
      this.style.visibility = '';
      this.dispatchEvent(new CustomEvent('pageload', { bubbles: true }));
    }, 50);
  }
  gwdActivate() { this.dispatchEvent(new CustomEvent('pageactivated', { bubbles: true })); }
  gwdPresent() {
    this.dispatchEvent(new CustomEvent('pagepresenting', { bubbles: true }));
    this.classList.add('gwd-play-animation');
  }
});
`;

test('loads GWD\'s own pages when only the page deck is missing', async ({ page }, testInfo) => {
  await checkFolder(page, testInfo, { 'Responsive.html': mockAdHtml('Headline', ['mock-page.js', 'gwdpagedeck_min.js']), 'mock-page.js': PAGE });
  await expect(page.locator('#summary .banner.standin')).toContainText('Not included: gwdpagedeck_min.js.');
  await expect(frame(page, '300x250').locator('#page1')).toHaveCSS('visibility', 'visible');
  await expect(frame(page, '300x250').locator('#page1')).toHaveClass(/gwd-play-animation/);
  // The 6px note on page two is checked as shown, not as hidden.
  await expect(row(page, 'type').locator('li', { hasText: 'p#SA_note_1' })).toHaveCount(1);
  await expect(row(page, 'type')).not.toContainText('hidden right now');
});
