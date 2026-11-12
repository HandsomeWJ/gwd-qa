// Pixel work for compression that needs no browser: reducing an image to a palette, and how far two
// versions of an image are apart.

import { applyPaletteSync, buildPaletteSync, utils } from 'image-q';

export interface Indexed {
  indices: Uint8Array;
  palette: [number, number, number, number][];
  /** Whether colors were merged to fit 256: false where the image had 256 colors or fewer already. */
  lossy: boolean;
}

const key = (r: number, g: number, b: number, a: number) => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;

/** The image's own colors when it has at most `colors` of them, else null. */
function exactPalette(rgba: Uint8Array | Uint8ClampedArray, colors: number): Indexed | null {
  const index = new Map<number, number>();
  const palette: Indexed['palette'] = [];
  const indices = new Uint8Array(rgba.length / 4);
  for (let p = 0; p < indices.length; p++) {
    const i = p * 4;
    // Fully transparent pixels all look alike: one entry serves them.
    const k = rgba[i + 3] === 0 ? 0 : key(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
    let at = index.get(k);
    if (at === undefined) {
      if (palette.length === colors) return null;
      at = palette.length;
      index.set(k, at);
      palette.push(rgba[i + 3] === 0 ? [0, 0, 0, 0] : [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]);
    }
    indices[p] = at;
  }
  return { indices, palette, lossy: false };
}

/**
 * The image as palette indices: exactly where it has at most `colors` colors, else reduced to that
 * many with error diffusion (Floyd and Steinberg), which keeps gradients from banding.
 */
export function toPalette(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, colors = 256): Indexed {
  const exact = exactPalette(rgba, colors);
  if (exact) return exact;
  const points = utils.PointContainer.fromUint8Array(rgba, width, height);
  const palette = buildPaletteSync([points], { colorDistanceFormula: 'euclidean-bt709', paletteQuantization: 'wuquant', colors });
  const out = applyPaletteSync(points, palette, { colorDistanceFormula: 'euclidean-bt709', imageQuantization: 'floyd-steinberg' }).toUint8Array();
  const reduced = exactPalette(out, colors);
  if (!reduced) throw new Error('The reduced image has more colors than its palette.');
  return { ...reduced, lossy: true };
}

export interface Difference {
  /** Mean difference per channel, in levels of 255, each pixel weighted by how opaque it is. */
  mean: number;
  /** The difference 99% of pixels stay within, in levels of 255 (the largest channel's). */
  p99: number;
}

/** How far a re-encoded image is from the one it came from, pixel by pixel; both the same size. */
export function difference(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): Difference {
  const histogram = new Uint32Array(256);
  let sum = 0;
  let weight = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const wa = a[i + 3] / 255;
    const wb = b[i + 3] / 255;
    let most = Math.abs(a[i + 3] - b[i + 3]);
    let d = most;
    for (let c = 0; c < 3; c++) {
      // Colors compared as they show: premultiplied by their opacity.
      const x = Math.abs(a[i + c] * wa - b[i + c] * wb);
      d += x;
      if (x > most) most = x;
    }
    const w = Math.max(wa, wb, 1 / 255);
    sum += (d / 4) * w;
    weight += w;
    histogram[Math.min(255, Math.round(most))]++;
  }
  let seen = 0;
  let p99 = 0;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v];
    if (seen >= pixels * 0.99) {
      p99 = v;
      break;
    }
  }
  return { mean: weight ? sum / weight : 0, p99 };
}
