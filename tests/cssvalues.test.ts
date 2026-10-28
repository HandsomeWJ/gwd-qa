import { describe, expect, it, vi } from 'vitest';
import { applyEdits, mergeEdits } from '../src/css/edit';
import { parseCss } from '../src/css/parse';
import { checkCssValues, cssValueIssues, describeIssue, type CssValidator } from '../src/audit/cssvalues';
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
  'transition-duration': /^\d*\.?\d+s$/,
  transform: /^scale\(\d+(, ?\d+)?\)$/,
  'background-size': /^(auto|cover|contain)$/,
  'box-shadow': /^(\d*\.?\d+px ){3}rgba\((\d*\.?\d+, ?){3}\d*\.?\d+\)$/,
  filter: /^blur\(\d*\.?\d+px\)$/,
  background: /^url\((("[^"]*")|[^)"]*)\) (calc\(\d*\.?\d+px\)|\d*\.?\d+px) \d*\.?\d+px no-repeat$/,
  font: /^\d*\.?\d+em "[^"]*"$/,
  '-webkit-text-stroke': /^\d*\.?\d+px$/,
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
      gwd.actions.events.setInlineStyle(event.target.id, 'font-family: \\'A B\\'; opacity: 0,4');
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
      // A vendor property the browser knows drops an invalid value like any other.
      ['.gwd-p-a', '', null, '-webkit-text-stroke: 0,5px', '0.5px'],
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

  it('skips unknown properties (vendor ones the browser does not know too), JSON and template scripts, comments, and strings that are not CSS', () => {
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
    function branch(el, c) {
      c ? el.style.opacity = '0,8' : el.style.opacity = '1';
      el.style.opacity = '0,9'
      'next'.length;
      el.style.left = '2,5px'
      \`tag\`;
    }
    function lines(el, v, n) {
      el.style.opacity = '0,11'
        != v ? '1' : '0';
      el.style.opacity = '0,12'
        !== v ? '1' : '0';
      el.style.opacity = '0,13'
      ++n;
      el.style.opacity = '0,14'
      --n;
      el.style.opacity = '0,15'
      + +n;
      el.style.opacity = '0,16'
      - -n;
      el.style.opacity = '0,17'
      --> a comment, so the next line could go on with it
      + n;
      el.style.opacity = '0,18'
      !n && go();
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
      ['branch', 'opacity: 0,8', '0.8'],
      ['branch', 'opacity: 0,9', '0.9'],
      // A '++' or '--' on the next line always starts a statement; '!=' and '!==' compare with the literal.
      ['lines', 'opacity: 0,13', '0.13'],
      ['lines', 'opacity: 0,14', '0.14'],
      ['lines', 'opacity: 0,18', '0.18'],
      [null, 'opacity: 0,7', '0.7'],
    ]);
  });

  it("reads setInlineStyle() the way GWD's runtime applies it, which ignores what cssText would take", () => {
    const html = page(`  <script type="text/javascript" gwd-events="handlers">
    gwd.styles = function(event) {
      gwd.actions.events.setInlineStyle('a', 'opacity: 0.3 !important;');
      gwd.actions.events.setInlineStyle('b', 'opacity : 0,4');
      gwd.actions.events.setInlineStyle('c', 'opacity: 0,3 !important;');
      gwd.actions.events.setInlineStyle('d', 'color: red;Opacity:0,5;');
      gwd.actions.events.setInlineStyle('e', "font-family: 'A;B'; opacity: 0,6");
      gwd.actions.events.setInlineStyle('f', 'color; opacity: 0,7');
      gwd.actions.events.setInlineStyle('g', 'background: url(http://x.test/a.png) 1px 1px no-repeat; opacity:0,8 ;; left: 1,5px: 2px');
      gwd.actions.events.setInlineStyle('h', ' opacity: 0,9; zoomy : 0,1; --x : 0,2');
    };
  </script>`);
    expect(issues(html).map((v) => [v.target, `${v.prop}: ${v.value}`, html.slice(v.start, v.end), v.fixed, v.note ?? null])).toEqual([
      ['a', 'opacity: 0.3 !important', '0.3 !important', null, 'setInlineStyle takes !important as part of the value, which browsers then reject'],
      ['b', 'opacity : 0,4', '0,4', null, 'setInlineStyle takes the spaces around the name as part of it, so browsers know no such property'],
      ['c', 'opacity: 0,3 !important', '0,3 !important', null, 'setInlineStyle takes !important as part of the value, which browsers then reject'],
      // style.setProperty() reads a name in any case.
      ['d', 'opacity: 0,5', '0,5', '0.5', null],
      // GWD splits at every ';', even one in quotes, and stops at a piece with no value: 'B'' in e, 'color' in f.
      // A value ends at the next colon, but not at one before '//'.
      ['g', 'opacity: 0,8', '0,8', '0.8', null],
      ['g', 'left: 1,5px', '1,5px', '1.5px', null],
      ['h', ' opacity: 0,9', '0,9', null, 'setInlineStyle takes the spaces around the name as part of it, so browsers know no such property'],
    ]);
  });

  it('never makes a comma inside url() or a string a point, trying the commas outside functions first', () => {
    const html = page(`  <style type="text/css">
    .gwd-div-a {
      background: url("assets/hero_1,5x.png") 1,5px 1,5px no-repeat;
    }
    .gwd-div-b {
      background: url(assets/hero_2,5x.png) 2,5px 1px no-repeat;
    }
    .gwd-div-c {
      background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><path d='M0,0 L10,10'/></svg>") 1,5px 2px no-repeat;
    }
    .gwd-p-d {
      font: 1,5em "Brand 1,5";
    }
    .gwd-div-e {
      background: url("assets/hero_3,5x.png") calc(1,5px) 2px no-repeat;
    }
  </style>`);
    expect(issues(html).map((v) => [v.target, v.fixed])).toEqual([
      ['.gwd-div-a', 'url("assets/hero_1,5x.png") 1.5px 1.5px no-repeat'],
      ['.gwd-div-b', 'url(assets/hero_2,5x.png) 2.5px 1px no-repeat'],
      ['.gwd-div-c', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><path d='M0,0 L10,10'/></svg>") 1.5px 2px no-repeat`],
      ['.gwd-p-d', '1.5em "Brand 1,5"'],
      // Only the commas inside a function make it valid, and still none inside url().
      ['.gwd-div-e', 'url("assets/hero_3,5x.png") calc(1.5px) 2px no-repeat'],
    ]);
  });

  it('reads every character reference in a style attribute as the browser does', () => {
    const html = page('', `  <div id="a" style="opacity: 0&period;5"></div>
  <div id="b" style="opacity: 0&comma;5"></div>
  <div id="c" style="opacity: .5&#59 left: 1,5px"></div>
  <div id="d" style="font-size: 1&frac12;px; opacity: 0,5&#0;"></div>
  <div id="e" style="opacity: 0,5&#150;"></div>`);
    expect(issues(html).map((v) => [v.target, `${v.prop}: ${v.value}`, html.slice(v.start, v.end), v.fixed])).toEqual([
      ['div#b', 'opacity: 0,5', '0&comma;5', '0.5'],
      ['div#c', 'left: 1,5px', '1,5px', '1.5px'],
      ['div#d', 'font-size: 1\u00bdpx', '1&frac12;px', null],
      ['div#d', 'opacity: 0,5\ufffd', '0,5&#0;', null],
      ['div#e', 'opacity: 0,5\u2013', '0,5&#150;', null],
    ]);
  });

  it('leaves a style attribute it cannot decode to you, where no HTML parser is there to ask', () => {
    vi.stubGlobal('document', undefined);
    try {
      const html = page('', `  <div id="a" style="opacity: 0&semi;5"></div>
  <div id="b" style="opacity: 0&amp;5; left: 1,5px"></div>`);
      const { issues: found, unknown } = checkCssValues(html, parseCss(html), valid);
      expect(found.map((v) => [v.target, `${v.prop}: ${v.value}`])).toEqual([['div#b', 'opacity: 0&5'], ['div#b', 'left: 1,5px']]);
      expect(unknown).toEqual([{ target: 'div#a', message: 'Its style attribute has &semi;, which could not be decoded here, so its CSS values were not checked.' }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not check what '+=' adds to a property, which depends on the value it has then", () => {
    const html = page(`  <script>
    function go(el) {
      el.style.transition = 'all 1s linear';
      el.style.transition += ', opacity 0,5s';
      el.style.opacity += '0,5';
      el.style.cssText += 'opacity: 0,6';
    }
  </script>`);
    const { issues: found, unknown } = checkCssValues(html, parseCss(html), valid);
    expect(found.map((v) => [v.via, `${v.prop}: ${v.value}`])).toEqual([['style.cssText', 'opacity: 0,6']]);
    expect(unknown).toEqual([
      { target: 'el', message: 'style.transition += ", opacity 0,5s" in go adds to the value it has then, so whether browsers accept the result is not known here.' },
      { target: 'el', message: 'style.opacity += "0,5" in go adds to the value it has then, so whether browsers accept the result is not known here.' },
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
    ['a chain before a style', () => `<script>${rep('a.', MB - 64)}a.style.opacity = '0,5'; ${rep('b.', 64)}b.setAttribute('style', 'left: 1,5px');</script>`],
    ['a chain before a function', () => `<script>${rep('a.', MB - 64)}a = function() { el.style.opacity = '0,5'; };</script>`],
    ['spaces in a setInlineStyle', () => `<script>gwd.actions.events.setInlineStyle('a', 'opacity: 0${' '.repeat(MB)}x');</script>`],
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

describe("the ad's other files", () => {
  const encoder = new TextEncoder();
  const ad = (files: Record<string, string>) => ({ htmlPath: 'Ad/Responsive.html', files: new Map(Object.entries(files).map(([k, v]) => [k, encoder.encode(v)])) });
  const html = page(`  <link href="gwdpage_style.css" rel="stylesheet" data-version="13" data-exports-type="gwd-page">
  <link href="gwdimage_style.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css?family=Inter" rel="stylesheet" type="text/css">
  <link href="css/extra.css?v=2" rel="stylesheet">
  <link href="print.css" rel="alternate stylesheet">
  <link href="missing.css" rel="stylesheet">
  <script data-source="gwdpage_min.js" data-exports-type="gwd-page" src="gwdpage_min.js"></script>
  <script src="gwd-events-support.1.0.js"></script>
  <script src="https://cdn.example.test/tracker.js"></script>
  <script src="js/custom.js">el.style.opacity = '0,1';</script>
  <script src="mock-runtime.js"></script>
  <script src="gone.js"></script>
  <style type="text/css">
    @import url("more.css");
    .gwd-p-a { opacity: 0,2; }
  </style>`);
  const files = ad({
    'Ad/Responsive.html': html,
    'Ad/gwdpage_style.css': '.x { opacity: 0,3; }',
    'Ad/gwdimage_style.css': '.x { opacity: 0,3; }',
    'Ad/css/extra.css': '/* @import "nowhere.css"; */\n@import "../more.css";\n.gwd-p-b { opacity: 0,4; }',
    'Ad/print.css': '.x { opacity: 0,3; }',
    'Ad/more.css': '.gwd-p-c { left: 1,5px; }',
    'Ad/gwdpage_min.js': "a.style.opacity = '0,3';",
    'Ad/gwd-events-support.1.0.js': "a.style.opacity = '0,3';",
    'Ad/js/custom.js': "function go(el) {\n  el.style.opacity = '0,6';\n}",
    'Ad/mock-runtime.js': "customElements.define('gwd-page', P); a.style.opacity = '0,3';",
  });

  it('reads the stylesheets and scripts the ad loads from its own files, and says which it could not read', () => {
    const { issues, unknown } = checkCssValues(html, parseCss(html), valid, files);
    expect(issues.map((v) => [v.file ?? null, v.target, v.via, `${v.prop}: ${v.value}`, v.fixed])).toEqual([
      [null, '.gwd-p-a', '', 'opacity: 0,2', '0.2'],
      ['Ad/more.css', '.gwd-p-c', '', 'left: 1,5px', '1.5px'],
      ['Ad/css/extra.css', '.gwd-p-b', '', 'opacity: 0,4', '0.4'],
      ['Ad/js/custom.js', 'el', 'style.opacity', 'opacity: 0,6', '0.6'],
    ]);
    // Offsets are into the file each value is in.
    expect(issues.map((v) => (v.file ? new TextDecoder().decode(files.files.get(v.file)) : html).slice(v.start, v.end))).toEqual(['0,2', '1,5px', '0,4', '0,6']);
    expect(describeIssue(issues[3])).toBe('"opacity: 0,6" is not valid CSS, so browsers ignore it; write 0.6. style.opacity sets it in go, in Ad/js/custom.js.');
    expect(unknown).toEqual([
      { target: 'missing.css', message: 'The ad loads missing.css, which is not among the files checked, so its CSS values were not checked.' },
      { target: 'gone.js', message: 'The ad loads gone.js, which is not among the files checked, so the styles it sets were not checked.' },
    ]);
  });

  it('reports them in the checklist, Review where a file could not be read, and leaves their values to you', () => {
    // @import, not <link> or <script src>: happy-dom's DOMParser, unlike a browser's, would fetch those.
    const linked = page(`  <style type="text/css">
    @import url("more.css");
    @import 'css/extra.css';
    @import "missing.css";
    .gwd-p-a { opacity: 0,2; }
  </style>`, '  <div class="gwd-p-a"></div>');
    const report = staticAudit(linked, parseCss(linked), valid, files);
    expect(report.findings.filter((f) => f.check === 'cssValues').map((f) => [f.level, f.target, f.message, f.hint ?? null, f.unknown ?? false])).toEqual([
      ['fail', '.gwd-p-a', '"opacity: 0,2" is not valid CSS, so browsers ignore it; write 0.2.', null, false],
      ['fail', '.gwd-p-c', '"left: 1,5px" is not valid CSS, so browsers ignore it; write 1.5px. It is in Ad/more.css.', 'Correct the value in Ad/more.css.', false],
      ['fail', '.gwd-p-b', '"opacity: 0,4" is not valid CSS, so browsers ignore it; write 0.4. It is in Ad/css/extra.css.', 'Correct the value in Ad/css/extra.css.', false],
      ['note', 'missing.css', 'The ad loads missing.css, which is not among the files checked, so its CSS values were not checked.', null, true],
    ]);
    const p = planFixes({ html: linked, css: parseCss(linked), boxes: [], media: new Map(), report, safety: [] });
    expect(p.fixes.map((f) => f.detail)).toEqual(['.gwd-p-a opacity: 0,2 -> 0.2']);
    expect(p.manual.map((m) => m.detail)).toEqual([
      '.gwd-p-c left: 1,5px in Ad/more.css is not valid CSS, so browsers ignore it; write 1.5px in Ad/more.css.',
      '.gwd-p-b opacity: 0,4 in Ad/css/extra.css is not valid CSS, so browsers ignore it; write 0.4 in Ad/css/extra.css.',
    ]);
  });

  it("never takes a value in another file for the HTML's own at the same offset", () => {
    const fade = page(`  <style type="text/css">
    @import "fade.css";
    .gwd-p-b {
      opacity: 0;
    }
  </style>`, '  <p class="gwd-p-b" id="SA_text_1">Hello</p>');
    const at = fade.indexOf('opacity: 0;') + 'opacity: '.length;
    const report = staticAudit(fade, parseCss(fade), valid, ad({ 'Ad/fade.css': `${' '.repeat(at - '.x{opacity:'.length)}.x{opacity:0,5}` }));
    expect(report.cssValues.map((v) => [v.file, v.start])).toEqual([['Ad/fade.css', at]]);
    expect(report.findings.filter((f) => f.check === 'textFade').map((f) => f.target)).toEqual(['p#SA_text_1']);
  });

  it('cannot read any of them without the files', () => {
    const { unknown } = checkCssValues(html, parseCss(html), valid);
    expect(unknown.map((u) => u.target)).toEqual(['more.css', 'css/extra.css?v=2', 'missing.css', 'js/custom.js', 'mock-runtime.js', 'gone.js']);
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
    .gwd-div-box {
      filter: blur(0,5px);
    }
  </style>`, '  <div id="SA_bg_1" style="opacity: 0,6"></div>\n  <img id="navigation3_3" src="dot.png">');

  it('writes decimal points in place where only paint changes, on what shows no text', () => {
    const p = plan(html);
    const [safe, ...more] = p.fixes.filter((f) => f.check === 'cssValues');
    expect(more).toEqual([]);
    expect(safe.detail).toBe('navigation3_3 opacity: 0,3 -> 0.3 (in gwd.framechange_savings), div#SA_bg_1 opacity: 0,6 -> 0.6');
    expect(applyEdits(html, mergeEdits(safe.edits))).toBe(
      html.replace("'opacity: 0,3;'", "'opacity: 0.3;'").replace('style="opacity: 0,6"', 'style="opacity: 0.6"'),
    );
  });

  it('leaves to you a value that, once valid, would change how text looks', () => {
    const text = page(HANDLERS, '  <div id="navigation3_3"><span>Next</span></div>\n  <p id="SA_bg_1" style="opacity: 0,6">Hello</p>\n  <div id="SA_x_1" style="opacity: 0,7"><gwd-image></gwd-image></div>');
    const p = plan(text);
    expect(p.fixes.map((f) => f.detail)).toEqual(['div#SA_x_1 opacity: 0,7 -> 0.7']);
    expect(p.manual.map((m) => m.detail)).toEqual([
      'navigation3_3 opacity: 0,3 (in gwd.framechange_savings) is not valid CSS, so browsers ignore it; write 0.3 in GWD. Once valid it would change how its text looks, so it is not changed here.',
      'p#SA_bg_1 opacity: 0,6 is not valid CSS, so browsers ignore it; write 0.6 in GWD. Once valid it would change how its text looks, so it is not changed here.',
    ]);
    // Where what it styles is not known, it may be text.
    expect(plan(page(HANDLERS)).manual.map((m) => m.detail)).toEqual([
      'navigation3_3 opacity: 0,3 (in gwd.framechange_savings) is not valid CSS, so browsers ignore it; write 0.3 in GWD. Once valid it would change how what it styles looks, which may be text, so it is not changed here.',
    ]);
  });

  it('offers a transition only when everything it animates only changes how things look', () => {
    const transitions = page(`  <script type="text/javascript" gwd-events="handlers">
    gwd.hover = function(event) {
      gwd.actions.events.setInlineStyle('SA_cta_1', 'transition: all 0,2s linear; color: white;');
      gwd.actions.events.setInlineStyle('SA_cta_2', 'transition: opacity 0,5s cubic-bezier(0.42,0,0.58,1)');
      gwd.actions.events.setInlineStyle('SA_cta_3', 'transition-duration: 0,5s');
    };
  </script>`, ['SA_cta_1', 'SA_cta_2', 'SA_cta_3'].map((id) => `  <div id="${id}"></div>`).join('\n'));
    const p = plan(transitions);
    expect(p.fixes.map((f) => f.detail)).toEqual(['SA_cta_2 transition: opacity 0,5s cubic-bezier(0.42,0,0.58,1) -> opacity 0.5s cubic-bezier(0.42,0,0.58,1) (in gwd.hover)']);
    // all, or a duration for whatever the element transitions, would make text that jumps slide or grow.
    expect(p.manual.map((m) => m.detail)).toEqual([
      'SA_cta_1 transition: all 0,2s linear (in gwd.hover) is not valid CSS, so browsers ignore it; write all 0.2s linear in GWD. Once valid it would size, place or animate what it styles, which can move text, so it is not changed here.',
      'SA_cta_3 transition-duration: 0,5s (in gwd.hover) is not valid CSS, so browsers ignore it; write 0.5s in GWD. Once valid it would size, place or animate what it styles, which can move text, so it is not changed here.',
    ]);
  });

  it('never edits a URL or string, and offers no fix for what setInlineStyle ignores whatever its value', () => {
    const html = page(`  <style type="text/css">
    .gwd-div-a {
      background: url("assets/hero_1,5x.png") 1,5px 1,5px no-repeat;
    }
  </style>
  <script type="text/javascript" gwd-events="handlers">
    gwd.styles = function(event) {
      gwd.actions.events.setInlineStyle('a', 'opacity: 0,3 !important;');
      gwd.actions.events.setInlineStyle('b', 'opacity : 0,4');
    };
  </script>`, '  <div class="gwd-div-a"></div>');
    const p = plan(html);
    expect(p.fixes.map((f) => f.detail)).toEqual(['.gwd-div-a background: url("assets/hero_1,5x.png") 1,5px 1,5px no-repeat -> url("assets/hero_1,5x.png") 1.5px 1.5px no-repeat']);
    expect(applyEdits(html, mergeEdits(p.fixes[0].edits))).toBe(html.replace('1,5px 1,5px', '1.5px 1.5px'));
    expect(p.manual.map((m) => m.detail)).toEqual([
      'a opacity: 0,3 !important (in gwd.styles) is ignored: setInlineStyle takes !important as part of the value, which browsers then reject; correct it in GWD.',
      'b opacity : 0,4 (in gwd.styles) is ignored: setInlineStyle takes the spaces around the name as part of it, so browsers know no such property; correct it in GWD.',
    ]);
  });

  it('leaves other invalid values to you, and those that would size or place things', () => {
    // A filter makes its element the containing block of positioned text inside it, so it can move text.
    expect(plan(html).manual.map((m) => m.detail)).toEqual([
      '.gwd-p-a left: 1,5px is not valid CSS, so browsers ignore it; write 1.5px in GWD. Once valid it would size, place or animate what it styles, which can move text, so it is not changed here.',
      '.gwd-p-a opacity: abc is not valid CSS, so browsers ignore it; correct it in GWD.',
      '.gwd-div-box filter: blur(0,5px) is not valid CSS, so browsers ignore it; write blur(0.5px) in GWD. Once valid it would size, place or animate what it styles, which can move text, so it is not changed here.',
    ]);
  });

  it('writes the points outside functions only, when that is what makes the value valid', () => {
    const shadow = page(`  <script type="text/javascript" gwd-events="handlers">
    window.gwd = window.gwd || {};
    gwd.shadow = function(event) {
      gwd.actions.events.setInlineStyle('SA_cta_1', 'box-shadow: 0px 2px 1,5px rgba(0,0,0,0.5);');
    };
  </script>`, '  <div id="SA_cta_1"></div>');
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
    @media ${M600} { .gwd-img-b { opacity: 0,5; top: 40px; } }
  </style>`, '  <p class="gwd-p-a" id="SA_headline_1">Text</p>\n  <div class="gwd-img-b"></div>');
    const p = plan(oneLine, [box({ classes: ['gwd-p-a'], frame: '300x600', normalLineHeight: 18.5 })], { '300x600': [M600] });
    expect(p.fixes.map((f) => [f.check, f.detail])).toEqual([
      ['lineHeight', '.gwd-p-a in 300x600: 18.5px'],
      ['cssValues', '.gwd-img-b in 300x600 opacity: 0,5 -> 0.5'],
    ]);
    const out = applyEdits(oneLine, mergeEdits(p.fixes.flatMap((f) => f.edits)));
    expect(out).toContain(`@media ${M600} { .gwd-img-b { opacity: 0.5; top: 40px; } \n      .gwd-p-a {\n        line-height: 18.5px;\n      }\n    }`);
  });
});
