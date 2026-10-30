// Finds CSS values a browser rejects, and so silently ignores, such as opacity: 0,3 typed with a
// decimal comma. Reads <style> blocks, style="" attributes, and the styles that GWD events and
// scripts set: setInlineStyle(), style.cssText, setAttribute('style'), style.<prop> and
// style.setProperty(). Stylesheets and scripts the ad loads from its own files are read too.

import { parseCss, parseDeclList, sizeOfMedia, startTags, type CssModel, type Decl, type Tag } from '../css/parse';
import { describeSize } from '../sizes';
import { dirOf, GWD_RUNTIME, type AdPackage } from '../zip';

/** Whether a browser accepts `value` for `prop`. */
export type CssValidator = (prop: string, value: string) => boolean;

/** The browser's own parser. Where there is none, every value passes. */
export const cssSupports: CssValidator = (prop, value) =>
  typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports(prop, value);

export interface CssValueIssue {
  /** A rule's selector, an element's label, or the element a script styles. */
  target: string;
  /** What a script sets it with (setInlineStyle, style.cssText…), 'style attribute', or '' in a <style> block. */
  via: string;
  /** The GWD event handler or function a script sets it in, when it has a name. */
  handler: string | null;
  /** The stylesheet or script it is in, when that is one of the ad's other files; else it is in the HTML. */
  file?: string;
  prop: string;
  value: string; // as the browser reads it, without !important
  start: number; // the value's source text in the HTML, or in `file`
  end: number;
  /** The value with its decimal commas made points, when that makes it valid. */
  fixed: string | null;
  /** Why the browser ignores it, when the value is not what is wrong. */
  note?: string;
  /** Set by staticAudit for a <style> declaration: whether what it styles shows text. Absent where that is not known. */
  showsText?: boolean;
}

/** Something the check could not read or decide, so the user must look. */
export interface CssValueUnknown {
  target: string;
  message: string;
}

/** The ad's files, which the stylesheets and scripts it loads are read from. */
export type AdFiles = Pick<AdPackage, 'files' | 'htmlPath'>;

export type Where = Pick<CssValueIssue, 'target' | 'via' | 'handler' | 'file'>;

// Starts at the '!', so a long run of spaces in a value costs no backtracking.
const IMPORTANT = /!\s*important$/i;
const PROP = /^-{0,2}[a-z][a-z0-9-]*$/;
export const JS_TYPE = /^((text|application)\/(x-)?(java|ecma)script|text\/jscript|module)$/i;
// GWD's components define its elements; an ad's own scripts never do.
const GWD_ELEMENT = /\b(customElements\.define|document\.registerElement)\(\s*["']gwd-/;
// Longer a.b.c… chains are not spelled out, so that naming what a script styles stays cheap.
const MAX_CHAIN = 32;

const withoutImportant = (value: string) => {
  const m = IMPORTANT.exec(value);
  return m ? value.slice(0, m.index).trimEnd() : value;
};

/** Where the url( at s[k] ends: past its ')', or at the end of the value. */
function urlEnd(s: string, k: number): number {
  let e = k + 4;
  while (e < s.length && /\s/.test(s[e])) e++;
  if (s[e] === '"' || s[e] === "'") e = stringEnd(s, e) + 1;
  while (e < s.length && s[e] !== ')') e += s[e] === '\\' ? 2 : 1;
  return Math.min(e + 1, s.length);
}

/**
 * The value with its decimal commas made points: all of them, or (`top`) only those outside
 * brackets, so that function arguments written without spaces keep their commas. Never inside
 * url() or a string, where a comma is part of a file name, an SVG path or text.
 */
function pointDecimals(s: string, top: boolean): string {
  let out = '';
  let depth = 0;
  for (let k = 0; k < s.length; ) {
    const c = s[k];
    const kept = c === '"' || c === "'" ? stringEnd(s, k) + 1 : (c === 'u' || c === 'U') && /^url\($/i.test(s.slice(k, k + 4)) && !/[\w-]/.test(s[k - 1] ?? '') ? urlEnd(s, k) : -1;
    if (kept > k) {
      out += s.slice(k, kept);
      k = kept;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    out += c === ',' && (!top || !depth) && /\d/.test(s[k - 1] ?? '') && /\d/.test(s[k + 1] ?? '') ? '.' : c;
    k++;
  }
  return out;
}

/**
 * GWD's own runtime: a component (data-source, data-exports-type), the events support or another
 * runtime file, inlined into the HTML or loaded from one of its files. The ad cannot change it,
 * and it compares and picks values rather than setting them ("none" != c ? c : "auto").
 */
function gwdRuntime(tag: Tag, content: string): boolean {
  const attrs = [...tag.attrs.keys()];
  return (
    attrs.some((a) => a === 'data-source' || a === 'data-exports-type' || /^gwd-[\w-]+-runtime$/.test(a)) ||
    tag.attrs.get('gwd-events')?.value.trim().toLowerCase() === 'support' ||
    GWD_ELEMENT.test(content)
  );
}

/** What is wrong with a value, and where a script, a style attribute or another file sets it. */
export function describeIssue(v: CssValueIssue): string {
  const file = v.file ? `, in ${v.file}` : '';
  const where = v.via === 'style attribute'
    ? ' It is in its style attribute.'
    : v.via ? ` ${v.via} sets it${v.handler ? ` in ${v.handler}` : ''}${file}.` : v.file ? ` It is in ${v.file}.` : '';
  const why = v.note ? `is ignored: ${v.note}` : `is not valid CSS, so browsers ignore it${v.fixed ? `; write ${v.fixed}` : ''}`;
  return `"${v.prop}: ${v.value}" ${why}.${where}`;
}

export function cssValueIssues(html: string, css: CssModel, valid: CssValidator = cssSupports, ad?: AdFiles): CssValueIssue[] {
  return checkCssValues(html, css, valid, ad).issues;
}

/**
 * The CSS values browsers ignore, and what the check could not read. `ad` has the files the HTML
 * loads; without it, every stylesheet or script it loads from its own files is one not read.
 */
export function checkCssValues(
  html: string,
  css: CssModel,
  valid: CssValidator = cssSupports,
  ad?: AdFiles,
): { issues: CssValueIssue[]; unknown: CssValueUnknown[] } {
  const issues: CssValueIssue[] = [];
  const unknown: CssValueUnknown[] = [];
  const known = new Map<string, boolean>();
  // Unknown properties are skipped, vendor ones included: a browser that does not know one ignores it by design.
  const knows = (prop: string) => {
    if (!known.has(prop)) known.set(prop, valid(prop, 'inherit'));
    return known.get(prop)!;
  };
  const check = (prop: string, value: string, start: number, end: number, where: Where) => {
    if (!value || !knows(prop) || valid(prop, value)) return;
    // Decimal commas made points outside functions, as in "1,5px rgba(0,0,0,0.5)"; failing that, every one.
    const top = pointDecimals(value, true);
    const all = pointDecimals(value, false);
    const fixed = top !== value && valid(prop, top) ? top : all !== value && all !== top && valid(prop, all) ? all : null;
    issues.push({ ...where, prop, value, start, end, fixed });
  };
  /** `at` maps an offset in the text the declarations were read from to the HTML (or the file). */
  const checkDecls = (decls: Decl[], where: Where, at: (i: number) => number = (i) => i) => {
    for (const d of decls) {
      const value = withoutImportant(d.value);
      check(d.prop, value, at(d.valueStart), at(d.valueStart + value.length), where);
    }
  };
  /**
   * A property set with style.setProperty(name, value), which GWD's setInlineStyle() also calls:
   * the name is taken as written, spaces and all, and !important belongs in its own argument.
   */
  const setProperty = (name: string, src: Source, from: number, to: number, where: Where) => {
    const value = src.text.slice(from, to);
    const trimmed = name.trim();
    const custom = trimmed.startsWith('--');
    // A custom property's name is its own; whether one with spaces around it is set is not checked.
    if (!value || !trimmed || (custom && name !== trimmed)) return;
    const prop = custom ? trimmed : trimmed.toLowerCase(); // as setProperty() reads it
    if (!knows(prop)) return;
    const note = name !== trimmed
      ? `${where.via} takes the spaces around the name as part of it, so browsers know no such property`
      : IMPORTANT.test(value) ? `${where.via} takes !important as part of the value, which browsers then reject` : null;
    if (!note) check(prop, value, src.at[from], src.at[to], where);
    else issues.push({ ...where, prop: name !== trimmed ? name : prop, value, start: src.at[from], end: src.at[to], fixed: null, note });
  };

  const inMedia = (media: string | null) => (media ? ` in ${describeSize(sizeOfMedia(media) ?? media)}` : '');
  const checkSheet = (model: CssModel, file?: string, at?: (i: number) => number) => {
    const inBlock = (target: string): Where => ({ target, via: '', handler: null, ...(file ? { file } : {}) });
    for (const rule of model.rules) checkDecls(rule.decls, inBlock(rule.selector + inMedia(rule.media)), at);
    for (const block of model.keyframes) {
      for (const frame of block.frames) checkDecls(frame.decls, inBlock(`${block.name} ${frame.selector}${inMedia(block.media)}`), at);
    }
  };
  /** What a script sets, inline in the HTML or in `file`. */
  const hits = (file?: string): ScriptHits => {
    const inFile = (where: Where): Where => (file ? { ...where, file } : where);
    return {
      list: (src, where) => {
        const decls = declList(src.text);
        if (decls) checkDecls(decls, inFile(where), (i) => src.at[i]);
      },
      inline: (src, where) => {
        for (const d of gwdInlineStyles(src.text)) setProperty(d.name, src, d.valueStart, d.valueEnd, inFile(where));
      },
      property: (name, src, where) => {
        const lead = src.text.length - src.text.trimStart().length;
        setProperty(name, src, lead, src.text.trimEnd().length, inFile(where));
      },
      single: (prop, src, where) => {
        const value = src.text.trim();
        const lead = src.text.length - src.text.trimStart().length;
        check(prop, value, src.at[lead], src.at[lead + value.length], inFile(where));
      },
      unknown: (target, message) => unknown.push({ target, message: file ? `${message} It is in ${file}.` : message }),
    };
  };

  const files = readAd(html, css, ad, unknown, {
    sheet: checkSheet,
    script: (text, from, to, file) => scanScript(text, from, to, hits(file)),
    tag: (tag) => {
      const style = tag.attrs.get('style');
      if (!style) return;
      const src = htmlText(style.value, style.start);
      if (src.undecoded) unknown.push({ target: tagLabel(tag), message: `Its style attribute has ${src.undecoded}, which could not be decoded here, so its CSS values were not checked.` });
      else checkDecls(parseDeclList(src.text), { target: tagLabel(tag), via: 'style attribute', handler: null }, (i) => src.at[i]);
    },
  });
  const order = (v: CssValueIssue) => (v.file ? files.order(v.file) : -1);
  return { issues: issues.sort((a, b) => order(a) - order(b) || a.start - b.start), unknown };
}

// @import chains deeper than this are never real CSS.
const MAX_IMPORTS = 8;

/** The URLs a stylesheet's @import rules load. */
function imports(css: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
  return [...bare.matchAll(/@import\s+(?:url\(\s*(["']?)([^"')]*)\1\s*\)|(["'])([^"'\n]*)\3)/gi)].map((m) => (m[2] ?? m[4]).trim());
}

/** What readAd() visits. */
export interface AdVisitor {
  /** A <style> block's rules, or a stylesheet's; `at` maps its offsets to the file's. */
  sheet: (model: CssModel, file?: string, at?: (i: number) => number) => void;
  /** An inline script (`text` is the HTML, `from`-`to` its content) or a script file's text. */
  script: (text: string, from: number, to: number, file?: string) => void;
  /** Every start tag of the HTML, in order. */
  tag?: (tag: Tag) => void;
}

/**
 * Visits the ad's CSS and scripts: the HTML's own, and the stylesheets and scripts it loads from its
 * own files, each once, leaving GWD's runtime out. A file it loads but does not have goes into
 * `unknown` as not read.
 */
export function readAd(html: string, css: CssModel, ad: AdFiles | undefined, unknown: CssValueUnknown[], visit: AdVisitor): AdFileReader {
  visit.sheet(css);
  const files = new AdFileReader(ad, unknown);
  const sheet = (path: string, label: string, chain = 0) => {
    if (GWD_RUNTIME.test(path.split('/').pop()!)) return;
    const text = files.read(path, label, 'its CSS values were not checked');
    if (text === null) return;
    // parseCss reads <style> elements, so the file is read as one; '</style' in it is made inert.
    const wrapped = `<style>${text.replace(/<\/(?=style)/gi, '< ')}</style>`;
    visit.sheet(parseCss(wrapped), path, (i) => i - '<style>'.length);
    if (chain < MAX_IMPORTS) for (const ref of imports(text)) files.ref(ref, path, (p, l) => sheet(p, l, chain + 1));
  };
  for (const block of css.styleBlocks) {
    for (const ref of imports(html.slice(block.open, block.close))) files.ref(ref, ad?.htmlPath ?? '', sheet);
  }
  for (const tag of startTags(html)) {
    visit.tag?.(tag);
    if (tag.name === 'link') {
      const rel = (tag.attrs.get('rel')?.value ?? '').toLowerCase().split(/\s+/);
      const type = tag.attrs.get('type')?.value.trim() || 'text/css';
      const href = tag.attrs.get('href');
      if (!href || !rel.includes('stylesheet') || rel.includes('alternate') || tag.attrs.has('disabled') || !/^text\/css$/i.test(type) || gwdRuntime(tag, '')) continue;
      files.ref(htmlText(href.value, href.start).text, ad?.htmlPath ?? '', sheet);
      continue;
    }
    const type = tag.attrs.get('type')?.value.trim() || 'text/javascript';
    if (tag.name !== 'script' || tag.attrs.has('gwd-served-sizes') || !JS_TYPE.test(type)) continue;
    const src = tag.attrs.get('src');
    if (src) {
      // A script with a src runs that file, never its own content.
      const ref = htmlText(src.value, src.start).text;
      if (!ref.trim() || gwdRuntime(tag, '')) continue;
      files.ref(ref, ad?.htmlPath ?? '', (path, label) => {
        if (GWD_RUNTIME.test(path.split('/').pop()!)) return;
        const text = files.read(path, label, 'the styles it sets were not checked');
        if (text !== null && !GWD_ELEMENT.test(text)) visit.script(text, 0, text.length, path);
      });
      continue;
    }
    if (!tag.content) continue;
    const { start, end } = tag.content;
    if (gwdRuntime(tag, html.slice(start, end))) continue;
    visit.script(html, start, end);
  }
  return files;
}

/**
 * Reads the stylesheets and scripts the ad loads from its own files, each once. Another site's
 * file is never the ad's to fix; one the ad does not have is reported as not read.
 */
class AdFileReader {
  private readonly seen = new Map<string, number>();
  private readonly decoder = new TextDecoder();

  constructor(private readonly ad: AdFiles | undefined, private readonly unknown: CssValueUnknown[]) {}

  /** Resolves `ref` against the file at `from`, as the preview frame does, and calls `then` once per file. */
  ref(ref: string, from: string, then: (path: string, label: string) => void) {
    const base = `https://ad.invalid/${dirOf(from).split('/').map(encodeURIComponent).join('/')}`;
    let url: URL;
    try {
      url = new URL(ref, base);
    } catch {
      return;
    }
    if (url.origin !== 'https://ad.invalid') return; // another site's file, or a data: URL
    let path = url.pathname.slice(1);
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep the raw path when it is not valid percent-encoding
    }
    if (this.seen.has(path)) return;
    this.seen.set(path, this.seen.size);
    then(path, ref.trim());
  }

  /** The file's text, or null after noting that it was not read. */
  read(path: string, label: string, what: string): string | null {
    const data = this.ad?.files.get(path);
    if (data) return this.decoder.decode(data);
    this.unknown.push({ target: label, message: `The ad loads ${label}, which is not among the files checked, so ${what}.` });
    return null;
  }

  order(path: string): number {
    return this.seen.get(path) ?? this.seen.size;
  }
}

/** The declarations, when the whole text is a declaration list ("opacity: 0; color: red;"); else null. */
export function declList(text: string): Decl[] | null {
  const decls = parseDeclList(text);
  let rest = '';
  let last = 0;
  for (const d of decls) {
    rest += text.slice(last, d.start);
    last = d.end;
  }
  rest += text.slice(last);
  return decls.length && /^[\s;]*$/.test(rest) && decls.every((d) => PROP.test(d.prop) && d.value) ? decls : null;
}

/**
 * The properties GWD's setInlineStyle() sets, read the way gwd-events-support.1.0.js reads them:
 * the text split at each ';' with the spaces around it, each piece cut at its colons (but not one
 * before '//'), the name kept as written and the value trimmed, !important and all. Each goes to
 * style.setProperty(name, value). It stops at the first piece with no name or no value.
 */
export function gwdInlineStyles(text: string): { name: string; valueStart: number; valueEnd: number }[] {
  const out: { name: string; valueStart: number; valueEnd: number }[] = [];
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  for (let from = 0; from <= text.length; ) {
    // split(/\s*;\s*/), without the regular expression's backtracking over long runs of spaces.
    const semi = text.indexOf(';', from);
    let end = semi < 0 ? text.length : semi;
    let next = semi < 0 ? text.length + 1 : semi + 1;
    if (semi >= 0) {
      while (end > from && space(text[end - 1])) end--;
      while (next < text.length && space(text[next])) next++;
    }
    if (end > from) {
      const colon = (k: number) => {
        for (let c = text.indexOf(':', k); c >= 0 && c < end; c = text.indexOf(':', c + 1)) if (!text.startsWith('//', c + 1)) return c;
        return end;
      };
      const first = colon(from);
      const valueEnd = first < end ? colon(first + 1) : end;
      let vs = first + 1;
      let ve = valueEnd;
      while (vs < ve && space(text[vs])) vs++;
      while (ve > vs && space(text[ve - 1])) ve--;
      if (first === from || first >= end || ve <= vs) break;
      out.push({ name: text.slice(from, first), valueStart: vs, valueEnd: ve });
    }
    from = next;
  }
  return out;
}

/** Text as the browser reads it, with the source offset of each character (and one past the end). */
export interface Source {
  text: string;
  at: number[];
  /** A character reference that could not be decoded, so the text may not be what the browser reads. */
  undecoded?: string;
}

function decode(raw: string, base: number, escape: RegExp, unescape: (m: RegExpExecArray) => string): Source {
  let text = '';
  const at: number[] = [];
  const take = (s: string, offset: number) => {
    text += s;
    for (let k = 0; k < s.length; k++) at.push(offset);
  };
  let last = 0;
  escape.lastIndex = 0;
  for (let m = escape.exec(raw); m; m = escape.exec(raw)) {
    for (let k = last; k < m.index; k++) take(raw[k], base + k);
    take(unescape(m), base + m.index);
    last = m.index + m[0].length;
  }
  for (let k = last; k < raw.length; k++) take(raw[k], base + k);
  at.push(base + raw.length);
  return { text, at };
}

// A numeric reference needs no ';', as in browsers; a named one is read only with it.
const ENTITY = /&(?:#x([\da-f]+);?|#(\d+);?|([a-z][a-z\d]*);)/gi;
// Used where there is no HTML parser to ask. Maps, so that a name such as "constructor" finds nothing rather than Object's own members.
const NAMED = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' ']]);
// What browsers read &#128; to &#159; as (windows-1252).
const C1 = '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ';
// The longest name HTML has is 31 letters; past this many different names the parser is asked no more.
const MAX_NAMED = 4096;
const named = new Map<string, string>();
const JS_ESCAPE = /\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g;
const JS_CHARS = new Map([
  ['n', '\n'], ['t', '\t'], ['r', '\r'], ['b', '\b'], ['f', '\f'], ['v', '\v'], ['0', '\0'],
  ['\n', ''], ['\r', ''], ['\r\n', ''], [' ', ''], [' ', ''],
]);

const fromCode = (code: number, fallback: string) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback);

/** A numeric character reference as browsers read it. */
function numericRef(code: number): string {
  if (code >= 0x80 && code <= 0x9f) return C1[code - 0x80];
  return code >= 0xd800 && code <= 0xdfff ? '�' : fromCode(code, '�');
}

/** &name; as a browser reads it in an attribute, asking its HTML parser; undefined where it cannot be asked. */
function namedRef(ref: string, name: string): string | undefined {
  if (name.length > 32) return ref; // no such name
  let text = named.get(name);
  if (text === undefined && typeof document !== 'undefined' && named.size < MAX_NAMED) {
    const probe = document.createElement('div');
    probe.innerHTML = `<i title="${ref}"></i>`; // only letters and digits between '&' and ';'
    text = probe.firstElementChild?.getAttribute('title') ?? undefined;
    if (text !== undefined) named.set(name, text);
  }
  return text ?? NAMED.get(name);
}

/** An attribute's text as the browser reads it; `undecoded` names a reference it could not read. */
function htmlText(raw: string, base: number): Source {
  let undecoded: string | undefined;
  const src = decode(raw, base, ENTITY, ([ref, hex, dec, name]) => {
    if (!name) return numericRef(hex ? parseInt(hex, 16) : parseInt(dec, 10));
    const text = namedRef(ref, name);
    if (text === undefined) undecoded ??= ref;
    return text ?? ref;
  });
  return undecoded ? { ...src, undecoded } : src;
}

function jsText(raw: string, base: number): Source {
  return decode(raw, base, JS_ESCAPE, ([, e]) => {
    if (e.length > 1 && (e[0] === 'u' || e[0] === 'x')) return fromCode(parseInt(e.replace(/[ux{}]/g, ''), 16), e);
    return JS_CHARS.get(e) ?? e;
  });
}

/** label() in static.ts, from a start tag. */
function tagLabel(tag: Tag): string {
  const id = tag.attrs.get('id')?.value;
  if (id) return `${tag.name}#${id}`;
  const cls = (tag.attrs.get('class')?.value ?? '').split(/\s+/).filter((c) => c && !c.startsWith('gwd-play') && !c.startsWith('gwd-pause'));
  return cls.length ? `${tag.name}.${cls.join('.')}` : tag.name;
}

interface Tok {
  kind: 'name' | 'str' | 'punct' | 'other';
  text: string; // for a string, its raw content
  start: number; // for a string, where its content starts
  end: number;
}

// A '/' after these starts a regular expression, not a division.
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const SETTERS = new Set(['setInlineStyle', 'setAttribute', 'style', 'classList', 'className']);

function stringEnd(src: string, i: number): number {
  let k = i + 1;
  while (k < src.length && src[k] !== src[i] && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
  return k;
}

/** The closing backtick of a template literal; `plain` when it has no ${} substitutions. */
function templateEnd(src: string, i: number): { end: number; plain: boolean } {
  // What encloses k, innermost last: a template (-1), or a ${} substitution with its count of open braces.
  // A stack rather than recursion, so that deeply nested templates cannot overflow the call stack.
  const within = [-1];
  let plain = true;
  let k = i + 1;
  for (; k < src.length; k++) {
    const c = src[k];
    const top = within[within.length - 1];
    if (top < 0) {
      if (c === '\\') k++;
      else if (c === '`') {
        within.pop();
        if (!within.length) break;
      } else if (c === '$' && src[k + 1] === '{') {
        plain = false;
        within.push(0);
        k++;
      }
    } else if (c === '{') within[within.length - 1]++;
    else if (c === '}') {
      if (top) within[within.length - 1]--;
      else within.pop();
    } else if (c === '"' || c === "'") k = stringEnd(src, k);
    else if (c === '`') within.push(-1);
  }
  return { end: k, plain };
}

function regexEnd(src: string, i: number): number {
  let k = i + 1;
  let inClass = false;
  while (k < src.length && src[k] !== '\n') {
    const c = src[k];
    if (c === '\\') k++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    k++;
  }
  k++;
  while (k < src.length && /\w/.test(src[k])) k++;
  return k;
}

/** A light JavaScript tokenizer: enough to find string literals and the calls around them. */
function jsTokens(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  const regexAllowed = () => {
    const prev = toks[toks.length - 1];
    if (!prev) return true;
    if (prev.kind === 'punct') return !')]}'.includes(prev.text);
    return prev.kind === 'name' && BEFORE_REGEX.has(prev.text);
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      const end = stringEnd(src, i);
      toks.push({ kind: 'str', text: src.slice(i + 1, end), start: i + 1, end });
      i = end + 1;
    } else if (c === '`') {
      const { end, plain } = templateEnd(src, i);
      toks.push(plain ? { kind: 'str', text: src.slice(i + 1, end), start: i + 1, end } : { kind: 'other', text: '`', start: i, end: end + 1 });
      i = end + 1;
    } else if (c === '/' && regexAllowed()) {
      const end = regexEnd(src, i);
      toks.push({ kind: 'other', text: '/', start: i, end });
      i = end;
    } else if (/[\w$]/.test(c)) {
      let end = i + 1;
      while (end < n && /[\w$]/.test(src[end])) end++;
      toks.push({ kind: /\d/.test(c) ? 'other' : 'name', text: src.slice(i, end), start: i, end });
      i = end;
    } else {
      toks.push({ kind: 'punct', text: c, start: i, end: i + 1 });
      i++;
    }
  }
  return toks;
}

const isP = (tok: Tok | undefined, text: string) => tok?.kind === 'punct' && tok.text === text;

/**
 * For each bracket token, the one that closes or opens it ('(' with ')', '[' or '{' alike); -1 for
 * other tokens and unmatched brackets. Found once, so no lookup walks the script again.
 */
function brackets(toks: Tok[]): number[] {
  const partner = new Array<number>(toks.length).fill(-1);
  const open: number[] = [];
  toks.forEach((tok, k) => {
    if (tok.kind !== 'punct') return;
    if ('([{'.includes(tok.text)) open.push(k);
    else if (')]}'.includes(tok.text) && open.length) {
      const o = open.pop()!;
      partner[o] = k;
      partner[k] = o;
    }
  });
  return partner;
}

/** Each argument of the call whose '(' is toks[open], as a token range [first, end); none when it never closes. */
function callArgs(toks: Tok[], partner: number[], open: number): [number, number][] {
  const close = partner[open];
  if (close < 0) return [];
  const args: [number, number][] = [];
  let first = open + 1;
  for (let k = open + 1; k < close; k++) {
    if (partner[k] > k) k = partner[k]; // over a nested bracket
    else if (isP(toks[k], ',')) {
      args.push([first, k]);
      first = k + 1;
    }
  }
  args.push([first, close]);
  return args;
}

/** The name an expression starting at toks[k] is assigned to: gwd.framechange_savings = function… */
function assignee(toks: Tok[], k: number): string | null {
  const op = toks[k - 1];
  if (isP(op, ':')) return toks[k - 2]?.kind === 'name' || toks[k - 2]?.kind === 'str' ? toks[k - 2].text : null;
  if (!isP(op, '=')) return null;
  return memberChain(toks, k - 2);
}

/** The a.b.c chain of names that ends at toks[k], or null when there is none or it is too long to spell out. */
function memberChain(toks: Tok[], k: number): string | null {
  const chain: string[] = [];
  for (let j = k; toks[j]?.kind === 'name'; j -= 2) {
    if (chain.length === MAX_CHAIN) return null;
    chain.push(toks[j].text);
    if (!isP(toks[j - 1], '.')) break;
  }
  return chain.length ? chain.reverse().join('.') : null;
}

/** The name of the function whose body the '{' at toks[t] opens, when it is one and has a name. */
function functionName(toks: Tok[], partner: number[], t: number): string | null {
  if (isP(toks[t - 1], '>') && isP(toks[t - 2], '=')) {
    const params = isP(toks[t - 3], ')') ? partner[t - 3] : toks[t - 3]?.kind === 'name' ? t - 3 : -1;
    return params < 0 ? null : assignee(toks, params);
  }
  if (!isP(toks[t - 1], ')')) return null;
  const params = partner[t - 1];
  const before = toks[params - 1];
  if (before?.kind !== 'name') return null;
  if (before.text === 'function') return assignee(toks, params - 1);
  return CONTROL.has(before.text) ? null : before.text; // function name() {, or a method
}

/**
 * What a script sets. `id` is the element's id where the code names it (getElementById('x'),
 * querySelector('#x'), or GWD's setInlineStyle('x', …)); null where it is found while the ad runs.
 */
export interface ScriptHits {
  /** A declaration list, read as cssText and style attributes are. */
  list: (src: Source, where: Where, id: string | null) => void;
  /** The styles string of GWD's setInlineStyle(). */
  inline: (src: Source, where: Where, id: string | null) => void;
  /** style.setProperty(name, value). */
  property: (name: string, src: Source, where: Where, id: string | null) => void;
  /** One property's whole value. */
  single: (prop: string, src: Source, where: Where, id: string | null) => void;
  /** A style it sets that cannot be checked here. */
  unknown: (target: string, message: string) => void;
  /** Classes it puts on or takes off an element: classList, className, setAttribute('class'). */
  classes?: (op: 'add' | 'remove' | 'toggle', names: string[], where: Where, id: string | null) => void;
}

/** style.fontSize -> font-size; vendor names (webkitTransform) get their leading dash. */
function cssName(member: string): string {
  if (member === 'cssFloat') return 'float';
  const name = member.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return /^(webkit|moz|ms|o)-/.test(name) ? `-${name}` : name;
}

/** Finds the CSS and classes a script's string literals set, with the element and the enclosing named function. */
export function scanScript(html: string, from: number, to: number, hits: ScriptHits) {
  const src = html.slice(from, to);
  const toks = jsTokens(src);
  const partner = brackets(toks);
  const str = (k: number) => toks[k]?.kind === 'str';
  const text = (k: number) => jsText(toks[k].text, from + toks[k].start);
  // A literal is the whole value only when the expression ends after it: nothing is concatenated,
  // called on, compared with it or picks it ("none" != c ? c : "auto"). A ':' ends the first branch
  // of a ?: it sits in. On a later line, a token that cannot continue the expression starts the
  // next statement.
  const whole = (k: number) => {
    const next = toks[k + 1];
    if (!str(k)) return false;
    if (!next) return true;
    const newLine = /[\n\r\u2028\u2029]/.test(src.slice(toks[k].end + 1, next.start));
    if (next.kind === 'punct') {
      if (';,)]}:'.includes(next.text)) return true;
      if (!newLine) return false;
      // The tokens are single characters, so '!=' and '++' come as two in a row.
      const after = toks[k + 2];
      const twice = (c: string) => isP(after, c) && after.start === next.end;
      if (next.text === '!') return !twice('='); // a '!=' or '!==' compares with it
      // A '++' or '--' on a new line always starts a new statement; '-->' there starts a comment.
      if (next.text === '+' || next.text === '-') return twice(next.text) && !(next.text === '-' && isP(toks[k + 3], '>') && toks[k + 3].start === after.end);
      return '{~'.includes(next.text);
    }
    if (!newLine) return false;
    if (next.kind === 'name') return next.text !== 'in' && next.text !== 'instanceof';
    if (next.kind === 'str') return src[next.start - 1] !== '`'; // a template right after it would be a tagged call
    return /^\d/.test(next.text);
  };
  const single = (arg: [number, number] | undefined) => (arg && arg[1] - arg[0] === 1 && str(arg[0]) ? arg[0] : -1);

  /** What a member call or assignment before toks[dot] styles: the id or selector it looked up, else the variable. */
  const objectBefore = (dot: number): string => {
    if (!isP(toks[dot], '.')) return 'an element';
    if (isP(toks[dot - 1], ')')) {
      const open = partner[dot - 1];
      if (/^(getElementById|querySelector)$/.test(toks[open - 1]?.text ?? '') && open + 2 === dot - 1 && str(open + 1)) return text(open + 1).text;
    }
    return memberChain(toks, dot - 1) ?? 'an element';
  };
  /** The id of the element a member call or assignment before toks[dot] looks up by id, else null. */
  const idBefore = (dot: number): string | null => {
    if (!isP(toks[dot], '.') || !isP(toks[dot - 1], ')')) return null;
    const open = partner[dot - 1];
    if (open + 2 !== dot - 1 || !str(open + 1)) return null;
    const arg = text(open + 1).text.trim();
    const fn = toks[open - 1]?.text;
    if (fn === 'getElementById') return arg || null;
    return fn === 'querySelector' && /^#[\w-]+$/.test(arg) ? arg.slice(1) : null;
  };
  const classNames = (k: number) => text(k).text.split(/\s+/).filter(Boolean);

  /** The string assigned by toks[k] ('=', or '+=' when `adds`), or -1. */
  const assigned = (k: number, adds: boolean) => {
    const v = isP(toks[k], '=') && !isP(toks[k + 1], '=') ? k + 1 : adds ? k + 2 : -1;
    return v >= 0 && whole(v) ? v : -1;
  };

  // Per open brace, the innermost named function around it: the handler.
  const handlers: (string | null)[] = [];
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t];
    if (isP(tok, '{')) handlers.push(functionName(toks, partner, t) ?? handlers[handlers.length - 1] ?? null);
    else if (isP(tok, '}')) handlers.pop();
    if (tok.kind !== 'name' || !SETTERS.has(tok.text)) continue;
    const handler = handlers[handlers.length - 1] ?? null;

    if (tok.text === 'setInlineStyle' && isP(toks[t + 1], '(')) {
      const [el, styles] = callArgs(toks, partner, t + 1);
      const k = single(styles);
      if (!el || el[1] <= el[0] || k < 0) continue;
      // A long expression is not spelled out: calls nested in each other would spell out the same text again and again.
      const words = el[1] - el[0] > 32 ? null : toks.slice(el[0], el[1]).map((w) => (w.kind === 'str' ? `'${w.text}'` : w.text));
      const id = single(el) >= 0 ? text(el[0]).text : null;
      const target = id ?? words?.join('') ?? 'an element';
      hits.inline(text(k), { target, via: 'setInlineStyle', handler }, id);
    } else if (tok.text === 'setAttribute' && isP(toks[t + 1], '(')) {
      const [name, styles] = callArgs(toks, partner, t + 1);
      const n = single(name);
      const k = single(styles);
      const attr = n < 0 ? '' : text(n).text.trim().toLowerCase();
      if (k < 0 || (attr !== 'style' && attr !== 'class')) continue;
      if (attr === 'class') hits.classes?.('add', classNames(k), { target: objectBefore(t - 1), via: "setAttribute('class')", handler }, idBefore(t - 1));
      else hits.list(text(k), { target: objectBefore(t - 1), via: "setAttribute('style')", handler }, idBefore(t - 1));
    } else if (tok.text === 'classList' && isP(toks[t - 1], '.') && isP(toks[t + 1], '.') && toks[t + 2]?.kind === 'name' && isP(toks[t + 3], '(')) {
      const method = toks[t + 2].text;
      if (!hits.classes || !['add', 'remove', 'toggle', 'replace'].includes(method)) continue;
      // toggle(name, force) and replace(old, new) read their class names from the first one or two.
      const all = callArgs(toks, partner, t + 3).map(single);
      const args = method === 'toggle' ? all.slice(0, 1) : method === 'replace' ? all.slice(0, 2) : all;
      if (!args.length || args.some((k) => k < 0)) continue;
      const where = { target: objectBefore(t - 1), via: `classList.${method}`, handler };
      const id = idBefore(t - 1);
      const names = args.map((k) => text(k).text.trim()).filter(Boolean);
      if (method === 'replace') {
        hits.classes('remove', names.slice(0, 1), where, id);
        hits.classes('add', names.slice(1, 2), where, id);
      } else hits.classes(method === 'toggle' ? 'toggle' : (method as 'add' | 'remove'), method === 'toggle' ? names.slice(0, 1) : names, where, id);
    } else if (tok.text === 'className' && isP(toks[t - 1], '.')) {
      // '=' puts these on (and takes the others off); '+=' adds them.
      const adds = isP(toks[t + 1], '+') && isP(toks[t + 2], '=');
      const k = assigned(t + 1, adds);
      if (k >= 0) hits.classes?.('add', classNames(k), { target: objectBefore(t - 1), via: 'className', handler }, idBefore(t - 1));
    } else if (tok.text === 'style' && isP(toks[t - 1], '.') && isP(toks[t + 1], '.') && toks[t + 2]?.kind === 'name') {
      const member = toks[t + 2].text;
      if (member === 'setProperty' && isP(toks[t + 3], '(')) {
        const [name, value] = callArgs(toks, partner, t + 3);
        const n = single(name);
        const k = single(value);
        if (n >= 0 && k >= 0) hits.property(text(n).text, text(k), { target: objectBefore(t - 1), via: 'style.setProperty', handler }, idBefore(t - 1));
        continue;
      }
      // '+=' adds to the value the element has then: whole declarations to cssText, but only the end of one to a property.
      const adds = isP(toks[t + 3], '+') && isP(toks[t + 4], '=');
      const k = assigned(t + 3, adds);
      if (k < 0) continue;
      // Named only for a hit, so that a long a.style.b.style… chain is walked once, not at every 'style'.
      const target = objectBefore(t - 1);
      const id = idBefore(t - 1);
      if (member === 'cssText') hits.list(text(k), { target, via: 'style.cssText', handler }, id);
      else if (adds) {
        const part = text(k).text;
        const shown = part.length > 40 ? `${part.slice(0, 40)}…` : part;
        hits.unknown(target, `style.${member} += "${shown}"${handler ? ` in ${handler}` : ''} adds to the value it has then, so whether browsers accept the result is not known here.`);
      } else hits.single(cssName(member), text(k), { target, via: `style.${member}`, handler }, id);
    }
  }
}
