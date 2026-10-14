// The stand-in for GWD's runtime (public/gwd-standin.js) on the parts of GWD it replaces when they
// are missing: the groups runtime, the overrides helper, the rich-text binder, the page deck and the
// web components file, beside the GWD files that are there.
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

// Groups as GWD writes them: definitions in a template, an empty instance on page one, and an instance,
// with 6px text, of a group that has no definition. A Card holds a Tag, with 7px text, and a Badge,
// which holds 6px text and, by mistake, a Card again.
const GROUPS = `<template id="gwd-group-definitions">
    <div data-gwd-group-def="Card" data-gwd-group-class="gwd-grp-c" style="display: none;">
      <p data-gwd-grp-id="title" class="gwd-grp-c gwd-p-title">Card title</p>
      <div data-gwd-grp-id="badge" class="gwd-grp-c gwd-div-badge" data-gwd-group="Badge"></div>
      <div data-gwd-grp-id="tag" class="gwd-grp-c gwd-div-tag" data-gwd-group="Tag"></div>
    </div>
    <div data-gwd-group-def="Badge" data-gwd-group-class="gwd-grp-b" style="display: none;">
      <p data-gwd-grp-id="label" class="gwd-grp-b gwd-p-label">Drag me</p>
      <div data-gwd-grp-id="loop" class="gwd-grp-b" data-gwd-group="Card"></div>
    </div>
    <div data-gwd-group-def="Tag" data-gwd-group-class="gwd-grp-t" style="display: none;">
      <p data-gwd-grp-id="text" class="gwd-grp-t gwd-p-tag">Tag text</p>
    </div>
  </template>`;
const GROUP_CSS = `<style>
    .gwd-div-card { position: absolute; left: 150px; top: 120px; width: 120px; height: 60px; }
    .gwd-p-title { position: absolute; left: 0px; top: 0px; margin: 0px; font-family: Arial; font-size: 14px; }
    .gwd-div-badge { position: absolute; left: 0px; top: 30px; width: 60px; height: 20px; }
    .gwd-p-label { position: absolute; left: 0px; top: 0px; margin: 0px; font-family: Arial; font-size: 6px; }
    .gwd-div-tag { position: absolute; left: 60px; top: 30px; width: 60px; height: 20px; }
    .gwd-p-tag { position: absolute; left: 0px; top: 0px; margin: 0px; font-family: Arial; font-size: 7px; }
  </style>`;

function groupedAd(runtime: string[]): string {
  return mockAdHtml('Headline', runtime)
    .replace('</head>', `  ${GROUP_CSS}\n</head>`)
    .replace('<body>', `<body>\n  ${GROUPS}`)
    .replace('<button class="gwd-button-b"', '<div id="SA_card_1" class="gwd-div-card" data-gwd-group="Card"></div>\n        <div id="SA_old_1" data-gwd-group="Old"><p class="gwd-p-label">Old copy</p></div>\n        <button class="gwd-button-b"');
}

// As GWD's groups runtime fills them, once however often the page is shown. Its walk of the definitions
// goes Card, then Badge, which leads back to the Card it came from, so it drops that Badge from its
// copy of the Card: the Card shows its title and its Tag, and the 6px text is nowhere.
async function expectGroupFilled(page: Page) {
  const ad = frame(page, '300x250');
  const card = ad.locator('#SA_card_1');
  await expect(card.locator('.gwd-p-title')).toHaveText(['Card title']);
  await expect(card.locator('[data-gwd-group="Tag"] .gwd-p-tag')).toHaveText(['Tag text']);
  await expect(card.locator('[data-gwd-group="Badge"]')).toHaveCount(0);
  await expect(ad.locator('#SA_old_1')).toHaveCount(0); // a group with no definition
  await expect(row(page, 'type').locator('li', { hasText: '"Tag text" renders at 7.00px' })).toHaveCount(1);
  await expect(row(page, 'type')).not.toContainText('Drag me');
  await expect(row(page, 'type')).not.toContainText('Old copy');
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

// Fills every instance its own way, as GWD's groups runtime does, when the document has loaded.
const OWN_GROUPS = `
document.addEventListener('DOMContentLoaded', () => {
  for (const el of document.querySelectorAll('[data-gwd-group]')) el.innerHTML = '<p class="gwd-p-title">Filled by GWD</p>';
});
`;

test('leaves the groups to GWD\'s own groups runtime when another runtime file is missing', async ({ page }, testInfo) => {
  const html = groupedAd(['mock-gwd.js', 'groups_runtime.min.1.0.js', 'gwdid.min.1.0.js']);
  await checkFolder(page, testInfo, { 'Responsive.html': html, 'mock-gwd.js': MOCK_RUNTIME, 'groups_runtime.min.1.0.js': OWN_GROUPS });
  await expect(page.locator('#summary .banner.standin')).toContainText('Not included: gwdid.min.1.0.js.');
  await expect(frame(page, '300x250').locator('#SA_card_1')).toHaveText('Filled by GWD');
});

// Like GWD's own page deck: it takes the pages out of the document once web components are ready.
const OWN_DECK_TAKES_PAGES = `
window.addEventListener('WebComponentsReady', () => { for (const deck of document.querySelectorAll('gwd-pagedeck')) deck.getPages(); });
`;

test('lets GWD\'s own groups runtime fill the groups before the pages leave the document, when only web components are missing', async ({ page }, testInfo) => {
  const html = groupedAd(['gwd_webcomponents_v1_min.js', 'mock-gwd.js', 'gwdpagedeck_min.js', 'groups_runtime.min.1.0.js']);
  await checkFolder(page, testInfo, { 'Responsive.html': html, 'mock-gwd.js': MOCK_RUNTIME, 'gwdpagedeck_min.js': OWN_DECK_TAKES_PAGES, 'groups_runtime.min.1.0.js': OWN_GROUPS });
  await expect(page.locator('#summary .banner.standin')).toContainText('Not included: gwd_webcomponents_v1_min.js.');
  await expect(frame(page, '300x250').locator('#SA_card_1')).toHaveText('Filled by GWD');
});

// Per-size overrides as GWD's helper applies them: every key whose size matches, ranges first, then the
// exact size, a later key winning per attribute. In 300x250 both keys match: the range's class applies
// and the exact size's text wins.
const MERGED = JSON.stringify({
  '300x250': { 'data-gwd-text': JSON.stringify({ content: 'Exact <span class="gwd-span-x">size</span>', isPlainText: false }) },
  '300x250:320x480': { class: 'gwd-p-a gwd-p-tiny', 'data-gwd-text': JSON.stringify({ content: 'Range size', isPlainText: false }) },
}).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

test('applies every per-size override that matches, ranges first, as GWD\'s helper does', async ({ page }) => {
  await page.goto('./');
  const html = mockAdHtml('Headline', GWD_RUNTIME)
    .replace('</head>', '  <style>.gwd-p-tiny { font-size: 6px; }</style>\n</head>')
    .replace('id="SA_headline_1"', `id="SA_headline_1" data-gwd-media-override="${MERGED}"`);
  await page.locator('#file').setInputFiles({ name: 'Responsive.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 90_000 });
  const headline = frame(page, '300x250').locator('#SA_headline_1');
  await expect(headline).toHaveText('Exact size');
  await expect(headline).toHaveClass('gwd-p-a gwd-p-tiny');
  // GWD keeps the value an override replaced on the element.
  await expect(headline).toHaveAttribute('data-gwd-media-override-class', 'gwd-p-a');
  await expect(frame(page, '320x480 (range 300x250 to 320x480)').locator('#SA_headline_1')).toHaveText('Range size');
  await expect(row(page, 'type').locator('li', { hasText: '"Exact size" renders at 6.00px' }).locator('.sizes')).toHaveText('300x250, 300x250 (range 300x250 to 320x480)');
});

// Like GWD's responsive helper: each size's text goes through gwd.binders.html, from
// gwd-dynamic-binders.js, and is shown as plain text when that is missing.
const HELPER = `
customElements.define('gwd-responsive-attributes-helper', class extends HTMLElement {});
customElements.define('gwd-text-helper', class extends HTMLElement { saveInitialText(el) { el.dataset.initialText = el.textContent; } });
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
    .replace('id="SA_headline_1"', `id="SA_headline_1" data-gwd-media-override="${OVERRIDE}"`)
    .replace('<gwd-genericad id="gwd-ad">', '<gwd-text-helper></gwd-text-helper>\n  <gwd-genericad id="gwd-ad">');
  await checkFolder(page, testInfo, { 'Responsive.html': html, 'mock-gwd.js': MOCK_RUNTIME, 'mock-helper.js': HELPER });
  await expect(page.locator('#summary .banner.standin')).toContainText('Not included: gwd-dynamic-binders.js.');
  const headline = frame(page, '300x250').locator('#SA_headline_1');
  await expect(headline).toHaveText('Exact size');
  await expect(headline.locator('span.gwd-span-x')).toHaveText('size');
  // GWD's text helper saw the text before the binder replaced it.
  await expect(headline).toHaveAttribute('data-initial-text', 'Headline one');
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

// GWD's own ad element and overrides helper, as files of GWD's names. The helper applies the 300x250
// text through the deck's pages, as GWD's does.
const OWN_AD = `
customElements.define('gwd-genericad', class extends HTMLElement {
  initAd() {
    this.dataset.runtime = 'own';
    const deck = this.querySelector('gwd-pagedeck');
    deck.goToPage(deck.getDefaultPage().id);
  }
});
`;
const OWN_HELPER = `
customElements.define('gwd-responsive-attributes-helper', class extends HTMLElement {
  connectedCallback() {
    this.dataset.runtime = 'own';
    setTimeout(() => {
      const deck = document.querySelector('gwd-pagedeck');
      const els = deck.getElementsBySelector('[data-gwd-media-override]').concat(deck.getPages().filter((p) => p.hasAttribute('data-gwd-media-override')));
      for (const el of els) {
        const values = JSON.parse(el.getAttribute('data-gwd-media-override'))['300x250'];
        if (values && matchMedia('(width: 300px) and (height: 250px)').matches) el.textContent = 'Own helper ' + JSON.parse(values['data-gwd-text']).content.replace(/<[^>]*>/g, '');
      }
    }, 1);
  }
});
`;

test('lets GWD\'s own ad element and overrides helper run when an earlier runtime file is missing', async ({ page }, testInfo) => {
  const html = mockAdHtml('Headline', ['mock-page.js', 'gwdpagedeck_min.js', 'groups_runtime.min.1.0.js', 'gwdgenericad_min.js', 'gwdresponsiveattributeshelper_min.js'])
    .replace('id="SA_headline_1"', `id="SA_headline_1" data-gwd-media-override="${OVERRIDE}"`)
    .replace('</gwd-genericad>', '</gwd-genericad>\n  <gwd-responsive-attributes-helper></gwd-responsive-attributes-helper>');
  await checkFolder(page, testInfo, { 'Responsive.html': html, 'mock-page.js': PAGE, 'gwdgenericad_min.js': OWN_AD, 'gwdresponsiveattributeshelper_min.js': OWN_HELPER });
  await expect(page.locator('#summary .banner.standin')).toContainText('Not included: gwdpagedeck_min.js, groups_runtime.min.1.0.js.');
  const ad = frame(page, '300x250');
  await expect(ad.locator('gwd-genericad')).toHaveAttribute('data-runtime', 'own');
  await expect(ad.locator('gwd-responsive-attributes-helper')).toHaveAttribute('data-runtime', 'own');
  await expect(ad.locator('#SA_headline_1')).toHaveText('Own helper Exact size');
});

// GWD's own elements are ES5 constructors that call HTMLElement.call(this), which only GWD's web
// components file lets construct.
const ES5_AD = `
function Ad() { return HTMLElement.call(this) || this; }
Ad.prototype = Object.create(HTMLElement.prototype);
Ad.prototype.constructor = Ad;
Object.setPrototypeOf(Ad, HTMLElement);
Ad.prototype.initAd = function () {
  this.dataset.runtime = 'own';
  this.querySelector('gwd-pagedeck').goToPage(0);
};
customElements.define('gwd-genericad', Ad);
`;

test('stands in for GWD\'s web components file so that GWD\'s own elements still start', async ({ page }, testInfo) => {
  const html = mockAdHtml('Headline', ['gwd_webcomponents_v1_min.js', 'gwdgenericad_min.js']);
  await checkFolder(page, testInfo, { 'Responsive.html': html, 'gwdgenericad_min.js': ES5_AD });
  await expect(page.locator('#summary .banner.standin')).toContainText('Not included: gwd_webcomponents_v1_min.js.');
  await expect(frame(page, '300x250').locator('gwd-genericad')).toHaveAttribute('data-runtime', 'own');
  await expect(frame(page, '300x250').locator('#page1')).toHaveClass(/gwd-play-animation/);
});

test('says which of GWD\'s files the stand-in runs in place of when they cannot run without a missing one', async ({ page }, testInfo) => {
  const html = mockAdHtml('Headline', ['gwdpage_min.js', 'gwdpagedeck_min.js', 'gwdimage_min.js']);
  const deck = 'customElements.define(\'gwd-pagedeck\', class extends HTMLElement {});';
  await checkFolder(page, testInfo, { 'Responsive.html': html, 'gwdpagedeck_min.js': deck, 'gwdimage_min.js': 'customElements.define(\'gwd-image\', class extends HTMLElement {});' });
  await expect(page.locator('#summary .banner.standin')).toContainText('Not included: gwdpage_min.js. The stand-in also runs in place of gwdpagedeck_min.js, gwdimage_min.js, which cannot run without them.');
  await expect(frame(page, '300x250').locator('#page1')).toHaveClass(/gwd-play-animation/);
});
