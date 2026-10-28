// Parses the CSS inside an HTML document's <style> blocks and keeps absolute offsets into
// the HTML, so fixes can edit the source in place without disturbing GWD's formatting. Also reads
// the HTML's start tags, the way a browser finds them.

export interface Decl {
  prop: string; // lower-cased property name
  value: string; // trimmed, without the trailing ';'
  start: number; // offset of the property name
  end: number; // offset just past the ';' (or past the value when there is no ';')
  valueStart: number;
  valueEnd: number;
}

export interface StyleRule {
  kind: 'rule';
  media: string | null; // condition of the enclosing @media; null at top level
  selector: string;
  start: number; // offset of the selector
  open: number; // offset of '{'
  close: number; // offset of '}'
  decls: Decl[];
}

export interface KeyframeBlock {
  selector: string;
  open: number;
  close: number;
  decls: Decl[];
}

export interface KeyframesRule {
  kind: 'keyframes';
  media: string | null;
  name: string;
  start: number;
  open: number;
  close: number;
  frames: KeyframeBlock[];
}

export interface MediaBlock {
  media: string;
  start: number;
  open: number;
  close: number;
}

export interface StyleBlock {
  open: number; // first character of the <style> element's content
  close: number; // offset of '</style>'
}

export interface CssModel {
  rules: StyleRule[];
  keyframes: KeyframesRule[];
  media: MediaBlock[];
  styleBlocks: StyleBlock[];
}

/** Comments become spaces and string contents become 'x', keeping every offset intact. */
function mask(css: string): string {
  const out = css.split('');
  let i = 0;
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' ';
      i = stop;
    } else if (css.startsWith('<!--', i) || css.startsWith('-->', i)) {
      const len = css.startsWith('<!--', i) ? 4 : 3;
      for (let k = i; k < i + len; k++) out[k] = ' ';
      i += len;
    } else if (css[i] === '"' || css[i] === "'") {
      const quote = css[i];
      let k = i + 1;
      while (k < css.length && css[k] !== quote && css[k] !== '\n') {
        if (css[k] === '\\') {
          out[k] = 'x';
          k++;
        }
        if (k < css.length) out[k] = 'x';
        k++;
      }
      i = k + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function matchBrace(m: string, open: number, limit: number): number {
  let depth = 0;
  for (let k = open; k < limit; k++) {
    if (m[k] === '{') depth++;
    else if (m[k] === '}' && --depth === 0) return k;
  }
  return limit - 1;
}

function parseDecls(m: string, orig: string, from: number, to: number, base: number): Decl[] {
  const decls: Decl[] = [];
  let segStart = from;
  let depth = 0;
  const flush = (segEnd: number, hasSemi: boolean) => {
    let colon = segStart;
    while (colon < segEnd && m[colon] !== ':') colon++;
    if (colon >= segEnd) return;
    let s = segStart;
    while (s < colon && /\s/.test(m[s])) s++;
    const prop = orig.slice(s, colon).trim().toLowerCase();
    if (!prop) return;
    let vs = colon + 1;
    while (vs < segEnd && /\s/.test(orig[vs])) vs++;
    let ve = segEnd;
    while (ve > vs && /\s/.test(orig[ve - 1])) ve--;
    decls.push({
      prop,
      value: orig.slice(vs, ve),
      start: base + s,
      end: base + (hasSemi ? segEnd + 1 : ve),
      valueStart: base + vs,
      valueEnd: base + ve,
    });
  };
  for (let k = from; k < to; k++) {
    const c = m[k];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) {
      flush(k, true);
      segStart = k + 1;
    }
  }
  flush(to, false);
  return decls;
}

// Deeper @media nesting is never real CSS; past it, blocks are skipped rather than overflow the stack.
const MAX_NESTING = 16;

function parseBlock(m: string, orig: string, from: number, to: number, base: number, media: string | null, out: CssModel, depth = 0) {
  let i = from;
  while (i < to) {
    const open = m.indexOf('{', i);
    if (open < 0 || open >= to) return;
    let ps = i;
    const head = m.slice(i, open);
    const cut = Math.max(head.lastIndexOf(';'), head.lastIndexOf('}'));
    if (cut >= 0) ps = i + cut + 1;
    while (ps < open && /\s/.test(m[ps])) ps++;
    const prelude = orig.slice(ps, open).trim();
    const close = matchBrace(m, open, to);
    if (/^@media\b/i.test(prelude)) {
      if (depth < MAX_NESTING) {
        const cond = prelude.slice(6).trim();
        out.media.push({ media: cond, start: base + ps, open: base + open, close: base + close });
        parseBlock(m, orig, open + 1, close, base, cond, out, depth + 1);
      }
    } else if (/^@(-webkit-)?keyframes\b/i.test(prelude)) {
      const frames: KeyframeBlock[] = [];
      let j = open + 1;
      while (j < close) {
        const fo = m.indexOf('{', j);
        if (fo < 0 || fo >= close) break;
        const fc = matchBrace(m, fo, close);
        frames.push({ selector: orig.slice(j, fo).trim(), open: base + fo, close: base + fc, decls: parseDecls(m, orig, fo + 1, fc, base) });
        j = fc + 1;
      }
      out.keyframes.push({ kind: 'keyframes', media, name: prelude.split(/\s+/)[1] ?? '', start: base + ps, open: base + open, close: base + close, frames });
    } else if (!prelude.startsWith('@')) {
      out.rules.push({ kind: 'rule', media, selector: prelude, start: base + ps, open: base + open, close: base + close, decls: parseDecls(m, orig, open + 1, close, base) });
    }
    i = close + 1;
  }
}

/** The <style> elements a browser applies: not in comments, nor in <noscript> or another raw text element. */
export function parseCss(html: string): CssModel {
  const out: CssModel = { rules: [], keyframes: [], media: [], styleBlocks: [] };
  for (const tag of startTags(html)) {
    if (tag.name !== 'style' || !tag.content || !html.startsWith('</', tag.content.end)) continue;
    const { start: open, end: close } = tag.content;
    out.styleBlocks.push({ open, close });
    const orig = html.slice(open, close);
    parseBlock(mask(orig), orig, 0, orig.length, open, null, out);
  }
  return out;
}

export interface Attr {
  value: string; // raw, as written
  start: number;
  end: number;
}

export interface Tag {
  name: string; // lower case
  attrs: Map<string, Attr>;
  /** For raw text elements such as <script>: where their content is. */
  content?: { start: number; end: number };
}

// Elements whose content is not markup, so it holds no tags or attributes. The ad runs with
// scripting on, so <noscript> is one of them.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'iframe', 'noembed', 'noframes']);
const COMMENT_END = /--!?>/g;

/** Start tags in source order, skipping comments and the content of raw text elements. */
export function startTags(html: string): Tag[] {
  const tags: Tag[] = [];
  const n = html.length;
  let i = html.indexOf('<');
  while (i >= 0 && i < n) {
    if (html.startsWith('<!--', i)) {
      // As in browsers, <!--> and <!---> are whole comments, and --!> also ends one.
      let end = n;
      if (html[i + 4] === '>') end = i + 5;
      else if (html.startsWith('->', i + 4)) end = i + 6;
      else {
        COMMENT_END.lastIndex = i + 4;
        if (COMMENT_END.exec(html)) end = COMMENT_END.lastIndex;
      }
      i = html.indexOf('<', end);
      continue;
    }
    const name = /^[a-zA-Z][^\s/>]*/.exec(html.slice(i + 1, i + 64))?.[0];
    if (!name) {
      i = html.indexOf('<', i + 1);
      continue;
    }
    const tag: Tag = { name: name.toLowerCase(), attrs: new Map() };
    let k = i + 1 + name.length;
    while (k < n) {
      while (k < n && /[\s/]/.test(html[k])) k++;
      if (k >= n || html[k] === '>') break;
      let e = k + 1;
      while (e < n && !/[\s/>=]/.test(html[e])) e++;
      const attr = html.slice(k, e).toLowerCase();
      let value: Attr = { value: '', start: e, end: e };
      let j = e;
      while (j < n && /\s/.test(html[j])) j++;
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, j + 1);
          const end = close < 0 ? n : close;
          value = { value: html.slice(j + 1, end), start: j + 1, end };
          e = end + 1;
        } else {
          let end = j;
          while (end < n && !/[\s>]/.test(html[end])) end++;
          value = { value: html.slice(j, end), start: j, end };
          e = end;
        }
      }
      if (!tag.attrs.has(attr)) tag.attrs.set(attr, value); // like browsers, the first one wins
      k = e;
    }
    i = k + 1;
    if (RAW_TEXT.has(tag.name)) {
      const close = new RegExp(`</${tag.name}[\\s/>]`, 'gi');
      close.lastIndex = i;
      const end = close.exec(html)?.index ?? n;
      tag.content = { start: i, end };
      i = end;
    }
    tags.push(tag);
    i = html.indexOf('<', i);
  }
  return tags;
}

/** Declarations in a bare declaration list, such as a style="" value; offsets are into `text`. */
export function parseDeclList(text: string): Decl[] {
  return parseDecls(mask(text), text, 0, text.length, 0);
}

/**
 * The served size key GWD wrote a media condition for: "(width: 300px) and (height: 250px)" ->
 * "300x250", and a min/max range (with its orientation) -> "300x250:320x480:l". Null otherwise.
 */
export function sizeOfMedia(media: string | null): string | null {
  if (!media) return null;
  const num = (feature: string) => new RegExp(`\\(\\s*${feature}\\s*:\\s*(\\d+(?:\\.\\d+)?)(?:px)?\\s*\\)`).exec(media)?.[1];
  const [w, h] = [num('width'), num('height')];
  if (w && h) return `${w}x${h}`;
  const [minW, minH, maxW, maxH] = ['min-width', 'min-height', 'max-width', 'max-height'].map(num);
  if (!minW || !minH || !maxW || !maxH) return null;
  const orientation = /\(\s*orientation\s*:\s*(landscape|portrait)\s*\)/.exec(media)?.[1];
  return `${minW}x${minH}:${maxW}x${maxH}${orientation ? `:${orientation[0]}` : ''}`;
}

/** A selector made of exactly one class, e.g. ".gwd-p-1lgf". */
export function singleClass(selector: string): string | null {
  const m = /^\.(-?[_a-zA-Z][\w-]*)$/.exec(selector.trim());
  return m ? m[1] : null;
}

/**
 * The class a GWD rule styles its element through: ".gwd-p-1lgf", or for an element of a GWD group,
 * '[data-gwd-group="Perks"] .gwd-grp-k2.gwd-span-one', where it is the class beside the group's.
 */
export function elementClass(selector: string): string | null {
  const single = singleClass(selector);
  if (single) return single;
  const m = /^\[data-gwd-group="[^"\\]*"\]\s+\.(-?[_a-zA-Z][\w-]*)\.(-?[_a-zA-Z][\w-]*)$/.exec(selector.trim());
  const own = m ? [m[1], m[2]].filter((c) => !c.startsWith('gwd-grp-')) : [];
  return own.length === 1 ? own[0] : null;
}

/** Class and id tokens of the last compound selector: ".a #b .c.d" -> ".c.d". */
export function lastCompound(selector: string): string {
  const parts = selector.trim().split(/\s*[\s>+~]\s*/);
  return parts[parts.length - 1] ?? '';
}

export function frameOffset(selector: string): number {
  const first = selector.split(',')[0].trim().toLowerCase();
  if (first === 'from') return 0;
  if (first === 'to') return 100;
  return parseFloat(first) || 0;
}
