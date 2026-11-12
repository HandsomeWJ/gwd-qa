// The package checks. Every file the ad loads must be in the package at the exact path it uses:
// StackAdapt serves ads from AWS, where paths are case-sensitive, so a name that differs only in
// letter case loads nothing there, though GWD's preview on a Mac finds it. And the zip for upload
// must be under 4 MB.

import { startTags, type CssModel } from '../css/parse';
import { dirOf } from '../zip';
import { htmlText, readAd, type AdFiles, type Source } from './cssvalues';
import { LIBRARY } from './states';
import type { Finding } from './types';

/** 4 MB counted as 4,000,000 bytes, the smaller of the two ways a platform may count it. */
export const WEIGHT_LIMIT = 4_000_000;

export interface FileRef {
  ref: string; // as written, character references decoded
  where: string; // 'this HTML', or the file it is in
  path: string; // the package path it resolves to
  state: 'ok' | 'case' | 'missing';
  actual?: string; // for 'case': the path as the package has it
  /** Where the ref is in this HTML, when it is written there plainly, and what to write instead to fix its case. */
  at?: { start: number; end: number };
  fix?: string;
  /** A path in a script's string: the code may build the path it loads differently, or never load it. */
  script?: boolean;
}

// Attributes that name a file on any element, and those GWD's components use for theirs.
const FILE_ATTRS = new Set(['src', 'poster']);
const GWD_FILE_ATTRS = new Set(['source', 'sources', 'images', 'up-image', 'over-image', 'down-image']);
const LIST_ATTRS = new Set(['sources', 'images']);
const LINK_SKIP = /\b(preconnect|dns-prefetch|canonical|alternate)\b/i;
const URL_FN = /url\(\s*(["']?)([^"')]*?)\1\s*\)|@import\s+(["'])([^"'\n]*)\3/gi;
// A file path in a script's string: no scheme, no markup, a name, and a type an ad loads. A string that
// is only an extension, such as ".png" added to a name the code builds, is not one.
const SCRIPT_PATH = /(["'`])((?:\.{1,2}\/)?[^"'`\n<>:*?|\\]*?[^"'`\n<>:*?|\\/.]\.(?:png|jpe?g|gif|svg|webp|avif|bmp|mp4|webm|mov|m4v|ogv|mp3|m4a|aac|ogg|wav|woff2?|ttf|otf|eot|json|css|js))\1/gi;
const MEDIA_OVERRIDE_KEY = /"(src|source|sources|poster|images)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** The package path a ref loads, resolved against the file it is in as a browser does; null for another site's or a data: URL. */
function resolve(ref: string, from: string): string | null {
  const base = `https://ad.invalid/${dirOf(from).split('/').map(encodeURIComponent).join('/')}`;
  let url: URL;
  try {
    url = new URL(ref, base);
  } catch {
    return null;
  }
  if (url.origin !== 'https://ad.invalid') return null;
  let path = url.pathname.slice(1);
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path when it is not valid percent-encoding
  }
  return path;
}

/** What to write instead of `ref` so it names `actual` exactly; null where only a person can tell. */
function caseFix(ref: string, actual: string): string | null {
  const [, path, tail] = /^([^?#]*)(.*)$/s.exec(ref)!;
  const lead = /^(?:\.\/)*/.exec(path)![0];
  const rest = path.slice(lead.length);
  if (!rest || rest.startsWith('/') || /(^|\/)\.\.?(\/|$)|[%\\]/.test(rest)) return null;
  const cut = actual.length - rest.length;
  if (cut < 0 || (cut > 0 && actual[cut - 1] !== '/') || actual.slice(cut).toLowerCase() !== rest.toLowerCase()) return null;
  return lead + actual.slice(cut) + tail;
}

export function fileRefs(html: string, css: CssModel, ad: AdFiles): FileRef[] {
  const refs: FileRef[] = [];
  const lower = new Map([...ad.files.keys()].map((k) => [k.toLowerCase(), k]));
  const add = (ref: string, where: string, from: string, at?: { start: number; end: number }, script = false) => {
    const written = ref.trim();
    if (!written || /^(#|data:|blob:|about:|javascript:|mailto:|tel:)/i.test(written) || /[{}]/.test(written)) return;
    if (/^file:/i.test(written)) {
      refs.push({ ref: written, where, path: written, state: 'missing', script });
      return;
    }
    const path = resolve(written, from);
    if (path === null || path.endsWith('/') || !path) return;
    if (refs.some((r) => r.where === where && r.ref === written && r.at?.start === at?.start)) return;
    const actual = ad.files.has(path) ? path : lower.get(path.toLowerCase());
    const state = actual === path ? 'ok' : actual ? 'case' : 'missing';
    const fix = state === 'case' && at ? caseFix(written, actual!) : null;
    refs.push({ ref: written, where, path, state, ...(actual && actual !== path ? { actual } : {}), ...(at ? { at } : {}), ...(fix ? { fix } : {}), ...(script ? { script } : {}) });
  };
  // A ref inside decoded text: its place in this HTML when the HTML writes it plainly, so a fix can rewrite it.
  const plain = (src: Source, from: number, to: number) => {
    const start = src.at[from];
    const end = src.at[to];
    return html.slice(start, end) === src.text.slice(from, to) ? { start, end } : undefined;
  };
  const fromList = (src: Source, from: number, to: number, list: boolean, where: string) => {
    const text = src.text.slice(from, to);
    const parts = list ? text.split(',') : [text];
    let k = from;
    for (const part of parts) {
      const lead = part.length - part.trimStart().length;
      const ref = part.trim();
      if (ref) add(ref, where, ad.htmlPath, plain(src, k + lead, k + lead + ref.length));
      k += part.length + 1;
    }
  };
  // CSS url()s and @imports in `text`; `place` maps a ref's span in it to this HTML, where it is there.
  const urls = (text: string, where: string, from: string, place?: (start: number, end: number) => { start: number; end: number } | undefined) => {
    for (const m of text.matchAll(URL_FN)) {
      const ref = m[2] ?? m[4];
      const at = m.index! + m[0].indexOf(ref, m[0].indexOf(m[1] || m[3] || '(') + 1);
      add(ref, where, from, place?.(at, at + ref.length));
    }
  };

  for (const tag of startTags(html)) {
    for (const [name, attr] of tag.attrs) {
      const src = htmlText(attr.value, attr.start);
      if (name === 'href' && tag.name === 'link') {
        if (!LINK_SKIP.test(tag.attrs.get('rel')?.value ?? '')) fromList(src, 0, src.text.length, false, 'this HTML');
      } else if (FILE_ATTRS.has(name) || (tag.name.startsWith('gwd-') && GWD_FILE_ATTRS.has(name))) {
        fromList(src, 0, src.text.length, LIST_ATTRS.has(name), 'this HTML');
      } else if (name === 'srcset') {
        let k = 0;
        for (const candidate of src.text.split(',')) {
          const lead = candidate.length - candidate.trimStart().length;
          const url = candidate.trim().split(/\s+/)[0];
          if (url) add(url, 'this HTML', ad.htmlPath, plain(src, k + lead, k + lead + url.length));
          k += candidate.length + 1;
        }
      } else if (name === 'style') {
        urls(src.text, 'this HTML', ad.htmlPath, (a, b) => plain(src, a, b));
      } else if (name === 'data-gwd-media-override') {
        // GWD's per-size attributes, as JSON: a size can load its own image.
        for (const m of src.text.matchAll(MEDIA_OVERRIDE_KEY)) {
          let value: string;
          try {
            value = JSON.parse(`"${m[2]}"`) as string;
          } catch {
            continue;
          }
          const at = m.index! + m[0].length - m[2].length - 1;
          if (value === m[2]) fromList(src, at, at + m[2].length, m[1] === 'sources' || m[1] === 'images', 'this HTML');
          else for (const one of m[1] === 'sources' || m[1] === 'images' ? value.split(',') : [value]) add(one, 'this HTML', ad.htmlPath);
        }
      }
    }
  }
  for (const block of css.styleBlocks) urls(html.slice(block.open, block.close), 'this HTML', ad.htmlPath, (a, b) => ({ start: block.open + a, end: block.open + b }));
  const decoder = new TextDecoder();
  readAd(html, css, ad, [], {
    sheet: (_css, path) => {
      const data = path ? ad.files.get(path) : undefined;
      if (path && data) urls(decoder.decode(data), path, path);
    },
    script: (text, from, to, file) => {
      if (file && LIBRARY.test(file.split('/').pop() ?? '')) return;
      for (const m of text.slice(from, to).matchAll(SCRIPT_PATH)) {
        const start = from + m.index! + 1;
        const at = file ? undefined : html.slice(start, start + m[2].length) === m[2] ? { start, end: start + m[2].length } : undefined;
        add(m[2], file ?? 'this HTML', file ?? ad.htmlPath, at, true);
      }
    },
  });
  return refs;
}

export function fileFindings(refs: FileRef[], lone: boolean): Finding[] {
  if (lone) return [{ check: 'files', level: 'note', target: 'package', message: 'Only the HTML came, so the files it loads were not checked: drop the whole folder or zip.', unknown: true }];
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    if (r.state === 'ok') continue;
    const key = `${r.where}|${r.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = r.state === 'case' ? `, but the package has it as ${r.actual}: the letter case differs, so a case-sensitive server such as StackAdapt's finds nothing, though GWD's preview on a Mac does` : ', which is not in the package';
    if (r.script) {
      out.push({ check: 'files', level: 'note', target: r.ref, message: `A script in ${r.where} names "${r.ref}"${found}. The code may build the path it loads differently, or never load it: check that it loads.`, unknown: true });
      continue;
    }
    const root = r.ref.startsWith('/') && !r.ref.startsWith('//') ? ` It starts with /, so it loads from the server's root, outside the ad.` : '';
    const local = /^file:/i.test(r.ref) ? ' It points at a file on a computer, which no one else has.' : '';
    const hint = r.state === 'case' ? (r.fix ? undefined : `Correct the name in ${r.where}.`) : 'Add the file to the package, or correct the path in GWD.';
    out.push({ check: 'files', level: 'fail', target: r.ref, message: `${r.where === 'this HTML' ? 'The HTML' : r.where} loads "${r.ref}"${found}.${root}${local}`, ...(hint ? { hint } : {}) });
  }
  return out;
}

const mb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;

/** The zip for upload, weighed: `files` are the package paths it holds, with their sizes. */
export function weightFindings(size: number, files: [string, number][], lone: boolean): Finding[] {
  if (lone) return [{ check: 'weight', level: 'note', target: 'package', message: 'Only the HTML came, so the package was not weighed: drop the whole folder or zip.', unknown: true }];
  if (size <= WEIGHT_LIMIT) return [{ check: 'weight', level: 'note', target: 'zip for upload', message: `${mb(size)}, under the 4 MB limit.` }];
  const biggest = [...files].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${p.split('/').pop()} (${mb(n)})`).join(', ');
  return [{
    check: 'weight',
    level: 'fail',
    target: 'zip for upload',
    message: `${mb(size)}, over the 4 MB limit. Its largest files: ${biggest}.`,
    hint: 'Compress the largest images or video, or take out files the ad does not use, and publish again.',
  }];
}
