import { unzipSync, zipSync, type Zippable } from 'fflate';

export interface AdPackage {
  zipName: string;
  entries: string[]; // entry names in their original order; directories end with '/'
  files: Map<string, Uint8Array>; // full zip path -> bytes (files only)
  htmlPath: string; // the ad's main HTML (full zip path)
}

const JUNK = /(^|\/)__MACOSX\/|(^|\/)\.DS_Store$/;
// GWD keeps older copies of the HTML here; they are never the ad itself.
const STALE_COPIES = /(^|\/)(_revision|gwd_preview_[^/]*)\//;
const STORED = /\.(png|jpe?g|gif|webp|woff2?|mp4|webm|zip)$/i;

export function readZip(zipName: string, bytes: Uint8Array): AdPackage {
  const raw = unzipSync(bytes);
  const entries: string[] = [];
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(raw)) {
    if (JUNK.test(name)) continue;
    entries.push(name);
    if (!name.endsWith('/')) files.set(name, data);
  }
  if (!files.size) throw new Error('The zip is empty.');
  return { zipName, entries, files, htmlPath: findAdHtml(files) };
}

export function findAdHtml(files: Map<string, Uint8Array>): string {
  const decoder = new TextDecoder();
  const candidates = [...files.keys()].filter((p) => /\.html?$/i.test(p) && !STALE_COPIES.test(p));
  if (!candidates.length) throw new Error('No HTML file found outside _revision/ and gwd_preview_ folders.');
  const score = (p: string) => {
    const text = decoder.decode(files.get(p)!.subarray(0, 400_000));
    const gwd = /gwd-served-sizes|<gwd-genericad|<gwd-pagedeck|name="generator" content="Google Web Designer/.test(text) ? 0 : 1;
    return [gwd, p.split('/').length, p.length];
  };
  return candidates
    .map((p) => ({ p, s: score(p) }))
    .sort((a, b) => a.s[0] - b.s[0] || a.s[1] - b.s[1] || a.s[2] - b.s[2])[0].p;
}

/** Same entries, same order, with any changed files swapped in. */
export function writeZip(pkg: AdPackage, changed: Map<string, Uint8Array>): Uint8Array {
  const input: Zippable = {};
  for (const name of pkg.entries) {
    if (name.endsWith('/')) {
      input[name] = [new Uint8Array(0), { level: 0 }];
    } else {
      const data = changed.get(name) ?? pkg.files.get(name)!;
      input[name] = [data, { level: STORED.test(name) ? 0 : 6 }];
    }
  }
  return zipSync(input);
}

/** Directory part of a zip path, with trailing slash ("" at the root). */
export function dirOf(path: string): string {
  const k = path.lastIndexOf('/');
  return k < 0 ? '' : path.slice(0, k + 1);
}
