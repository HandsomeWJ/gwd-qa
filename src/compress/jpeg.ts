// JPEG files: size, color channels and color profile, from the markers before the image data.

import { iccIsSrgb } from './png';

export interface JpegInfo {
  width: number;
  height: number;
  /** 1 grey, 3 color, 4 CMYK, which a browser's re-encode would turn into RGB with other colors. */
  components: number;
  profile: 'none' | 'srgb' | 'other';
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Reads a JPEG's markers up to its image data; null for a file that is not a JPEG. */
export function jpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (!isJpeg(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info: JpegInfo = { width: 0, height: 0, components: 0, profile: 'none' };
  const icc: Uint8Array[] = [];
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1];
    if (marker === 0xff || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // the image data, or its end
    const length = view.getUint16(at + 2);
    const data = bytes.subarray(at + 4, at + 2 + length);
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      info.height = view.getUint16(at + 5);
      info.width = view.getUint16(at + 7);
      info.components = data[5];
    } else if (marker === 0xe2 && String.fromCharCode(...data.subarray(0, 11)) === 'ICC_PROFILE') {
      icc.push(data.subarray(14));
    }
    at += 2 + length;
  }
  if (icc.length) {
    const all = new Uint8Array(icc.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of icc) {
      all.set(part, at);
      at += part.length;
    }
    info.profile = iccIsSrgb(all) ? 'srgb' : 'other';
  }
  return info.width ? info : null;
}
