// How large each image of the ad ever shows, read from the preview frames: every <img> (GWD's own
// gwd-image draws one) and CSS background, in every size, on every page, at moments through the
// ad's timeline, so an image an animation scales up counts at its largest. Also which of the ad's
// files the frames loaded.

import { declared, frameParts, scaleOf, visitPages, type AdFrame } from '../audit/observe';

/** One way an image shows: the largest box it was drawn in (CSS px, transforms included) and how it fills it. */
export interface ImageUse {
  w: number;
  h: number;
  /** As object-fit or background-size has it; 'natural' where its own pixel size sets how large it shows. */
  fit: 'fill' | 'contain' | 'cover' | 'natural';
}

const BASE = import.meta.env.BASE_URL;

/** The package path a URL in a frame loads, or null for anything that is not one of the ad's files. */
function pathOf(url: string, base: string, id: string): string | null {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return null;
  }
  const root = `${BASE}__ad/${id}/`;
  if (u.origin !== location.origin || !u.pathname.startsWith(root)) return null;
  try {
    return u.pathname.slice(root.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

/** The end of the ad's timeline, for sampling it: animations that repeat forever count once. */
function timelineEnd(anims: Animation[]): number {
  let end = 0;
  for (const a of anims) {
    const t = a.effect?.getComputedTiming();
    if (!t) continue;
    const e = Number.isFinite(Number(t.endTime)) ? Number(t.endTime) : (Number(t.delay) || 0) + (Number(t.duration) || 0);
    if (Number.isFinite(e)) end = Math.max(end, e);
  }
  return Math.min(end, 60_000);
}

interface Item {
  el: Element;
  path: string;
  fit: ImageUse['fit'];
  /** For a background with a set size: that size, in the element's own CSS px. */
  size?: { w: number; h: number };
}

/** A background's size where it is set without auto: in px, from px or % of the element's box. */
function backgroundSize(value: string, el: HTMLElement): { w: number; h: number } | null {
  const parts = value.split(',')[0].trim().split(/\s+/);
  if (parts.length !== 2 || parts.some((p) => p === 'auto')) return null;
  const read = (p: string, of: number) => (p.endsWith('%') ? (parseFloat(p) / 100) * of : p.endsWith('px') ? parseFloat(p) : NaN);
  const w = read(parts[0], el.clientWidth);
  const h = read(parts[1], el.clientHeight);
  return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
}

function itemsIn(scope: Element, win: Window, base: string, id: string): Item[] {
  const items: Item[] = [];
  for (const el of [scope, ...scope.querySelectorAll('*')]) {
    const cs = win.getComputedStyle(el);
    // GWD draws an image it scales proportionally as its <img>'s background.
    const background = cs.backgroundImage.includes('url(');
    if (background) {
      const size = cs.backgroundSize.trim();
      for (const m of cs.backgroundImage.matchAll(/url\("?([^")]*)"?\)/g)) {
        const path = pathOf(m[1], base, id);
        if (!path) continue;
        if (size === 'cover' || size === 'contain') items.push({ el, path, fit: size });
        else {
          const set = backgroundSize(size, el as HTMLElement);
          items.push(set ? { el, path, fit: 'fill', size: set } : { el, path, fit: 'natural' });
        }
      }
    }
    if (el.tagName !== 'IMG') continue;
    const img = el as HTMLImageElement;
    const src = img.currentSrc || img.getAttribute('src') || '';
    // Its box follows its own pixel size unless its CSS or attributes set both width and height.
    const set = declared(win, el, ['width', 'height']);
    const sized = (['width', 'height'] as const).every((p) => img.hasAttribute(p) || (set[p] !== '' && set[p] !== 'auto'));
    const fit: ImageUse['fit'] = !sized || cs.objectFit === 'none' || cs.objectFit === 'scale-down' ? 'natural' : (cs.objectFit as ImageUse['fit']);
    if (src && !src.startsWith('data:')) {
      const path = pathOf(src, base, id);
      if (path) items.push({ el, path, fit });
    } else if (!background) {
      // A GWD image that has not loaded its source yet: how it will fit is known only for a plain one.
      const gwd = el.closest('gwd-image');
      const path = gwd?.getAttribute('source') ? pathOf(gwd.getAttribute('source')!, base, id) : null;
      if (path) items.push({ el, path, fit: gwd!.classList.contains('scaled-proportionally') ? 'natural' : fit });
    }
  }
  return items;
}

/** The largest each image of the ad shows, by package path, one entry per way it fills its box. */
export async function measureImages(frames: AdFrame[], id: string): Promise<Map<string, ImageUse[]>> {
  const out = new Map<string, ImageUse[]>();
  const note = (path: string, fit: ImageUse['fit'], w: number, h: number) => {
    const uses = out.get(path) ?? [];
    const use = uses.find((u) => u.fit === fit);
    if (use) {
      use.w = Math.max(use.w, w);
      use.h = Math.max(use.h, h);
    } else uses.push({ fit, w, h });
    out.set(path, uses);
  };
  for (const f of frames) {
    const { doc, win } = frameParts(f);
    await visitPages(f, (scope) => {
      const items = itemsIn(scope, win, doc.baseURI, id);
      if (!items.length) return;
      const anims = doc.getAnimations();
      const saved = anims.map((a) => ({ a, t: a.currentTime, running: a.playState === 'running' }));
      anims.forEach((a) => a.pause());
      const end = timelineEnd(anims);
      const step = Math.max(50, end / 120);
      try {
        for (let t = 0; ; t += step) {
          const at = Math.min(t, end);
          anims.forEach((a) => {
            a.currentTime = at;
          });
          for (const item of items) {
            if (item.fit === 'natural') {
              note(item.path, 'natural', 0, 0);
              continue;
            }
            const r = item.el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (item.size) {
              const scale = scaleOf(win, item.el);
              note(item.path, 'fill', item.size.w * scale, item.size.h * scale);
            } else note(item.path, item.fit, r.width, r.height);
          }
          if (at >= end) break;
        }
      } finally {
        for (const { a, t, running } of saved) {
          a.currentTime = t;
          if (running) a.play();
        }
      }
    });
  }
  return out;
}

/** The ad's files every frame loaded, by package path: what it fetched as it ran, the HTML included. */
export function loadedPaths(frames: AdFrame[], id: string): Set<string> {
  const out = new Set<string>();
  for (const f of frames) {
    const { doc, win } = frameParts(f);
    const add = (url: string) => {
      const path = pathOf(url, doc.baseURI, id);
      if (path) out.add(path);
    };
    add(doc.URL);
    for (const entry of win.performance.getEntriesByType('resource')) add(entry.name);
  }
  return out;
}
