// Compresses one image off the page's thread: resizes it with the browser's best filter, re-encodes it
// (JPEG at a quality, PNG with a palette or losslessly), and measures how far the result is from the
// resized original.

import { encodeIndexedPng, encodeRgbaPng } from './png';
import { difference, toPalette } from './pixels';

export interface ShrinkJob {
  id: number;
  data: ArrayBuffer;
  type: 'image/jpeg' | 'image/png';
  /** The size to resize to, or null to keep its own. */
  resize: { width: number; height: number } | null;
  quality: number; // JPEG, 0 to 1
  colors: number; // PNG: the most palette colors, or 0 to keep every color
}

export interface ShrinkDone {
  id: number;
  data: ArrayBuffer;
  width: number;
  height: number;
  mean: number;
  p99: number;
  /** Whether pixels changed in the re-encode, beyond the resize. */
  lossy: boolean;
}

export interface ShrinkFailed {
  id: number;
  error: string;
}

async function decode(blob: Blob, resize: ShrinkJob['resize']) {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
    ...(resize ? { resizeWidth: resize.width, resizeHeight: resize.height, resizeQuality: 'high' as const } : {}),
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { canvas, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
}

const post = (message: ShrinkDone | ShrinkFailed, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = async (e: MessageEvent<ShrinkJob>) => {
  const job = e.data;
  try {
    const { canvas, data } = await decode(new Blob([job.data], { type: job.type }), job.resize);
    let out: Uint8Array;
    let lossy = true;
    if (job.type === 'image/jpeg') {
      out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: job.quality })).arrayBuffer());
    } else if (job.colors) {
      const indexed = toPalette(data, canvas.width, canvas.height, job.colors);
      out = encodeIndexedPng(canvas.width, canvas.height, indexed.indices, indexed.palette);
      lossy = indexed.lossy;
    } else {
      out = encodeRgbaPng(canvas.width, canvas.height, data);
      lossy = false;
    }
    const back = await decode(new Blob([out as BlobPart], { type: job.type }), null);
    const d = difference(data, back.data);
    const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    post({ id: job.id, data: buffer, width: canvas.width, height: canvas.height, mean: d.mean, p99: d.p99, lossy }, [buffer]);
  } catch (err) {
    post({ id: job.id, error: err instanceof Error ? err.message : String(err) });
  }
};
