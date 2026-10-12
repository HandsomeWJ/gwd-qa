// Parses the CSS inside an HTML document's <style> blocks and keeps absolute offsets into
// the HTML, so fixes can edit the source in place without disturbing GWD's formatting.

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
    const colon = m.indexOf(':', segStart);
    if (colon < 0 || colon >= segEnd) return;
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

function parseBlock(m: string, orig: string, from: number, to: number, base: number, media: string | null, out: CssModel) {
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
      const cond = prelude.slice(6).trim();
      out.media.push({ media: cond, start: base + ps, open: base + open, close: base + close });
      parseBlock(m, orig, open + 1, close, base, cond, out);
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

export function parseCss(html: string): CssModel {
  const out: CssModel = { rules: [], keyframes: [], media: [], styleBlocks: [] };
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    const open = match.index + match[0].indexOf('>') + 1;
    const close = open + match[1].length;
    out.styleBlocks.push({ open, close });
    const orig = html.slice(open, close);
    parseBlock(mask(orig), orig, 0, orig.length, open, null, out);
  }
  return out;
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
