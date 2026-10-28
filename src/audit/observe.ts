// Reads the rendered ad. Every served size runs in its own same-origin frame, and every GWD page
// in it is shown in turn, since GWD keeps inactive pages out of the DOM. The result is plain data
// (Box) that the rendered checks and the fix planner read.

import { lastCompound, singleClass, type CssModel, type Decl, type MediaBlock, type StyleRule } from '../css/parse';
import { gwdRefNames, type States } from './states';
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
  /** Set where the element draws nothing in this frame, nor anything in it, and cannot push what does. */
  hidden?: HiddenSubtree;
}

/**
 * An element its own style hides (visibility, from a rule, not its style attribute), absolutely
 * positioned, with nothing in it made visible: what names it and what runs on it, which decide
 * whether anything in the ad's CSS or scripts could show it.
 */
export interface HiddenSubtree {
  ids: string[];
  classes: string[];
  animations: string[];
  /** Its place in the document (domPath), which CSS edits never change: what positions() tells texts apart by. */
  path: string;
}

/** An element's place in its document: the index among its parent's elements, at each level from the root. */
export function domPath(el: Element): string {
  const steps: number[] = [];
  for (let x: Element | null = el; x?.parentElement; x = x.parentElement) steps.unshift([...x.parentElement.children].indexOf(x));
  return steps.join('/');
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

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|math|emoji|fangsong|-apple-system|blinkmacsystemfont)$/i;

/**
 * Whether text renders in its own font. A web font that failed to load (missing from the upload)
 * or has not loaded yet leaves a fallback font in its place, whose spacing is not the design's. So
 * does a font that a blocked script would have loaded (a web font loader), which leaves no
 * FontFace at all: check() passes it, so it must be one the browser has.
 */
function fontReady(doc: Document, font: Font, text: string): boolean {
  const fonts = doc.fonts;
  if (!fonts) return true;
  const unquote = (f: string) => f.trim().replace(/^["']|["']$/g, '');
  const family = unquote(font.family.split(',')[0]);
  const faces: FontFace[] = [];
  fonts.forEach((f) => { if (unquote(f.family) === family) faces.push(f); });
  if (faces.some((f) => f.status === 'error') && !faces.some((f) => f.status === 'loaded')) return false;
  if (!faces.length && !GENERIC.test(family) && !installed(doc, family)) return false;
  try {
    return fonts.check(fontText(font), text || 'Xg');
  } catch {
    return false; // not a font it can read, such as a size block's "font-weight: inherit"
  }
}

/** Whether the browser has a font of this family to draw with: text in one it lacks measures as its fallback. */
function installed(doc: Document, family: string): boolean {
  const ctx = doc.createElement('canvas').getContext('2d');
  if (!ctx) return true;
  const sample = 'mmmmmmmmmmlli1WQ@#';
  return ['monospace', 'serif'].some((fallback) => {
    ctx.font = `72px ${fallback}`;
    const width = ctx.measureText(sample).width;
    ctx.font = `72px "${family.replace(/"/g, '')}", ${fallback}`;
    return Math.abs(ctx.measureText(sample).width - width) > 0.01;
  });
}

const lineCss = (font: Font) => 'white-space:nowrap;line-height:normal;'
  + `font-family:${font.family};font-size:${font.size};font-weight:${font.weight};font-style:${font.style}`;

/** The px line-height a browser renders for `normal` in this font: the line box of the whole text on one line. */
function measureNormal(doc: Document, font: Font, text: string): number {
  const probe = doc.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;${lineCss(font)}`;
  probe.textContent = text.trim() || 'Xg';
  doc.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.round(px * 100) / 100;
}

/**
 * Whether some characters of the text draw in a fallback font with other metrics (an emoji, a
 * symbol, Chinese, Japanese or Korean type the font lacks). Under line-height: normal a line that
 * holds one is taller than one that does not, so the lines of a wrapped text need not all be one
 * height, and no one value keeps them. Each character is laid out on a line of its own.
 */
function mixedFonts(doc: Document, font: Font, text: string): boolean {
  const glyphs = [...new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((g) => g.segment).filter((g) => g.trim()))];
  if (glyphs.length < 2) return false;
  const lines = doc.createElement('div');
  lines.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0';
  for (const g of glyphs) {
    const line = doc.createElement('div');
    line.style.cssText = lineCss(font);
    line.textContent = g;
    lines.appendChild(line);
  }
  doc.body.appendChild(lines);
  const heights = [...lines.children].map((line) => line.getBoundingClientRect().height);
  lines.remove();
  return heights.some((h) => Math.abs(h - heights[0]) > 0.005);
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

// An element takes its parent's line-height where it declares none, or one of these.
const TAKES_PARENT = new Set(['', 'inherit', 'unset', 'revert', 'revert-layer']);

/**
 * Texts inside `el` that take its line-height today: no element from the text up to `el` declares
 * one of its own (a multiplier or 'inherit' passes it on too). `byEl` holds every box in its scope;
 * `own` caches the line-height elements without a box declare.
 */
function inheritors(win: Window, el: Element, byEl: Map<Element, Box>, own: Map<Element, string>, ctx: Context): Inheritor[] {
  const out: Inheritor[] = [];
  const takes = (n: Element) => {
    if (!own.has(n)) own.set(n, byEl.get(n)?.declared.lineHeight ?? declared(win, n, ['line-height'])['line-height']);
    return TAKES_PARENT.has(own.get(n)!.trim().toLowerCase());
  };
  for (const d of el.querySelectorAll('*')) {
    const box = byEl.get(d);
    if (!box?.type) continue;
    const path: Inheritor['path'] = [];
    let n: Element | null = d;
    for (; n && n !== el && takes(n); n = n.parentElement) path.unshift({ tag: n.localName, classes: [...n.classList] });
    if (n !== el) continue; // an element on the way declares a line-height of its own
    const cs = win.getComputedStyle(d);
    const normal = cs.lineHeight === 'normal';
    out.push({
      target: box.target,
      tag: box.tag,
      path,
      // what it renders now: its font's normal, or the px it inherits (a multiplier resolved in its own font)
      normal: normal ? box.normalLineHeight ?? normalLineHeight(win, d) : Math.round(parseFloat(cs.lineHeight) * 100) / 100,
      fontLoaded: !normal || (box.fontLoaded ?? fontReady(d.ownerDocument, fontOf(cs), box.text)),
      ...((box.fontAnimated ?? fontAnimated(d, ctx)) ? { fontAnimated: true } : {}),
    });
  }
  return out;
}

// Keyframe properties (as getKeyframes names them) that change a text's line spacing while it plays.
const SPACING_KEYFRAME = /^(font|lineHeight)/;

/**
 * Whether an animation on the element or an element it sits in changes its font or line-height,
 * now or later in the timeline (one that has not started is not always running yet), so that what
 * was measured holds at one moment only.
 */
function fontAnimated(el: Element, ctx: Context): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.getAnimations().some((a) => propsOf((a.effect as KeyframeEffect).getKeyframes()).some((p) => SPACING_KEYFRAME.test(p)))) return true;
    if (ctx.animators.some((s) => matches(n!, s)) || ctx.stateAnimated(n)) return true;
  }
  return false;
}

const FONT_PROPS: [string, keyof Font][] = [['font-family', 'family'], ['font-size', 'size'], ['font-weight', 'weight'], ['font-style', 'style']];
const FONT_DECL = /^font(-family|-size|-weight|-style)?$/;
// A form control does not inherit its font: the browser's own style gives it one.
const FORM_CONTROLS = new Set(['button', 'input', 'select', 'textarea']);

/** An @media block (a GWD size or any other) and its rules that set a font property or line-height, in source order. */
interface FontBlock {
  block: MediaBlock;
  rules: StyleRule[];
}

const setsFont = (r: StyleRule, prop?: string) => r.decls.some((d) => (prop ? d.prop === prop || d.prop === 'font' : FONT_DECL.test(d.prop)));
// The shorthand sets a line-height too.
const setsSpacing = (r: StyleRule) => r.decls.some((d) => d.prop === 'line-height' || d.prop === 'font');

/** Whether a font value depends on the font of what the element sits in. */
function relative(prop: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (/^(inherit|unset|revert|revert-layer)$|var\(/.test(v)) return true;
  if (prop === 'font-size') return !/^\d*\.?\d+px$/.test(v);
  return prop === 'font-weight' && (v === 'bolder' || v === 'lighter');
}

/** Whether a browser keeps a declaration: one it cannot read (line-height: 1,5) is dropped, as if never written. */
function kept(d: Decl): boolean {
  try {
    return CSS.supports(d.prop, d.value.replace(/\s*!\s*important\s*$/i, ''));
  } catch {
    return true;
  }
}

interface ProbeSpec {
  box: Box;
  start: number; // the block's start offset
  font: Font | null; // null: it cannot be measured exactly
  text: string;
}

/** What boxesIn needs besides the frame: the stylesheet, and the probes it asks for. */
interface Context {
  css: CssModel; // as a browser reads it: without the declarations it drops
  blocks: FontBlock[];
  fit: Fitting | null;
  claimed: WeakMap<Element, Set<number>>; // the blocks each element is already probed under
  specs: ProbeSpec[];
  /** The selectors (their last compound) that run keyframes setting a font property or line-height. */
  animators: string[];
  /** Whether a script puts a class on the element that runs such keyframes, as when it is clicked. */
  stateAnimated: (el: Element) => boolean;
}

/**
 * Asks for the element's normal line-height under every @media block that does not apply in this
 * frame and sets a font property or line-height for it or an element it sits in (or the font of a
 * text that takes its line-height), so that a line-height given to it can be checked in sizes no
 * frame shows. A block is measured only where that is exact: from a frame whose own blocks leave its
 * chain alone (its font here is then the base one, and the block's declarations go on top), for a
 * block that sets no line-height in its chain and no font inside it. Every other one is null, so
 * the planner knows the block is there but not what it needs.
 */
function askProbes(win: Window, el: Element, box: Box, ctx: Context) {
  if (!box.classes.length || !ctx.blocks.length) return;
  const chain: Element[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
  const on = (fb: FontBlock, nodes: Element[], test: (r: StyleRule) => boolean) => fb.rules.some((r) => test(r) && nodes.some((n) => matches(n, r.selector)));
  const any = () => true;
  const applying = ctx.blocks.filter((fb) => win.matchMedia(fb.block.media).matches);
  const based = !applying.some((fb) => on(fb, chain, any));
  // Texts that take its line-height: a block that changes their font leaves what they need unknown.
  const below = box.inherits?.length ? [...el.querySelectorAll('*')] : [];
  for (const fb of ctx.blocks) {
    if (applying.includes(fb)) continue;
    const done = ctx.claimed.get(el) ?? new Set<number>();
    if (done.has(fb.block.start)) continue;
    const inside = on(fb, below, (r) => setsFont(r));
    if (!inside && !on(fb, chain, any)) continue;
    ctx.claimed.set(el, done.add(fb.block.start));
    const exact = based && !inside && !on(fb, chain, setsSpacing);
    ctx.specs.push({ box, start: fb.block.start, font: exact ? fontUnder(win, chain, fb, ctx.css) : null, text: el.textContent ?? '' });
  }
}

/**
 * The font of chain[0] under a block: its own, with what the block sets for it or for an ancestor it
 * inherits from. Null where that is not plain: an inline style, an !important, an id or a longer
 * selector may beat the block's rule, a relative value depends on an element above that the block
 * changes, and the shorthand also sets a line-height.
 */
function fontUnder(win: Window, chain: Element[], fb: FontBlock, css: CssModel): Font | null {
  const font = fontOf(win.getComputedStyle(chain[0]));
  const base = css.rules.filter((r) => r.media === null);
  const decl = (r: StyleRule, prop: string) => r.decls.filter((d) => d.prop === prop || d.prop === 'font').pop()!;
  for (const [prop, key] of FONT_PROPS) {
    const sets = (r: StyleRule) => setsFont(r, prop);
    for (const [i, n] of chain.entries()) {
      const mine = fb.rules.filter((r) => sets(r) && matches(n, r.selector));
      const own = base.filter((r) => sets(r) && matches(n, r.selector));
      const inline = (n as HTMLElement).style?.getPropertyValue(prop) ?? '';
      const decls = [...mine, ...own].map((r) => decl(r, prop));
      if (decls.some((d) => /!\s*important\s*$/i.test(d.value))) return null;
      if (mine.length) {
        if (inline || [...mine, ...own].some((r) => !singleClass(r.selector))) return null;
        const d = decl(mine.at(-1)!, prop);
        if (d.prop === 'font' || relative(prop, d.value)) return null;
        font[key] = d.value;
        break;
      }
      if (inline || own.length) {
        // Declared here for every size: it keeps what it has now, unless that depends on an element above that the block changes.
        const above = chain.slice(i + 1);
        if ([inline, ...decls.map((d) => d.value)].some((v) => v && relative(prop, v)) && fb.rules.some((r) => sets(r) && above.some((a) => matches(a, r.selector)))) return null;
        break;
      }
      if (FORM_CONTROLS.has(n.localName)) break;
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
    const px = s.font && fontReady(doc, s.font, s.text.trim()) && !mixedFonts(doc, s.font, s.text) ? measureNormal(doc, s.font, s.text) : null;
    s.box.probes = { ...s.box.probes, [s.start]: px };
  }
}

/**
 * Every text element and every <p>, <span> and <button> in `scope`, and every element with a class
 * and no text of its own that holds text.
 */
function boxesIn(f: AdFrame, scope: Element, multi: boolean, ctx: Context): Box[] {
  const { win } = frameParts(f);
  const out: Box[] = [];
  const byEl = new Map<Element, Box>();
  for (const el of scope.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    const direct = hasDirectText(el);
    const typed = direct && el.getClientRects().length > 0;
    const holder = !direct && !TEXT_TAGS.has(tag) && el.classList.length > 0 && (el.textContent ?? '').trim() !== '' && !el.closest('script, style, template, noscript');
    if (!typed && !TEXT_TAGS.has(tag) && !holder) continue;
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
    if (holder) box.holder = true;
    if (TEXT_TAGS.has(tag) && !box.declared.lineHeight) {
      box.normalLineHeight = normalLineHeight(win, el);
      box.fontLoaded = fontReady(el.ownerDocument, fontOf(cs), box.text);
      if (cs.lineHeight === 'normal' && mixedFonts(el.ownerDocument, fontOf(cs), el.textContent ?? '')) box.mixedFonts = true;
      if (fontAnimated(el, ctx)) box.fontAnimated = true;
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
  const own = new Map<Element, string>();
  for (const [el, box] of byEl) {
    if (box.runtime || !box.classes.length) continue;
    box.inherits = inheritors(win, el, byEl, own, ctx);
    if (TEXT_TAGS.has(box.tag) && !box.declared.lineHeight) askProbes(win, el, box, ctx);
  }
  return out;
}

/** The element and everything in it, open shadow roots included. */
function subtree(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (root: Element | ShadowRoot) => {
    for (const x of root.querySelectorAll('*')) {
      out.push(x);
      if (x.shadowRoot) walk(x.shadowRoot);
    }
  };
  out.push(el);
  if (el.shadowRoot) walk(el.shadowRoot);
  walk(el);
  return out;
}

/** The element as a HiddenSubtree, when it draws nothing now and cannot move what does; else undefined. */
function hiddenSubtree(win: Window, el: Element): HiddenSubtree | undefined {
  const hides = (v: string) => /^(hidden|collapse)$/.test(v.trim());
  const cs = win.getComputedStyle(el);
  if (!hides(cs.visibility) || !/^(absolute|fixed)$/.test(cs.position)) return undefined;
  if ((el as HTMLElement).style?.visibility || !hides(declared(win, el, ['visibility']).visibility)) return undefined;
  const all = subtree(el);
  if (all.some((x) => win.getComputedStyle(x).visibility === 'visible')) return undefined;
  const ids = all.map((x) => x.id).filter(Boolean);
  const classes = [...new Set(all.flatMap((x) => [...x.classList]))];
  const animations = [...new Set(all.flatMap((x) => win.getComputedStyle(x).animationName.split(/,\s*/)).filter((n) => n && n !== 'none'))];
  return { ids, classes, animations, path: domPath(el) };
}

/**
 * An unchanged keyframes value is only safe to delete when it equals the element's normal style, or
 * when the element never shows (see HiddenSubtree; the planner checks what could show it).
 */
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
      const hidden = hiddenSubtree(win, el);
      const saved = (el as HTMLElement).style.animation;
      (el as HTMLElement).style.animation = 'none';
      unchanged.forEach((p, i) => {
        checked++;
        const normal = (win.getComputedStyle(el) as unknown as Record<string, string>)[p];
        if (normal !== animated[i]) {
          mismatches.push({ size: f.label, target: label(el), animation: (anim as CSSAnimation).animationName, prop: p, keyframes: animated[i], normal, ...(hidden ? { hidden } : {}) });
        }
      });
      (el as HTMLElement).style.animation = saved;
    }
  }
  return { checked, mismatches };
}

/**
 * Reads every frame, showing each GWD page in turn. Leaves the frames on their last page. `states`
 * holds the classes the ad's scripts put on elements, as when they are clicked.
 */
export async function observe(frames: AdFrame[], css: CssModel, states?: States): Promise<Observation> {
  const conditions = [...new Set(css.media.map((m) => m.media))];
  const live: CssModel = { ...css, rules: css.rules.map((r) => ({ ...r, decls: r.decls.filter(kept) })) };
  const blocks = css.media
    .map((block) => ({
      block,
      rules: live.rules.filter((r) => r.start > block.open && r.start < block.close && (setsFont(r) || setsSpacing(r))),
    }))
    .filter((fb) => fb.rules.length);
  const spacingKeyframes = new Set(css.keyframes.filter((k) => k.frames.some((fr) => fr.decls.some((d) => /^(font(-|$)|line-height$)/.test(d.prop)))).map((k) => k.name));
  const animators = css.rules
    .filter((r) => r.decls.some((d) => /^(-webkit-)?animation(-name)?$/.test(d.prop) && d.value.split(/[\s,]+/).some((name) => spacingKeyframes.has(name))))
    // the element it styles, whatever state (playing, clicked) the rest of the selector waits for
    .flatMap((r) => r.selector.split(',').map((sel) => lastCompound(sel).replace(/::?[a-z-]+(\([^)]*\))?/gi, '') || '*'));
  // A class a script puts on an element (one it does not name: any element) that runs such keyframes.
  const named = (states?.classes ?? []).filter((c) => c.op !== 'remove' && animators.some((a) => a.split(/(?=[.#:[])/).includes(`.${c.name}`)));
  const stateAnimated = (el: Element) => named.some((c) => c.ref === null || gwdRefNames(el, c.ref));
  const claimed = new WeakMap<Element, Set<number>>();
  const results = await Promise.all(frames.map(async (f) => {
    const { doc, win } = frameParts(f);
    const boxes: Box[] = [];
    const safety: SafetyMismatch[] = [];
    let checked = 0;
    const ctx: Context = { css: live, blocks, fit: fittingOf(doc, win), claimed, specs: [], animators, stateAnimated };
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
        if (!hasDirectText(el) || el.closest('script, style, template, noscript')) continue;
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
        out.push([key, `${rects.join(' | ')} ${win.getComputedStyle(el).display} @${domPath(el)}`]);
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

/**
 * Compares two positions() snapshots, counting texts and line spacings apart. A key that is gone counts
 * as changed. Texts inside `hidden` elements (domPaths of elements a fix proved never show) are counted
 * apart too: they may move with those elements, which nobody sees.
 */
export function comparePositions(before: Map<string, string>, after: Map<string, string>, hidden: string[] = []) {
  const keys = [...before.keys()];
  const differs = (k: string) => after.get(k) !== before.get(k);
  const inHidden = (k: string) => {
    const path = /@([\d/]*)$/.exec(before.get(k) ?? '')?.[1];
    return path !== undefined && hidden.some((root) => path === root || path.startsWith(`${root}/`));
  };
  const texts = keys.filter((k) => !LINE_HEIGHT_KEY.test(k));
  const spacings = keys.filter((k) => LINE_HEIGHT_KEY.test(k));
  const unseen = texts.filter((k) => after.has(k) && differs(k) && inHidden(k));
  return {
    changed: keys.filter((k) => after.has(k) && differs(k) && !unseen.includes(k)),
    missing: keys.filter((k) => !after.has(k)),
    added: [...after.keys()].filter((k) => !before.has(k)),
    texts: texts.length - unseen.length,
    moved: texts.filter((k) => differs(k) && !unseen.includes(k)),
    unseen,
    spacings: spacings.length,
    respaced: spacings.filter(differs),
  };
}
