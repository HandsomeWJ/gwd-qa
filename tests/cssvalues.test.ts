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
  transition: /^all \d*\.?\d+s linear$/,
  transform: /^scale\(\d+(, ?\d+)?\)$/,
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
  function plan(html: string, boxes: Box[] = []) {
    const css = parseCss(html);
    const report = staticAudit(html, css, valid);
    return planFixes({ html, css, boxes, media: new Map(), report, safety: [] });
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
});
