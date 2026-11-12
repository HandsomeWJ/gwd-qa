import { describe, expect, it } from 'vitest';
import { applyEdits, mergeEdits, removeDecl, setValue } from '../src/css/edit';
import { parseCss } from '../src/css/parse';
import { staticAudit } from '../src/audit/static';
import { fixture } from './fixture';

const html = fixture('mini-ad.html');

describe('staticAudit', () => {
  const report = staticAudit(html);

  it('reads sizes and the environment', () => {
    expect(report.sizes).toEqual(['300x250', '300x600']);
    expect(report.environment).toBe('gwd-genericad');
    expect(report.findings.filter((f) => f.check === 'environment')).toEqual([]);
  });

  it('finds unchanged keyframe properties per block, base and per size', () => {
    expect(report.unchanged.map((u) => [u.block.name, u.block.media, u.props])).toEqual([
      ['gwd-gen-hand_gwd-keyframes', null, ['transform']],
      ['gwd-gen-hand_gwd-keyframes', '(width: 300px) and (height: 250px)', ['transform']],
    ]);
  });

  it('finds text that fades in from opacity 0, from keyframes and from rules', () => {
    const fades = report.findings.filter((f) => f.check === 'textFade');
    expect(fades.map((f) => f.target)).toEqual(['gwd-gen-fade_gwd-keyframes', 'p#SA_headline_11']);
    expect(report.fadeDecls.map((d) => html.slice(d.start, d.end))).toEqual(['opacity: 0;', 'opacity: 0;']);
  });

  it('counts a value the first and last keyframes share as unchanged, where a keyframe between them leaves it out', () => {
    const unchanged = (frames: [string, string][]) => {
      const kf = frames.map(([at, decls]) => `      ${at} {\n${decls.split(';').filter((d) => d.trim()).map((d) => `        ${d.trim()};\n`).join('')}      }\n`).join('');
      const ad = html.replace('  </style>', `    @keyframes kf-mid {\n${kf}    }\n    .gwd-p-swap {\n      animation: 1s linear 0s 1 normal forwards kf-mid;\n    }\n  </style>`);
      const report = staticAudit(ad);
      return [report.unchanged.filter((u) => u.block.name === 'kf-mid').flatMap((u) => u.props), report.findings.filter((f) => f.target === 'kf-mid').map((f) => f.message)];
    };
    expect(unchanged([['0%', 'width: 160px; transform: scale(1)'], ['25.3%', 'transform: scale(1.02)'], ['100%', 'width: 160px; transform: scale(1.1)']])).toEqual([['width'], ['width never changes (160px).']]);
    expect(unchanged([['from', 'width: 160px; transform: scale(1)'], ['50%', 'transform: scale(2)'], ['to', 'width: 160px; transform: scale(1)']])[0]).toEqual(['width']);
    // not where an end leaves it out, so it animates from the element's own value, or a keyframe sets another
    expect(unchanged([['0%', 'width: 160px; transform: scale(1)'], ['50%', 'width: 160px'], ['100%', 'transform: scale(1.1)']])[0]).toEqual([]);
    expect(unchanged([['0%', 'width: 160px'], ['50%', 'width: 150px'], ['100%', 'width: 160px']])[0]).toEqual([]);
  });

  it('flags a text fade that starts anywhere below 0.01, and passes one that starts at 0.01', () => {
    const startingAt = (v: string) => {
      const ad = html.replace('    @keyframes gwd-gen-fade_gwd-keyframes {\n      0% {\n        opacity: 0;', `    @keyframes gwd-gen-fade_gwd-keyframes {\n      0% {\n        opacity: ${v};`);
      return staticAudit(ad).findings.filter((f) => f.check === 'textFade' && f.target === 'gwd-gen-fade_gwd-keyframes').map((f) => f.message);
    };
    expect(startingAt('0.001')).toEqual([expect.stringContaining('from opacity 0.001')]);
    expect(startingAt('0.001')[0]).toContain('start at 0.01.');
    expect(startingAt('0.5%')).toHaveLength(1);
    expect(startingAt('0.01')).toEqual([]);
    expect(startingAt('1%')).toEqual([]);
    expect(startingAt('0.2')).toEqual([]);
  });

  it('lists copy, base and per size, with entities decoded', () => {
    expect(report.copy).toContainEqual({ target: 'p#SA_headline_10', size: 'base', text: 'Sample headline' });
    expect(report.copy).toContainEqual({ target: 'p#SA_headline_10', size: '300x250', text: 'Sample BIG headline for this size' });
    expect(report.copy).toContainEqual({ target: 'button#SA_cta_14', size: 'base', text: 'Ticker item' });
    expect(report.copy.filter((c) => c.text === 'Tap')).toHaveLength(1);
  });

  it('marks keyframes that nothing mentions but their own @keyframes rules as unused', () => {
    const orphan = html.replace('  </style>', '    @keyframes kf-orphan {\n      0% {\n        left: 5px;\n      }\n      100% {\n        left: 5px;\n      }\n    }\n  </style>');
    expect(staticAudit(orphan).unchanged.map((u) => [u.block.name, u.unused])).toEqual([
      ['kf-orphan', true],
      ['gwd-gen-hand_gwd-keyframes', false],
      ['gwd-gen-hand_gwd-keyframes', false],
    ]);
    // A script that names it may run it.
    const named = orphan.replace('</body>', '<script>var kf = "kf-orphan";</script>\n</body>');
    expect(staticAudit(named).unchanged.find((u) => u.block.name === 'kf-orphan')?.unused).toBe(false);
  });

  it('flags environments other than Non-Google Ad', () => {
    const dv360 = html.replace('content="gwd-genericad"', 'content="gwd-dv360"');
    expect(staticAudit(dv360).findings.find((f) => f.check === 'environment')?.message).toContain('gwd-dv360');
  });
});

describe('mergeEdits', () => {
  it('lets a deletion win over an edit inside the deleted line', () => {
    const css = parseCss(html);
    const fade = css.keyframes[1].frames[0].decls.find((d) => d.prop === 'opacity')!;
    const merged = mergeEdits([setValue(fade, '0.01'), removeDecl(html, fade)]);
    expect(merged).toHaveLength(1);
    expect(applyEdits(html, merged)).not.toContain('opacity: 0;\n        animation-timing-function: linear;\n      }\n      100%');
  });
});

describe('text that starts hidden', () => {
  it('ignores an invisible element with no text, such as a click overlay', () => {
    const withOverlay = html.replace('.gwd-empty {}', '.gwd-empty {}\n    .gwd-overlay {\n      opacity: 0;\n    }')
      .replace('</gwd-page>', '<button class="gwd-overlay" id="SA_clicktag_1"></button></gwd-page>');
    const targets = staticAudit(withOverlay).findings.filter((f) => f.check === 'textFade').map((f) => f.target);
    expect(targets).not.toContain('button#SA_clicktag_1');
  });
});

describe('GWD groups', () => {
  // GWD keeps a group's elements in a <template> and copies them into each group that names it.
  const html = fixture('group-ad.html');
  const report = staticAudit(html);

  it('finds text in a group, and the groups and elements text sits in, that start at opacity 0', () => {
    const fades = report.findings.filter((f) => f.check === 'textFade').map((f) => f.target);
    expect(fades).toEqual([
      'gwd-gen-in_gwd-keyframes',
      'div#SA_group_1', // filled with the group's text when the ad runs
      'span.gwd-span-one.gwd-grp-k2',
    ]);
    // not the image beside them, on the page or in the group, nor the CTA's group (div#SA_group_2,
    // class gwd-div-cta): CTAs are exempt from the 0.01 start (QA checklist, 2026-11-13)
    expect(report.fadeDecls.map((d) => html.slice(d.start - 60, d.start).trim().split('\n')[0])).not.toContain('.gwd-image-dot {');
    expect(report.fadeDecls.map((d) => html.slice(d.start - 60, d.start).trim().split('\n')[0])).not.toContain('.gwd-div-cta {');
    expect(report.fadeDecls).toHaveLength(3);
  });

  it("lists a group's copy where the group is used", () => {
    expect(report.copy.map((c) => [c.target, c.size, c.text])).toEqual([
      ['p#SA_headline_1', 'base', 'Big sale'],
      ['span.gwd-span-one.gwd-grp-k2', 'base', 'Two-year guarantee'],
      ['span.gwd-span-one.gwd-grp-k2', '300x250', 'Two-year'],
      ['span.gwd-grp-k2.gwd-span-two.gwd-gen-in', 'base', 'Easy returns'],
      ['button#SA_cta_1', 'base', 'BUY IT'],
    ]);
  });

  it('knows which ignored values style text, in a group too', () => {
    const invalid = html
      .replace('      line-height: 16px;\n      opacity: 0;', '      line-height: 16px;\n      opacity: 0,5;')
      .replace('    .gwd-image-dot {\n      position: absolute;\n      opacity: 0;', '    .gwd-image-dot {\n      position: absolute;\n      opacity: 0,5;')
      .replace('<div class="gwd-div-cta" id="SA_group_2">', '<div class="gwd-div-cta" id="SA_group_2" style="opacity: 0,2">')
      .replace('<gwd-image class="gwd-image-dot" id="SA_dot_1">', '<gwd-image class="gwd-image-dot" id="SA_dot_1" style="opacity: 0,2">');
    // Decimal commas are what browsers reject here; happy-dom has no CSS.supports to ask.
    const values = staticAudit(invalid, parseCss(invalid), (_prop, value) => !/\d,\d/.test(value)).cssValues;
    expect(values.map((v) => [v.target, v.showsText])).toEqual([
      ['.gwd-image-dot', false],
      ['[data-gwd-group="Perks"] .gwd-grp-k2.gwd-span-one', true],
      ['div#SA_group_2', true],
      ['gwd-image#SA_dot_1', false],
    ]);
  });
});

describe('text fade-in, as the QA checklist of 2026-11-13 has it', () => {
  const ad = `<!DOCTYPE html>
<html>
<head>
  <meta name="environment" content="gwd-genericad">
  <style type="text/css">
    .gwd-p-a { opacity: 0.1; }
    .gwd-p-b { opacity: 0.1; }
    .gwd-p-c { opacity: 0; }
    .gwd-p-d { opacity: 0; }
    @keyframes rise {
      0% { opacity: 0.1; }
      100% { opacity: 1; }
    }
    @keyframes fx {
      0% { opacity: 0; }
      100% { opacity: 1; }
    }
    .gwd-play-animation .gwd-p-a { animation: 1s linear 0s 1 normal forwards rise; }
    .gwd-play-animation .gwd-p-e { animation: 1s linear 0s 1 normal forwards fx; }
  </style>
</head>
<body>
  <gwd-genericad id="gwd-ad">
    <p class="gwd-p-a" id="SA_headline_1">Fades in from 0.1</p>
    <p class="gwd-p-b" id="SA_note_1">Faint on purpose</p>
    <p class="gwd-p-c" id="SA_cta_text_1">Shop now</p>
    <p class="gwd-p-d" gwd-text-effect="">Effect</p>
    <p class="gwd-p-e" id="SA_ctaLabel_2">Learn more</p>
  </gwd-genericad>
</body>
</html>
`;
  const report = staticAudit(ad);
  const fades = report.findings.filter((f) => f.check === 'textFade');

  it('leaves CTAs and text effects alone, whatever they start at', () => {
    expect(fades.map((f) => f.target)).toEqual(['rise', 'p#SA_headline_1']);
    expect(report.fadeDecls).toEqual([]);
  });

  it('flags a fade in from 0.1, never changing it, and leaves text that is only faint', () => {
    expect(fades.every((f) => f.level === 'fail' && f.hint === 'Starting at 0.01 instead makes the text fainter at the start, so change it in GWD if that is right.')).toBe(true);
    expect(fades[0].message).toBe('Fades text in from opacity 0.1 (p#SA_headline_1); the checklist wants 0.01.');
    expect(fades[1].message).toBe('.gwd-p-a starts it at opacity 0.1, and a keyframes animation fades it in; the checklist wants 0.01.');
    expect(report.fadeVisible.map(({ target, value, decl }) => [target, value, decl?.prop])).toEqual([['rise', '0.1', 'opacity'], ['p#SA_headline_1', '0.1', 'opacity']]);
  });
});
