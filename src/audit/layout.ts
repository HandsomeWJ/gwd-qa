// The layout safety net. Lays the ad's HTML out with its scripts off, in a hidden sandboxed frame,
// at every served size and at the sizes in and around its ranges that no preview shows, and
// compares two versions of the HTML there: each <p>, <span> and <button>'s line-height, and where
// each line of every text sits. The frame loads the ad's stylesheets and fonts from its cache,
// through the service worker, so text lays out in its own fonts.

import { sizeOfMedia } from '../css/parse';
import { covers, frameSizes, isRange, parseSize, type ServedSize } from '../sizes';
import { describeStates, forceStates, hasStates, type States } from './states';
import { hasDirectText, label } from './static';

export interface LayoutSize {
  key: string; // "310x400"
  width: number;
  height: number;
  /** A preview frame shows this exact size. */
  previewed: boolean;
}

/** A text that the second version lays out differently, at one size. */
export interface LayoutDiff {
  size: string;
  previewed: boolean;
  target: string; // label(el)
  text: string;
  /** Its line-height changed; otherwise only where its lines sit. */
  spacing: boolean;
  /** Classes whose rules lay it out: its own, then those of what it sits in (nearest first), then of what sits in it. */
  classes: string[];
  index: number; // its place in the document, the same in both versions
  /** The hover, focus or click state both versions were laid out in; absent at rest. */
  state?: string;
}

const TEXT_TAGS = new Set(['p', 'span', 'button']);
// As in the previews, requests to other sites are blocked, except stylesheets and fonts. Of scripts,
// only the stand-in runs, in its layout mode, to fill GWD's groups: none of the ad's own.
const NONCE = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const CSP = `default-src 'self' data: blob:; script-src 'nonce-${NONCE}'; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:`;
const GROUPS = `${import.meta.env.BASE_URL}gwd-standin.js?layout`;
// At rest: no animation or transition, which two layouts would catch at different moments; and
// <noscript>, which only shows without scripts, stays hidden as it is in the ad.
const AT_REST = 'noscript{display:none!important}*,*::before,*::after{animation:none!important;transition:none!important}';
const LOAD_MS = 30_000;
const FONT_MS = 8000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function middle(s: ServedSize): [number, number] {
  let w = Math.round((s.min[0] + s.max[0]) / 2);
  let h = Math.round((s.min[1] + s.max[1]) / 2);
  if (s.orientation === 'portrait' && h < w) {
    h = Math.min(s.max[1], w);
    w = Math.min(w, h);
  } else if (s.orientation === 'landscape' && w <= h) {
    w = Math.min(s.max[0], h + 1);
    h = Math.min(h, w - 1);
  }
  return [w, h];
}

const overlap = (a: ServedSize, b: ServedSize) =>
  Math.max(a.min[0], b.min[0]) <= Math.min(a.max[0], b.max[0]) && Math.max(a.min[1], b.min[1]) <= Math.min(a.max[1], b.max[1]);

const corners = (s: ServedSize): [number, number][] => [[s.min[0], s.min[1]], [s.max[0], s.max[1]], [s.min[0], s.max[1]], [s.max[0], s.min[1]]];

/**
 * The sizes to lay the ad out at: every served exact size; and for each range, its two ends, its
 * middle, the sizes at and just around the corners of every other served size (or GWD size block)
 * inside it, where that size's block starts or stops applying, a size on the edge of its
 * orientation, and the sizes either side of a width or height that another media query names.
 * Each keeps the range's orientation.
 */
export function layoutSizes(served: string[], media: string[] = []): LayoutSize[] {
  const sizes = served.map(parseSize).filter((s): s is ServedSize => !!s);
  const keys = new Set(sizes.map((s) => s.key));
  const blocks = media.map(sizeOfMedia).filter((k): k is string => !!k && !keys.has(k)).map(parseSize).filter((s): s is ServedSize => !!s);
  const lines: ['width' | 'height', number][] = [];
  for (const m of media) {
    if (sizeOfMedia(m) !== null) continue;
    for (const x of m.matchAll(/\(\s*(?:min-|max-)?(width|height)\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g)) lines.push([x[1] as 'width' | 'height', Number(x[2])]);
  }
  const previewed = new Set(served.flatMap(frameSizes).map((f) => `${f.width}x${f.height}`));
  const out = new Map<string, LayoutSize>();
  const add = (width: number, height: number) => {
    const key = `${width}x${height}`;
    if (width >= 1 && height >= 1 && !out.has(key)) out.set(key, { key, width, height, previewed: previewed.has(key) });
  };
  for (const s of sizes) {
    if (!isRange(s)) {
      add(s.min[0], s.min[1]);
      continue;
    }
    const at = (w: number, h: number) => {
      if (covers(s, w, h)) add(w, h);
    };
    for (const f of frameSizes(s.key)) add(f.width, f.height);
    const [mw, mh] = middle(s);
    at(mw, mh);
    for (const o of [...sizes, ...blocks]) {
      if (o === s || !overlap(o, s)) continue;
      for (const [cw, ch] of corners(o)) for (const dw of [-1, 0, 1]) for (const dh of [-1, 0, 1]) at(cw + dw, ch + dh);
    }
    if (s.orientation === 'portrait') {
      const x = Math.min(Math.max(mw, s.min[0], s.min[1]), s.max[0], s.max[1]);
      at(x, x);
    } else if (s.orientation === 'landscape') {
      const x = Math.min(Math.max(mh, s.min[1], s.min[0] - 1), s.max[1], s.max[0] - 1);
      at(x + 1, x);
    }
    for (const [axis, v] of lines) {
      for (const n of new Set([Math.floor(v) - 1, Math.floor(v), Math.ceil(v), Math.ceil(v) + 1])) {
        if (axis === 'width') at(n, mh);
        else at(mw, n);
      }
    }
  }
  return [...out.values()];
}

/** The HTML with a base URL for its files, the previews' request blocking, and everything at rest. */
function atRest(html: string, url: string): string {
  let at = 0;
  for (const m of html.matchAll(/<!--[\s\S]*?(?:-->|$)|<head(?=[\s/>])[^>]*>/gi)) {
    if (m[0].startsWith('<!--')) continue;
    at = m.index! + m[0].length;
    break;
  }
  const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `${html.slice(0, at)}<base href="${attr(url)}"><meta http-equiv="Content-Security-Policy" content="${attr(CSP)}"><style>${AT_REST}</style><script nonce="${NONCE}" src="${attr(new URL(GROUPS, location.href).href)}"></script>${html.slice(at)}`;
}

interface Font {
  family: string;
  size: string;
  weight: string;
  style: string;
}

/** One version laid out: its texts, and at each size each text's line-height and lines. */
interface Laid {
  els: { target: string; text: string; classes: string[] }[];
  at: Map<string, string[]>;
  /** In a state layout, what a script sets on an element that the document does not have. */
  unreached: string[];
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

/**
 * Lays out the document in `frame` at each size, after loading every font its texts use in any of
 * them; with `states`, in every hover, focus and click state at once.
 */
async function measure(frame: HTMLIFrameElement, sizes: LayoutSize[], states: States | null): Promise<Laid> {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc?.body || !win) throw new Error('its frame did not load');
  const unreached = states ? forceStates(doc, states) : [];
  const resize = (s: LayoutSize) => {
    frame.style.width = `${s.width}px`;
    frame.style.height = `${s.height}px`;
    if (win.innerWidth !== s.width || win.innerHeight !== s.height) throw new Error(`its frame did not take the size ${s.key}`);
  };
  const els = [...doc.body.querySelectorAll('*')].filter((el) => !el.closest('script, style, template, noscript, textarea')
    && (TEXT_TAGS.has(el.localName) || hasDirectText(el)));
  const fontOf = (cs: CSSStyleDeclaration): Font => ({ family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, style: cs.fontStyle });

  // A font only starts loading once something lays it out, and fonts.ready alone does not wait for it.
  const wanted = new Map<string, Set<string>>();
  for (const s of sizes) {
    resize(s);
    for (const el of els) {
      const f = fontOf(win.getComputedStyle(el));
      const font = `${f.style} ${f.weight} ${f.size} ${f.family}`;
      const chars = wanted.get(font) ?? new Set<string>();
      for (const c of (el.textContent ?? '').slice(0, 200)) chars.add(c);
      wanted.set(font, chars);
    }
  }
  const loads = [...wanted].map(([font, chars]) => doc.fonts.load(font, [...chars].join('').trim() || 'Xg').catch(() => []));
  await Promise.race([Promise.all(loads).then(() => doc.fonts.ready), sleep(FONT_MS)]);

  const at = new Map<string, string[]>();
  const normals = new Map<string, number>(); // line-height: normal by font and text, measured as the checks measure it
  const range = doc.createRange();
  for (const s of sizes) {
    resize(s);
    const asked = new Map<string, Font & { text: string }>();
    const rows = els.map((el) => {
      const cs = win.getComputedStyle(el);
      let lh = '';
      if (TEXT_TAGS.has(el.localName)) {
        if (cs.lineHeight === 'normal') {
          const f = fontOf(cs);
          const text = (el.textContent ?? '').trim() || 'Xg';
          lh = `${f.style} ${f.weight} ${f.size} ${f.family}\n${text}`;
          if (!normals.has(lh)) asked.set(lh, { ...f, text });
        } else {
          lh = px(parseFloat(cs.lineHeight));
        }
      }
      const lines: string[] = [];
      for (const node of el.childNodes) {
        if (node.nodeType !== 3 || !(node.textContent ?? '').trim()) continue;
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) lines.push([r.left, r.top, r.width, r.height].map((v) => v.toFixed(2)).join(','));
      }
      return { lh, lines: lines.join(' ') };
    });
    // Every normal line-height this size needs, in one layout.
    const probes = [...asked].map(([key, f]) => {
      const probe = doc.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;'
        + `font-family:${f.family};font-size:${f.size};font-weight:${f.weight};font-style:${f.style}`;
      probe.textContent = f.text;
      return [key, probe] as const;
    });
    doc.body.append(...probes.map(([, p]) => p));
    for (const [key, probe] of probes) normals.set(key, probe.getBoundingClientRect().height);
    for (const [, probe] of probes) probe.remove();
    at.set(s.key, rows.map((r) => `${normals.has(r.lh) ? px(normals.get(r.lh)!) : r.lh}\n${r.lines}`));
  }

  const info = els.map((el) => {
    const classes = [...el.classList];
    for (let n = el.parentElement; n; n = n.parentElement) classes.push(...n.classList);
    for (const d of el.querySelectorAll('[class]')) classes.push(...d.classList);
    return { target: label(el), text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24), classes: [...new Set(classes)] };
  });
  return { els: info, at, unreached };
}

/** Lays out versions of one ad's HTML and compares them. */
export class LayoutNet {
  // The version the others are compared with, laid out once per view: at rest, and in its states.
  private readonly kept = new Map<string, Promise<Laid>>();
  /** "in its hover, focus or click state (…)" when the ad has one that changes a font or line-height. */
  readonly state: string | null;
  /** What a script sets on an element the ad does not have, so that its state was not laid out. */
  unreached: string[] = [];

  /** `url`: the ad's HTML as the service worker serves it, which its files are relative to. */
  constructor(private readonly url: string, readonly sizes: LayoutSize[], private readonly states: States | null = null) {
    this.state = states && hasStates(states) ? describeStates(states) : null;
  }

  /** Where `after` lays out differently from `before`, at every size or only at the sizes named; at rest, and in the ad's states. */
  async compare(before: string, after: string, only?: string[]): Promise<LayoutDiff[]> {
    const views = this.state ? [false, true] : [false];
    return (await Promise.all(views.map((forced) => this.compareIn(forced, before, after, only)))).flat();
  }

  private async compareIn(forced: boolean, before: string, after: string, only?: string[]): Promise<LayoutDiff[]> {
    const view = forced ? 'state' : 'rest';
    const key = `${view}\n${before}`;
    let base = this.kept.get(key);
    if (!base) {
      for (const k of [...this.kept.keys()]) if (k.startsWith(`${view}\n`)) this.kept.delete(k);
      const laid = this.layOut(before, this.sizes, forced);
      this.kept.set(key, laid);
      laid.catch(() => {
        if (this.kept.get(key) === laid) this.kept.delete(key);
      });
      base = laid;
    }
    const sizes = only ? this.sizes.filter((s) => only.includes(s.key)) : this.sizes;
    const [a, b] = await Promise.all([base, this.layOut(after, sizes, forced)]);
    if (forced) this.unreached = a.unreached;
    const out: LayoutDiff[] = [];
    for (const s of sizes) {
      const [x, y] = [a.at.get(s.key)!, b.at.get(s.key)!];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (x[i] === y[i]) continue;
        const el = b.els[i] ?? a.els[i];
        const spacing = x[i]?.split('\n')[0] !== y[i]?.split('\n')[0];
        out.push({ size: s.key, previewed: s.previewed, target: el.target, text: el.text, spacing, classes: el.classes, index: i, ...(forced ? { state: this.state! } : {}) });
      }
    }
    return out;
  }

  private async layOut(html: string, sizes: LayoutSize[], forced = false): Promise<Laid> {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
    host.setAttribute('aria-hidden', 'true');
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts'); // its CSP lets only the stand-in run
    frame.setAttribute('scrolling', 'no');
    frame.tabIndex = -1;
    frame.style.cssText = 'border:0;display:block';
    host.appendChild(frame);
    try {
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('its frame did not load')), LOAD_MS);
        frame.addEventListener('load', function loaded() {
          if (frame.contentDocument?.URL !== 'about:srcdoc') return;
          frame.removeEventListener('load', loaded);
          clearTimeout(timer);
          done();
        });
        frame.srcdoc = atRest(html, this.url);
        document.body.appendChild(host);
      });
      return await measure(frame, sizes, forced ? this.states : null);
    } finally {
      host.remove();
    }
  }
}
