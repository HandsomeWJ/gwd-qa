// The package weight fix: smaller images and files the ad never loads, offered for the user to pick.
// An image shown smaller than it is gets resized to `dpr` times the largest it shows, so it stays
// sharp on screens with that many pixels per CSS pixel; JPEGs are re-encoded at a quality, PNGs
// with a palette (or losslessly). Nothing is resized that a script names or whose own pixel size sets
// how large it shows, and nothing at all where a color profile or animation could be lost.

import type { FileRef } from '../audit/package';
import { GWD_RUNTIME } from '../zip';
import { jpegInfo } from './jpeg';
import type { ImageUse } from './measure';
import { pngInfo } from './png';
import type { ShrinkDone, ShrinkJob } from './worker';

export interface SavingsOptions {
  /** Screen pixels per CSS pixel to keep images sharp on: 2 for most laptops and phones, 3 for the densest phones. */
  dpr: number;
  /** JPEG quality, 0 to 1. */
  quality: number;
  /** PNG palette size, or 0 to keep every color. */
  colors: number;
}

export const DEFAULT_OPTIONS: SavingsOptions = { dpr: 2, quality: 0.85, colors: 256 };

export interface Shrink {
  path: string;
  type: 'image/jpeg' | 'image/png';
  before: { bytes: number; width: number; height: number };
  after: { bytes: number; width: number; height: number; data: Uint8Array };
  /** Why it has the size it has now, such as "shows at most 127 × 136". */
  why: string;
  mean: number;
  p99: number;
  lossy: boolean;
  /** Offered ticked: pixels the same, or apart by so little nobody sees it at its size on screen. */
  recommended: boolean;
  /** The largest it shows, in CSS px, where that is known. */
  shows?: { w: number; h: number };
}

export interface Savings {
  shrinks: Shrink[];
  unused: { path: string; bytes: number }[];
  skipped: { path: string; why: string }[];
}

export interface SavingsInput {
  /** The ad's files as they are now, and the ones the zip for upload holds. */
  files: Map<string, Uint8Array>;
  upload: string[];
  htmlPath: string;
  refs: FileRef[];
  uses: Map<string, ImageUse[]>;
  loaded: Set<string>;
}

export type Run = (job: Omit<ShrinkJob, 'id'>) => Promise<ShrinkDone>;

export const IMAGE = /\.(jpe?g|png)$/i;
export const MIN_BYTES = 8_000; // smaller images are not worth the risk
// Below these, a re-encode is offered ticked: the mean is levels of 255, the 99th percentile the
// largest channel difference all but 1% of pixels stay within. A 256-color PNG of a photo-like
// mascot at 2.2 and 14 looked the same as its original at its size on screen (2026-11-13).
export const QUIET_MEAN = 3;
export const QUIET_P99 = 28;

const px = (n: number) => Math.ceil(n - 0.01);

/**
 * How much of its own resolution an image needs, as a share of its pixels (1 or more: all of it),
 * from the largest it shows; null where its own pixel size sets how large it shows.
 */
export function needed(uses: ImageUse[], width: number, height: number, dpr: number): { share: number; w: number; h: number } | null {
  if (!uses.length || uses.some((u) => u.fit === 'natural')) return null;
  let share = 0;
  let w = 0;
  let h = 0;
  for (const u of uses) {
    const sx = u.w / width;
    const sy = u.h / height;
    share = Math.max(share, u.fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy));
    w = Math.max(w, u.w);
    h = Math.max(h, u.h);
  }
  return { share: share * dpr, w, h };
}

/** The ad's files that nothing loads: neither its HTML, stylesheets or scripts, nor the previews as they ran. */
export function unusedFiles(input: Pick<SavingsInput, 'files' | 'upload' | 'htmlPath' | 'refs' | 'loaded'>): { path: string; bytes: number }[] {
  const used = new Set([input.htmlPath, ...input.loaded]);
  for (const r of input.refs) {
    used.add(r.path);
    if (r.actual) used.add(r.actual);
  }
  // GWD's runtime loads parts of itself, which may not have run in the previews.
  return input.upload
    .filter((path) => !used.has(path) && !GWD_RUNTIME.test(path.split('/').pop()!) && !/\.(js|css|html?)$/i.test(path))
    .map((path) => ({ path, bytes: input.files.get(path)?.length ?? 0 }))
    .filter((f) => f.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
}

// Files a browser cannot use in an ad: GWD's own working files and design sources.
export const NEVER_LOADED = /(^|\/)(gwd_workspace\.json|[^/]*_groups_archive[^/]*)$|\.(psd|psb|ai|sketch|fig|xd|indd|zip|rar|7z)$/i;
const MEDIA = /\.(png|jpe?g|gif|webp|avif|svg|bmp|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|woff2?|ttf|otf)$/i;
const TEXT = /\.(html?|m?js|css|json|xml|svg|txt)$/i;
// What a script that puts a file name together must write: the extension, apart from any whole name.
const EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg|bmp|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|woff2?|ttf|otf)(?![\w-])/i;

/**
 * Files the ad cannot load, so leaving them out of the zip for upload changes nothing: GWD's working
 * files and design sources; and media files no preview loaded or measured and nothing names, whose
 * name, with or without its extension, is written in none of the ad's text files, as long as none of
 * the ad's own scripts could put a file name together (an extension in its code apart from whole names).
 */
export function unloadableFiles(input: Pick<SavingsInput, 'files' | 'upload' | 'htmlPath' | 'refs' | 'loaded' | 'uses'>): { path: string; bytes: number; why: string }[] {
  const unused = unusedFiles(input).filter((f) => !input.uses.has(f.path));
  const never = unused.filter((f) => NEVER_LOADED.test(f.path)).map((f) => ({ ...f, why: "GWD's working file, which no ad loads" }));
  const media = unused.filter((f) => !NEVER_LOADED.test(f.path) && MEDIA.test(f.path));
  if (!media.length) return never;
  const decoder = new TextDecoder();
  const texts = input.upload.filter((p) => TEXT.test(p) && !NEVER_LOADED.test(p) && input.files.has(p)).map((p) => [p, decoder.decode(input.files.get(p)!).toLowerCase()] as const);
  const forms = (name: string) => [...new Set([name, name.replace(/ /g, '%20'), encodeURIComponent(name).toLowerCase()])];
  const names = [...new Set([...input.files.keys()].flatMap((p) => forms(p.split('/').pop()!.toLowerCase())))].sort((a, b) => b.length - a.length);
  const scripts = texts.flatMap(([p, t]) => {
    if (/\.m?js$/i.test(p)) return GWD_RUNTIME.test(p.split('/').pop()!) ? [] : [t];
    return /\.html?$/i.test(p) ? [...t.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]) : [];
  });
  if (scripts.some((code) => EXTENSION.test(names.reduce((rest, n) => rest.split(n).join(' '), code)))) return never;
  const written = (path: string) => {
    const name = path.split('/').pop()!.toLowerCase();
    const stem = name.replace(/\.[^.]+$/, '');
    return texts.some(([, t]) => [...forms(name), ...forms(stem)].some((f) => f.length > 0 && t.includes(f)));
  };
  const spare = media.filter((f) => !written(f.path)).map((f) => ({ ...f, why: 'nothing in the ad names or loads it' }));
  return [...never, ...spare].sort((a, b) => b.bytes - a.bytes);
}

export async function findSavings(input: SavingsInput, options: SavingsOptions, run: Run, progress?: (done: number, total: number) => void): Promise<Savings> {
  const shrinks: Shrink[] = [];
  const skipped: Savings['skipped'] = [];
  const images = input.upload.filter((path) => IMAGE.test(path) && (input.files.get(path)?.length ?? 0) >= MIN_BYTES);
  const scripted = new Set(input.refs.filter((r) => r.script).map((r) => r.actual ?? r.path));
  let done = 0;
  for (const path of images) {
    progress?.(done++, images.length);
    const data = input.files.get(path)!;
    const jpeg = jpegInfo(data);
    const png = jpeg ? null : pngInfo(data);
    const info = jpeg ?? png;
    if (!info) {
      skipped.push({ path, why: 'its contents are not the JPEG or PNG its name says' });
      continue;
    }
    if (png?.animated) {
      skipped.push({ path, why: 'it is an animated PNG' });
      continue;
    }
    // A profile other than sRGB is converted to sRGB, which can shift its colors a little: offered, never ticked.
    const converted = info.profile === 'other';
    if (jpeg && jpeg.components === 4) {
      skipped.push({ path, why: 'it is a CMYK JPEG' });
      continue;
    }
    const need = scripted.has(path) ? null : needed(input.uses.get(path) ?? [], info.width, info.height, options.dpr);
    const share = need ? Math.min(1, need.share) : 1;
    const resize = share < 0.9 ? { width: Math.max(1, Math.round(info.width * share)), height: Math.max(1, Math.round(info.height * share)) } : null;
    const type = jpeg ? 'image/jpeg' : 'image/png';
    let out: ShrinkDone;
    try {
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      out = await run({ data: buffer, type, resize, quality: options.quality, colors: options.colors });
    } catch (err) {
      skipped.push({ path, why: `the browser could not re-encode it (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    const after = new Uint8Array(out.data);
    if (after.length >= data.length * 0.95) {
      skipped.push({ path, why: 'it is already about as small as this makes it' });
      continue;
    }
    const profile = converted ? '; its color profile becomes sRGB, which can shift its colors a little' : '';
    const why = scripted.has(path)
      ? 'kept at its size: a script names it'
      : !need
        ? (input.uses.get(path)?.length ? 'kept at its size: its own pixel size sets how large it shows' : 'kept at its size: no preview showed it')
        : resize
          ? `shows at most ${px(need.w)} × ${px(need.h)}, so ${options.dpr}× that is enough`
          : 'kept at its size: it shows at about its size or larger';
    const whyAll = why + profile;
    shrinks.push({
      path,
      type,
      before: { bytes: data.length, width: info.width, height: info.height },
      after: { bytes: after.length, width: out.width, height: out.height, data: after },
      why: whyAll,
      mean: out.mean,
      p99: out.p99,
      lossy: out.lossy,
      recommended: !converted && (!out.lossy || (out.mean <= QUIET_MEAN && out.p99 <= QUIET_P99)),
      ...(need ? { shows: { w: need.w, h: need.h } } : {}),
    });
  }
  progress?.(images.length, images.length);
  return { shrinks: shrinks.sort((a, b) => b.before.bytes - b.after.bytes - (a.before.bytes - a.after.bytes)), unused: unusedFiles(input), skipped };
}

/** Runs compression jobs in a worker, one at a time. */
export function shrinker(): { run: Run; close: () => void } {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let next = 0;
  const waiting = new Map<number, { resolve: (d: ShrinkDone) => void; reject: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<ShrinkDone | { id: number; error: string }>) => {
    const w = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if ('error' in e.data) w?.reject(new Error(e.data.error));
    else w?.resolve(e.data);
  };
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || 'The compression worker failed.'));
    waiting.clear();
  };
  const run: Run = (job) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...job, id }, [job.data]);
  });
  return { run, close: () => worker.terminate() };
}
