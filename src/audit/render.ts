// Checks that need the ad rendered: each served size runs in its own same-origin frame.

import { hasDirectText, label } from './static';
import type { Finding } from './types';

export interface AdFrame {
  size: string;
  el: HTMLIFrameElement;
  started?: boolean; // false when the ad never showed its first page
}

const KEYFRAME_META = ['offset', 'computedOffset', 'easing', 'composite'];
const MOVING = ['transform', 'translate', 'left', 'top', 'right', 'bottom', 'marginLeft', 'marginTop'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function frameParts(f: AdFrame): { doc: Document; win: Window } {
  const doc = f.el.contentDocument;
  const win = f.el.contentWindow;
  if (!doc || !win) throw new Error(`The ${f.size} frame is not loaded.`);
  return { doc, win };
}

/**
 * Waits for GWD to show its first page (any non-GWD page counts as started once loaded),
 * then lets it settle. Returns false when a GWD ad never starts.
 */
export async function waitForAd(el: HTMLIFrameElement, timeoutMs = 10_000): Promise<boolean> {
  // GWD starts its ad from requestAnimationFrame, which browsers do not run in a hidden tab,
  // so the timeout only counts time while the tab is visible.
  let waited = 0;
  const giveUp = performance.now() + 15 * 60_000;
  while (waited < timeoutMs && performance.now() < giveUp) {
    const doc = el.contentDocument;
    if (doc?.readyState === 'complete' && (doc.querySelector('.gwd-play-animation') || !doc.querySelector('gwd-pagedeck, gwd-page'))) {
      await sleep(700); // per-size text overrides land just after the page shows
      return true;
    }
    await sleep(100);
    if (document.visibilityState === 'visible') waited += 100;
  }
  return false;
}

/** Value of prop from inline style or the last matching rule in an active @media block. */
export function declared(win: Window, el: Element, prop: string): string {
  const inline = (el as HTMLElement).style?.getPropertyValue(prop);
  if (inline) return inline;
  let value = '';
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
        const v = hit && (rule as CSSStyleRule).style.getPropertyValue(prop);
        if (v) value = v;
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
  return value;
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

export function renderAudit(frames: AdFrame[]): Finding[] {
  const out: Finding[] = [];
  for (const f of frames) {
    const { doc, win } = frameParts(f);
    for (const el of doc.body.querySelectorAll('*')) {
      if (!hasDirectText(el) || !el.getClientRects().length) continue;
      const fontSize = parseFloat(win.getComputedStyle(el).fontSize);
      const scale = scaleOf(win, el);
      const px = Math.round(fontSize * scale * 100) / 100;
      if (px >= 8) continue;
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (onScreen(win, el) || moves(el)) {
        const hint = scale < 0.999
          ? `It is ${+fontSize.toFixed(2)}px scaled by ${scale.toFixed(2)}. Scale its group to at least ${(Math.ceil((8 / fontSize) * 100) / 100).toFixed(2)}, raise its font-size to ${Math.ceil(8 / scale)}px in this size, or hide it in this size.`
          : `Raise its font-size to at least 8px in this size, or hide it in this size.`;
        const hidden = hiddenNow(win, el) ? ' It is hidden right now, so this only matters if something shows it.' : '';
        out.push({ check: 'type', level: 'fail', size: f.size, target: label(el), message: `"${text}" renders at ${px.toFixed(2)}px.${hidden}`, hint });
      } else {
        out.push({ check: 'type', level: 'note', size: f.size, target: label(el), message: `"${text}" is ${px.toFixed(2)}px but sits off-canvas and never moves, so it is never visible.` });
      }
    }
    for (const el of doc.querySelectorAll('p, span, button')) {
      const cs = win.getComputedStyle(el);
      if (!declared(win, el, 'line-height')) {
        out.push({ check: 'lineHeight', level: 'fail', size: f.size, target: label(el), message: `No line-height (renders ${cs.lineHeight}).` });
      }
      if (el.tagName === 'BUTTON') {
        if ([cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].some((v) => v !== '0px')) {
          out.push({ check: 'buttonPadding', level: 'fail', size: f.size, target: label(el), message: `Padding is ${cs.padding}.` });
        }
        if (!declared(win, el, 'color')) {
          out.push({ check: 'buttonColor', level: 'fail', size: f.size, target: label(el), message: `No explicit color (renders ${cs.color}).` });
        }
      } else if (declared(win, el, 'margin-block-start') !== '0px' || declared(win, el, 'margin-block-end') !== 'auto') {
        out.push({ check: 'marginBlock', level: 'fail', size: f.size, target: label(el), message: 'Missing margin-block: 0px auto.' });
      }
    }
  }
  return out;
}

export interface SafetyMismatch {
  size: string;
  target: string;
  animation: string;
  prop: string;
  keyframes: string;
  normal: string;
}

/** An unchanged keyframes value is only safe to delete when it equals the element's normal style. */
export function keyframeSafety(frames: AdFrame[]): { checked: number; mismatches: SafetyMismatch[] } {
  const mismatches: SafetyMismatch[] = [];
  let checked = 0;
  for (const f of frames) {
    const { doc, win } = frameParts(f);
    for (const el of doc.querySelectorAll('*')) {
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
            mismatches.push({ size: f.size, target: label(el), animation: (anim as CSSAnimation).animationName, prop: p, keyframes: animated[i], normal });
          }
        });
        (el as HTMLElement).style.animation = saved;
      }
    }
  }
  return { checked, mismatches };
}

/** Client rects of every text node, with animations paused at 1s so two runs compare. */
export function positions(frames: AdFrame[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of frames) {
    const { doc, win } = frameParts(f);
    doc.getAnimations().forEach((a) => {
      a.pause();
      a.currentTime = 1000;
    });
    const seen = new Map<string, number>();
    for (const el of doc.body.querySelectorAll('*')) {
      if (!hasDirectText(el)) continue;
      let key = `${f.size} ${label(el)} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
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
      out.set(key, `${rects.join(' | ')} ${win.getComputedStyle(el).display}`);
    }
  }
  return out;
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
