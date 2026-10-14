import { unzipSync, zipSync, type Zippable } from 'fflate';

export interface AdPackage {
  zipName: string; // the name it downloads as: the zip's, "<folder>.zip", or the lone HTML file's
  kind: 'zip' | 'folder' | 'html'; // what was dropped: a zip, a folder (or several files), or just the HTML
  entries: string[]; // entry names in their original order; directories end with '/'
  files: Map<string, Uint8Array>; // full zip path -> bytes (files only)
  htmlPath: string; // the ad's main HTML (full zip path)
}

const JUNK = /(^|\/)__MACOSX\/|(^|\/)\.DS_Store$/;
// GWD keeps older copies of the HTML here; they are never the ad itself.
const STALE_COPIES = /(^|\/)(_revisions?|gwd_preview_[^/]*)\//;

/** GWD's backup and preview copies: never part of the ad, so an upload leaves them out. */
export const isGwdBackup = (name: string) => STALE_COPIES.test(name);
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
  return { zipName, kind: 'zip', entries, files, htmlPath: findAdHtml(files) };
}

/**
 * A dropped folder, or several files, by their relative paths. Entries are sorted, each folder
 * listed before its files, so the zip it downloads as is the folder zipped.
 */
export function readFolder(picked: { path: string; data: Uint8Array }[]): AdPackage {
  const files = new Map<string, Uint8Array>();
  const twice = new Set<string>();
  for (const f of [...picked].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (JUNK.test(f.path)) continue;
    if (files.has(f.path)) twice.add(f.path);
    files.set(f.path, f.data);
  }
  if (!files.size) throw new Error('The folder is empty.');
  // Files dragged from search results, or from two folders at once, come without their folder:
  // one of two Responsive.html files would be dropped unseen, and the other checked as the ad.
  if (twice.size) {
    const list = [...twice].slice(0, 3).join(', ') + (twice.size > 3 ? ` and ${twice.size - 3} more` : '');
    throw new Error(`Files with the same name came from different folders: ${list}. They may be different ads. Check one ad at a time: its zip, its folder, or just its HTML.`);
  }
  const entries: string[] = [];
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    for (let k = path.indexOf('/'); k >= 0; k = path.indexOf('/', k + 1)) {
      const dir = path.slice(0, k + 1);
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      entries.push(dir);
    }
    entries.push(path);
  }
  const htmlPath = findAdHtml(files);
  const name = topFolder(files.keys()) || htmlPath.split('/').pop()!.replace(/\.html?$/i, '');
  return { zipName: `${name}.zip`, kind: 'folder', entries, files, htmlPath };
}

/** The one folder every path is in, or '' when they are not all in one folder. */
function topFolder(paths: Iterable<string>): string {
  const tops = new Set([...paths].map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')));
  return tops.size === 1 ? [...tops][0] : '';
}

/** Just the ad's HTML file: GWD's runtime and the ad's images are not there. */
export function readHtml(name: string, data: Uint8Array): AdPackage {
  return { zipName: name, kind: 'html', entries: [name], files: new Map([[name, data]]), htmlPath: name };
}

const GWD_PAGE = /gwd-served-sizes|<gwd-genericad|<gwd-pagedeck|name="generator" content="Google Web Designer/;

export function findAdHtml(files: Map<string, Uint8Array>): string {
  const decoder = new TextDecoder();
  const candidates = [...files.keys()].filter((p) => /\.html?$/i.test(p) && !STALE_COPIES.test(p));
  if (!candidates.length) throw new Error('No HTML file found outside _revisions/ and gwd_preview_ folders.');
  const ads = candidates.filter((p) => GWD_PAGE.test(decoder.decode(files.get(p)!.subarray(0, 400_000))));
  // Checking one of them would pass the others on in the download, unchecked.
  if (ads.length > 1) {
    const list = ads.slice(0, 3).join(', ') + (ads.length > 3 ? ` and ${ads.length - 3} more` : '');
    throw new Error(`Found ${ads.length} ads: ${list}. Check one ad at a time: its zip, its folder, or just its HTML.`);
  }
  if (ads.length) return ads[0];
  return candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];
}

/**
 * The key the page remembers choices about this ad under, such as disclaimer marks: the name it
 * came as, and a short hash of its HTML. Names repeat between ads: GWD names every ad's HTML
 * Responsive.html, and macOS names every zip it makes Archive.zip.
 */
export function adKey(pkg: AdPackage): string {
  return keyFor(pkg.zipName, pkg.files.get(pkg.htmlPath)!);
}

/** The key of an ad that comes as `name` with this HTML, such as the fixed ad as it downloads. */
export function keyFor(name: string, html: Uint8Array): string {
  return `${name}#${shortHash(html)}`;
}

/** The key a zip or a folder had before keys held the HTML's hash: its name alone. */
export function legacyKey(pkg: AdPackage): string | undefined {
  return pkg.kind === 'zip' || (pkg.kind === 'folder' && topFolder(pkg.files.keys())) ? pkg.zipName : undefined;
}

/** FNV-1a, 32 bits, as 8 hex digits. */
function shortHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Same entries, same order, with any changed files swapped in and any `leaveOut` entries dropped. */
export function writeZip(pkg: AdPackage, changed: Map<string, Uint8Array>, leaveOut?: (name: string) => boolean): Uint8Array {
  const input: Zippable = {};
  for (const name of pkg.entries) {
    if (leaveOut?.(name)) continue;
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

// GWD's runtime files, such as gwd_webcomponents_v1_min.js, gwdpage_min.js, gwd-events-support.1.0.js,
// gwdpage_style.css and the groups runtime, groups_runtime.min.1.0.js. The service worker
// (public/sw.js) stands in for these when they are missing.
export const GWD_RUNTIME = /^(gwd[\w.-]*\.(js|css)|groups_runtime[\w.-]*\.js)$/i;

/** GWD runtime files the ad's HTML loads but the package does not have, by path. */
export function missingRuntime(pkg: AdPackage): string[] {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(pkg.files.get(pkg.htmlPath)), 'text/html');
  const refs = [...doc.querySelectorAll('script[src], link[href]')].map((el) => el.getAttribute(el.localName === 'script' ? 'src' : 'href')!);
  // Resolved against the HTML's folder, as the preview frame resolves them.
  const base = `https://ad.invalid/${dirOf(pkg.htmlPath).split('/').map(encodeURIComponent).join('/')}`;
  const missing = new Set<string>();
  for (const ref of refs) {
    let url: URL;
    try {
      url = new URL(ref, base);
    } catch {
      continue;
    }
    if (url.origin !== 'https://ad.invalid') continue; // another site's file, never part of the ad
    let path = url.pathname.slice(1);
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep the raw path when it is not valid percent-encoding
    }
    if (GWD_RUNTIME.test(path.split('/').pop()!) && !pkg.files.has(path)) missing.add(path);
  }
  return [...missing];
}
