import { describe, expect, it } from 'vitest';
import { applyEdits, mergeEdits } from '../src/css/edit';
import { parseCss } from '../src/css/parse';
import { staticAudit } from '../src/audit/static';
import type { Box } from '../src/audit/types';
import { planFixes } from '../src/fix/plan';
import { box } from './boxes';
import { fixture } from './fixture';

const M250 = '(width: 300px) and (height: 250px)';
const M600 = '(width: 300px) and (height: 600px)';
const RANGE = '(min-width: 300px) and (max-width: 320px) and (min-height: 250px) and (max-height: 480px)';

function plan(html: string, boxes: Box[], media: Record<string, string[]>, safety: { animation: string }[] = []) {
  const css = parseCss(html);
  const report = staticAudit(html, css);
  const p = planFixes({ html, css, boxes, media: new Map(Object.entries(media).map(([k, v]) => [k, new Set(v)])), report, safety });
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
    expect(p.manual[0].detail).toContain('its web font was missing or still loading');
  });

  it('accepts a font whose metrics round differently at different sizes', () => {
    // Chromium rounds ascent and descent to whole pixels: 8px -> 10, 15px -> 17 (ratios 1.25 and 1.13)
    const { fix } = plan(html, [
      box({ ...head, frame: '300x250', size: '300x250', normalLineHeight: 10, computed: { fontSize: 8, fontFamily: 'Brand' } }),
      box({ ...head, frame: '300x600', size: '300x600', normalLineHeight: 17, computed: { fontSize: 15, fontFamily: 'Brand' } }),
    ], { '300x250': [M250], '300x600': [M600] });
    expect(fix('lineHeight')?.detail).toBe('.gwd-p-head in 300x250: 10px, .gwd-p-head in 300x600: 17px');
  });

  it('covers a size that sets its own font-size but was not measured', () => {
    // only the base size is measured; 300x250 has its own font-size, which the base value must not reach
    const { applied } = plan(html, [
      box({ ...head, frame: '320x480', normalLineHeight: 16, computed: { fontSize: 16, fontFamily: 'Brand' } }),
    ], { '320x480': [] });
    expect(applied('lineHeight')).toContain('      top: 0px;\n      line-height: 16px;\n    }');
    expect(applied('lineHeight')).toContain('        font-size: 12px;\n        line-height: 12px;\n      }');
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
