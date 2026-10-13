// Finds CSS values a browser rejects, and so silently ignores, such as opacity: 0,3 typed with a
// decimal comma. Reads <style> blocks, style="" attributes, and the styles that GWD events and
// scripts set: setInlineStyle(), style.cssText, setAttribute('style'), style.<prop> and
// style.setProperty().

import { parseDeclList, sizeOfMedia, startTags, type CssModel, type Decl, type Tag } from '../css/parse';
import { describeSize } from '../sizes';

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
  prop: string;
  value: string; // as the browser reads it, without !important
  start: number; // the value's source text in the HTML
  end: number;
  /** The value with its decimal commas made points, when that makes it valid. */
  fixed: string | null;
}

type Where = Pick<CssValueIssue, 'target' | 'via' | 'handler'>;

// Starts at the '!', so a long run of spaces in a value costs no backtracking.
const IMPORTANT = /!\s*important$/i;
const PROP = /^-{0,2}[a-z][a-z0-9-]*$/;
const JS_TYPE = /^((text|application)\/(x-)?(java|ecma)script|text\/jscript|module)$/i;
// GWD's components define its elements; an ad's own scripts never do.
const GWD_ELEMENT = /\b(customElements\.define|document\.registerElement)\(\s*["']gwd-/;

const withoutImportant = (value: string) => {
  const m = IMPORTANT.exec(value);
  return m ? value.slice(0, m.index).trimEnd() : value;
};

const pointDecimals = (s: string) => s.replace(/(?<=\d),(?=\d)/g, '.');

/** pointDecimals() outside brackets only, so that function arguments written without spaces keep their commas. */
function pointTopDecimals(s: string): string {
  let out = '';
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    out += c === ',' && !depth && /\d/.test(s[k - 1] ?? '') && /\d/.test(s[k + 1] ?? '') ? '.' : c;
  }
  return out;
}

/**
 * GWD's own runtime, inlined into the HTML: a component (data-source, data-exports-type), the
 * events support or another runtime file. The ad cannot change it, and it compares and picks
 * values rather than setting them ("none" != c ? c : "auto").
 */
function gwdRuntime(tag: Tag, content: string): boolean {
  const attrs = [...tag.attrs.keys()];
  return (
    attrs.some((a) => a === 'data-source' || a === 'data-exports-type' || /^gwd-[\w-]+-runtime$/.test(a)) ||
    tag.attrs.get('gwd-events')?.value.trim().toLowerCase() === 'support' ||
    GWD_ELEMENT.test(content)
  );
}

/** What is wrong with a value, and where a script or a style attribute sets it. */
export function describeIssue(v: CssValueIssue): string {
  const where = v.via === 'style attribute'
    ? ' It is in its style attribute.'
    : v.via ? ` ${v.via} sets it${v.handler ? ` in ${v.handler}` : ''}.` : '';
  return `"${v.prop}: ${v.value}" is not valid CSS, so browsers ignore it${v.fixed ? `; write ${v.fixed}` : ''}.${where}`;
}

export function cssValueIssues(html: string, css: CssModel, valid: CssValidator = cssSupports): CssValueIssue[] {
  const issues: CssValueIssue[] = [];
  const known = new Map<string, boolean>();
  const check = (prop: string, value: string, start: number, end: number, where: Where) => {
    // Vendor and unknown properties are skipped: a browser that does not know one ignores it by design.
    if (prop.startsWith('-') || !value) return;
    if (!known.has(prop)) known.set(prop, valid(prop, 'inherit'));
    if (!known.get(prop) || valid(prop, value)) return;
    // Every decimal comma made a point; failing that, only those outside functions, as in "1,5px rgba(0,0,0,0.5)".
    const all = pointDecimals(value);
    const top = pointTopDecimals(value);
    const fixed = all !== value && valid(prop, all) ? all : top !== value && top !== all && valid(prop, top) ? top : null;
    issues.push({ ...where, prop, value, start, end, fixed });
  };
  /** `at` maps an offset in the text the declarations were read from to the HTML. */
  const checkDecls = (decls: Decl[], where: Where, at: (i: number) => number = (i) => i) => {
    for (const d of decls) {
      const value = withoutImportant(d.value);
      check(d.prop, value, at(d.valueStart), at(d.valueStart + value.length), where);
    }
  };

  const inMedia = (media: string | null) => (media ? ` in ${describeSize(sizeOfMedia(media) ?? media)}` : '');
  const inBlock = (target: string): Where => ({ target, via: '', handler: null });
  for (const rule of css.rules) checkDecls(rule.decls, inBlock(rule.selector + inMedia(rule.media)));
  for (const block of css.keyframes) {
    for (const frame of block.frames) checkDecls(frame.decls, inBlock(`${block.name} ${frame.selector}${inMedia(block.media)}`));
  }

  for (const tag of startTags(html)) {
    const style = tag.attrs.get('style');
    if (style) {
      const src = htmlText(style.value, style.start);
      checkDecls(parseDeclList(src.text), { target: tagLabel(tag), via: 'style attribute', handler: null }, (i) => src.at[i]);
    }
    const type = tag.attrs.get('type')?.value.trim() || 'text/javascript';
    if (tag.name !== 'script' || !tag.content || tag.attrs.has('src') || tag.attrs.has('gwd-served-sizes') || !JS_TYPE.test(type)) continue;
    const { start, end } = tag.content;
    if (gwdRuntime(tag, html.slice(start, end))) continue;
    scanScript(html, start, end, {
      list: (src, where) => {
        const decls = declList(src.text);
        if (decls) checkDecls(decls, where, (i) => src.at[i]);
      },
      single: (prop, src, where) => {
        const value = src.text.trim();
        const lead = src.text.length - src.text.trimStart().length;
        check(prop, value, src.at[lead], src.at[lead + value.length], where);
      },
    });
  }
  return issues.sort((a, b) => a.start - b.start);
}

/** The declarations, when the whole text is a declaration list ("opacity: 0; color: red;"); else null. */
function declList(text: string): Decl[] | null {
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

/** Text as the browser reads it, with the source offset of each character (and one past the end). */
interface Source {
  text: string;
  at: number[];
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

const ENTITY = /&(#x[\da-f]+|#\d+|[a-z]+);/gi;
// Maps, so that a name such as "constructor" finds nothing rather than Object's own members.
const NAMED = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', '\u00a0']]);
const JS_ESCAPE = /\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g;
const JS_CHARS = new Map([
  ['n', '\n'], ['t', '\t'], ['r', '\r'], ['b', '\b'], ['f', '\f'], ['v', '\v'], ['0', '\0'],
  ['\n', ''], ['\r', ''], ['\r\n', ''], ['\u2028', ''], ['\u2029', ''],
]);

const fromCode = (code: number, fallback: string) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback);

function htmlText(raw: string, base: number): Source {
  return decode(raw, base, ENTITY, ([all, name]) => {
    if (name[0] !== '#') return NAMED.get(name.toLowerCase()) ?? all;
    return fromCode(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10), all);
  });
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
const SETTERS = new Set(['setInlineStyle', 'setAttribute', 'style']);

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
  const chain: string[] = [];
  for (let j = k - 2; toks[j]?.kind === 'name'; j -= 2) {
    chain.unshift(toks[j].text);
    if (!isP(toks[j - 1], '.')) break;
  }
  return chain.length ? chain.join('.') : null;
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

interface ScriptHits {
  list: (src: Source, where: Where) => void;
  single: (prop: string, src: Source, where: Where) => void;
}

/** style.fontSize -> font-size; vendor names (webkitTransform) get their leading dash. */
function cssName(member: string): string {
  if (member === 'cssFloat') return 'float';
  const name = member.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return /^(webkit|moz|ms|o)-/.test(name) ? `-${name}` : name;
}

/** Finds the CSS a script's string literals set, with the element and the enclosing named function. */
function scanScript(html: string, from: number, to: number, hits: ScriptHits) {
  const src = html.slice(from, to);
  const toks = jsTokens(src);
  const partner = brackets(toks);
  const str = (k: number) => toks[k]?.kind === 'str';
  const text = (k: number) => jsText(toks[k].text, from + toks[k].start);
  // A literal is the whole value only when the expression ends after it: nothing is concatenated,
  // called on, compared with it or picks it ("none" != c ? c : "auto"). A name on a later line
  // starts the next statement.
  const whole = (k: number) => {
    const next = toks[k + 1];
    if (!str(k)) return false;
    if (!next) return true;
    if (next.kind === 'punct') return ';,)]}'.includes(next.text);
    return next.kind === 'name' && next.text !== 'in' && next.text !== 'instanceof' && /[\n\r\u2028\u2029]/.test(src.slice(toks[k].end + 1, next.start));
  };
  const single = (arg: [number, number] | undefined) => (arg && arg[1] - arg[0] === 1 && str(arg[0]) ? arg[0] : -1);

  /** What a member call or assignment before toks[dot] styles: the id or selector it looked up, else the variable. */
  const objectBefore = (dot: number): string => {
    if (!isP(toks[dot], '.')) return 'an element';
    if (isP(toks[dot - 1], ')')) {
      const open = partner[dot - 1];
      if (/^(getElementById|querySelector)$/.test(toks[open - 1]?.text ?? '') && open + 2 === dot - 1 && str(open + 1)) return text(open + 1).text;
    }
    const chain: string[] = [];
    for (let k = dot - 1; toks[k]?.kind === 'name'; k -= 2) {
      chain.unshift(toks[k].text);
      if (!isP(toks[k - 1], '.')) break;
    }
    return chain.join('.') || 'an element';
  };

  /** The string assigned by toks[k] ('=' or '+='), or -1. */
  const assigned = (k: number) => {
    const v = isP(toks[k], '=') && !isP(toks[k + 1], '=') ? k + 1 : isP(toks[k], '+') && isP(toks[k + 1], '=') ? k + 2 : -1;
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
      const target = single(el) >= 0 ? text(el[0]).text : words?.join('') ?? 'an element';
      hits.list(text(k), { target, via: 'setInlineStyle', handler });
    } else if (tok.text === 'setAttribute' && isP(toks[t + 1], '(')) {
      const [name, styles] = callArgs(toks, partner, t + 1);
      const n = single(name);
      const k = single(styles);
      if (n < 0 || k < 0 || text(n).text.trim().toLowerCase() !== 'style') continue;
      hits.list(text(k), { target: objectBefore(t - 1), via: "setAttribute('style')", handler });
    } else if (tok.text === 'style' && isP(toks[t - 1], '.') && isP(toks[t + 1], '.') && toks[t + 2]?.kind === 'name') {
      const member = toks[t + 2].text;
      if (member === 'setProperty' && isP(toks[t + 3], '(')) {
        const [name, value] = callArgs(toks, partner, t + 3);
        const n = single(name);
        const k = single(value);
        if (n >= 0 && k >= 0) hits.single(text(n).text.trim().toLowerCase(), text(k), { target: objectBefore(t - 1), via: 'style.setProperty', handler });
        continue;
      }
      const k = assigned(t + 3);
      if (k < 0) continue;
      // Named only for a hit, so that a long a.style.b.style… chain is walked once, not at every 'style'.
      const target = objectBefore(t - 1);
      if (member === 'cssText') hits.list(text(k), { target, via: 'style.cssText', handler });
      else hits.single(cssName(member), text(k), { target, via: `style.${member}`, handler });
    }
  }
}
