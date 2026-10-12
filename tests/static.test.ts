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

  it('lists copy, base and per size, with entities decoded', () => {
    expect(report.copy).toContainEqual({ target: 'p#SA_headline_10', size: 'base', text: 'Sample headline' });
    expect(report.copy).toContainEqual({ target: 'p#SA_headline_10', size: '300x250', text: 'Sample BIG headline for this size' });
    expect(report.copy).toContainEqual({ target: 'button#SA_cta_14', size: 'base', text: 'Ticker item' });
    expect(report.copy.filter((c) => c.text === 'Tap')).toHaveLength(1);
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
    const merged = mergeEdits([setValue(fade, '0.001'), removeDecl(html, fade)]);
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
