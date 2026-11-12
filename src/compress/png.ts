// PNG files: what a file holds (size, color type, animation, color profile), and writing one from
// pixels, as an indexed (palette) image or losslessly as RGB or RGBA, deflated at the highest level.

import { unzlibSync, zlibSync } from 'fflate';

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** An animated PNG (APNG), which re-encoding would flatten to its first frame. */
  animated: boolean;
  /** Its color profile: none, sRGB (what browsers assume anyway), or another, which a re-encode could shift. */
  profile: 'none' | 'srgb' | 'other';
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const latin1 = new TextDecoder('latin1');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Whether ICC profile bytes describe sRGB, by its name in the profile (ASCII, or UTF-16 in a v4 profile). */
export function iccIsSrgb(profile: Uint8Array): boolean {
  const ascii = latin1.decode(profile);
  return ascii.includes('sRGB') || ascii.includes('\0s\0R\0G\0B');
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Reads a PNG's header chunks; null for a file that is not a PNG. */
export function pngInfo(bytes: Uint8Array): PngInfo | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info: PngInfo = { width: 0, height: 0, bitDepth: 0, colorType: 0, animated: false, profile: 'none' };
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at);
    const type = latin1.decode(bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      info.width = view.getUint32(at + 8);
      info.height = view.getUint32(at + 12);
      info.bitDepth = data[8];
      info.colorType = data[9];
    } else if (type === 'acTL') {
      info.animated = true;
    } else if (type === 'sRGB') {
      info.profile = 'srgb';
    } else if (type === 'iCCP') {
      const nul = data.indexOf(0);
      try {
        info.profile = iccIsSrgb(unzlibSync(data.subarray(nul + 2))) || latin1.decode(data.subarray(0, nul)).includes('sRGB') ? 'srgb' : 'other';
      } catch {
        info.profile = 'other';
      }
    } else if (type === 'IDAT' || type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  return info.width ? info : null;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function ihdr(width: number, height: number, bitDepth: number, colorType: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  return chunk('IHDR', data);
}

function file(chunks: Uint8Array[]): Uint8Array {
  const all = [Uint8Array.from(SIGNATURE), ...chunks, chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * An indexed PNG: `indices` holds one palette index per pixel, row by row; `palette` RGBA entries
 * (at most 256). Fewer colors pack into fewer bits per pixel.
 */
export function encodeIndexedPng(width: number, height: number, indices: Uint8Array, palette: [number, number, number, number][]): Uint8Array {
  const n = palette.length;
  const bitDepth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
  const perByte = 8 / bitDepth;
  const rowBytes = Math.ceil(width / perByte);
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1);
    raw[row] = 0; // filter: none, which suits palette images
    for (let x = 0; x < width; x++) {
      const index = indices[y * width + x];
      const byte = row + 1 + Math.floor(x / perByte);
      raw[byte] |= index << (8 - bitDepth * (1 + (x % perByte)));
    }
  }
  const plte = new Uint8Array(n * 3);
  palette.forEach(([r, g, b], i) => plte.set([r, g, b], i * 3));
  let lastAlpha = -1;
  palette.forEach(([, , , a], i) => {
    if (a < 255) lastAlpha = i;
  });
  const chunks = [ihdr(width, height, bitDepth, 3), chunk('PLTE', plte)];
  if (lastAlpha >= 0) chunks.push(chunk('tRNS', Uint8Array.from(palette.slice(0, lastAlpha + 1).map((p) => p[3]))));
  chunks.push(chunk('IDAT', zlibSync(raw, { level: 9 })));
  return file(chunks);
}

/** Paeth's predictor, as PNG filter 4 uses it. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** A lossless RGB or RGBA PNG (RGB where every pixel is opaque), each row with the filter that leaves it smallest. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const bpp = opaque ? 3 : 4;
  const rowBytes = width * bpp;
  const raw = new Uint8Array((rowBytes + 1) * height);
  const line = new Uint8Array(rowBytes);
  const prior = new Uint8Array(rowBytes);
  const trial = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < bpp; c++) line[x * bpp + c] = rgba[(y * width + x) * 4 + c];
    }
    let best = 0;
    let bestScore = Infinity;
    const out = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prior[i];
        const c = i >= bpp ? prior[i - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (line[i] - pred) & 0xff;
        trial[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
        out.set(trial);
      }
    }
    raw[y * (rowBytes + 1)] = best;
    prior.set(line);
  }
  return file([ihdr(width, height, 8, opaque ? 2 : 6), chunk('IDAT', zlibSync(raw, { level: 9 }))]);
}
