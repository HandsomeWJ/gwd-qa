// StackAdapt's click scripts, which every StackAdapt ad loads from creative.stackadapt.com.
// iframe-ct.js reports each click to StackAdapt. param.js opens the landing page from the ad's tap
// areas (class dynamicClick), or from anywhere in the ad when it has none; it looks for them once,
// as it loads. StackAdapt's templates load iframe-ct.js right after the stylesheet links and param.js
// as the body's last tag, so a missing one goes back exactly there.

import { lineIndent } from '../css/edit';
import { startTags, type CssModel, type Tag } from '../css/parse';
import { JS_TYPE, readAd, type AdFiles } from './cssvalues';
import type { Finding } from './types';

export const STACKADAPT_SCRIPTS = ['iframe-ct.js', 'param.js'] as const;
export type StackAdaptScript = (typeof STACKADAPT_SCRIPTS)[number];

export const stackAdaptTag = (name: StackAdaptScript) => `<script type="text/javascript" src="https://creative.stackadapt.com/js/${name}"></script>`;

/** Where a tag goes: on a line of its own after offset `at`, indented as `indent`. */
export interface Spot {
  at: number;
  indent: string;
}

export interface StackAdaptReport {
  /** How many script tags load each script when the page loads. */
  loaded: Record<StackAdaptScript, number>;
  /** For a script no tag loads, where else it appears (this HTML, the ad's own files): it may still run. */
  elsewhere: Record<StackAdaptScript, string[]>;
  /** Where a missing iframe-ct.js goes: before the head's first style or script, else after its last tag. */
  head: Spot | null;
  /** Where a missing param.js goes: after the body's last tag, before any closing comment. */
  body: Spot | null;
  /** Tap areas (class dynamicClick) in the page, and how many come after the first tag that loads param.js. */
  tapAreas: number;
  tapAreasAfter: number;
  /** What in the ad opens a page itself, as param.js would too. */
  ownExits: string[];
}

// What gives a script away where no tag loads it: its address, or words from its own code.
const TRACE: Record<StackAdaptScript, RegExp> = {
  'iframe-ct.js': /creative\.stackadapt\.com\/js\/iframe-ct|iframe-ct (sending|click|pointer)/i,
  'param.js': /creative\.stackadapt\.com\/js\/param|\bsa_clickurl\b|\bclick_args\b/i,
};

// Code that opens a page. A clickTag alone opens nothing: StackAdapt templates name tap areas "clicktag".
const EXITS: [RegExp, string][] = [
  [/\bwindow\.open\s*\(/, 'window.open'],
  [/\.exit\s*\(/, 'a GWD exit action'],
  [/\blocation(\.href)?\s*=(?!=)/, 'a change of location'],
];

/** The StackAdapt script a src loads, whatever its scheme, the case of its host or its query. */
function scriptOf(src: string): StackAdaptScript | null {
  let url: URL;
  try {
    url = new URL(src.trim(), 'https://ad.invalid/');
  } catch {
    return null;
  }
  if (url.hostname !== 'creative.stackadapt.com' || !/^https?:$/.test(url.protocol)) return null;
  return STACKADAPT_SCRIPTS.find((s) => url.pathname === `/js/${s}`) ?? null;
}

/** Whether a script element runs as the page loads. DOMParser reads <noscript> as markup; a browser does not. */
function runs(el: Element): boolean {
  return !el.closest('noscript') && !el.hasAttribute('nomodule') && JS_TYPE.test(el.getAttribute('type')?.trim() || 'text/javascript');
}

/** Where its element ends: after the closing tag of a raw text element such as <script>, else after its '>'. */
function elementEnd(html: string, tag: Tag): number {
  if (!tag.content) return tag.end;
  const close = html.indexOf('>', tag.content.end);
  return close < 0 ? html.length : close + 1;
}

function headSpot(html: string, tags: Tag[]): Spot | null {
  const head = tags.findIndex((t) => t.name === 'head');
  const body = tags.findIndex((t) => t.name === 'body');
  if (head < 0 || body < head) return null;
  // Before the head's first style or script: after the stylesheet links GWD writes first. A web font's
  // link can come later in the head.
  const first = tags.findIndex((t, i) => i > head && i < body && (t.name === 'style' || t.name === 'script'));
  const anchor = tags[(first < 0 ? body : first) - 1];
  return { at: elementEnd(html, anchor), indent: lineIndent(html, anchor.start) };
}

function bodySpot(html: string, tags: Tag[]): Spot | null {
  if (!tags.some((t) => t.name === 'body')) return null;
  const last = tags[tags.length - 1];
  let at = elementEnd(html, last);
  let line = last.content?.end ?? last.start;
  // Only end tags, text and comments follow the last start tag: go past the end tags before </body>.
  const after = /<!--[\s\S]*?(?:--!?>|$)|<\/([a-zA-Z][^\s/>]*)[^>]*>/g;
  after.lastIndex = at;
  for (let m = after.exec(html); m; m = after.exec(html)) {
    if (!m[1]) continue;
    if (/^(body|html)$/i.test(m[1])) break;
    at = after.lastIndex;
    line = m.index;
  }
  return { at, indent: lineIndent(html, line) };
}

export function stackAdaptAudit(html: string, doc: Document, css: CssModel, ad?: AdFiles): StackAdaptReport {
  const scripts = [...doc.querySelectorAll('script[src]')].filter(runs);
  const loading = (name: StackAdaptScript) => scripts.filter((s) => scriptOf(s.getAttribute('src') ?? '') === name);
  const loaded = { 'iframe-ct.js': loading('iframe-ct.js').length, 'param.js': loading('param.js').length };

  // The ad's own code: its inline scripts and the script files it loads, never GWD's runtime.
  const own: { where: string; text: string }[] = [];
  readAd(html, css, ad, [], { sheet: () => {}, script: (text, from, to, file) => own.push({ where: file ?? 'this HTML', text: text.slice(from, to) }) });
  const elsewhere: Record<StackAdaptScript, string[]> = { 'iframe-ct.js': [], 'param.js': [] };
  for (const name of STACKADAPT_SCRIPTS) {
    if (loaded[name]) continue;
    const files = own.filter((o) => o.where !== 'this HTML' && TRACE[name].test(o.text)).map((o) => o.where);
    elsewhere[name] = [...new Set([...(TRACE[name].test(html) ? ['this HTML'] : []), ...files])];
  }

  const taps = [...doc.querySelectorAll('.dynamicClick')];
  const param = loading('param.js')[0];
  const tapAreasAfter = param ? taps.filter((t) => param.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).length : 0;
  const links = [...doc.querySelectorAll('a[href]')].some((a) => /^\s*(https?:)?\/\//i.test(a.getAttribute('href') ?? ''));
  const ownExits = [
    ...new Set([
      ...own.flatMap((o) => EXITS.filter(([re]) => re.test(o.text)).map(([, what]) => `${what} in ${o.where}`)),
      ...(links ? ['a link'] : []),
      ...(doc.querySelector('gwd-exit') ? ['a GWD exit'] : []),
    ]),
  ];

  const tags = startTags(html);
  return { loaded, elsewhere, head: headSpot(html, tags), body: bodySpot(html, tags), tapAreas: taps.length, tapAreasAfter, ownExits };
}

export function stackAdaptFindings(r: StackAdaptReport): Finding[] {
  const findings: Finding[] = [];
  const fail = (target: StackAdaptScript, message: string) => findings.push({ check: 'stackAdapt', level: 'fail', target, message });
  for (const name of STACKADAPT_SCRIPTS) {
    const n = r.loaded[name];
    if (!n && r.elsewhere[name].length) {
      const message = `No script tag loads it, but it appears in ${r.elsewhere[name].join(', ')}. Check that it loads, once.`;
      findings.push({ check: 'stackAdapt', level: 'note', target: name, message, unknown: true });
    } else if (!n) {
      fail(name, name === 'iframe-ct.js'
        ? "Not loaded. It reports each click to StackAdapt; StackAdapt's templates load it in the head."
        : "Not loaded. It opens the landing page when the ad is clicked; StackAdapt's templates load it as the body's last tag.");
    } else if (n > 1) {
      fail(name, name === 'iframe-ct.js' ? `Loaded ${n} times, so each click is reported ${n} times.` : `Loaded ${n} times, so one click can open the landing page ${n} times.`);
    }
  }
  if (r.tapAreasAfter) {
    const n = r.tapAreasAfter;
    fail('param.js', `Its tag comes before ${n} tap area${n === 1 ? '' : 's'} (class dynamicClick). It looks for them once, as it loads, so it misses ${n === 1 ? 'it' : 'them'}.`);
  }
  return findings;
}
