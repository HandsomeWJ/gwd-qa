import { describe, expect, it } from 'vitest';
import { applyEdits, mergeEdits } from '../src/css/edit';
import { parseCss } from '../src/css/parse';
import type { CssValidator } from '../src/audit/cssvalues';
import { staticAudit } from '../src/audit/static';
import type { Box, Inheritor } from '../src/audit/types';
import { planFixes, withoutPart } from '../src/fix/plan';
import { box } from './boxes';
import { fixture } from './fixture';

const M250 = '(width: 300px) and (height: 250px)';
const M600 = '(width: 300px) and (height: 600px)';
const RANGE = '(min-width: 300px) and (max-width: 320px) and (min-height: 250px) and (max-height: 480px)';

function plan(html: string, boxes: Box[], media: Record<string, string[]>, safety: { animation: string }[] = [], more: { incomplete?: string[]; valid?: CssValidator } = {}) {
  const css = parseCss(html);
  const report = staticAudit(html, css, more.valid);
  const incomplete = more.incomplete && new Set(more.incomplete);
  const p = planFixes({ html, css, boxes, media: new Map(Object.entries(media).map(([k, v]) => [k, new Set(v)])), report, safety, ...(incomplete ? { incomplete } : {}) });
  const fix = (check: string, moves = false) => p.fixes.find((f) => f.check === check && !!f.moves === moves);
  const applied = (check: string, moves = false) => applyEdits(html, mergeEdits(fix(check, moves)?.edits ?? []));
  return { p, fix, applied };
}

describe('line-height', () => {
  // The fixture declares line-height for .gwd-p-head in 300x250; drop it so both sizes need one.
  const html = fixture('mini-ad.html').replace('        font-size: 12px;\n        line-height: 14px;\n', '        font-size: 12px;\n');
  const head = { tag: 'p', classes: ['gwd-p-head'], target: 'p#SA_headline_10' };

  it('puts each size\'s value, at the px it renders now, in that size\'s own media block', () => {
    const { fix, applied } = plan(html, [
      box({ ...head, frame: '300x250', size: '300x250', normalLineHeight: 15, computed: { fontSize: 12 } }),
      box({ ...head, frame: '300x600', size: '300x600', normalLineHeight: 19.5, computed: { fontSize: 16 } }),
    ], { '300x250': [M250], '300x600': [M600] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x250: 15px, .gwd-p-head in 300x600: 19.5px');
    expect(applied('lineHeight')).toContain('        font-size: 12px;\n        line-height: 15px;\n      }');
    // the 300x600 block had no rule for the class: it gets one, and the base rule stays untouched
    expect(applied('lineHeight')).toContain('    @media (width: 300px) and (height: 600px) {\n      .gwd-p-head {\n        line-height: 19.5px;\n      }\n    }');
    expect(applied('lineHeight')).toContain('      top: 0px;\n    }');
  });

  it('puts the design\'s base size, which has no media block, in the base rule', () => {
    const { fix, applied } = plan(html, [
      box({ ...head, frame: '320x480', size: '320x480', normalLineHeight: 19.5, computed: { fontSize: 16 } }),
      box({ ...head, frame: '300x250', size: '300x250', normalLineHeight: 15, computed: { fontSize: 12 } }),
    ], { '320x480': [], '300x250': [M250] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-p-head: 19.5px, .gwd-p-head in 300x250: 15px');
    expect(applied('lineHeight')).toContain('      top: 0px;\n      line-height: 19.5px;\n    }');
  });

  it('leaves out word spans a text effect makes at runtime', () => {
    const { fix, p } = plan(html, [box({ tag: 'span', classes: [], runtime: true, normalLineHeight: 30, computed: { fontSize: 24 } })], {});
    expect(fix('lineHeight')).toBeUndefined();
    expect(p.manual).toEqual([]);
  });

  it('uses a range size\'s own rule when its font-size lives there', () => {
    const withRange = html.replace('    @media (width: 300px) and (height: 600px) {}', `    @media ${RANGE} {\n      .gwd-p-swap {\n        font-size: 12px;\n      }\n    }\n    @media (width: 300px) and (height: 600px) {}`);
    const label = '320x480 (range 300x250 to 320x480)';
    const { applied } = plan(withRange, [box({ tag: 'p', classes: ['gwd-p-swap'], frame: label, size: '300x250:320x480', normalLineHeight: 14.5 })], { [label]: [RANGE] });
    expect(applied('lineHeight')).toContain('        font-size: 12px;\n        line-height: 14.5px;\n      }');
  });

  it('lets an exact size inside a range keep its own value, and gives the range the other end\'s', () => {
    // GWD writes ranges first, so at 300x250 the exact block overrides the range block
    const withRange = html.replace(/(    @media \(width: 300px\) and \(height: 250px\) \{)/, `    @media ${RANGE} {\n      .gwd-p-head {\n        font-size: 10px;\n      }\n    }\n$1`);
    const [lo, hi] = ['300x250 (range 300x250 to 320x480)', '320x480 (range 300x250 to 320x480)'];
    const range = '300x250:320x480';
    const { fix, p, applied } = plan(withRange, [
      box({ ...head, frame: '300x250', size: '300x250', normalLineHeight: 15 }),
      box({ ...head, frame: lo, size: range, normalLineHeight: 15 }),
      box({ ...head, frame: hi, size: range, normalLineHeight: 12.5 }),
    ], { '300x250': [RANGE, M250], [lo]: [RANGE, M250], [hi]: [RANGE] });
    expect(p.manual).toEqual([]);
    expect(fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x250: 15px, .gwd-p-head in 300x250 to 320x480: 12.5px');
    expect(applied('lineHeight')).toContain('        font-size: 10px;\n        line-height: 12.5px;\n      }');
    expect(applied('lineHeight')).toContain('        font-size: 12px;\n        line-height: 15px;\n      }');
  });

  it('gives a span in its parent\'s font its own px line-height when the parent\'s differs', () => {
    const { fix } = plan(html, [
      box({ tag: 'span', classes: ['gwd-span-hl'], inTextParent: true, normalLineHeight: 34, parentLineHeight: 19.5 }),
    ], { '300x250': [M250] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-span-hl in 300x250: 34px');
  });

  it('refuses measurements taken before the web font loaded', () => {
    const { fix, p } = plan(html, [
      box({ ...head, frame: '300x250', size: '300x250', normalLineHeight: 12, fontLoaded: false, computed: { fontSize: 12, fontFamily: 'Brand' } }),
      box({ ...head, frame: '300x600', size: '300x600', normalLineHeight: 19, computed: { fontSize: 16, fontFamily: 'Brand' } }),
    ], { '300x250': [M250], '300x600': [M600] });
    expect(fix('lineHeight')).toBeUndefined();
    expect(p.manual[0].detail).toContain('its font had not loaded');
  });

  it('accepts a font whose metrics round differently at different sizes', () => {
    // Chromium rounds ascent and descent to whole pixels: 8px -> 10, 15px -> 17 (ratios 1.25 and 1.13)
    const { fix } = plan(html, [
      box({ ...head, frame: '300x250', size: '300x250', normalLineHeight: 10, computed: { fontSize: 8, fontFamily: 'Brand' } }),
      box({ ...head, frame: '300x600', size: '300x600', normalLineHeight: 17, computed: { fontSize: 15, fontFamily: 'Brand' } }),
    ], { '300x250': [M250], '300x600': [M600] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x250: 10px, .gwd-p-head in 300x600: 17px');
  });

  it('covers a size no frame measured with the normal measured in its font there, never an estimate', () => {
    // only the base size is measured; 300x250 has its own font-size, which the base value must not reach
    const m250 = parseCss(html).media[0].start;
    const { fix, applied } = plan(html, [
      box({ ...head, frame: '320x480', normalLineHeight: 19.5, probes: { [m250]: 15 }, computed: { fontSize: 16, fontFamily: 'Montserrat' } }),
    ], { '320x480': [] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-p-head: 19.5px, .gwd-p-head in 300x250: 15px');
    expect(applied('lineHeight')).toContain('      top: 0px;\n      line-height: 19.5px;\n    }');
    expect(applied('lineHeight')).toContain('        font-size: 12px;\n        line-height: 15px;\n      }');
  });

  it('gives the base rule nothing where a size no frame measured could not be measured in its font', () => {
    const { fix, p } = plan(html, [box({ ...head, frame: '320x480', normalLineHeight: 19.5, computed: { fontSize: 16 } })], { '320x480': [] });
    expect(fix('lineHeight')).toBeUndefined();
    expect(p.manual.map((m) => m.detail)).toEqual([
      '.gwd-p-head in 300x250 was not measured, and a value in its base rule would reach it there, so its base size gets none; set its line-height in GWD.',
    ]);
    const m250 = parseCss(html).media[0].start;
    const fallback = plan(html, [box({ ...head, frame: '320x480', normalLineHeight: 19.5, probes: { [m250]: null } })], { '320x480': [] });
    expect(fallback.fix('lineHeight')).toBeUndefined();
  });

  it('counts a size as measured where a frame showed every page, and not where a page never showed', () => {
    // .gwd-p-head is only seen in the base size; 300x250 changes its font-size
    const boxes = [box({ ...head, frame: '320x480', normalLineHeight: 19.5 }), box({ classes: ['gwd-p-swap'], frame: '300x250', declared: { lineHeight: '14px' } })];
    const media = { '320x480': [], '300x250': [M250] };
    expect(plan(html, boxes, media).fix('lineHeight')?.detail).toBe('.gwd-p-head: 19.5px');
    const css = parseCss(html);
    const skipped = planFixes({ html, css, boxes, media: new Map(Object.entries(media).map(([k, v]) => [k, new Set(v)])), report: staticAudit(html, css), safety: [], incomplete: new Set(['300x250']) });
    expect(skipped.fixes.find((f) => f.check === 'lineHeight')).toBeUndefined();
    expect(skipped.manual.map((m) => m.detail)).toEqual([
      '.gwd-p-head in 300x250 was not measured, and a value in its base rule would reach it there, so its base size gets none; set its line-height in GWD.',
    ]);
  });

  it('gives a span its own value where a size no frame shows would part it from its parent', () => {
    // The span keeps its own 16px where 300x250 shrinks the paragraph around it.
    const ownSize = html.replace('      color: rgb(255, 210, 0);\n', '      color: rgb(255, 210, 0);\n      font-size: 16px;\n');
    const m250 = parseCss(ownSize).media[0].start;
    const { fix } = plan(ownSize, [
      box({ ...head, frame: '320x480', normalLineHeight: 19.5, probes: { [m250]: 15 } }),
      box({ tag: 'span', classes: ['gwd-span-hl'], frame: '320x480', inTextParent: true, normalLineHeight: 19.5, parentLineHeight: 19.5, probes: { [m250]: 19.5 } }),
    ], { '320x480': [] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-p-head: 19.5px, .gwd-span-hl: 19.5px, .gwd-p-head in 300x250: 15px');
  });

  it('keeps each class\'s edits apart, so one class can be left out alone', () => {
    const ownSize = html.replace('      color: rgb(255, 210, 0);\n', '      color: rgb(255, 210, 0);\n      font-size: 16px;\n');
    const m250 = parseCss(ownSize).media[0].start;
    const { fix } = plan(ownSize, [
      box({ ...head, frame: '320x480', normalLineHeight: 19.5, probes: { [m250]: 15 } }),
      box({ tag: 'span', classes: ['gwd-span-hl'], frame: '320x480', inTextParent: true, normalLineHeight: 19.5, parentLineHeight: 19.5, probes: { [m250]: 19.5 } }),
    ], { '320x480': [] });
    const lh = fix('lineHeight')!;
    const [headPart, spanPart] = lh.parts!;
    expect([headPart.name, spanPart.name]).toEqual(['.gwd-p-head', '.gwd-span-hl']);
    expect([...headPart.edits, ...spanPart.edits].sort((a, b) => a.start - b.start)).toEqual([...lh.edits].sort((a, b) => a.start - b.start));
    expect(applyEdits(ownSize, spanPart.edits)).toContain('      font-size: 16px;\n      line-height: 19.5px;\n    }');

    const headOnly = withoutPart(lh, '.gwd-span-hl')!;
    expect(headOnly.detail).toBe('.gwd-p-head: 19.5px, .gwd-p-head in 300x250: 15px');
    expect(headOnly.edits).toEqual(lh.edits.filter((e) => headPart.edits.includes(e)));
    expect(withoutPart(lh, '.gwd-p-head')!.detail).toBe('.gwd-span-hl: 19.5px');
    expect(withoutPart(headOnly, '.gwd-p-head')).toBeNull();
  });

  it('treats a range whose two ends are exact sizes as never measured', () => {
    // GWD writes the range first, so at both of its ends an exact size's block wins
    const shadowed = html
      .replace('    @media (width: 300px) and (height: 250px) {', `    @media ${RANGE} {\n      .gwd-p-head {\n        font-size: 10px;\n      }\n    }\n    @media (width: 300px) and (height: 250px) {`)
      .replace('    @media (width: 300px) and (height: 600px) {}', '    @media (width: 320px) and (height: 480px) {\n      .gwd-p-head {\n        font-size: 14px;\n      }\n    }');
    const M480 = '(width: 320px) and (height: 480px)';
    const [lo, hi] = ['300x250 (range 300x250 to 320x480)', '320x480 (range 300x250 to 320x480)'];
    const media = { '300x600': [], '300x250': [RANGE, M250], [lo]: [RANGE, M250], [hi]: [RANGE, M480], '320x480': [RANGE, M480] };
    const boxes = (probes?: Box['probes']) => [
      box({ ...head, frame: '300x600', normalLineHeight: 19.5, probes }),
      ...['300x250', lo].map((frame) => box({ ...head, frame, normalLineHeight: 15 })),
      ...[hi, '320x480'].map((frame) => box({ ...head, frame, normalLineHeight: 16.5 })),
    ];
    const unmeasured = plan(shadowed, boxes(), media);
    expect(unmeasured.fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x250: 15px, .gwd-p-head in 320x480: 16.5px');
    expect(unmeasured.p.manual.map((m) => m.detail)).toEqual([
      '.gwd-p-head in 300x250 to 320x480 was not measured, and a value in its base rule would reach it there, so its base size gets none; set its line-height in GWD.',
    ]);
    const range = parseCss(shadowed).media[0];
    const probed = plan(shadowed, boxes({ [range.start]: 11.5 }), media);
    expect(probed.fix('lineHeight')?.detail).toBe('.gwd-p-head: 19.5px, .gwd-p-head in 300x250: 15px, .gwd-p-head in 320x480: 16.5px, .gwd-p-head in 300x250 to 320x480: 11.5px');
    expect(probed.applied('lineHeight')).toContain('        font-size: 10px;\n        line-height: 11.5px;\n      }');
  });

  it('leaves a class to you where its value in a range reaches a size inside it that no frame measured', () => {
    // R2 sits inside R1 and comes after it; both its ends are exact sizes, so no frame shows R2's 30px.
    const R1 = '(min-width: 300px) and (max-width: 336px) and (min-height: 250px) and (max-height: 480px)';
    const R2 = '(min-width: 310px) and (max-width: 320px) and (min-height: 300px) and (max-height: 400px)';
    const E1 = '(width: 310px) and (height: 300px)';
    const E2 = '(width: 320px) and (height: 400px)';
    const blocks = ([[R1, 16], [R2, 30], [E1, 12], [E2, 14]] as const).map(([m, px]) => `    @media ${m} {\n      .gwd-p-head {\n        font-size: ${px}px;\n      }\n    }\n`).join('');
    const nested = `<!DOCTYPE html>\n<html>\n<head>\n  <style type="text/css">\n    .gwd-p-head {\n      position: absolute;\n      font-family: Arial;\n      font-size: 16px;\n    }\n${blocks}  </style>\n</head>\n<body>\n  <script gwd-served-sizes="" type="application/json">["300x250:336x480", "310x300:320x400", "310x300", "320x400"]</script>\n  <p class="gwd-p-head" id="SA_headline_1">Text</p>\n</body>\n</html>\n`;
    const frames: [string, string, string[], number][] = [
      ['300x250 (range 300x250 to 336x480)', '300x250:336x480', [R1], 18.5],
      ['336x480 (range 300x250 to 336x480)', '300x250:336x480', [R1], 18.5],
      ['310x300 (range 310x300 to 320x400)', '310x300:320x400', [R1, R2, E1], 14],
      ['320x400 (range 310x300 to 320x400)', '310x300:320x400', [R1, R2, E2], 16],
      ['310x300', '310x300', [R1, R2, E1], 14],
      ['320x400', '320x400', [R1, R2, E2], 16],
    ];
    const { fix, p } = plan(nested, frames.map(([frame, size, , lh]) => box({ ...head, frame, size, normalLineHeight: lh })), Object.fromEntries(frames.map(([f, , m]) => [f, m])));
    expect(fix('lineHeight')).toBeUndefined();
    expect(p.manual.map((m) => m.detail)).toContain('.gwd-p-head in 310x300 to 320x400 was not measured, and its value in 300x250 to 336x480 would reach it there; set its line-height in GWD.');
  });

  it('declares what a text renders now: a px it inherits from a parent\'s declaration', () => {
    // A span in a p that declares 14px renders 14px, whatever its own normal; so does text in a div that declares 20px.
    const { fix } = plan(html, [
      box({ tag: 'span', classes: ['gwd-span-hl'], inTextParent: true, normalLineHeight: 15, parentLineHeight: 14, computed: { lineHeight: '14px' } }),
      box({ classes: ['gwd-p-swap'], normalLineHeight: 19, computed: { lineHeight: '20px' } }),
    ], { '300x250': [M250] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-p-swap in 300x250: 20px, .gwd-span-hl: inherit');
  });

  it('leaves a class whose texts render different values in one size to you, in every size', () => {
    // The base size has no block of its own. One of the texts also carries .gwd-p-swap, which shrinks it in 300x250.
    const both = { tag: 'p', classes: ['gwd-p-head', 'gwd-p-swap'] };
    const { fix, p } = plan(html, [
      box({ ...head, frame: '320x480', normalLineHeight: 19.5 }),
      box({ ...both, frame: '320x480', normalLineHeight: 19.5 }),
      box({ ...head, frame: '300x250', normalLineHeight: 15 }),
      box({ ...both, frame: '300x250', normalLineHeight: 12.5 }),
    ], { '320x480': [], '300x250': [M250] });
    expect(fix('lineHeight')).toBeUndefined();
    expect(p.manual.map((m) => m.detail)).toEqual(['.gwd-p-head renders 15px and 12.5px in 300x250; set its line-height in GWD.']);
  });

  it('leaves a class to you where its value would reach text inside that has none of its own', () => {
    const sup = { target: 'sup', tag: 'sup', path: [], normal: 15.33, fontLoaded: true };
    const loose = { target: 'span', tag: 'span', path: [{ tag: 'span', classes: [] }], normal: 32, fontLoaded: true };
    const classed = { target: 'span.gwd-span-hl', tag: 'span', path: [{ tag: 'span', classes: ['gwd-span-hl'] }], normal: 32, fontLoaded: true };
    const span = { tag: 'span', classes: ['gwd-span-hl'], inTextParent: true, normalLineHeight: 32, parentLineHeight: 18 };
    for (const d of [sup, loose]) {
      const { fix, p } = plan(html, [box({ ...head, normalLineHeight: 18, inherits: [d] })], { '300x250': [M250] });
      expect(fix('lineHeight')).toBeUndefined();
      expect(p.manual.map((m) => m.detail)).toEqual([`.gwd-p-head: ${d.target} inside it takes its line-height and would go from ${d.normal}px to 18px in 300x250; set their line-heights in GWD.`]);
    }
    // a span with a value of its own keeps it; a span whose class is left to you takes the p's
    const kept = plan(html, [box({ ...head, normalLineHeight: 18, inherits: [classed] }), box(span)], { '300x250': [M250] });
    expect(kept.fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x250: 18px, .gwd-span-hl in 300x250: 32px');
    const unloaded = plan(html, [box({ ...head, normalLineHeight: 18, inherits: [classed] }), box({ ...span, fontLoaded: false })], { '300x250': [M250] });
    expect(unloaded.fix('lineHeight')).toBeUndefined();
    expect(unloaded.p.manual.map((m) => m.detail)).toEqual([
      '.gwd-span-hl: its font had not loaded when it was measured, so its line-height is not fixed automatically. Check the whole ad folder or zip, and let the ad contact other sites if a script loads its fonts, or set it in GWD.',
      '.gwd-p-head: span.gwd-span-hl inside it takes its line-height and would go from 32px to 18px in 300x250; set their line-heights in GWD.',
    ]);
  });

  it('leaves a class to you where it also sits on text styled by another class', () => {
    // .gwd-p-swap is the main class of one text and also on another, mainly .gwd-p-head, that renders another value
    const { fix, p } = plan(html, [
      box({ classes: ['gwd-p-swap'], normalLineHeight: 19.5 }),
      box({ classes: ['gwd-p-head', 'gwd-p-swap'], target: 'p#SA_headline_10', normalLineHeight: 15 }),
    ], { '300x250': [M250] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x250: 15px');
    expect(p.manual.map((m) => m.detail)).toEqual(['.gwd-p-swap is also on p#SA_headline_10, whose spacing its line-height would change in 300x250; set it in GWD.']);
    // a text in a <div> carrying the class takes its value too, though nothing was planned from it
    const div = plan(html, [box({ classes: ['gwd-p-swap'], normalLineHeight: 19.5 }), box({ tag: 'div', classes: ['gwd-p-swap'], target: 'div#SA_text_1' })], { '300x250': [M250] });
    expect(div.fix('lineHeight')).toBeUndefined();
    expect(div.p.manual.map((m) => m.detail)).toEqual(['.gwd-p-swap is also on div#SA_text_1, whose spacing its line-height would change in 300x250; set it in GWD.']);
  });

  it('leaves text that GWD fits to its box to you', () => {
    for (const [fit, note] of [
      ['missing', '.gwd-p-head: GWD fits this text when the ad runs, which needs its gwd-text-fitting.js; check the whole folder or zip.'],
      ['runs', '.gwd-p-head: GWD fits this text to its box when the ad runs, and a fixed line-height would change how it fits; set its line-height in GWD.'],
    ] as const) {
      const { fix, p } = plan(html, [box({ ...head, normalLineHeight: 18, fit })], { '300x250': [M250] });
      expect(fix('lineHeight')).toBeUndefined();
      expect(p.manual.map((m) => m.detail)).toEqual([note]);
    }
  });

  it('counts no line-height or font that browsers drop as invalid', () => {
    const decimalPoint: CssValidator = (_, value) => !/\d,\d/.test(value);
    const noBase = '.gwd-p-head in 300x250 was not measured, and a value in its base rule would reach it there, so its base size gets none; set its line-height in GWD.';
    // The 300x250 block's line-height has a decimal comma, so the base value would reach that size.
    const comma = fixture('mini-ad.html').replace('        line-height: 14px;\n', '        line-height: 1,5;\n');
    const unprobed = plan(comma, [box({ ...head, frame: '320x480', normalLineHeight: 19.5 })], { '320x480': [] }, [], { valid: decimalPoint });
    expect(unprobed.fix('lineHeight')).toBeUndefined();
    expect(unprobed.p.manual.map((m) => m.detail)).toContain(noBase);
    const m250 = parseCss(comma).media[0].start;
    const probed = plan(comma, [box({ ...head, frame: '320x480', normalLineHeight: 19.5, probes: { [m250]: 15 } })], { '320x480': [] }, [], { valid: decimalPoint });
    expect(probed.fix('lineHeight')?.detail).toBe('.gwd-p-head: 19.5px, .gwd-p-head in 300x250: 15px');
    // A font shorthand browsers drop sets no font: an earlier range's font-size still reaches the home block's sizes.
    const H = '(min-width: 305px) and (max-width: 336px) and (min-height: 240px) and (max-height: 490px)';
    const ranges = html.replace('    @media (width: 300px) and (height: 600px) {}', `    @media ${RANGE} {\n      .gwd-p-head {\n        font-size: 20px;\n      }\n    }\n    @media ${H} {\n      .gwd-p-head {\n        font: 1,5px Arial;\n      }\n    }`);
    const ends = ['305x240 (range 305x240 to 336x490)', '336x490 (range 305x240 to 336x490)'];
    const shorthand = plan(ranges, ends.map((frame) => box({ ...head, frame, normalLineHeight: 18 })), Object.fromEntries(ends.map((f) => [f, [H]])), [], { valid: decimalPoint });
    expect(shorthand.fix('lineHeight')).toBeUndefined();
    expect(shorthand.p.manual.map((m) => m.detail)).toContain('.gwd-p-head in 300x250 to 320x480 was not measured, and its value in 305x240 to 336x490 would reach it there; set its line-height in GWD.');
  });

  it('leaves a class to you where an earlier range no frame measured gives it, or what it sits in, a line-height', () => {
    // H is measured at both its ends, where the earlier range does not apply; they overlap in between.
    const H = '(min-width: 305px) and (max-width: 336px) and (min-height: 240px) and (max-height: 490px)';
    const ranges = (earlier: string) => html.replace('    @media (width: 300px) and (height: 600px) {}', `    @media ${RANGE} {\n${earlier}    }\n    @media ${H} {\n      .gwd-p-head {\n        font-family: Arial;\n        font-size: 14px;\n        font-weight: 400;\n        font-style: normal;\n      }\n    }`);
    const ends = ['305x240 (range 305x240 to 336x490)', '336x490 (range 305x240 to 336x490)'];
    const media = Object.fromEntries(ends.map((f) => [f, [H]]));
    const note = '.gwd-p-head in 300x250 to 320x480 was not measured, and its value in 305x240 to 336x490 would reach it there; set its line-height in GWD.';
    const own = plan(ranges('      .gwd-p-head {\n        line-height: 30px;\n      }\n'), ends.map((frame) => box({ ...head, frame, normalLineHeight: 16 })), media);
    expect(own.fix('lineHeight')).toBeUndefined();
    expect(own.p.manual.map((m) => m.detail)).toContain(note);
    // A wrapper's line-height there: observe records the block with a null probe.
    const wrapper = ranges('      .gwd-div-w {\n        line-height: 30px;\n      }\n');
    const range = parseCss(wrapper).media.find((m) => m.media === RANGE)!.start;
    const unknown = plan(wrapper, ends.map((frame) => box({ ...head, frame, normalLineHeight: 16, probes: { [range]: null } })), media);
    expect(unknown.fix('lineHeight')).toBeUndefined();
    expect(unknown.p.manual.map((m) => m.detail)).toContain(note);
    // A font it sets that the home block sets in full is safe.
    const font = plan(ranges('      .gwd-div-w {\n        font-size: 30px;\n      }\n'), ends.map((frame) => box({ ...head, frame, normalLineHeight: 16, probes: { [range]: 35 } })), media);
    expect(font.fix('lineHeight')?.detail).toBe('.gwd-p-head in 305x240 to 336x490: 16px');
  });

  it('gives the base rule nothing where a text that inherits a px sits in a size no frame measured that changes its font', () => {
    const m250 = parseCss(html).media[0].start;
    const { fix, p } = plan(html, [box({ ...head, frame: '320x480', normalLineHeight: 19.5, probes: { [m250]: 15 }, computed: { lineHeight: '20px' } })], { '320x480': [] });
    expect(fix('lineHeight')).toBeUndefined();
    expect(p.manual.map((m) => m.detail)).toEqual([
      '.gwd-p-head in 300x250 was not measured, and a value in its base rule would reach it there, so its base size gets none; set its line-height in GWD.',
    ]);
  });

  it('leaves a class to you where a page it sits on never showed in a size, and offers class-wide fixes there unticked', () => {
    // page2 never showed in 300x250; 300x600 showed both pages, with .gwd-p-head and the button on page2.
    const missing = { marginBlockStart: '', marginBlockEnd: '' };
    const boxes = [
      box({ ...head, frame: '300x600', page: 'page1', normalLineHeight: 19.5, declared: missing }),
      box({ ...head, frame: '300x600', page: 'page2', normalLineHeight: 19.5, declared: missing }),
      box({ classes: ['gwd-p-swap'], frame: '300x600', page: 'page1', declared: { lineHeight: '14px', ...missing } }),
      box({ tag: 'button', classes: ['gwd-empty'], frame: '300x600', page: 'page2', declared: { lineHeight: '20px', width: '100px', height: '30px' }, computed: { color: 'rgb(1, 2, 3)', padding: [1, 6, 1, 6], paddingText: '1px 6px' } }),
      box({ ...head, frame: '300x250', page: 'page1', normalLineHeight: 15, declared: missing }),
      box({ classes: ['gwd-p-swap'], frame: '300x250', page: 'page1', declared: { lineHeight: '14px', ...missing } }),
    ];
    const media = { '300x600': [M600], '300x250': [M250] };
    const shown = plan(html, boxes, media);
    expect(shown.fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x600: 19.5px, .gwd-p-head in 300x250: 15px');
    expect(shown.fix('buttonColor')?.detail).toBe('.gwd-empty (rgb(1, 2, 3))');
    expect(shown.fix('buttonPadding')?.detail).toBe('.gwd-empty');
    const { fix, p } = plan(html, boxes, media, [], { incomplete: ['300x250'] });
    expect(fix('lineHeight')).toBeUndefined();
    expect(fix('buttonColor')).toBeUndefined();
    expect(fix('buttonPadding')).toBeUndefined();
    expect(p.manual.map((m) => m.detail)).toEqual([
      '.gwd-empty may sit on a page that never showed in 300x250, so it was not checked there; set its padding in GWD.',
      '.gwd-empty may sit on a page that never showed in 300x250, so it was not checked there; set its color in GWD.',
      '.gwd-p-head may sit on a page that never showed in 300x250, so it was not checked there; set its line-height in GWD.',
    ]);
    // .gwd-p-swap sits only on page1, which showed everywhere
    expect(fix('marginBlock')?.detail).toBe('.gwd-p-swap');
    expect(fix('marginBlock', true)?.detail).toBe('.gwd-p-head');
    expect(fix('marginBlock', true)?.moves).toBe('It may move text: .gwd-p-head may sit on a page that never showed in 300x250, so it was not checked there. The checklist still asks for it; check the result in the preview.');
  });

  it('treats every class as on a page that never showed where no frame showed every page', () => {
    const only = [box({ ...head, frame: '300x250', page: 'page1', normalLineHeight: 15 })];
    expect(plan(html, only, { '300x250': [M250] }).fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x250: 15px');
    const { fix, p } = plan(html, only, { '300x250': [M250] }, [], { incomplete: ['300x250'] });
    expect(fix('lineHeight')).toBeUndefined();
    expect(p.manual.map((m) => m.detail)).toEqual(['.gwd-p-head may sit on a page that never showed in 300x250, so it was not checked there; set its line-height in GWD.']);
  });

  it('leaves text to you whose lines are not all one height, or whose font an animation changes', () => {
    const mixed = plan(html, [box({ ...head, normalLineHeight: 20, mixedFonts: true })], { '300x250': [M250] });
    expect(mixed.fix('lineHeight')).toBeUndefined();
    expect(mixed.p.manual.map((m) => m.detail)).toEqual(['.gwd-p-head: some of its characters draw in another font (an emoji, a symbol, or Chinese, Japanese or Korean type its font lacks), so its lines are not all one height; set its line-height in GWD.']);
    // under a px it inherits, every line is that px tall
    const inherited = plan(html, [box({ ...head, normalLineHeight: 20, mixedFonts: true, computed: { lineHeight: '24px' } })], { '300x250': [M250] });
    expect(inherited.fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x250: 24px');
    const animated = plan(html, [box({ ...head, normalLineHeight: 18, fontAnimated: true })], { '300x250': [M250] });
    expect(animated.fix('lineHeight')).toBeUndefined();
    expect(animated.p.manual.map((m) => m.detail)).toEqual(['.gwd-p-head: an animation changes its font while the ad runs, and a fixed line-height would not follow it; set its line-height in GWD.']);
    // the same for a text inside that takes its line-height, though it renders the same px now
    const sup: Inheritor = { target: 'sup', tag: 'sup', path: [{ tag: 'sup', classes: [] }], normal: 18, fontLoaded: true, fontAnimated: true };
    const inside = plan(html, [box({ ...head, normalLineHeight: 18, inherits: [sup] })], { '300x250': [M250] });
    expect(inside.fix('lineHeight')).toBeUndefined();
    expect(inside.p.manual.map((m) => m.detail)).toEqual(['.gwd-p-head: sup inside it takes its line-height and has its font changed by an animation, so what it needs changes as it plays in 300x250; set their line-heights in GWD.']);
  });

  it('leaves a class to you where a media query that is not a GWD size changes it in no frame it was measured in', () => {
    const query = '(min-width: 305px) and (max-width: 315px)';
    const handWritten = html.replace('    @media (width: 300px) and (height: 600px) {}', `    @media ${query} {\n      .gwd-p-swap {\n        font-size: 10px;\n      }\n    }`);
    const swap = { tag: 'p', classes: ['gwd-p-swap'], normalLineHeight: 18 };
    const note = `.gwd-p-swap: @media ${query} changes its font or line-height in sizes no frame shows; set its line-height in GWD.`;
    const unseen = plan(handWritten, [box({ ...swap, frame: '300x250' }), box({ ...swap, frame: '320x480' })], { '300x250': [M250], '320x480': [] });
    expect(unseen.fix('lineHeight')).toBeUndefined();
    expect(unseen.p.manual.map((m) => m.detail)).toEqual([note]);
    // where a frame the class was measured in shows it, what it does was measured there
    const seen = plan(handWritten, [box({ ...swap, frame: '310x250' })], { '310x250': [query] });
    expect(seen.fix('lineHeight')?.detail).toBe('.gwd-p-swap: 18px');
    // through an element it sits in, which observe records as a probe
    const block = parseCss(html).media.length;
    const wrapper = html.replace('    @media (width: 300px) and (height: 600px) {}', `    @media ${query} {\n      .gwd-div-w {\n        line-height: 30px;\n      }\n    }`);
    const start = parseCss(wrapper).media[block - 1].start;
    const probed = plan(wrapper, [box({ ...swap, frame: '320x480', probes: { [start]: null } })], { '320x480': [] });
    expect(probed.p.manual.map((m) => m.detail)).toEqual([note]);
  });

  it('leaves a class to you where it also sits on an element without text of its own whose texts would take its value', () => {
    const inner: Inheritor = { target: 'div#SA_inner_1', tag: 'div', path: [{ tag: 'div', classes: [] }], normal: 11, fontLoaded: true };
    const wrap = { tag: 'div', classes: ['gwd-p-swap'], target: 'div#SA_wrap_1', holder: true };
    const { fix, p } = plan(html, [box({ classes: ['gwd-p-swap'], normalLineHeight: 18 }), box({ ...wrap, inherits: [inner] })], { '300x250': [M250] });
    expect(fix('lineHeight')).toBeUndefined();
    expect(p.manual.map((m) => m.detail)).toEqual(['.gwd-p-swap is also on div#SA_wrap_1, and div#SA_inner_1 inside it takes its line-height and would go from 11px to 18px in 300x250; set it in GWD.']);
    // texts inside that render the same value now keep it
    const same = plan(html, [box({ classes: ['gwd-p-swap'], normalLineHeight: 18 }), box({ ...wrap, inherits: [{ ...inner, normal: 18 }] })], { '300x250': [M250] });
    expect(same.fix('lineHeight')?.detail).toBe('.gwd-p-swap in 300x250: 18px');
  });

  it('gives a span inside text line-height: inherit, and leaves sizes that disagree to you', () => {
    const { fix, p } = plan(html, [
      box({ tag: 'span', classes: ['gwd-span-hl'], inTextParent: true, normalLineHeight: 19.5, parentLineHeight: 19.5 }),
      box({ ...head, frame: '300x600', normalLineHeight: 19.5 }),
      box({ ...head, frame: '300x600 again', normalLineHeight: 21 }),
    ], { '300x600': [M600], '300x600 again': [M600] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-span-hl: inherit');
    expect(p.manual.map((m) => m.detail)).toEqual(['.gwd-p-head renders 19.5px and 21px in 300x600; set its line-height in GWD.']);
  });
});

describe('buttons', () => {
  const html = fixture('mini-ad.html');
  const tick = { tag: 'button', classes: ['gwd-button-tick'], target: 'button#SA_cta_14', declared: { lineHeight: '24px', color: 'rgb(255, 255, 255)', width: '177px', height: '24px' } };

  it('turns a left inset on centred text into text-indent', () => {
    const { fix, applied } = plan(html, [box({ ...tick, computed: { padding: [0, 0, 0, 20], paddingText: '0px 0px 0px 20px', textAlign: 'center' } })], { '300x250': [M250] });
    expect(fix('buttonPadding')?.detail).toBe('.gwd-button-tick (its 20px left inset becomes text-indent)');
    expect(applied('buttonPadding')).toContain('      height: 24px;\n      padding: 0px;\n      text-indent: 20px;\n      position: absolute;');
  });

  it('offers zeroing browser padding on a content-sized button as a fix that moves text', () => {
    const cta = { tag: 'button', classes: ['gwd-button-cta'], declared: { lineHeight: '20px', color: 'rgb(255, 255, 255)' } };
    const noPad = html.replace('      font-size: 17px;\n      padding: 0px;\n', '      font-size: 17px;\n');
    const { fix } = plan(noPad, [box({ ...cta, computed: { padding: [1, 6, 1, 6], paddingText: '1px 6px' } })], { '300x250': [M250] });
    expect(fix('buttonPadding')).toBeUndefined();
    expect(fix('buttonPadding', true)?.detail).toBe('.gwd-button-cta');
  });

  it('declares the color a button renders, unless sizes render different ones', () => {
    const plain = { tag: 'button', classes: ['gwd-empty'], declared: { lineHeight: '20px' } };
    const same = plan(html, [box({ ...plain, computed: { color: 'rgb(1, 2, 3)' } })], { '300x250': [M250] });
    expect(same.applied('buttonColor')).toContain('    .gwd-empty {\n      color: rgb(1, 2, 3);\n    }');
    const mixed = plan(html, [box({ ...plain, computed: { color: 'rgb(1, 2, 3)' } }), box({ ...plain, frame: '300x600', computed: { color: 'rgb(9, 9, 9)' } })], {});
    expect(mixed.fix('buttonColor')).toBeUndefined();
    expect(mixed.p.manual[0].detail).toContain('renders rgb(1, 2, 3) and rgb(9, 9, 9)');
  });
});

describe('margin-block', () => {
  const html = fixture('mini-ad.html');

  it('is safe on positioned text, and marked as moving where a default margin is in play', () => {
    const missing = { marginBlockStart: '', marginBlockEnd: '' };
    const { fix } = plan(html, [
      box({ classes: ['gwd-p-head'], declared: { lineHeight: '14px', ...missing } }),
      box({ classes: ['gwd-p-swap'], declared: { lineHeight: '14px', ...missing }, computed: { position: 'static', marginTop: 16, marginBottom: 16 } }),
    ], {});
    expect(fix('marginBlock')?.detail).toBe('.gwd-p-head');
    expect(fix('marginBlock', true)?.moves).toContain('.gwd-p-swap has margin 16px / 16px today');
  });
});

describe('keyframes and fades', () => {
  const html = fixture('mini-ad.html');

  it('deletes unchanged keyframe values only where they match the element', () => {
    expect(plan(html, [], {}).fix('keyframes')?.detail).toBe('4 declarations in 2 keyframes blocks');
    const unsafe = plan(html, [], {}, [{ animation: 'gwd-gen-hand_gwd-keyframes' }]);
    expect(unsafe.fix('keyframes')).toBeUndefined();
    expect(unsafe.p.manual[0].detail).toContain('gwd-gen-hand_gwd-keyframes: deleting transform');
  });

  it('starts text fades at 0.001', () => {
    const out = plan(html, [], {}).applied('textFade');
    expect(out.match(/opacity: 0\.001;/g)).toHaveLength(2);
  });
});
