// Served sizes. GWD writes an exact size as "300x250" and a range as "300x250:320x480", optionally
// ending ":l" or ":p" for landscape or portrait only: the same keys its responsive helper reads
// in data-gwd-media-override. A range is previewed at its smallest and largest sizes.

const KEY = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?::([lp]))?)?$/;

export type Orientation = 'landscape' | 'portrait';

export interface ServedSize {
  key: string;
  min: [number, number];
  max: [number, number];
  orientation: Orientation | null;
}

/** One preview frame: the served size it stands for, and the exact size it renders at. */
export interface FrameSize {
  size: string; // served size key
  label: string; // shown on the page; unique per frame
  width: number;
  height: number;
}

export function parseSize(key: string): ServedSize | null {
  const m = KEY.exec(key.trim());
  if (!m) return null;
  const min: [number, number] = [Number(m[1]), Number(m[2])];
  const max: [number, number] = m[3] ? [Number(m[3]), Number(m[4])] : min;
  if (max[0] < min[0] || max[1] < min[1]) return null;
  return { key: key.trim(), min, max, orientation: m[5] === 'l' ? 'landscape' : m[5] === 'p' ? 'portrait' : null };
}

export const isRange = (s: ServedSize) => s.min[0] !== s.max[0] || s.min[1] !== s.max[1] || s.orientation !== null;

/** "300x250", or "300x250 to 320x480" for a range, with its orientation when it has one. */
export function describeSize(key: string): string {
  const s = parseSize(key);
  if (!s || !isRange(s)) return key;
  return `${s.min.join('x')} to ${s.max.join('x')}${s.orientation ? `, ${s.orientation}` : ''}`;
}

// CSS orientation: portrait when height >= width, landscape otherwise.
const fits = (o: Orientation | null, w: number, h: number) => !o || (o === 'portrait' ? h >= w : w > h);

/** Whether the ad is served as `s` at this size: inside its bounds, in its orientation. */
export function covers(s: ServedSize, width: number, height: number): boolean {
  return width >= s.min[0] && width <= s.max[0] && height >= s.min[1] && height <= s.max[1] && fits(s.orientation, width, height);
}

/**
 * The sizes to preview a served size at: the size itself, or a range's smallest and largest
 * sizes that keep its orientation. Empty when the key is not a size, or no size fits the range.
 */
export function frameSizes(key: string): FrameSize[] {
  const s = parseSize(key);
  if (!s) return [];
  if (!isRange(s)) return [{ size: s.key, label: s.key, width: s.min[0], height: s.min[1] }];
  const [minW, minH] = s.min;
  const [maxW, maxH] = s.max;
  let small: [number, number] = [minW, minH];
  let large: [number, number] = [maxW, maxH];
  if (s.orientation === 'portrait') {
    small = [minW, Math.min(maxH, Math.max(minH, minW))];
    large = [Math.max(minW, Math.min(maxW, maxH)), maxH];
  } else if (s.orientation === 'landscape') {
    small = [Math.min(maxW, Math.max(minW, minH + 1)), minH];
    large = [maxW, Math.max(minH, Math.min(maxH, maxW - 1))];
  }
  const range = describeSize(key);
  return [small, large]
    .filter(([w, h], i, all) => fits(s.orientation, w, h) && (i === 0 || w !== all[0][0] || h !== all[0][1]))
    .map(([width, height]) => ({ size: s.key, label: `${width}x${height} (range ${range})`, width, height }));
}
