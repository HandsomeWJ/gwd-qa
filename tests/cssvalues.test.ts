import { describe, expect, it } from 'vitest';
import { applyEdits, mergeEdits } from '../src/css/edit';
import { parseCss } from '../src/css/parse';
import { cssValueIssues, type CssValidator } from '../src/audit/cssvalues';
import { staticAudit } from '../src/audit/static';
import type { Box } from '../src/audit/types';
import { planFixes } from '../src/fix/plan';
import { box } from './boxes';

// Stands in for CSS.supports, which happy-dom stubs to accept everything.
const VALUES: Record<string, RegExp> = {
  opacity: /^\d*\.?\d+$/,
  'font-size': /^\d*\.?\d+px$/,
  left: /^-?\d*\.?\d+px$/,
  padding: /^(\d*\.?\d+px ?){1,4}$/,
  color: /^(red|white)$/,
  'font-family': /^.+$/,
  transition: /^(all \d*\.?\d+s linear|opacity \d*\.?\d+s cubic-bezier\((\d*\.?\d+, ?){3}\d*\.?\d+\))$/,
  transform: /^scale\(\d+(, ?\d+)?\)$/,
  'background-size': /^(auto|cover|contain)$/,
  'box-shadow': /^(\d*\.?\d+px ){3}rgba\((\d*\.?\d+, ?){3}\d*\.?\d+\)$/,
};
const valid: CssValidator = (prop, value) => (value === 'inherit' ? Object.hasOwn(VALUES, prop) : VALUES[prop]?.test(value) ?? false);
const issues = (html: string) => cssValueIssues(html, parseCss(html), valid);

const page = (head: string, body = '') => `<!DOCTYPE html>
<html>
<head>
${head}
</head>
<body>
${body}
</body>
</html>
`;

const STYLE = `  <style type="text/css">
    .gwd-p-a {
      opacity: 0,5;
      font-size: 12,5px !important;
      -webkit-text-stroke: 0,5px;
      zoomy: 0,3;
      color: red;
    }
    @keyframes kf-fade {
      0% {
        opacity: 0,2;
      }
      100% {
        opacity: 1;
      }
    }
    @media (width: 300px) and (height: 250px) {
      .gwd-p-a {
        left: 1,5px;
      }
    }
  </style>`;

const HANDLERS = `  <script type="text/javascript" gwd-events="handlers">
    window.gwd = window.gwd || {};
    gwd.framechange_savings = function(event) {
      // GWD Predefined Function
      gwd.actions.events.setInlineStyle('navigation3_3', 'opacity: 0,3;');
      gwd.actions.events.setInlineStyle('SA_cta_2', 'transition: all 0.2s linear; color: white;');
    };
  </script>
  <script gwd-served-sizes="" type="application/json">["300x250"]</script>`;

const SCRIPT = `  <script>
    function fade(el) {
      if (/'/.test(el.id)) el.style.opacity = '0,7';
      el.style.cssText = 'opacity: 0,8; color: red';
      el.setAttribute('style', "left: 3,5px");
      document.getElementById('SA_cta_2').style.setProperty('opacity', '0,9');
      document.querySelector('#x').style.fontSize = '11,5px';
    }
    var tick = () => {
      el.style.transform = 'scale(1,05)';
      gwd.actions.events.setInlineStyle(event.target.id, 'font-family: \\'A;B\\'; opacity: 0,4');
    };
  </script>`;

describe('cssValueIssues', () => {
  it('finds invalid values in style blocks, style attributes and scripts, naming where each is', () => {
    const html = page(`${STYLE}\n${HANDLERS}`, `  <div id="SA_bg_1" style="font-family: &quot;A;B&quot;; opacity: 0,6"></div>
  <p class="gwd-p-a gwd-play-animation" style='left: 2,5px'>Text</p>
${SCRIPT}`);
    const found = issues(html);
    expect(found.map((v) => [v.target, v.via, v.handler, `${v.prop}: ${v.value}`, v.fixed])).toEqual([
      ['.gwd-p-a', '', null, 'opacity: 0,5', '0.5'],
      ['.gwd-p-a', '', null, 'font-size: 12,5px', '12.5px'],
      ['kf-fade 0%', '', null, 'opacity: 0,2', '0.2'],
      ['.gwd-p-a in 300x250', '', null, 'left: 1,5px', '1.5px'],
      ['navigation3_3', 'setInlineStyle', 'gwd.framechange_savings', 'opacity: 0,3', '0.3'],
      ['div#SA_bg_1', 'style attribute', null, 'opacity: 0,6', '0.6'],
      ['p.gwd-p-a', 'style attribute', null, 'left: 2,5px', '2.5px'],
      ['el', 'style.opacity', 'fade', 'opacity: 0,7', '0.7'],
      ['el', 'style.cssText', 'fade', 'opacity: 0,8', '0.8'],
      ['el', "setAttribute('style')", 'fade', 'left: 3,5px', '3.5px'],
      ['SA_cta_2', 'style.setProperty', 'fade', 'opacity: 0,9', '0.9'],
      ['#x', 'style.fontSize', 'fade', 'font-size: 11,5px', '11.5px'],
      ['event.target.id', 'setInlineStyle', 'tick', 'opacity: 0,4', '0.4'],
    ]);
    // Offsets point at the value as written, past entities and escapes, and before !important.
    expect(found.map((v) => html.slice(v.start, v.end))).toEqual(found.map((v) => v.value));
  });

  it('skips unknown and vendor properties, JSON and template scripts, comments, and strings that are not CSS', () => {
    const html = page(`  <script type="application/json">gwd.actions.events.setInlineStyle('a', 'opacity: 0,3');</script>
  <script gwd-served-sizes="">el.style.opacity = '0,3';</script>
  <script type="text/template">el.style.opacity = '0,3';</script>
  <script src="ad.js">el.style.opacity = '0,3';</script>
  <script>
    // el.style.opacity = '0,3';
    /* gwd.actions.events.setInlineStyle('a', 'opacity: 0,3'); */
    gwd.actions.events.setInlineStyle('a', 'Save 0,3 today');
    gwd.actions.events.setInlineStyle('a', 'opacity: ' + level);
    gwd.actions.events.setInlineStyle('a, opacity: 0,3;');
    el.style.cssText = 'opacity: 0,3' + more;
    el.style.cssText = \`opacity: \${level},3\`;
    el.setAttribute('title', 'opacity: 0,3');
    alert('opacity: 0,3');
    if (el.style.opacity == '0,3') done();
    var note = "el.style.opacity = '0,3'";
    el.style.webkitTransform = 'scale(0,,5)';
    el.style.zoomy = '0,3';
    gwd.actions.events.setInlineStyle('a', 'zoomy: 0,3; -moz-opacity: 0,3');
  </script>`, `  <!-- <div style="opacity: 0,3"></div> -->
  <textarea>&lt;div style="opacity: 0,3"&gt;</textarea>`);
    expect(issues(html)).toEqual([]);
  });

  it('accepts everything when the browser cannot check', () => {
    expect(cssValueIssues(page(STYLE), parseCss(page(STYLE)), () => true)).toEqual([]);
  });

  it('takes a literal as the value only when the expression ends after it', () => {
    const html = page(`  <script>
    function pick(el, c, v) {
      el.style.backgroundSize = "none" != c ? c : "auto";
      el.style.opacity = "0,5" == v ? "1" : "0";
      el.style.opacity = '0,5' || v;
      el.style.opacity = '0,5' && v;
      el.style.opacity = '0,5' < v;
      el.style.opacity = '0,5' in v;
      el.style.cssText = 'opacity: 0,5' === v ? '' : v;
    }
    function set(el) {
      el.style.opacity = '0,1'
      el.style.opacity = '0,2', el.style.left = '1,5px';
      (el.style.opacity = '0,3');
      [el.style.opacity = '0,4'];
      if (el) { el.style.opacity = '0,6' }
    }
  </script>
  <script>el.style.opacity = '0,7'</script>`);
    expect(issues(html).map((v) => [v.handler, `${v.prop}: ${v.value}`, v.fixed])).toEqual([
      ['set', 'opacity: 0,1', '0.1'],
      ['set', 'opacity: 0,2', '0.2'],
      ['set', 'left: 1,5px', '1.5px'],
      ['set', 'opacity: 0,3', '0.3'],
      ['set', 'opacity: 0,4', '0.4'],
      ['set', 'opacity: 0,6', '0.6'],
      [null, 'opacity: 0,7', '0.7'],
    ]);
  });

  it("skips GWD's own runtime inlined in the HTML, which the ad cannot change", () => {
    const html = page(`  <script data-source="gwdimage_min.js" data-version="17" data-exports-type="gwd-image">a.style.opacity = '0,1';</script>
  <script data-exports-type="gwd-page">a.style.opacity = '0,2';</script>
  <script data-source="gwdpage_min.js">a.style.opacity = '0,3';</script>
  <script type="text/javascript" gwd-events="support">a.style.opacity = '0,4';</script>
  <script gwd-text-effects-runtime="">a.style.opacity = '0,5';</script>
  <script>(function(){ customElements.define("gwd-thing", Thing); a.style.opacity = '0,6'; })();</script>
  <script type="text/javascript" gwd-events="handlers">a.style.opacity = '0,7';</script>
  <script>customElements.define('my-thing', Thing); a.style.opacity = '0,8';</script>`);
    expect(issues(html).map((v) => v.value)).toEqual(['0,7', '0,8']);
  });

  it('skips style blocks in comments, and styles inside noscript, iframe, noembed and noframes', () => {
    const html = page(`  <!-- <style>.gwd-p-a { opacity: 0,1; }</style> -->
  <noscript><style>.gwd-p-b { opacity: 0,2; }</style></noscript>`, `  <noscript><div style="opacity: 0,3"></div></noscript>
  <iframe src="x.html"><div style="opacity: 0,3"></div></iframe>
  <noembed><div style="opacity: 0,3"></div></noembed>
  <noframes><div style="opacity: 0,3"></div></noframes>
  <!--> <div id="a" style="opacity: 0,4"></div>
  <!---> <div id="b" style="opacity: 0,5"></div>
  <!-- closed the lax way --!> <div id="c" style="opacity: 0,6"></div>
  <style>.gwd-p-c { opacity: 0,7; }</style>`);
    expect(parseCss(html).styleBlocks).toHaveLength(1);
    expect(issues(html).map((v) => [v.target, v.value])).toEqual([
      ['div#a', '0,4'],
      ['div#b', '0,5'],
      ['div#c', '0,6'],
      ['.gwd-p-c', '0,7'],
    ]);
  });

  it('reads an entity named like an Object member as text, keeping every offset', () => {
    const html = page('', `  <div id="x" style="font-family: &constructor; ; opacity: 0,5;"></div>
  <div id="y" style="font-family: &toString;&valueOf;&hasOwnProperty; ; left: 1,5px"></div>
  <script>go(1,2);</script>`);
    const found = issues(html);
    expect(found.map((v) => [v.target, v.value, html.slice(v.start, v.end)])).toEqual([
      ['div#x', '0,5', '0,5'],
      ['div#y', '1,5px', '1,5px'],
    ]);
  });

  it('makes only the commas outside functions points when making every comma one breaks a function', () => {
    const html = page(`  <script>
    gwd.actions.events.setInlineStyle('SA_cta_1', 'box-shadow: 0px 2px 1,5px rgba(0,0,0,0.5);');
    gwd.actions.events.setInlineStyle('SA_cta_1', 'transition: opacity 0,5s cubic-bezier(0.42,0,0.58,1)');
    el.style.transform = 'scale(0,5,0,5)';
  </script>`);
    expect(issues(html).map((v) => [v.prop, v.fixed])).toEqual([
      ['box-shadow', '0px 2px 1.5px rgba(0,0,0,0.5)'],
      ['transition', 'opacity 0.5s cubic-bezier(0.42,0,0.58,1)'],
      ['transform', null], // a comma inside a function could be either
    ]);
  });
});

describe('scanning time', () => {
  const MB = 1 << 20;
  const rep = (s: string, len = MB) => s.repeat(Math.ceil(len / s.length)).slice(0, len);
  // Each of these once took from seconds to hours, or overflowed the stack.
  it.each([
    ['calls that never close', () => `<script>${rep('e.setAttribute(')}</script>`],
    ['calls nested in each other', () => `<script>${rep('gwd.actions.events.setInlineStyle(', MB / 2)}${rep("x, 'opacity: 0,5')", MB / 2)}</script>`],
    ['unmatched brackets', () => `<script>${rep('}){')}</script>`],
    ['nested template literals', () => `<script>${rep('`${')}</script>`],
    ['style chains', () => `<script>${rep('a.style.')}</script>`],
    ['open braces', () => `<script>${rep('{', MB / 2)}${rep('x.style.y;', MB / 2)}</script>`],
    ['spaces in a value', () => `<div style="opacity: 0${' '.repeat(MB)}x"></div>`],
    ['semicolons', () => `<div style="${rep(';')}"></div>`],
    ['nested @media', () => `<style>${rep('@media x{')}</style>`],
  ])('reads 1 MB of %s in time', (_, make) => {
    const html = make();
    const start = performance.now();
    cssValueIssues(html, parseCss(html), valid);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('staticAudit', () => {
  it('reports each value with where it is set, and an invalid opacity never counts as a fade from 0', () => {
    const html = page(`${HANDLERS}
  <style type="text/css">
    .gwd-p-b {
      opacity: abc;
    }
    @keyframes kf-in {
      0% {
        opacity: 0,2;
      }
      100% {
        opacity: 1;
      }
    }
    .gwd-play-animation .gwd-p-b {
      animation: 1s linear 0s 1 normal forwards kf-in;
    }
  </style>`, '  <p class="gwd-p-b" id="SA_text_1">Hello</p>');
    const report = staticAudit(html, parseCss(html), valid);
    expect(report.findings.filter((f) => f.check === 'textFade')).toEqual([]);
    expect(report.findings.filter((f) => f.check === 'cssValues').map((f) => [f.target, f.message, f.hint])).toEqual([
      ['navigation3_3', '"opacity: 0,3" is not valid CSS, so browsers ignore it; write 0.3. setInlineStyle sets it in gwd.framechange_savings.', undefined],
      ['.gwd-p-b', '"opacity: abc" is not valid CSS, so browsers ignore it.', 'Correct the value in GWD.'],
      ['kf-in 0%', '"opacity: 0,2" is not valid CSS, so browsers ignore it; write 0.2.', undefined],
    ]);
  });
});

describe('fixing CSS values', () => {
  function plan(html: string, boxes: Box[] = [], media: Record<string, string[]> = {}) {
    const css = parseCss(html);
    const report = staticAudit(html, css, valid);
    return planFixes({ html, css, boxes, media: new Map(Object.entries(media).map(([k, v]) => [k, new Set(v)])), report, safety: [] });
  }

  const html = page(`${HANDLERS}
  <style type="text/css">
    .gwd-p-a {
      left: 1,5px;
      opacity: abc;
    }
  </style>`, '  <div id="SA_bg_1" style="opacity: 0,6"></div>');

  it('writes decimal points in place, offering values that size or place things unticked', () => {
    const p = plan(html);
    const [safe, moving] = p.fixes.filter((f) => f.check === 'cssValues');
    expect(safe.detail).toBe('navigation3_3 opacity: 0,3 -> 0.3 (in gwd.framechange_savings), div#SA_bg_1 opacity: 0,6 -> 0.6');
    expect(safe.moves).toBeUndefined();
    expect(applyEdits(html, mergeEdits(safe.edits))).toBe(
      html.replace("'opacity: 0,3;'", "'opacity: 0.3;'").replace('style="opacity: 0,6"', 'style="opacity: 0.6"'),
    );
    expect(moving.detail).toBe('.gwd-p-a left: 1,5px -> 1.5px');
    expect(moving.moves).toContain('Check the result in the preview');
    expect(applyEdits(html, moving.edits)).toBe(html.replace('left: 1,5px;', 'left: 1.5px;'));
  });

  it('leaves other invalid values to you', () => {
    expect(plan(html).manual).toEqual([
      { check: 'cssValues', detail: '.gwd-p-a opacity: abc is not valid CSS, so browsers ignore it; correct it in GWD.' },
    ]);
  });

  it('writes the points outside functions only, when that is what makes the value valid', () => {
    const shadow = page(`  <script type="text/javascript" gwd-events="handlers">
    window.gwd = window.gwd || {};
    gwd.shadow = function(event) {
      gwd.actions.events.setInlineStyle('SA_cta_1', 'box-shadow: 0px 2px 1,5px rgba(0,0,0,0.5);');
    };
  </script>`);
    const [safe] = plan(shadow).fixes;
    expect(safe.detail).toBe('SA_cta_1 box-shadow: 0px 2px 1,5px rgba(0,0,0,0.5) -> 0px 2px 1.5px rgba(0,0,0,0.5) (in gwd.shadow)');
    expect(applyEdits(shadow, safe.edits)).toBe(shadow.replace('1,5px', '1.5px'));
  });

  it('leaves a value to you when its source is not written the way the browser reads it', () => {
    const escaped = page('  <script>function fade(el) { el.style.opacity = "0\\x2c5"; }</script>', `  <div id="a" style="left:1&#44;5px"></div>
  <div id="b" style="opacity: 0,6"></div>`);
    const p = plan(escaped);
    expect(p.fixes.map((f) => f.detail)).toEqual(['div#b opacity: 0,6 -> 0.6']);
    expect(p.manual).toEqual([
      { check: 'cssValues', detail: 'el opacity: 0,5 (in fade) is not valid CSS, so browsers ignore it; write 0.5 in GWD.' },
      { check: 'cssValues', detail: 'div#a left: 1,5px is not valid CSS, so browsers ignore it; write 1.5px in GWD.' },
    ]);
  });

  it('never edits a value it cannot place in the source', () => {
    const html = '0,5 <div id="x" style="opacity: 0,5"></div>';
    const issue = { target: 'div#x', via: 'style attribute', handler: null, prop: 'opacity', value: '0,5', fixed: '0.5' };
    // No offsets, offsets that slice() would still read as '0,5', and offsets at other text.
    const places = [[NaN, NaN], [undefined, 3], [-Infinity, 3], [4, 7]] as number[][];
    const report = { fadeDecls: [], unchanged: [], cssValues: places.map(([start, end]) => ({ ...issue, start, end })) };
    const p = planFixes({ html, css: parseCss(html), boxes: [], media: new Map(), report, safety: [] });
    expect(p.fixes).toEqual([]);
    expect(p.manual).toEqual([{ check: 'cssValues', detail: 'div#x opacity: 0,5 is not valid CSS, so browsers ignore it; write 0.5 in GWD.' }]);
  });

  it('edits only the value after an entity named like an Object member', () => {
    const html = page('', `  <div id="x" style="font-family: &constructor; ; opacity: 0,5;"></div>
  <script>function go(n, m) { return 'rgba(0,0,0,0.5)'; } go(1,2);</script>`);
    const fixes = plan(html).fixes;
    expect(fixes.map((f) => f.detail)).toEqual(['div#x opacity: 0,5 -> 0.5']);
    expect(applyEdits(html, fixes[0].edits)).toBe(html.replace('opacity: 0,5;', 'opacity: 0.5;'));
  });

  it('never edits a declaration another fix rewrites', () => {
    const padded = page(`  <style type="text/css">
    .gwd-button-x {
      padding: 0px 0px 0px 2,5px;
      width: 100px;
    }
  </style>`, '  <button class="gwd-button-x" id="SA_cta_1">Go</button>');
    const button = box({ tag: 'button', classes: ['gwd-button-x'], declared: { lineHeight: '20px', color: 'red' }, computed: { padding: [0, 0, 0, 20], paddingText: '0px 0px 0px 20px', textAlign: 'center' } });
    const p = plan(padded, [button]);
    expect(p.fixes.map((f) => f.check)).toEqual(['buttonPadding']);
    expect(() => applyEdits(padded, mergeEdits(p.fixes.flatMap((f) => f.edits)))).not.toThrow();
  });

  it('still fixes a value in a size block written on one line that the line-height fix adds a rule to', () => {
    const M600 = '(width: 300px) and (height: 600px)';
    const oneLine = page(`  <style type="text/css">
    .gwd-p-a {
      position: absolute;
      font-size: 16px;
    }
    .gwd-img-b {
      position: absolute;
    }
    @media ${M600} { .gwd-img-b { left: 1,5px; top: 40px; } }
  </style>`, '  <p class="gwd-p-a" id="SA_headline_1">Text</p>');
    const p = plan(oneLine, [box({ classes: ['gwd-p-a'], frame: '300x600', normalLineHeight: 18.5 })], { '300x600': [M600] });
    expect(p.fixes.map((f) => [f.check, f.detail])).toEqual([
      ['lineHeight', '.gwd-p-a in 300x600: 18.5px'],
      ['cssValues', '.gwd-img-b in 300x600 left: 1,5px -> 1.5px'],
    ]);
    const out = applyEdits(oneLine, mergeEdits(p.fixes.flatMap((f) => f.edits)));
    expect(out).toContain(`@media ${M600} { .gwd-img-b { left: 1.5px; top: 40px; } \n      .gwd-p-a {\n        line-height: 18.5px;\n      }\n    }`);
  });
});
