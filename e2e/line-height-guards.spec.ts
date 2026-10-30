// The line-height fix where the previews cannot see what its value reaches: sizes inside a range
// that no frame shows, pages that never show, text inside other text, and fonts that change. Each
// test applies the fixes as offered and lays the original and the fixed HTML out side by side,
// scripts off, at sizes no frame shows: no text may move and no line spacing may change.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { MOCK_RUNTIME } from './mock-ad';

const RANGE = '(min-width: 300px) and (max-width: 320px) and (min-height: 250px) and (max-height: 480px)';
const exact = (w: number, h: number) => `(width: ${w}px) and (height: ${h}px)`;
// At both ends of the range an exact size's block wins, so no frame shows what the range block does.
const SHADOWED = ['300x600', '300x250:320x480', '300x250', '320x480'];
const INSIDE: [number, number][] = [[310, 400], [305, 300], [319, 470]];
const TEXT = 'Some longer text that wraps onto several lines here';
const P = (top: number, more = 'font-family: Arial; font-size: 16px') => `position: absolute; left: 10px; top: ${top}px; width: 140px; margin: 0px; ${more}`;

const decls = (list: string, indent: string) => list.split(';').map((d) => d.trim()).filter(Boolean).map((d) => `${indent}${d};\n`).join('');
const rule = (sel: string, list: string) => `    ${sel} {\n${decls(list, '      ')}    }\n`;
const block = (media: string, rules: Record<string, string>) =>
  `    @media ${media} {\n${Object.entries(rules).map(([sel, list]) => `      ${sel} {\n${decls(list, '        ')}      }\n`).join('')}    }\n`;

/** A GWD-shaped ad on the mock runtime, with StackAdapt's two scripts: `pages` holds each page's inner HTML. */
function ad(served: string[], css: string, pages: string[]): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="generator" content="Google Web Designer 16.4.1.0219">
  <meta name="environment" content="gwd-genericad">
  <script src="mock-gwd.js"></script>
  <script type="text/javascript" src="https://creative.stackadapt.com/js/iframe-ct.js"></script>
  <style type="text/css">
    html, body {
      width: 100%;
      height: 100%;
      margin: 0px;
    }
${css}  </style>
</head>
<body>
  <script gwd-served-sizes="" type="application/json">${JSON.stringify(served)}</script>
  <gwd-genericad id="gwd-ad">
    <gwd-pagedeck class="gwd-page-container" id="pagedeck">
${pages.map((p, i) => `      <gwd-page id="page${i + 1}">\n        ${p}\n      </gwd-page>`).join('\n')}
    </gwd-pagedeck>
  </gwd-genericad>
  <script type="text/javascript" src="https://creative.stackadapt.com/js/param.js"></script>
</body>
</html>
`;
}

/**
 * Every text's line-height in px (normal measured in its font) and the rects of its own text, laid
 * out at this size with scripts off, every page in place.
 */
async function layout(browser: Browser, html: string, width: number, height: number): Promise<string[]> {
  const page = await browser.newPage({ viewport: { width, height }, javaScriptEnabled: false });
  await page.setContent(html);
  const out = await page.evaluate(() => [...document.body.querySelectorAll('*')].flatMap((el) => {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
    if (!own.length || el.closest('script, style')) return [];
    const cs = getComputedStyle(el);
    let lh = parseFloat(cs.lineHeight);
    if (cs.lineHeight === 'normal') {
      const probe = document.createElement('div');
      probe.style.cssText = `position:absolute;white-space:nowrap;line-height:normal;font:${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      probe.textContent = el.textContent;
      document.body.append(probe);
      lh = probe.getBoundingClientRect().height;
      probe.remove();
    }
    const rects = own.flatMap((n) => {
      const range = document.createRange();
      range.selectNodeContents(n);
      return [...range.getClientRects()].map((b) => [b.left, b.top, b.width, b.height].map((v) => v.toFixed(2)).join(','));
    });
    return [`${el.id || el.localName} lh=${lh.toFixed(2)} ${rects.join(' | ')}`];
  }));
  await page.close();
  return out;
}

interface Checked {
  detail: string; // the ticked line-height fix, '' when there is none
  manual: string;
  banner: string;
}

/**
 * Loads the ad, applies the fixes as offered (ticked ones only) and checks that the fixed HTML lays
 * out exactly like the original at `sizes`, which include sizes no frame shows.
 */
async function applyAndCompare(page: Page, browser: Browser, html: string, sizes: [number, number][], runtime = MOCK_RUNTIME): Promise<Checked> {
  await page.goto('./');
  const zip = Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/mock-gwd.js': strToU8(runtime) }));
  await page.locator('#file').setInputFiles({ name: 'guards.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#summary')).toBeVisible({ timeout: 240_000 });
  const fix = page.locator('#fixes .fixlist li', { hasText: 'Declare line-height' });
  const detail = (await fix.count()) && (await fix.locator('input').isChecked()) ? await fix.locator('.detail').first().innerText() : '';
  // The notes as written: the list hides some punctuation that innerText would drop.
  const manual = (await page.locator('#fixes .manual').count()) ? ((await page.locator('#fixes .manual').textContent()) ?? '') : '';
  if (!(await page.locator('#fixes input[data-fix]:checked').count())) return { detail, manual, banner: '' }; // nothing offered ticked
  await page.getByRole('button', { name: 'Apply selected fixes' }).click();
  await expect(page.locator('#fixes .banner')).toBeVisible({ timeout: 240_000 });
  const banner = await page.locator('#fixes .banner').innerText();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download fixed zip', exact: true }).click()]);
  const fixed = strFromU8(unzipSync(new Uint8Array(readFileSync((await download.path())!)))['Mock Ad/Responsive.html']);
  expect(fixed).not.toBe(html);
  for (const [w, h] of sizes) expect(await layout(browser, fixed, w, h), `${w}x${h}`).toEqual(await layout(browser, html, w, h));
  return { detail, manual, banner };
}

test('keeps the spacing inside a range where only the range block sets a line-height or font the text takes', async ({ page, browser }) => {
  const css = [
    // A wrapper's line-height, which the text inherits, set only in the range block.
    rule('.gwd-div-w', 'position: absolute; left: 0px; top: 0px; width: 300px; height: 90px'),
    rule('.gwd-p-w', P(0)),
    // A paragraph's line-height, which a bigger span inside it inherits, set only in the range block.
    rule('.gwd-p-u', P(100)),
    rule('.gwd-span-u', 'font-size: 24px'),
    // An inline font-size, which beats the range block's.
    rule('.gwd-p-g', P(200)),
    // A button keeps the browser's font when its wrapper's font changes.
    rule('.gwd-div-h', 'position: absolute; left: 0px; top: 300px; width: 300px; height: 40px; font-family: serif'),
    rule('.gwd-button-h', 'position: absolute; left: 10px; top: 0px; width: 120px; height: 30px; padding: 0px; color: rgb(0, 0, 0)'),
    // A size in em, which follows its wrapper's, which the range block changes.
    rule('.gwd-div-d', 'position: absolute; left: 0px; top: 350px; width: 300px; height: 90px; font-size: 16px'),
    rule('.gwd-p-d', P(0, 'font-family: Arial; font-size: 1.5em')),
    // A <sup> inside the paragraph, whose font only the range block changes.
    rule('.gwd-p-s', P(460)),
    rule('#SA_s_1 sup', 'font-size: 1em'),
    // An id rule and an !important, which beat the range block's font-size.
    rule('.gwd-p-i', P(510)),
    rule('#SA_i_1', 'font-size: 20px'),
    rule('.gwd-p-x', P(560, 'font-family: Arial; font-size: 20px !important')),
    // A font-family browsers drop, so the text takes its wrapper's (a generic family, which every system
    // has), which the range block changes.
    rule('.gwd-div-v', 'position: absolute; left: 0px; top: 610px; width: 300px; height: 90px; font-family: cursive'),
    rule('.gwd-p-v', P(0, 'font-family: Arial,,Helvetica; font-size: 16px')),
    // Chinese type its own font has, in a font that lacks it in the range alone, so only there some lines are taller.
    rule('.gwd-p-z', P(710, 'font-family: "PingFang SC", "Noto Sans CJK SC", sans-serif; font-size: 14px; width: 150px')),
    block(RANGE, {
      '.gwd-div-w': 'line-height: 30px', '.gwd-p-u': 'line-height: 30px', '.gwd-p-g': 'font-size: 10px', '.gwd-div-h': 'font-size: 30px; font-family: Arial',
      '.gwd-div-d': 'font-size: 10px', '#SA_s_1 sup': 'font-size: 30px', '.gwd-p-i': 'font-size: 10px', '.gwd-p-x': 'font-size: 10px', '.gwd-div-v': 'font-family: Arial',
      '.gwd-p-z': 'font-family: Arial',
    }),
    block(exact(300, 250), { '.gwd-div-w': 'left: 0px', '.gwd-div-d': 'font-size: 10px', '#SA_s_1 sup': 'font-size: 1em', '.gwd-p-z': 'font-family: "PingFang SC", "Noto Sans CJK SC", sans-serif' }),
    block(exact(320, 480), { '.gwd-div-w': 'left: 0px', '.gwd-div-d': 'font-size: 10px', '#SA_s_1 sup': 'font-size: 1em', '.gwd-p-z': 'font-family: "PingFang SC", "Noto Sans CJK SC", sans-serif' }),
  ].join('');
  const html = ad(SHADOWED, css, [[
    `<div class="gwd-div-w" id="SA_w_1"><p class="gwd-p-w" id="SA_w_2">${TEXT}</p></div>`,
    '<p class="gwd-p-u" id="SA_u_1">Save <span class="gwd-span-u" id="SA_u_2">50%</span> on everything today</p>',
    `<p class="gwd-p-g" id="SA_g_1" style="font-size: 20px;">${TEXT}</p>`,
    '<div class="gwd-div-h" id="SA_h_1"><button class="gwd-button-h" id="SA_h_2">Go now</button></div>',
    `<div class="gwd-div-d" id="SA_d_1"><p class="gwd-p-d" id="SA_d_2">${TEXT}</p></div>`,
    '<p class="gwd-p-s" id="SA_s_1">Brand<sup>TM</sup> deals for everyone</p>',
    `<p class="gwd-p-i" id="SA_i_1">${TEXT}</p>`,
    `<p class="gwd-p-x" id="SA_x_1">${TEXT}</p>`,
    `<div class="gwd-div-v" id="SA_v_1"><p class="gwd-p-v" id="SA_v_2">${TEXT}</p></div>`,
    '<p class="gwd-p-z" id="SA_z_1">Great savings on every order 限时优惠</p>',
  ].join('\n        ')]);
  const { detail, manual, banner } = await applyAndCompare(page, browser, html, [...INSIDE, [300, 600], [300, 250], [320, 480]]);
  expect(banner).toContain('exactly where they were');
  // measured in the range's font: the wrapper's family, as the dropped one leaves it (where that
  // system's cursive and Arial happen to space alike, the base value already fits the range)
  const base = /\.gwd-p-v: ([\d.]+)px/.exec(detail)?.[1];
  const arial = await page.evaluate(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;white-space:nowrap;line-height:normal;font:16px Arial';
    d.textContent = 'Xg';
    document.body.append(d);
    const h = d.getBoundingClientRect().height;
    d.remove();
    return h;
  });
  if (base && Math.abs(Number(base) - arial) > 0.05) expect(detail).toContain('.gwd-p-v in 300x250 to 320x480:');
  for (const cls of ['gwd-p-w', 'gwd-span-u', 'gwd-p-g', 'gwd-p-d', 'gwd-p-s', 'gwd-p-i', 'gwd-p-x']) {
    expect(manual).toContain(`.${cls} in 300x250 to 320x480 was not measured, and a value in its base rule would reach it there, so its base size gets none`);
  }
});

test('keeps the spacing inside a nested range that changes the font or line-height of what the text sits in', async ({ page, browser }) => {
  const R1 = '(min-width: 300px) and (max-width: 336px) and (min-height: 250px) and (max-height: 480px)';
  const R2 = '(min-width: 310px) and (max-width: 320px) and (min-height: 300px) and (max-height: 400px)';
  const css = [
    rule('.gwd-div-j', 'position: absolute; left: 0px; top: 0px; width: 300px; height: 200px; font-size: 16px'),
    rule('.gwd-p-j', P(0, 'font-family: Arial')),
    rule('.gwd-div-k', 'position: absolute; left: 0px; top: 220px; width: 300px; height: 200px'),
    rule('.gwd-p-k', P(0)),
    // R1 touches both texts in every frame, so no frame's font is the base one to measure R2 on.
    block(R1, { '.gwd-p-j': 'font-family: Arial', '.gwd-p-k': 'font-size: 16px' }),
    block(R2, { '.gwd-div-j': 'font-size: 24px', '.gwd-div-k': 'line-height: 30px' }),
    block(exact(310, 300), { '.gwd-div-j': 'left: 0px' }),
    block(exact(320, 400), { '.gwd-div-j': 'left: 0px' }),
  ].join('');
  const html = ad(['300x250:336x480', '310x300:320x400', '310x300', '320x400'], css, [
    `<div class="gwd-div-j" id="SA_j_1"><p class="gwd-p-j" id="SA_j_2">${TEXT}</p></div>\n        <div class="gwd-div-k" id="SA_k_1"><p class="gwd-p-k" id="SA_k_2">${TEXT}</p></div>`,
  ]);
  const { manual } = await applyAndCompare(page, browser, html, [[315, 350], [312, 390], [300, 250], [336, 480], [310, 300], [320, 400]]);
  for (const cls of ['gwd-p-j', 'gwd-p-k']) expect(manual).toContain(`.${cls} in 310x300 to 320x400 was not measured, and its value in 300x250 to 336x480 would reach it there`);
});

test('leaves text to you where a media query that is not a GWD size changes its font inside a range', async ({ page, browser }) => {
  const query = '(min-width: 305px) and (max-width: 315px)';
  const css = rule('.gwd-p-e', P(10))
    // the same for one it sits in
    + rule('.gwd-div-q', 'position: absolute; left: 0px; top: 150px; width: 300px; height: 100px; font-size: 16px')
    + rule('.gwd-p-q', P(0, 'font-family: Arial'))
    + block(query, { '.gwd-p-e': 'font-size: 10px', '.gwd-div-q': 'font-size: 10px' });
  const html = ad(['300x250:320x480'], css, [`<p class="gwd-p-e" id="SA_e_1">${TEXT}</p>\n        <div class="gwd-div-q" id="SA_q_1"><p class="gwd-p-q" id="SA_q_2">${TEXT}</p></div>`]);
  const { detail, manual } = await applyAndCompare(page, browser, html, [[310, 400], [305, 300], [300, 250], [320, 480]]);
  for (const cls of ['gwd-p-e', 'gwd-p-q']) expect(manual).toContain(`.${cls}: @media ${query} changes its font or line-height in sizes no frame shows`);
  expect(detail).toBe('');
});

test('leaves text to you that its line-height would reach through a multiplier, an inherit or a wrapper carrying its class', async ({ page, browser }) => {
  const css = [
    // A unitless line-height on a wrapper: each text inside renders it in its own font.
    rule('.gwd-div-b', 'position: absolute; left: 0px; top: 0px; width: 300px; height: 100px; line-height: 1.5'),
    rule('.gwd-p-b', P(0)),
    rule('.gwd-p-c', P(110)),
    rule('.gwd-span-c', 'font-size: 24px; line-height: inherit'),
    // The class of a paragraph also on a wrapper with no text of its own.
    rule('.gwd-p-a', P(210)),
  ].join('');
  const html = ad(['300x250'], css, [[
    '<div class="gwd-div-b" id="SA_b_1"><p class="gwd-p-b" id="SA_b_2">Save <span style="font-size: 24px;">50%</span> and Brand<sup>TM</sup> deals</p></div>',
    '<p class="gwd-p-c" id="SA_c_1">Save <span class="gwd-span-c" id="SA_c_2">50%</span> on everything today</p>',
    '<p class="gwd-p-a" id="SA_a_1">Headline</p>',
    '<div class="gwd-p-a" id="SA_wrap_1"><div id="SA_inner_1" style="position: absolute; top: 150px; font-size: 10px;">Inner small text that wraps</div></div>',
  ].join('\n        ')]);
  const { detail, manual, banner } = await applyAndCompare(page, browser, html, [[300, 250]]);
  expect(banner).toContain('exactly where they were');
  expect(manual).toContain('.gwd-p-b: span inside it takes its line-height and would go from 36px to 24px in 300x250');
  expect(manual).toContain('.gwd-p-c: span#SA_c_2 inside it takes its line-height and would go from');
  expect(manual).toContain('.gwd-p-a is also on div#SA_wrap_1, and div#SA_inner_1 inside it takes its line-height and would go from');
  expect(detail).toBe('');
});

test('leaves text to you whose lines are not all one height, or whose font an animation changes', async ({ page, browser }) => {
  const css = [
    // An emoji and Chinese type that Arial lacks, each on one line of a wrapped text only.
    rule('.gwd-p-m', P(0, 'font-family: Arial; font-size: 14px')),
    rule('.gwd-p-n', P(80, 'font-family: Arial; font-size: 14px; width: 150px')),
    // A font-size animation that starts after the text is measured.
    rule('.gwd-p-f', P(160, 'font-family: Arial; font-size: 14px')),
    '    @keyframes grow {\n      0% {\n        font-size: 14px;\n      }\n      100% {\n        font-size: 24px;\n      }\n    }\n',
    rule('.gwd-play-animation .gwd-p-f', 'animation: 0.5s linear 4s 1 normal forwards grow'),
    // One that has finished by then, and one a script starts.
    rule('.gwd-p-o', P(210, 'font-family: Arial; font-size: 14px')),
    rule('.gwd-play-animation .gwd-p-o', 'animation: 0.1s linear 0s 1 normal none grow'),
    rule('.gwd-p-r', P(260, 'font-family: Arial; font-size: 14px')),
    // A span inside text, whose font alone an animation changes.
    rule('.gwd-p-k', P(310, 'font-family: Arial; font-size: 14px')),
    rule('.gwd-span-k', 'color: rgb(200, 0, 0)'),
    rule('.gwd-play-animation .gwd-span-k', 'animation: 0.5s linear 4s 1 normal forwards grow'),
  ].join('');
  const html = ad(['300x250'], css, [[
    '<p class="gwd-p-m" id="SA_m_1">Fresh deals every single day for you 🔥 now</p>',
    '<p class="gwd-p-n" id="SA_n_1">Great savings on every order 限时优惠</p>',
    '<p class="gwd-p-f" id="SA_f_1">Some longer text that wraps onto lines</p>',
    '<p class="gwd-p-o" id="SA_o_1">Some longer text that wraps onto lines</p>',
    '<p class="gwd-p-r" id="SA_r_1">Some longer text that wraps onto lines</p>',
    '<p class="gwd-p-k" id="SA_k_1">Save <span class="gwd-span-k" id="SA_k_2">50%</span> on everything today</p>',
  ].join('\n        ')]).replace('</body>', "  <script>window.addEventListener('load', () => setTimeout(() => document.getElementById('SA_r_1').animate([{ fontSize: '14px' }, { fontSize: '24px' }], { duration: 500, delay: 4000, fill: 'forwards' }), 100));</script>\n</body>");
  // Which characters draw in a fallback font depends on the fonts installed: the layout comparison
  // checks that nothing moved, whatever the machine.
  const { detail, manual, banner } = await applyAndCompare(page, browser, html, [[300, 250]]);
  expect(banner).toContain('exactly where they were');
  for (const cls of ['gwd-p-f', 'gwd-p-o', 'gwd-p-r', 'gwd-span-k']) expect(manual).toContain(`.${cls}: an animation changes its font while the ad runs`);
  expect(manual).toContain('.gwd-p-k: span#SA_k_2 inside it takes its line-height and has its font changed by an animation');
  for (const cls of ['gwd-p-f', 'gwd-p-o', 'gwd-p-r', 'gwd-p-k']) expect(detail).not.toContain(`.${cls}`);
});

test('leaves a class to you where a page it sits on never showed in a size', async ({ page, browser }) => {
  test.setTimeout(400_000);
  // The mock runtime, except that page 2 never shows at 300x250.
  const stubborn = MOCK_RUNTIME.replace('if (i < 0 || i === this.current || this.busy) return;', 'if (i < 0 || i === this.current || this.busy) return;\n    if (i === 1 && innerWidth === 300 && innerHeight === 250) return;');
  expect(stubborn).not.toBe(MOCK_RUNTIME);
  const css = [
    rule('.gwd-div-a', 'position: absolute; left: 0px; top: 0px; width: 300px; height: 100px; font-size: 16px; font-family: Arial'),
    rule('.gwd-div-b', 'position: absolute; left: 0px; top: 100px; width: 300px; height: 100px; font-size: 16px; font-family: Arial'),
    rule('.gwd-p-t', 'position: absolute; left: 10px; top: 10px; width: 140px; margin: 0px; color: rgb(0, 0, 0)'),
    block(exact(300, 250), { '.gwd-div-b': 'font-size: 10px' }),
  ].join('');
  const html = ad(['300x600', '300x250'], css, [
    '<div class="gwd-div-a" id="SA_a_1"><p class="gwd-p-t" id="SA_t_1">Some longer text that wraps onto lines</p></div>',
    '<div class="gwd-div-b" id="SA_b_1"><p class="gwd-p-t" id="SA_t_2">Other longer text that wraps onto lines</p></div>',
  ]);
  const { detail, manual, banner } = await applyAndCompare(page, browser, html, [[300, 250], [300, 600]], stubborn);
  expect(manual).toContain('.gwd-p-t may sit on a page that never showed in 300x250, so it was not checked there; set its line-height in GWD.');
  expect(detail).toBe('');
  // margin-block is left to you there too
  expect(manual).toContain('.gwd-p-t may sit on a page that never showed in 300x250, so it was not checked there; add margin-block: 0px auto in GWD.');
  expect(banner).toBe('');
});
