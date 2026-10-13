// Reads the rendered ad. Every served size runs in its own same-origin frame, and every GWD page
// in it is shown in turn, since GWD keeps inactive pages out of the DOM. The result is plain data
// (Box) that the rendered checks and the fix planner read.

import { sizeOfMedia, type CssModel, type MediaBlock, type StyleRule } from '../css/parse';
import { hasDirectText, label } from './static';
import type { Box, Inheritor } from './types';

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
  /** Labels of the frames where a page never showed. */
  incomplete: Set<string>;
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

interface Font {
  family: string;
  size: string;
  weight: string;
  style: string;
}

const fontOf = (cs: CSSStyleDeclaration): Font => ({ family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, style: cs.fontStyle });
const fontText = (f: Font) => `${f.style} ${f.weight} ${f.size} ${f.family}`;

/**
 * Whether text renders in its own font. A web font that failed to load (missing from the upload)
 * or has not loaded yet leaves a fallback font in its place, whose spacing is not the design's.
 */
function fontReady(doc: Document, font: Font, text: string): boolean {
  const fonts = doc.fonts;
  if (!fonts) return true;
  const unquote = (f: string) => f.trim().replace(/^["']|["']$/g, '');
  const family = unquote(font.family.split(',')[0]);
  const faces: FontFace[] = [];
  fonts.forEach((f) => { if (unquote(f.family) === family) faces.push(f); });
  if (faces.some((f) => f.status === 'error') && !faces.some((f) => f.status === 'loaded')) return false;
  try {
    return fonts.check(fontText(font), text || 'Xg');
  } catch {
    return false; // not a font it can read, such as a size block's "font-weight: inherit"
  }
}

/** The px line-height a browser renders for `normal` in this font. */
function measureNormal(doc: Document, font: Font, text: string): number {
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;'
    + `font-family:${font.family};font-size:${font.size};font-weight:${font.weight};font-style:${font.style}`;
  probe.textContent = text.trim() || 'Xg';
  doc.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.round(px * 100) / 100;
}

/** The px line-height a browser renders for `normal` in this element's font. */
export function normalLineHeight(win: Window, el: Element): number {
  return measureNormal(el.ownerDocument, fontOf(win.getComputedStyle(el)), el.textContent ?? '');
}

const pageOf = (el: Element, multi: boolean) => (multi ? el.closest('gwd-page')?.id ?? '' : '');

// GWD's text helper (gwdtexthelper_min.js) has gwd-text-fitting.js shrink the text that matches
// its fit-font-size-for-selector until it fits its box, when the ad starts and on each page.
interface Fitting {
  helper: Element;
  selector: string;
  reduce: boolean; // the helper's default: shrink, unless its data-gwd-fit-font-size is "false"
  min: number; // px it never shrinks below
  runs: boolean; // GWD's own fitting ran in this frame
}

function fittingOf(doc: Document, win: Window): Fitting | null {
  const helper = doc.querySelector('gwd-text-helper');
  if (!helper) return null;
  const min = parseInt(helper.getAttribute('gwd-min-font-size-px') ?? '', 10);
  const gwd = (win as unknown as { gwd?: { textfitting?: { fit?: unknown } } }).gwd;
  return {
    helper,
    selector: helper.getAttribute('fit-font-size-for-selector') || ':not(*)',
    reduce: helper.getAttribute('data-gwd-fit-font-size') !== 'false',
    min: Number.isNaN(min) ? 10 : min,
    runs: typeof gwd?.textfitting?.fit === 'function' && typeof (helper as unknown as { fit?: unknown }).fit === 'function',
  };
}

const matches = (el: Element, selector: string) => {
  try {
    return el.matches(selector);
  } catch {
    return false; // a selector this browser cannot match
  }
};

/**
 * Whether GWD's fitting sets the font-size of this element or of the text it sits in (fitting
 * turns the px font-sizes inside a fitted element into em, so they shrink with it).
 */
function fitted(fit: Fitting, win: Window, el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n === fit.helper || n.hasAttribute('gwd-dont-fit') || !matches(n, fit.selector)) continue;
    const own = n.getAttribute('data-gwd-fit-font-size');
    if (!(own === null ? fit.reduce : own !== 'false')) continue;
    // With GWD's fitting running, what was measured may already be fitted.
    if (fit.runs) return true;
    const min = parseInt(n.getAttribute('gwd-min-font-size-px') ?? '', 10);
    if (parseFloat(win.getComputedStyle(n).fontSize) > (Number.isFinite(min) ? min : fit.min)) return true;
  }
  return false;
}

/** Texts inside `el` that take its line-height today; `byEl` holds every box in its scope. */
function inheritors(win: Window, el: Element, byEl: Map<Element, Box>): Inheritor[] {
  const out: Inheritor[] = [];
  for (const d of el.querySelectorAll('*')) {
    const box = byEl.get(d);
    if (!box?.type || box.declared.lineHeight || box.computed.lineHeight !== 'normal') continue;
    const path: Inheritor['path'] = [];
    for (let n: Element | null = d; n && n !== el; n = n.parentElement) {
      if (TEXT_TAGS.has(n.localName)) path.unshift({ tag: n.localName, classes: [...n.classList] });
    }
    out.push({
      target: box.target,
      tag: box.tag,
      path,
      normal: box.normalLineHeight ?? normalLineHeight(win, d),
      fontLoaded: box.fontLoaded ?? fontReady(d.ownerDocument, fontOf(win.getComputedStyle(d)), box.text),
    });
  }
  return out;
}

const FONT_PROPS: [string, keyof Font][] = [['font-family', 'family'], ['font-size', 'size'], ['font-weight', 'weight'], ['font-style', 'style']];
const FONT_DECL = /^font(-family|-size|-weight|-style)?$/;

/** A size block and its rules that set a font property, in source order. */
interface FontBlock {
  block: MediaBlock;
  rules: StyleRule[];
}

interface ProbeSpec {
  box: Box;
  start: number; // the block's start offset
  font: Font | null; // null: it cannot be measured exactly
  text: string;
}

/** What boxesIn needs besides the frame: the stylesheet, and the probes it asks for. */
interface Context {
  css: CssModel;
  fonts: FontBlock[];
  fit: Fitting | null;
  claimed: WeakMap<Element, Set<number>>; // the blocks each element is already probed under
  specs: ProbeSpec[];
}

/**
 * Asks for the element's normal line-height under every size block that changes its font (or an
 * ancestor's, which it inherits) but does not apply in this frame, so that a line-height given to
 * its base rule can be checked in sizes no frame shows. Only from a frame whose own size blocks
 * leave its font alone: its font here is then the base one, and the block's declarations go on top.
 */
function askProbes(win: Window, el: Element, box: Box, ctx: Context) {
  if (!box.classes.length || !ctx.fonts.length) return;
  const chain: Element[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
  const touches = (fb: FontBlock) => fb.rules.some((r) => chain.some((n) => matches(n, r.selector)));
  const applying = ctx.fonts.filter((fb) => win.matchMedia(fb.block.media).matches);
  if (applying.some(touches)) return;
  // Texts that take its line-height: a block that changes their font leaves what they need unknown.
  const below = box.inherits?.length ? [...el.querySelectorAll('*')] : [];
  for (const fb of ctx.fonts) {
    if (applying.includes(fb)) continue;
    const done = ctx.claimed.get(el) ?? new Set<number>();
    if (done.has(fb.block.start)) continue;
    const inside = fb.rules.some((r) => below.some((n) => matches(n, r.selector)));
    if (!inside && !touches(fb)) continue;
    ctx.claimed.set(el, done.add(fb.block.start));
    ctx.specs.push({ box, start: fb.block.start, font: inside ? null : fontUnder(win, chain, fb, ctx.css), text: el.textContent ?? '' });
  }
}

/** The font of chain[0] under a size block: its own, with what the block sets for it or for an ancestor it inherits from. */
function fontUnder(win: Window, chain: Element[], fb: FontBlock, css: CssModel): Font | null {
  const font = fontOf(win.getComputedStyle(chain[0]));
  const sets = (r: StyleRule, prop: string) => r.decls.some((d) => d.prop === prop || d.prop === 'font');
  for (const [prop, key] of FONT_PROPS) {
    for (const n of chain) {
      const rule = fb.rules.filter((r) => sets(r, prop) && matches(n, r.selector)).pop();
      if (rule) {
        const d = rule.decls.filter((x) => x.prop === prop || x.prop === 'font').pop()!;
        // The shorthand also sets line-height, and a relative size depends on what it sits in.
        if (d.prop === 'font' || (prop === 'font-size' && !/^\d*\.?\d+px$/.test(d.value))) return null;
        font[key] = d.value;
        break;
      }
      // Declared here for every size: the element keeps what it has now.
      if ((n as HTMLElement).style?.getPropertyValue(prop) || css.rules.some((r) => r.media === null && sets(r, prop) && matches(n, r.selector))) break;
    }
  }
  return font;
}

/** Measures what askProbes asked for, loading each font first. */
async function runProbes(doc: Document, specs: ProbeSpec[]): Promise<void> {
  const fonts = doc.fonts;
  if (fonts) {
    const loads = specs.filter((s) => s.font).map((s) => fonts.load(fontText(s.font!), s.text.trim() || 'Xg').catch(() => []));
    await Promise.race([Promise.all(loads), sleep(8000)]);
  }
  for (const s of specs) {
    const px = s.font && fontReady(doc, s.font, s.text.trim()) ? measureNormal(doc, s.font, s.text) : null;
    s.box.probes = { ...s.box.probes, [s.start]: px };
  }
}

/** Every text element and every <p>, <span> and <button> in `scope`. */
function boxesIn(f: AdFrame, scope: Element, multi: boolean, ctx: Context): Box[] {
  const { win } = frameParts(f);
  const out: Box[] = [];
  const byEl = new Map<Element, Box>();
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
      box.fontLoaded = fontReady(el.ownerDocument, fontOf(cs), box.text);
    }
    if (box.inTextParent) {
      const parent = el.parentElement!.closest(TEXT_PARENT)!;
      const lh = win.getComputedStyle(parent).lineHeight;
      box.parentLineHeight = lh === 'normal' ? normalLineHeight(win, parent) : parseFloat(lh);
    }
    if (ctx.fit && fitted(ctx.fit, win, el)) box.fit = ctx.fit.runs ? 'runs' : 'missing';
    byEl.set(el, box);
    out.push(box);
  }
  for (const [el, box] of byEl) {
    if (!TEXT_TAGS.has(box.tag) || box.declared.lineHeight || box.runtime) continue;
    box.inherits = inheritors(win, el, byEl);
    askProbes(win, el, box, ctx);
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
  const fonts = css.media
    .filter((block) => sizeOfMedia(block.media) !== null)
    .map((block) => ({
      block,
      rules: css.rules.filter((r) => r.start > block.open && r.start < block.close && r.decls.some((d) => FONT_DECL.test(d.prop))),
    }))
    .filter((fb) => fb.rules.length);
  const claimed = new WeakMap<Element, Set<number>>();
  const results = await Promise.all(frames.map(async (f) => {
    const { doc, win } = frameParts(f);
    const boxes: Box[] = [];
    const safety: SafetyMismatch[] = [];
    let checked = 0;
    const ctx: Context = { css, fonts, fit: fittingOf(doc, win), claimed, specs: [] };
    const visit = await visitPages(f, (scope, multi) => {
      boxes.push(...boxesIn(f, scope, multi, ctx));
      const s = keyframeSafety(f, scope); // pauses animations, so it goes after the boxes
      checked += s.checked;
      safety.push(...s.mismatches);
    });
    await runProbes(doc, ctx.specs);
    return { f, media: new Set(conditions.filter((c) => win.matchMedia(c).matches)), boxes, safety, checked, visit };
  }));
  return {
    boxes: results.flatMap((r) => r.boxes),
    media: new Map(results.map((r) => [r.f.label, r.media])),
    safety: results.flatMap((r) => r.safety),
    safetyChecked: results.reduce((n, r) => n + r.checked, 0),
    pages: Math.max(1, ...results.map((r) => r.visit.pages)),
    skipped: results.flatMap((r) => r.visit.skipped),
    incomplete: new Set(results.filter((r) => r.visit.skipped.length).map((r) => r.f.label)),
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

// The keys positions() gives line spacings; every other key is a text's position.
const LINE_HEIGHT_KEY = / line-height( \(\d+\))?$/;

/** Compares two positions() snapshots, counting texts and line spacings apart. A key that is gone counts as changed. */
export function comparePositions(before: Map<string, string>, after: Map<string, string>) {
  const keys = [...before.keys()];
  const differs = (k: string) => after.get(k) !== before.get(k);
  const texts = keys.filter((k) => !LINE_HEIGHT_KEY.test(k));
  const spacings = keys.filter((k) => LINE_HEIGHT_KEY.test(k));
  return {
    changed: keys.filter((k) => after.has(k) && differs(k)),
    missing: keys.filter((k) => !after.has(k)),
    added: [...after.keys()].filter((k) => !before.has(k)),
    texts: texts.length,
    moved: texts.filter(differs),
    spacings: spacings.length,
    respaced: spacings.filter(differs),
  };
}
