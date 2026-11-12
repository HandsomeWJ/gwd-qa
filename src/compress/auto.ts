// The package weight fix done for the user: the least change that brings the zip for upload under
// 4 MB. Every image first gets what nobody can see (resized to twice its largest size on screen,
// JPEGs saved again at quality 92, PNGs without loss) and files no ad can load leave the upload zip.
// Then, only while the zip is still over, stronger steps, one level at a time, the images that save
// most first, and at each level only as many as it takes. Each step re-encodes the original image,
// never an earlier step's output.

import { jpegInfo } from './jpeg';
import { IMAGE, MIN_BYTES, needed, unusedFiles, type Run, type SavingsInput } from './plan';
import { pngInfo } from './png';

/** Under the 4,000,000-byte limit, with room for the zip's own headers. */
export const TARGET = 3_990_000;

interface Level {
  dpr: number; // screen pixels per CSS pixel the image stays sharp on
  quality: number; // JPEG
  colors: number; // PNG palette size, 0 for every color
}

// Level 0 is what nobody sees; each later one gives up a little more.
const LEVELS: Record<'image/jpeg' | 'image/png', Level[]> = {
  'image/jpeg': [
    { dpr: 2, quality: 0.92, colors: 0 },
    { dpr: 2, quality: 0.85, colors: 0 },
    { dpr: 2, quality: 0.75, colors: 0 },
    { dpr: 1.5, quality: 0.7, colors: 0 },
    { dpr: 1, quality: 0.6, colors: 0 },
  ],
  'image/png': [
    { dpr: 2, quality: 0, colors: 0 },
    { dpr: 2, quality: 0, colors: 256 },
    { dpr: 1.5, quality: 0, colors: 256 },
    { dpr: 1, quality: 0, colors: 256 },
    { dpr: 1, quality: 0, colors: 128 },
  ],
};

// Files a browser cannot use in an ad: GWD's own working files and design sources.
const NEVER_LOADED = /(^|\/)(gwd_workspace\.json|[^/]*_groups_archive[^/]*)$|\.(psd|psb|ai|sketch|fig|xd|indd|zip|rar|7z)$/i;

export interface AutoPick {
  path: string;
  type: 'image/jpeg' | 'image/png';
  before: { bytes: number; width: number; height: number };
  after: { bytes: number; width: number; height: number; data: Uint8Array };
  level: number;
  /** What was done to it, such as "resized to 496 × 530, 256 colors". */
  how: string;
  mean: number;
  p99: number;
}

/** Where Fix package weight is: the step (0 is what nobody can see), the image it is on, and the zip for upload as the steps so far leave it. */
export interface AutoProgress {
  step: number;
  steps: number;
  done: number;
  total: number;
  path: string;
  size: number;
}

export interface AutoResult {
  picks: AutoPick[];
  /** Files left out of the zip for upload: ones no ad can load. */
  omit: { path: string; bytes: number }[];
  before: number;
  /** The zip for upload with all of it: exact, as images are stored in it as they are. */
  after: number;
  reached: boolean;
}

interface Image {
  path: string;
  type: 'image/jpeg' | 'image/png';
  data: Uint8Array;
  width: number;
  height: number;
  /** Share of its pixels its largest use on screen needs at 1 screen pixel per CSS pixel; null to keep its size. */
  share: number | null;
  /** A color profile other than sRGB: converting it is a step, never level 0. */
  profiled: boolean;
  current: (AutoPick & { key: string }) | null;
}

export async function autoShrink(input: SavingsInput, uploadBytes: number, run: Run, progress?: (p: AutoProgress) => void): Promise<AutoResult> {
  const scripted = new Set(input.refs.filter((r) => r.script).map((r) => r.actual ?? r.path));
  const images: Image[] = [];
  for (const path of input.upload) {
    const data = input.files.get(path);
    if (!data || !IMAGE.test(path) || data.length < MIN_BYTES) continue;
    const jpeg = jpegInfo(data);
    const png = jpeg ? null : pngInfo(data);
    const info = jpeg ?? png;
    if (!info || png?.animated || (jpeg && jpeg.components === 4)) continue;
    const need = scripted.has(path) ? null : needed(input.uses.get(path) ?? [], info.width, info.height, 1);
    images.push({ path, type: jpeg ? 'image/jpeg' : 'image/png', data, width: info.width, height: info.height, share: need?.share ?? null, profiled: info.profile === 'other', current: null });
  }
  const omit = unusedFiles(input).filter((f) => NEVER_LOADED.test(f.path));
  let total = uploadBytes - omit.reduce((n, f) => n + f.bytes, 0);

  const steps = LEVELS['image/jpeg'].length;
  for (let level = 0; level < steps && (level === 0 || total > TARGET); level++) {
    const cands: { img: Image; pick: Image['current'] & {}; gain: number }[] = [];
    const todo = images.filter((img) => !(level === 0 && img.profiled));
    for (const [i, img] of todo.entries()) {
      progress?.({ step: level, steps, done: i, total: todo.length, path: img.path, size: total });
      const lv = LEVELS[img.type][level];
      const share = img.share === null ? 1 : Math.min(1, img.share * lv.dpr);
      const resize = share < 0.9 ? { width: Math.max(1, Math.round(img.width * share)), height: Math.max(1, Math.round(img.height * share)) } : null;
      const key = `${resize?.width}x${resize?.height}|${img.type === 'image/jpeg' ? lv.quality : lv.colors}`;
      if (img.current?.key === key) continue;
      const buffer = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength) as ArrayBuffer;
      let out;
      try {
        out = await run({ data: buffer, type: img.type, resize, quality: lv.quality, colors: lv.colors });
      } catch {
        continue; // one the browser cannot re-encode stays as it is
      }
      const bytes = out.data.byteLength;
      const now = img.current?.after.bytes ?? img.data.length;
      if (bytes >= now * 0.97) continue;
      const how = [resize ? `resized to ${out.width} × ${out.height}` : '', img.type === 'image/jpeg' ? `quality ${Math.round(lv.quality * 100)}` : lv.colors ? `${lv.colors} colors` : 'stored without loss'].filter(Boolean).join(', ');
      const pick = { path: img.path, type: img.type, before: { bytes: img.data.length, width: img.width, height: img.height }, after: { bytes, width: out.width, height: out.height, data: new Uint8Array(out.data) }, level, how, mean: out.mean, p99: out.p99, key };
      if (level === 0) {
        // Nobody sees these: all of them, whatever the zip weighs, so the zip shrinks image by image.
        img.current = pick;
        total -= now - bytes;
      } else {
        cands.push({ img, gain: now - bytes, pick });
      }
    }
    if (level === 0) {
      progress?.({ step: level, steps, done: todo.length, total: todo.length, path: '', size: total });
      continue;
    }
    // The images that save most first, until the zip is under; then back out any it did not need.
    cands.sort((a, b) => b.gain - a.gain);
    const taken: typeof cands = [];
    let over = total - TARGET;
    for (const c of cands) {
      if (over <= 0) break;
      taken.push(c);
      over -= c.gain;
    }
    for (const c of [...taken].sort((a, b) => a.gain - b.gain)) {
      if (over + c.gain <= 0) {
        taken.splice(taken.indexOf(c), 1);
        over += c.gain;
      }
    }
    for (const c of taken) {
      c.img.current = c.pick;
      total -= c.gain;
    }
    progress?.({ step: level, steps, done: todo.length, total: todo.length, path: '', size: total });
  }
  const picks = images.flatMap((img) => {
    if (!img.current) return [];
    const { key: _, ...pick } = img.current;
    return [pick];
  });
  return { picks, omit, before: uploadBytes, after: total, reached: total <= TARGET };
}
