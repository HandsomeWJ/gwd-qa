// Reads the rendered ad. Every served size runs in its own same-origin frame, and every GWD page
// in it is shown in turn, since GWD keeps inactive pages out of the DOM. The result is plain data
// (Box) that the rendered checks and the fix planner read.

import type { CssModel } from '../css/parse';
import { hasDirectText, label } from './static';
import type { Box } from './types';

export interface AdFrame {
  size: string; // served size key
  label: string; // unique per frame, shown on the page
  el: HTMLIFrameElement;
  started?: boolean; // false when the ad never showed its first page
}

interface PageDeck extends Element {
  getPages(): Element[];
  getCurrentPage(): Element | null;
  goToPage(page: number | string): void;
}

export interface SafetyMismatch {
  size: string;
  target: string;
  animation: string;
  prop: string;
  keyframes: string;
  normal: string;
}

export interface Observation {
  boxes: Box[];
  /** Per frame label, the stylesheet's media conditions that apply in that frame. */
  media: Map<string, Set<string>>;
  safety: SafetyMismatch[];
  safetyChecked: number;
  pages: number; // pages in the ad
  skipped: string[]; // pages that never showed, so were not checked
}

const KEYFRAME_META = ['offset', 'computedOffset', 'easing', 'composite'];
const MOVING = ['transform', 'translate', 'left', 'top', 'right', 'bottom', 'marginLeft', 'marginTop'];
const TEXT_TAGS = new Set(['p', 'span', 'button']);
// An inline <span> inside one of these takes the parent's line-height.
const TEXT_PARENT = 'p, h1, h2, h3, h4, h5, h6, button, a, li, label, span';
const DECLARED = ['line-height', 'color', 'width', 'height', 'margin-block-start', 'margin-block-end'];
const SETTLE_MS = 700; // per-size text overrides land just after a page shows
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function frameParts(f: AdFrame): { doc: Document; win: Window } {
  const doc = f.el.contentDocument;
  const win = f.el.contentWindow;
  if (!doc || !win) throw new Error(`The ${f.label} frame is not loaded.`);
  return { doc, win };
}

/**
 * Polls until `ready` holds. GWD runs on requestAnimationFrame, which browsers do not run in a
 * hidden tab, so the timeout only counts time while the tab is visible.
 */
async function waitVisible(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  let waited = 0;
  const giveUp = performance.now() + 15 * 60_000;
  while (performance.now() < giveUp) {
    if (ready()) return true;
    if (waited >= timeoutMs) return false;
    await sleep(100);
    if (document.visibilityState === 'visible') waited += 100;
  }
  return false;
}

/**
 * Waits for GWD to show its first page (any non-GWD page counts as started once loaded),
 * then lets it settle. Returns false when a GWD ad never starts.
 */
export async function waitForAd(el: HTMLIFrameElement, timeoutMs = 10_000): Promise<boolean> {
  const started = await waitVisible(() => {
    const doc = el.contentDocument;
    return doc?.readyState === 'complete' && (!!doc.querySelector('.gwd-play-animation') || !doc.querySelector('gwd-pagedeck, gwd-page'));
  }, timeoutMs);
  if (started) {
    if (el.contentDocument) await Promise.race([fontsLoaded(el.contentDocument), sleep(8000)]);
    await sleep(SETTLE_MS);
  }
  return started;
}

/**
 * Loads every font the ad's text uses. Line heights are measured from font metrics, and a web
 * font that has not arrived yet measures as its fallback (Times, Arial), which has other metrics.
 * fonts.ready alone is not enough: a font only starts loading once something lays it out.
 */
async function fontsLoaded(doc: Document): Promise<void> {
  const fonts = doc.fonts;
  const win = doc.defaultView;
  if (!fonts || !win) return;
  const wanted = new Map<string, string>();
  for (const el of doc.body.querySelectorAll('*')) {
    if (!hasDirectText(el)) continue;
    const cs = win.getComputedStyle(el);
    wanted.set(`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, (el.textContent ?? '').trim().slice(0, 40));
  }
  await Promise.all([...wanted].map(([font, text]) => fonts.load(font, text || 'Xg').catch(() => [])));
  await fonts.ready;
}

function deckOf(doc: Document): PageDeck | null {
  const deck = doc.querySelector('gwd-pagedeck') as PageDeck | null;
  return deck && typeof deck.getPages === 'function' && typeof deck.goToPage === 'function' ? deck : null;
}

const showing = (deck: PageDeck, page: Element) =>
  deck.getCurrentPage() === page && page.isConnected && page.classList.contains('gwd-play-animation');

/** Shows a page and lets it settle. GWD ignores goToPage during a transition, so it is asked again. */
async function showPage(deck: PageDeck, index: number, page: Element): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const shown = await waitVisible(() => {
      if (showing(deck, page)) return true;
      deck.goToPage(index);
      return false;
    }, 10_000);
    if (!shown) return false;
    await sleep(SETTLE_MS);
    // The ad's own timeline can move on to another page while it settles.
    if (showing(deck, page)) return true;
  }
  return false;
}

/**
 * Calls `fn` once per GWD page, with that page showing. The first call gets the whole body, so
 * elements outside the page deck are seen once; later calls get just their page.
 */
export async function visitPages(f: AdFrame, fn: (scope: Element, multi: boolean) => void): Promise<{ pages: number; skipped: string[] }> {
  const { doc } = frameParts(f);
  const deck = deckOf(doc);
  const pages = deck ? [...deck.getPages()] : [];
  if (!deck || pages.length < 2) {
    fn(doc.body, false);
    return { pages: 1, skipped: [] };
  }
  const skipped: string[] = [];
  let first = true;
  for (const [i, page] of pages.entries()) {
    if (!showing(deck, page) && !(await showPage(deck, i, page))) {
      skipped.push(`${page.id || `page ${i + 1}`} in ${f.label}`);
      continue;
    }
    fn(first ? doc.body : page, true);
    first = false;
  }
  return { pages: pages.length, skipped };
}

/** Values of `props` from inline style or the last matching rule in an active @media block; '' when none. */
export function declared(win: Window, el: Element, props: string[]): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(props.map((p) => [p, '']));
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      const media = (rule as CSSMediaRule).media;
      if (media && (rule as CSSMediaRule).cssRules) {
        if (win.matchMedia(media.mediaText).matches) walk((rule as CSSMediaRule).cssRules);
      } else if ((rule as CSSStyleRule).selectorText) {
        let hit = false;
        try {
          hit = el.matches((rule as CSSStyleRule).selectorText);
        } catch {
          // a selector this browser cannot match
        }
        if (!hit) continue;
        for (const p of props) {
          const v = (rule as CSSStyleRule).style.getPropertyValue(p);
          if (v) out[p] = v;
        }
      }
    }
  };
  for (const sheet of win.document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // cross-origin stylesheet (e.g. Google Fonts)
    }
  }
  for (const p of props) {
    const inline = (el as HTMLElement).style?.getPropertyValue(p);
    if (inline) out[p] = inline;
  }
  return out;
}

export function scaleOf(win: Window, el: Element): number {
  let m = new DOMMatrix();
  for (let n: Element | null = el; n; n = n.parentElement) {
    const t = win.getComputedStyle(n).transform;
    if (t && t !== 'none') m = new DOMMatrix(t).multiply(m);
  }
  return Math.hypot(m.a, m.b);
}

/** Invisible through opacity 0 or visibility: hidden on itself or an ancestor. */
function hiddenNow(win: Window, el: Element): boolean {
  if (win.getComputedStyle(el).visibility === 'hidden') return true;
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (parseFloat(win.getComputedStyle(n).opacity) < 0.01) return true;
  }
  return false;
}

function onScreen(win: Window, el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < win.innerWidth && r.top < win.innerHeight;
}

function propsOf(kfs: Keyframe[]): string[] {
  return [...new Set(kfs.flatMap((k) => Object.keys(k).filter((p) => !KEYFRAME_META.includes(p))))];
}

/** Whether the element or an ancestor has an animation that can carry it on screen. */
function moves(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.getAnimations().some((a) => propsOf((a.effect as KeyframeEffect).getKeyframes()).some((p) => MOVING.includes(p)))) return true;
  }
  return false;
}

/** The px line-height a browser renders for `normal` in this element's font. */
export function normalLineHeight(win: Window, el: Element): number {
  const cs = win.getComputedStyle(el);
  const doc = el.ownerDocument;
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;'
    + `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle}`;
  probe.textContent = (el.textContent ?? '').trim() || 'Xg';
  doc.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.round(px * 100) / 100;
}

const pageOf = (el: Element, multi: boolean) => (multi ? el.closest('gwd-page')?.id ?? '' : '');

/** Every text element and every <p>, <span> and <button> in `scope`. */
function boxesIn(f: AdFrame, scope: Element, multi: boolean): Box[] {
  const { win } = frameParts(f);
  const out: Box[] = [];
  for (const el of scope.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    const typed = hasDirectText(el) && el.getClientRects().length > 0;
    if (!typed && !TEXT_TAGS.has(tag)) continue;
    const cs = win.getComputedStyle(el);
    const d = declared(win, el, DECLARED);
    const box: Box = {
      frame: f.label,
      size: f.size,
      // GWD's text effects replace a text with id- and class-less word spans while the ad runs
      runtime: !el.id && !el.classList.length && !!el.closest('[gwd-text-effect]'),
      page: pageOf(el, multi),
      target: label(el),
      id: el.id,
      tag,
      classes: [...el.classList],
      text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
      declared: {
        lineHeight: d['line-height'],
        color: d.color,
        width: d.width,
        height: d.height,
        marginBlockStart: d['margin-block-start'],
        marginBlockEnd: d['margin-block-end'],
      },
      computed: {
        color: cs.color,
        fontSize: parseFloat(cs.fontSize),
        fontFamily: cs.fontFamily,
        lineHeight: cs.lineHeight,
        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat) as Box['computed']['padding'],
        paddingText: cs.padding,
        textAlign: cs.textAlign,
        whiteSpace: cs.whiteSpace,
        display: cs.display,
        position: cs.position,
        marginTop: parseFloat(cs.marginTop),
        marginBottom: parseFloat(cs.marginBottom),
      },
      inTextParent: tag === 'span' && !!el.parentElement?.closest(TEXT_PARENT),
    };
    if (typed) {
      box.type = { fontSize: parseFloat(cs.fontSize), scale: scaleOf(win, el), onScreen: onScreen(win, el), moves: moves(el), hidden: hiddenNow(win, el) };
    }
    if (TEXT_TAGS.has(tag) && !box.declared.lineHeight) {
      box.normalLineHeight = normalLineHeight(win, el);
      box.fontLoaded = el.ownerDocument.fonts?.check(`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, box.text || 'Xg') ?? true;
    }
    if (box.inTextParent) {
      const parent = el.parentElement!.closest(TEXT_PARENT)!;
      const lh = win.getComputedStyle(parent).lineHeight;
      box.parentLineHeight = lh === 'normal' ? normalLineHeight(win, parent) : parseFloat(lh);
    }
    out.push(box);
  }
  return out;
}

/** An unchanged keyframes value is only safe to delete when it equals the element's normal style. */
function keyframeSafety(f: AdFrame, scope: Element): { checked: number; mismatches: SafetyMismatch[] } {
  const { win } = frameParts(f);
  const mismatches: SafetyMismatch[] = [];
  let checked = 0;
  for (const el of [scope, ...scope.querySelectorAll('*')]) {
    for (const anim of el.getAnimations()) {
      const kfs = (anim.effect as KeyframeEffect).getKeyframes();
      const unchanged = kfs.length > 1
        ? propsOf(kfs).filter((p) => kfs.every((k) => k[p] !== undefined) && new Set(kfs.map((k) => k[p])).size === 1)
        : [];
      if (!unchanged.length) continue;
      anim.pause();
      anim.currentTime = Number((anim.effect as KeyframeEffect).getTiming().delay ?? 0) + 1;
      const style = win.getComputedStyle(el) as unknown as Record<string, string>;
      const animated = unchanged.map((p) => style[p]);
      const saved = (el as HTMLElement).style.animation;
      (el as HTMLElement).style.animation = 'none';
      unchanged.forEach((p, i) => {
        checked++;
        const normal = (win.getComputedStyle(el) as unknown as Record<string, string>)[p];
        if (normal !== animated[i]) {
          mismatches.push({ size: f.label, target: label(el), animation: (anim as CSSAnimation).animationName, prop: p, keyframes: animated[i], normal });
        }
      });
      (el as HTMLElement).style.animation = saved;
    }
  }
  return { checked, mismatches };
}

/** Reads every frame, showing each GWD page in turn. Leaves the frames on their last page. */
export async function observe(frames: AdFrame[], css: CssModel): Promise<Observation> {
  const conditions = [...new Set(css.media.map((m) => m.media))];
  const results = await Promise.all(frames.map(async (f) => {
    const { win } = frameParts(f);
    const boxes: Box[] = [];
    const safety: SafetyMismatch[] = [];
    let checked = 0;
    const visit = await visitPages(f, (scope, multi) => {
      boxes.push(...boxesIn(f, scope, multi));
      const s = keyframeSafety(f, scope); // pauses animations, so it goes after the boxes
      checked += s.checked;
      safety.push(...s.mismatches);
    });
    return { f, media: new Set(conditions.filter((c) => win.matchMedia(c).matches)), boxes, safety, checked, visit };
  }));
  return {
    boxes: results.flatMap((r) => r.boxes),
    media: new Map(results.map((r) => [r.f.label, r.media])),
    safety: results.flatMap((r) => r.safety),
    safetyChecked: results.reduce((n, r) => n + r.checked, 0),
    pages: Math.max(1, ...results.map((r) => r.visit.pages)),
    skipped: results.flatMap((r) => r.visit.skipped),
  };
}

/** Client rects of every text node on every page, with animations paused at 1s so two runs compare. */
export async function positions(frames: AdFrame[]): Promise<Map<string, string>> {
  const results = await Promise.all(frames.map(async (f) => {
    const { doc, win } = frameParts(f);
    const out: [string, string][] = [];
    const seen = new Map<string, number>();
    await visitPages(f, (scope, multi) => {
      doc.getAnimations().forEach((a) => {
        a.pause();
        a.currentTime = 1000;
      });
      for (const el of scope.querySelectorAll('*')) {
        if (!hasDirectText(el)) continue;
        const page = pageOf(el, multi);
        let key = `${f.label}${page ? ` ${page}` : ''} ${label(el)} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n > 1) key += ` (${n})`;
        const rects: string[] = [];
        for (const node of el.childNodes) {
          if (node.nodeType !== 3 || !(node.textContent ?? '').trim()) continue;
          const range = doc.createRange();
          range.selectNodeContents(node);
          for (const b of range.getClientRects()) rects.push([b.left, b.top, b.width, b.height].map((v) => v.toFixed(2)).join(','));
        }
        out.push([key, `${rects.join(' | ')} ${win.getComputedStyle(el).display}`]);
      }
      // Line spacing too, element by element: unlike positions it does not depend on what is
      // showing at this moment, so text that is hidden or not yet typed is compared as well.
      for (const el of scope.querySelectorAll('p, span, button')) {
        if (!el.id && !el.classList.length && el.closest('[gwd-text-effect]')) continue;
        const page = pageOf(el, multi);
        let key = `${f.label}${page ? ` ${page}` : ''} ${label(el)} line-height`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n > 1) key += ` (${n})`;
        const lh = win.getComputedStyle(el).lineHeight;
        out.push([key, lh === 'normal' ? `${normalLineHeight(win, el)}px` : lh]);
      }
    });
    return out;
  }));
  return new Map(results.flat());
}

export function comparePositions(before: Map<string, string>, after: Map<string, string>) {
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k));
  return {
    changed,
    missing: [...before.keys()].filter((k) => !after.has(k)),
    added: [...after.keys()].filter((k) => !before.has(k)),
    unchanged: before.size - changed.length,
  };
}
