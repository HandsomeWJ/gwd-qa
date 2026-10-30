import { beforeAll, describe, expect, it } from 'vitest';
import { applyEdits, mergeEdits } from '../src/css/edit';
import { parseCss } from '../src/css/parse';
import { staticAudit } from '../src/audit/static';
import { planFixes } from '../src/fix/plan';

// Laid out as StackAdapt's GWD templates are: iframe-ct.js right after the stylesheet links, param.js
// as the body's last tag, before the closing comment.
const IFRAME_CT = '  <script type="text/javascript" src="https://creative.stackadapt.com/js/iframe-ct.js"></script>\n';
const PARAM = '  <script type="text/javascript" src="https://creative.stackadapt.com/js/param.js"></script>\n';
const AD = `<!DOCTYPE html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="environment" content="gwd-genericad">
  <link href="gwdpage_style.css" rel="stylesheet" data-version="13" data-exports-type="gwd-page">
  <link href="gwdtaparea_style.css" rel="stylesheet" data-version="7" data-exports-type="gwd-taparea">
${IFRAME_CT}  <style type="text/css">
    .gwd-p-a {
      font-size: 16px;
    }
  </style>
  <script data-source="gwdpage_min.js" data-version="13" data-exports-type="gwd-page" src="gwdpage_min.js"></script>
  <script type="text/javascript" gwd-events="handlers">
    window.gwd = window.gwd || {};
  </script>
</head>

<body>
  <gwd-genericad id="gwd-ad">
    <gwd-pagedeck class="gwd-page-container" id="pagedeck">
      <gwd-page id="page1">
        <p class="gwd-p-a" id="SA_headline_1">Headline</p>
        <gwd-taparea id="SA_clicktag_1" class="dynamicClick gwd-taparea-a" style="cursor: pointer;"></gwd-taparea>
      </gwd-page>
    </gwd-pagedeck>
  </gwd-genericad>
  <script type="text/javascript" id="gwd-init-code">
    window.addEventListener('WebComponentsReady', () => document.getElementById('gwd-ad').initAd());
  </script>
${PARAM}  <!-- Published by Creative Studio: TEST -->
</body>

</html>
`;

function run(html: string, files: Record<string, string> = {}) {
  const css = parseCss(html);
  const ad = { htmlPath: 'ad/Responsive.html', files: new Map(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])) };
  const report = staticAudit(html, css, undefined, ad);
  const plan = planFixes({ html, css, boxes: [], media: new Map(), report, safety: [] });
  const findings = report.findings.filter((f) => f.check === 'stackAdapt');
  const fixes = plan.fixes.filter((f) => f.check === 'stackAdapt');
  const notes = plan.manual.filter((m) => m.check === 'stackAdapt').map((m) => m.detail);
  return { report, findings, fixes, notes, fixed: applyEdits(html, mergeEdits(fixes.flatMap((f) => f.edits))) };
}

describe('StackAdapt scripts', () => {
  // happy-dom fetches the scripts and styles of a parsed document, which a browser never does.
  beforeAll(() => {
    Object.assign((window as unknown as { happyDOM: { settings: object } }).happyDOM.settings, {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    });
  });

  it('passes an ad that loads both, once each', () => {
    const r = run(AD);
    expect(r.report.stackAdapt.loaded).toEqual({ 'iframe-ct.js': 1, 'param.js': 1 });
    expect(r.findings).toEqual([]);
    expect(r.fixes).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it('puts a missing iframe-ct.js back exactly where the templates load it', () => {
    const r = run(AD.replace(IFRAME_CT, ''));
    expect(r.findings.map((f) => [f.level, f.target])).toEqual([['fail', 'iframe-ct.js']]);
    expect(r.fixes.map((f) => f.title)).toEqual(["Load StackAdapt's iframe-ct.js"]);
    expect(r.fixed).toBe(AD);
  });

  it('puts a missing param.js back as the body\'s last tag, before the closing comment', () => {
    const r = run(AD.replace(PARAM, ''));
    expect(r.findings.map((f) => [f.level, f.target])).toEqual([['fail', 'param.js']]);
    expect(r.fixes.map((f) => f.title)).toEqual(["Load StackAdapt's param.js"]);
    expect(r.fixed).toBe(AD);
  });

  it('puts both back', () => {
    const r = run(AD.replace(IFRAME_CT, '').replace(PARAM, ''));
    expect(r.fixes).toHaveLength(2);
    expect(r.fixed).toBe(AD);
    expect(run(r.fixed).findings).toEqual([]);
  });

  it('counts a tag however its address is written', () => {
    const html = AD.replace('src="https://creative.stackadapt.com/js/iframe-ct.js"', 'src=" //CREATIVE.stackadapt.com/js/iframe-ct.js?v=2 "')
      .replace('src="https://creative.stackadapt.com/js/param.js"', "src='http://creative.stackadapt.com/js/param.js#x'");
    expect(run(html).findings).toEqual([]);
  });

  it('fails a script loaded twice, and leaves the extra tag to you', () => {
    const r = run(AD.replace(PARAM, PARAM + IFRAME_CT));
    expect(r.findings.map((f) => f.message)).toEqual(['Loaded 2 times, so each click is reported 2 times.']);
    expect(r.fixes).toEqual([]);
    expect(r.notes).toEqual(["iframe-ct.js: 2 script tags load it; delete all but one in GWD's code view."]);
  });

  it('adds nothing where the script may load another way, and asks you to check', () => {
    const cases: [string, Record<string, string>, string][] = [
      [AD.replace(IFRAME_CT, `  <!--${IFRAME_CT.trim()}-->\n`), {}, 'this HTML'],
      [AD.replace(IFRAME_CT, IFRAME_CT.replace('text/javascript', 'text/plain')), {}, 'this HTML'],
      [AD.replace(IFRAME_CT, '  <noscript><script src="https://creative.stackadapt.com/js/iframe-ct.js"></script></noscript>\n'), {}, 'this HTML'],
      [AD.replace(IFRAME_CT, '  <script>var said = "iframe-ct sending";</script>\n'), {}, 'this HTML'],
      [AD.replace(IFRAME_CT, '  <script src="loader.js"></script>\n'), { 'ad/loader.js': "s.src = 'https://creative.stackadapt.com/js/iframe-ct.js';" }, 'ad/loader.js'],
    ];
    for (const [html, files, where] of cases) {
      const r = run(html, files);
      expect(r.findings.map((f) => [f.level, f.target, f.unknown])).toEqual([['note', 'iframe-ct.js', true]]);
      expect(r.findings[0].message).toContain(where);
      expect(r.fixes).toEqual([]);
    }
  });

  it('leaves param.js to you where it would make the whole ad clickable', () => {
    const r = run(AD.replace(PARAM, '').replace('class="dynamicClick gwd-taparea-a"', 'class="gwd-taparea-a"'));
    expect(r.findings.map((f) => f.target)).toEqual(['param.js']);
    expect(r.fixes).toEqual([]);
    expect(r.notes[0]).toMatch(/^param\.js: no element has the class dynamicClick, so it would make every part of the ad open the landing page/);
  });

  it('leaves param.js to you where the ad opens pages itself', () => {
    const exit = "    gwd.auto_Tap = function() { gwd.actions.gwdGenericad.exit('gwd-ad', 'https://example.com/', true, true); };\n";
    const r = run(AD.replace(PARAM, '').replace('    window.gwd = window.gwd || {};\n', `    window.gwd = window.gwd || {};\n${exit}`));
    expect(r.fixes).toEqual([]);
    expect(r.notes[0]).toContain('the ad opens pages itself (a GWD exit action in this HTML)');
  });

  it('fails a param.js that loads before the tap areas', () => {
    const r = run(AD.replace(PARAM, '').replace(IFRAME_CT, IFRAME_CT + PARAM));
    expect(r.findings.map((f) => f.message)).toEqual(['Its tag comes before 1 tap area (class dynamicClick). It looks for them once, as it loads, so it misses it.']);
    expect(r.fixes).toEqual([]);
    expect(r.notes).toEqual(["param.js: its tag comes before tap areas it should find; move it to be the body's last tag in GWD's code view."]);
  });

  it('puts iframe-ct.js before a web font\'s link that comes later in the head', () => {
    const font = '  <link href="https://fonts.googleapis.com/css?family=Inter" rel="stylesheet" type="text/css">\n';
    const html = AD.replace('  </style>\n', `  </style>\n${font}`);
    expect(run(html.replace(IFRAME_CT, '')).fixed).toBe(html);
  });

  it('finds the head\'s first style and the body\'s last tag past comments, scripts and other markup', () => {
    // No stylesheet link: after the metas. A '</body>' inside a script is not the body's end.
    const html = AD.replace(IFRAME_CT, '').replace(PARAM, '').replace(/ {2}<link [^\n]*\n/g, '')
      .replace("initAd());\n", "initAd());\n    var end = '</body>';\n");
    const r = run(html);
    const doc = new DOMParser().parseFromString(r.fixed, 'text/html');
    expect(doc.head.querySelector('style')?.previousElementSibling?.getAttribute('src')).toBe('https://creative.stackadapt.com/js/iframe-ct.js');
    expect(doc.body.lastElementChild?.getAttribute('src')).toBe('https://creative.stackadapt.com/js/param.js');
    expect(r.fixed).toContain("    var end = '</body>';\n  </script>\n  <script type=\"text/javascript\" src=\"https://creative.stackadapt.com/js/param.js\"></script>\n  <!-- Published");
  });

  it('adds both to an ad on one line', () => {
    const line = AD.replace(IFRAME_CT, '').replace(PARAM, '').replace(/\n\s*/g, '');
    const r = run(line);
    const doc = new DOMParser().parseFromString(r.fixed, 'text/html');
    expect(r.fixes).toHaveLength(2);
    expect(doc.head.querySelectorAll('script[src*="iframe-ct.js"]')).toHaveLength(1);
    expect(doc.body.lastElementChild?.getAttribute('src')).toBe('https://creative.stackadapt.com/js/param.js');
  });
});
