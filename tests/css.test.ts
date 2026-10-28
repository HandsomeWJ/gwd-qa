import { describe, expect, it } from 'vitest';
import { applyEdits, insertDecl, insertRule, mergeEdits, removeDecl, setValue } from '../src/css/edit';
import { elementClass, lastCompound, parseCss, singleClass, sizeOfMedia } from '../src/css/parse';
import { fixture } from './fixture';

const html = fixture('mini-ad.html');

describe('parseCss', () => {
  const css = parseCss(html);

  it('finds rules, media blocks and keyframes with their context', () => {
    expect(css.styleBlocks).toHaveLength(2);
    expect(css.media.map((m) => sizeOfMedia(m.media))).toEqual(['300x250', '300x600']);
    const head = css.rules.filter((r) => r.selector === '.gwd-p-head');
    expect(head.map((r) => r.media && sizeOfMedia(r.media))).toEqual([null, '300x250']);
    expect(css.keyframes.map((k) => [k.name, sizeOfMedia(k.media)])).toEqual([
      ['gwd-gen-hand_gwd-keyframes', null],
      ['gwd-gen-fade_gwd-keyframes', null],
      ['gwd-gen-hand_gwd-keyframes', '300x250'],
    ]);
  });

  it('keeps exact offsets for every declaration', () => {
    for (const rule of css.rules) {
      for (const d of rule.decls) {
        expect(html.slice(d.start, d.end)).toBe(`${d.prop}: ${d.value};`);
        expect(html.slice(d.valueStart, d.valueEnd)).toBe(d.value);
      }
    }
    const kf = css.keyframes[0];
    expect(kf.frames.map((f) => f.selector)).toEqual(['0%', '100%']);
    expect(kf.frames[0].decls.map((d) => d.prop)).toEqual(['visibility', 'opacity', 'transform', 'animation-timing-function']);
  });

  it('parses an empty rule and an empty media block', () => {
    expect(css.rules.find((r) => r.selector === '.gwd-empty')?.decls).toEqual([]);
    expect(css.media[1].close - css.media[1].open).toBe(1);
  });
});

describe('selector helpers', () => {
  it('recognises single-class selectors and last compounds', () => {
    expect(singleClass('.gwd-p-head')).toBe('gwd-p-head');
    expect(singleClass('.a.b')).toBeNull();
    expect(singleClass('#page1 .a')).toBeNull();
    expect(lastCompound('#page1.gwd-play-animation .gwd-gen-hand')).toBe('.gwd-gen-hand');
    expect(lastCompound('[data-gwd-group="G"] .x.y')).toBe('.x.y');
  });
});

describe('edits', () => {
  const css = parseCss(html);
  const rule = (sel: string, media: string | null = null) => {
    const r = css.rules.find((x) => x.selector === sel && (media === null ? x.media === null : sizeOfMedia(x.media) === media));
    if (!r) throw new Error(sel);
    return r;
  };

  it('appends a declaration on its own line with matching indent', () => {
    const out = applyEdits(html, [insertDecl(html, rule('.gwd-p-head'), 'margin-block: 0px auto;')]);
    expect(out).toContain('      top: 0px;\n      margin-block: 0px auto;\n    }');
  });

  it('fills an empty one-line rule', () => {
    const out = applyEdits(html, [insertDecl(html, rule('.gwd-empty'), 'color: red;')]);
    expect(out).toContain('    .gwd-empty {\n      color: red;\n    }');
  });

  it('removes a declaration line and replaces a value', () => {
    const tick = rule('.gwd-button-tick');
    const pad = tick.decls.filter((d) => d.prop.startsWith('padding'));
    const out = applyEdits(html, [
      ...pad.slice(1).map((d) => removeDecl(html, d)),
      setValue(pad[0], '0px'),
    ]);
    expect(out).toContain('      height: 24px;\n      padding-block: 0px;\n      position: absolute;');
  });

  it('adds rules to a media block and to an empty one', () => {
    const [m250, m600] = parseCss(html).media;
    const out = applyEdits(html, [
      insertRule(html, m250, '.gwd-p-swap', ['line-height: 14px;']),
      insertRule(html, m600, '.gwd-p-swap', ['line-height: 19.5px;']),
    ]);
    expect(out).toContain('      }\n      .gwd-p-swap {\n        line-height: 14px;\n      }\n    }\n    @media (width: 300px) and (height: 600px) {\n      .gwd-p-swap {\n        line-height: 19.5px;\n      }\n    }');
    expect(parseCss(out).rules.filter((r) => r.selector === '.gwd-p-swap')).toHaveLength(3);
  });

  it('keeps the rules of a block written on one line when it adds one', () => {
    const src = '<style>\n    @media (width: 300px) and (height: 600px) { .gwd-p-swap { font-size: 20px; top: 40px; } }\n</style>';
    const out = applyEdits(src, [insertRule(src, parseCss(src).media[0], '.gwd-p-head', ['line-height: 19.5px;'])]);
    expect(out).toContain('{ .gwd-p-swap { font-size: 20px; top: 40px; } \n      .gwd-p-head {\n        line-height: 19.5px;\n      }\n    }');
    expect(parseCss(out).rules.map((r) => r.selector)).toEqual(['.gwd-p-swap', '.gwd-p-head']);
    const style = '  <style>.a { color: red; }</style>';
    const added = applyEdits(style, [insertRule(style, parseCss(style).styleBlocks[0], '.b', ['margin-block: 0px auto;'], true)]);
    expect(parseCss(added).rules.map((r) => r.selector)).toEqual(['.a', '.b']);
  });

  it('adds several rules to a blank block, on one line or several', () => {
    for (const body of ['', ' ', '\n    ']) {
      const src = `<style>\n    @media (width: 300px) and (height: 600px) {${body}}\n</style>`;
      const block = parseCss(src).media[0];
      const out = applyEdits(src, mergeEdits([insertRule(src, block, '.a', ['line-height: 18px;']), insertRule(src, block, '.b', ['line-height: 14px;'])]));
      expect(parseCss(out).rules.map((r) => `${r.media} ${r.selector}`).sort(), JSON.stringify(body)).toEqual(['(width: 300px) and (height: 600px) .a', '(width: 300px) and (height: 600px) .b']);
    }
  });

  it('adds a rule at the end of a style element', () => {
    const block = parseCss(html).styleBlocks[1];
    const out = applyEdits(html, [insertRule(html, block, '.gwd-new', ['margin-block: 0px auto;'], true)]);
    expect(out).toContain('    @media (width: 300px) and (height: 600px) {}\n    .gwd-new {\n      margin-block: 0px auto;\n    }\n  </style>');
  });

  it('refuses overlapping edits', () => {
    expect(() => applyEdits('abcdef', [{ start: 1, end: 4, text: '' }, { start: 3, end: 5, text: '' }])).toThrow();
  });
});

describe('elementClass', () => {
  it("reads the element's own class from a plain rule and from a GWD group's", () => {
    expect(elementClass('.gwd-p-a')).toBe('gwd-p-a');
    expect(elementClass('[data-gwd-group="Perks"] .gwd-grp-k2.gwd-span-one')).toBe('gwd-span-one');
    expect(elementClass(' [data-gwd-group="Perks"]  .gwd-span-one.gwd-grp-k2 ')).toBe('gwd-span-one');
    expect(elementClass('.gwd-play-animation [data-gwd-group="Perks"] .gwd-gen-ingwdanimation')).toBeNull();
    expect(elementClass('[data-gwd-group="Perks"]')).toBeNull();
    expect(elementClass('#page1 .gwd-p-a')).toBeNull();
  });
});
