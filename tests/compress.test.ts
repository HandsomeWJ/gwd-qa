import { describe, expect, it } from 'vitest';
import { unzlibSync } from 'fflate';
import { jpegInfo } from '../src/compress/jpeg';
import type { ImageUse } from '../src/compress/measure';
import { encodeIndexedPng, encodeRgbaPng, pngInfo } from '../src/compress/png';
import { difference, toPalette } from '../src/compress/pixels';
import { findSavings, needed, unusedFiles, type Run } from '../src/compress/plan';
import type { FileRef } from '../src/audit/package';

/** The pixels of a PNG this module wrote: unfiltered rows, as its encoders write them. */
function idat(png: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'IDAT') return unzlibSync(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  throw new Error('no IDAT');
}

describe('PNG files', () => {
  it('writes a palette PNG that packs few colors into few bits, with transparency where it has any', () => {
    const png = encodeIndexedPng(3, 2, Uint8Array.from([0, 1, 1, 1, 0, 0]), [[255, 0, 0, 255], [0, 0, 255, 128]]);
    expect(pngInfo(png)).toEqual({ width: 3, height: 2, bitDepth: 1, colorType: 3, animated: false, profile: 'none' });
    // each row: filter byte 0, then 3 one-bit indices packed into a byte from its top bit
    expect([...idat(png)]).toEqual([0, 0b01100000, 0, 0b10000000]);
    expect(new TextDecoder('latin1').decode(png)).toContain('tRNS');
  });

  it('writes every pixel back losslessly, as RGB where all are opaque', () => {
    const rgba = Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const png = encodeRgbaPng(2, 2, rgba);
    expect(pngInfo(png)).toMatchObject({ width: 2, height: 2, bitDepth: 8, colorType: 2 });
    // Undo each row's filter as a decoder does, and the pixels come back.
    const raw = idat(png);
    const rows: number[][] = [];
    for (let y = 0; y < 2; y++) {
      const f = raw[y * 7];
      const line = [...raw.subarray(y * 7 + 1, y * 7 + 7)];
      const prior = rows[y - 1] ?? [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 6; i++) {
        const a = i >= 3 ? line[i - 3] : 0;
        const b = prior[i];
        const c = i >= 3 ? prior[i - 3] : 0;
        const p = a + b - c;
        const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        line[i] = (line[i] + [0, a, b, (a + b) >> 1, paeth][f]) & 0xff;
      }
      rows.push(line);
    }
    expect(rows.flat()).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
  });

  it('tells an animated PNG and a color profile apart from a plain one', () => {
    const png = encodeIndexedPng(1, 1, Uint8Array.from([0]), [[0, 0, 0, 255]]);
    const chunk = (type: string) => {
      const out = new Uint8Array(12);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      return out;
    };
    const withChunk = (type: string) => Uint8Array.from([...png.subarray(0, 33), ...chunk(type), ...png.subarray(33)]);
    expect(pngInfo(withChunk('acTL'))?.animated).toBe(true);
    expect(pngInfo(withChunk('sRGB'))?.profile).toBe('srgb');
    expect(pngInfo(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});

describe('JPEG files', () => {
  it('reads the size and channels from the frame header, and an ICC profile by its name', () => {
    const sof = [0xff, 0xc0, 0, 17, 8, 0, 50, 0, 80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    const icc = [...'ICC_PROFILE'].map((c) => c.charCodeAt(0));
    const app2 = (name: string) => {
      const body = [...icc, 0, 1, 1, ...[...`    ${name} profile`].map((c) => c.charCodeAt(0))];
      return [0xff, 0xe2, 0, body.length + 2, ...body];
    };
    const jpeg = (extra: number[]) => Uint8Array.from([0xff, 0xd8, ...extra, ...sof, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
    expect(jpegInfo(jpeg([]))).toEqual({ width: 80, height: 50, components: 3, profile: 'none' });
    expect(jpegInfo(jpeg(app2('sRGB IEC61966-2.1')))?.profile).toBe('srgb');
    expect(jpegInfo(jpeg(app2('Display P3')))?.profile).toBe('other');
  });
});

describe('palettes and differences', () => {
  it('keeps an image with few colors exactly, and reduces one with many', () => {
    const few = Uint8Array.from([1, 2, 3, 255, 1, 2, 3, 255, 9, 9, 9, 255, 0, 0, 0, 0]);
    expect(toPalette(few, 2, 2)).toEqual({ indices: Uint8Array.from([0, 0, 1, 2]), palette: [[1, 2, 3, 255], [9, 9, 9, 255], [0, 0, 0, 0]], lossy: false });
    const many = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) many.set([i % 256, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
    const reduced = toPalette(many, 32, 32, 16);
    expect(reduced.lossy).toBe(true);
    expect(reduced.palette.length).toBeLessThanOrEqual(16);
  });

  it('measures how far two images are apart, transparent pixels counting for little', () => {
    const a = Uint8Array.from([100, 100, 100, 255, 0, 0, 0, 0]);
    expect(difference(a, a)).toEqual({ mean: 0, p99: 0 });
    expect(difference(a, Uint8Array.from([104, 100, 100, 255, 0, 0, 0, 0])).mean).toBeCloseTo(1, 1);
  });
});

describe('what to make smaller', () => {
  const use = (w: number, h: number, fit: ImageUse['fit'] = 'fill'): ImageUse => ({ w, h, fit });

  it('needs as much of an image as its largest box at twice the size, and all of it where its own size sets how it shows', () => {
    expect(needed([use(100, 50), use(200, 80)], 1000, 500, 2)).toEqual({ share: 0.4, w: 200, h: 80 });
    expect(needed([use(100, 100, 'contain')], 1000, 500, 2)?.share).toBe(0.2);
    expect(needed([use(100, 100, 'cover')], 1000, 500, 2)?.share).toBe(0.4);
    expect(needed([use(100, 100), use(0, 0, 'natural')], 1000, 500, 2)).toBeNull();
    expect(needed([], 1000, 500, 2)).toBeNull();
  });

  it('leaves out only files nothing names or loads, never code or GWD runtime', () => {
    const files = new Map(['Ad/Responsive.html', 'Ad/a.png', 'Ad/b.png', 'Ad/c.png', 'Ad/x.js', 'Ad/gwdpage_min.js', 'Ad/notes.psd'].map((p) => [p, new Uint8Array(10)]));
    const refs = [{ path: 'Ad/a.png', state: 'ok' }, { path: 'Ad/B.png', actual: 'Ad/b.png', state: 'case' }] as FileRef[];
    const unused = unusedFiles({ files, upload: [...files.keys()], htmlPath: 'Ad/Responsive.html', refs, loaded: new Set(['Ad/c.png']) });
    expect(unused.map((u) => u.path)).toEqual(['Ad/notes.psd']);
  });

  it('resizes an image that shows smaller than it is, and keeps one a script names at its size', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x03, 0xe8, 0x07, 0xd0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0, 2, ...new Uint8Array(20_000), 0xff, 0xd9]);
    const files = new Map([['Ad/Responsive.html', new Uint8Array(1)], ['Ad/big.jpg', jpeg], ['Ad/named.jpg', jpeg]]);
    const jobs: Parameters<Run>[0][] = [];
    const run: Run = async (job) => {
      jobs.push(job);
      const w = job.resize?.width ?? 2000;
      const h = job.resize?.height ?? 1000;
      return { id: 0, data: new ArrayBuffer(1000), width: w, height: h, mean: 1, p99: 4, lossy: true };
    };
    const uses = new Map([['Ad/big.jpg', [use(300, 150)]], ['Ad/named.jpg', [use(300, 150)]]]);
    const refs = [{ ref: 'named.jpg', where: 'this HTML', path: 'Ad/named.jpg', state: 'ok', script: true }] as FileRef[];
    const found = await findSavings({ files, upload: [...files.keys()], htmlPath: 'Ad/Responsive.html', refs, uses, loaded: new Set() }, { dpr: 2, quality: 0.85, colors: 256 }, run);
    expect(jobs.map((j) => j.resize)).toEqual([{ width: 600, height: 300 }, null]);
    expect(found.shrinks.map((x) => [x.path, x.why, x.recommended])).toEqual([
      ['Ad/big.jpg', 'shows at most 300 × 150, so 2× that is enough', true],
      ['Ad/named.jpg', 'kept at its size: a script names it', true],
    ]);
  });
});
