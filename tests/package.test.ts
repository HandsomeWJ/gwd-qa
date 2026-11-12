import { beforeAll, describe, expect, it } from 'vitest';
import { applyEdits, mergeEdits } from '../src/css/edit';
import { parseCss } from '../src/css/parse';
import { fileFindings, fileRefs, weightFindings } from '../src/audit/package';
import { staticAudit } from '../src/audit/static';
import { planFixes } from '../src/fix/plan';

// happy-dom fetches the scripts and styles of a parsed document, which a browser never does.
beforeAll(() => {
  Object.assign((window as unknown as { happyDOM: { settings: object } }).happyDOM.settings, {
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
    handleDisabledFileLoadingAsSuccess: true,
  });
});

const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="environment" content="gwd-genericad">
  <link href="style.css" rel="stylesheet">
  <link rel="preconnect" href="https://fonts.gstatic.com">
  <script src="gwdpage_min.js"></script>
  <script type="text/javascript" src="https://creative.stackadapt.com/js/param.js"></script>
  <style>
    .bg { background-image: url("assets/bg.jpg"); }
    .x { background: url(assets/gone.png); }
  </style>
</head>
<body>
  <gwd-genericad id="gwd-ad">
    <gwd-image source="assets/logo.png" data-gwd-media-override="{&quot;300x250&quot;:{&quot;source&quot;:&quot;assets/Logo.PNG&quot;}}"></gwd-image>
    <img src="data:image/gif;base64,R0lGOD" srcset="assets/bg.jpg 1x, assets/bg@2x.jpg 2x">
    <a href="https://example.com/landing">Shop</a>
    <div style="background: url('/assets/bg.jpg')"></div>
  </gwd-genericad>
  <script>var frames = ['assets/frame1.png'];</script>
</body>
</html>
`;
const enc = new TextEncoder();
const ad = {
  htmlPath: 'Ad/Responsive.html',
  files: new Map<string, Uint8Array>([
    ['Ad/Responsive.html', enc.encode(html)],
    ['Ad/style.css', enc.encode('.y { background: url(img/missing.png); }')],
    ['Ad/gwdpage_min.js', enc.encode('')],
    ['Ad/assets/Logo.PNG', new Uint8Array(4)],
    ['Ad/assets/bg.jpg', new Uint8Array(4)],
  ]),
};

describe('package files', () => {
  const refs = fileRefs(html, parseCss(html), ad);
  const state = (ref: string) => refs.filter((r) => r.ref === ref).map((r) => r.state);

  it("resolves what the HTML, its CSS and its scripts load, and leaves out other sites' files and data: URLs", () => {
    expect([...new Set(refs.map((r) => r.ref))].sort()).toEqual([
      '/assets/bg.jpg', 'assets/Logo.PNG', 'assets/bg.jpg', 'assets/bg@2x.jpg', 'assets/frame1.png', 'assets/gone.png', 'assets/logo.png', 'gwdpage_min.js', 'img/missing.png', 'style.css',
    ]);
    expect(state('assets/bg.jpg')).toEqual(['ok', 'ok']); // the style block and the srcset
    expect(state('assets/Logo.PNG')).toEqual(['ok']); // GWD's per-size source
    expect(state('assets/gone.png')).toEqual(['missing']);
    expect(state('/assets/bg.jpg')).toEqual(['missing']); // the server's root, outside the ad
    expect(refs.find((r) => r.ref === 'img/missing.png')).toMatchObject({ where: 'Ad/style.css', path: 'Ad/img/missing.png', state: 'missing' });
    expect(refs.find((r) => r.ref === 'assets/frame1.png')).toMatchObject({ state: 'missing', script: true });
  });

  it('finds a name that differs only in letter case, and what to write instead', () => {
    const r = refs.find((x) => x.ref === 'assets/logo.png')!;
    expect(r).toMatchObject({ state: 'case', actual: 'Ad/assets/Logo.PNG', fix: 'assets/Logo.PNG' });
    expect(html.slice(r.at!.start, r.at!.end)).toBe('assets/logo.png');
  });

  it('fails what is missing or misnamed, notes a script\'s path for a person, and says when only the HTML came', () => {
    const findings = fileFindings(refs, false);
    expect(findings.filter((f) => f.level === 'fail').map((f) => f.target).sort()).toEqual(['/assets/bg.jpg', 'assets/bg@2x.jpg', 'assets/gone.png', 'assets/logo.png', 'img/missing.png']);
    expect(findings.find((f) => f.target === '/assets/bg.jpg')?.message).toContain("It starts with /, so it loads from the server's root, outside the ad.");
    expect(findings.find((f) => f.target === 'assets/logo.png')?.message).toContain('the package has it as Ad/assets/Logo.PNG');
    expect(findings.find((f) => f.target === 'assets/frame1.png')).toMatchObject({ level: 'note', unknown: true });
    expect(fileFindings([], true)).toEqual([expect.objectContaining({ check: 'files', level: 'note', unknown: true })]);
  });

  it('rewrites a misnamed reference in the HTML to the exact name, and nothing else', () => {
    const css = parseCss(html);
    const report = staticAudit(html, css, undefined, ad);
    const p = planFixes({ html, css, boxes: [], media: new Map(), report, safety: [] });
    const fix = p.fixes.find((f) => f.check === 'files')!;
    expect(fix.detail).toBe('assets/logo.png → assets/Logo.PNG');
    const out = applyEdits(html, mergeEdits(fix.edits));
    expect(out).toBe(html.replace('source="assets/logo.png"', 'source="assets/Logo.PNG"'));
  });
});

describe('package weight', () => {
  it('passes a zip under 4 MB with its size as a note, and fails one over it naming its largest files', () => {
    expect(weightFindings(3_500_000, [], false)).toEqual([{ check: 'weight', level: 'note', target: 'zip for upload', message: '3.50 MB, under the 4 MB limit.' }]);
    const over = weightFindings(4_200_000, [['Ad/assets/video.mp4', 3_100_000], ['Ad/Responsive.html', 90_000], ['Ad/assets/a.png', 600_000], ['Ad/assets/b.png', 300_000]], false);
    expect(over).toMatchObject([{ level: 'fail', message: '4.20 MB, over the 4 MB limit. Its largest files: video.mp4 (3.10 MB), a.png (0.60 MB), b.png (0.30 MB).' }]);
    expect(weightFindings(0, [], true)).toMatchObject([{ level: 'note', unknown: true }]);
  });
});

describe("a script's strings", () => {
  it('takes a whole path, never an extension the code adds to a name it builds', () => {
    const page = '<html><body><script>var a = "assets/" + id + ".png"; var b = \'.jpg\'; var c = "frames/f1.png";</script></body></html>';
    const refs = fileRefs(page, parseCss(page), { htmlPath: 'Ad/Responsive.html', files: new Map([['Ad/Responsive.html', new Uint8Array(0)]]) });
    expect(refs.map((r) => r.ref)).toEqual(['frames/f1.png']);
  });
});
