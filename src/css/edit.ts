// Text edits against the HTML source. Every edit keeps GWD's layout: one declaration per
// line, and the indentation already used around the edit.

import type { Decl } from './parse';

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  for (let k = 1; k < sorted.length; k++) {
    const later = sorted[k - 1];
    const earlier = sorted[k];
    if (earlier.end > later.start && !(earlier.start === earlier.end && later.start === later.end)) {
      throw new Error(`Overlapping edits at ${earlier.start}-${earlier.end} and ${later.start}-${later.end}`);
    }
  }
  let out = src;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function lineStart(src: string, at: number): number {
  return src.lastIndexOf('\n', at - 1) + 1;
}

function indentAt(src: string, at: number): string {
  const ls = lineStart(src, at);
  return /^[ \t]*/.exec(src.slice(ls, at))?.[0] ?? '';
}

/** Detects the indent step a stylesheet uses (GWD writes two spaces). */
function indentUnit(src: string, open: number, close: number): string {
  const body = src.slice(open, close);
  const outer = indentAt(src, open);
  const m = /\n([ \t]+)\S/.exec(body);
  if (m && m[1].length > outer.length && m[1].startsWith(outer)) return m[1].slice(outer.length);
  return '  ';
}

export function setValue(decl: Decl, value: string): Edit {
  return { start: decl.valueStart, end: decl.valueEnd, text: value };
}

/** Removes a declaration; when it sits alone on its line, the whole line goes. */
export function removeDecl(src: string, decl: Decl): Edit {
  const ls = lineStart(src, decl.start);
  const lineEnd = src.indexOf('\n', decl.end);
  const before = src.slice(ls, decl.start);
  const after = src.slice(decl.end, lineEnd < 0 ? src.length : lineEnd);
  if (!before.trim() && !after.trim() && lineEnd >= 0) return { start: ls, end: lineEnd + 1, text: '' };
  let end = decl.end;
  while (end < src.length && (src[end] === ' ' || src[end] === '\t')) end++;
  return { start: decl.start, end, text: '' };
}

/**
 * Appends "prop: value;" as the last declaration of a rule (or keyframe) body. Declarations
 * in `skip` may be deleted by another fix, so the new line never anchors to them.
 */
export function insertDecl(src: string, block: { open: number; close: number; decls: Decl[] }, declText: string, skip?: Set<Decl>): Edit {
  const outer = indentAt(src, block.open);
  const inner = outer + indentUnit(src, block.open, block.close);
  const kept = skip ? block.decls.filter((d) => !skip.has(d)) : block.decls;
  const last = kept[kept.length - 1];
  if (last) {
    const indent = indentAt(src, last.start) || inner;
    const needsSemi = src[last.end - 1] !== ';';
    return { start: last.end, end: last.end, text: `${needsSemi ? ';' : ''}\n${indent}${declText}` };
  }
  const body = src.slice(block.open + 1, block.close);
  if (!body.includes('\n')) {
    return { start: block.open + 1, end: block.close, text: `\n${inner}${declText}\n${outer}` };
  }
  return { start: block.open + 1, end: block.open + 1, text: `\n${inner}${declText}` };
}

/** Indentation of the line an offset sits on. */
export function lineIndent(src: string, at: number): string {
  return indentAt(src, at);
}

/**
 * Combines edits from several fixes. Where an edit touches text another fix deletes
 * (for example a fade fix on a keyframe line that the keyframes fix removes), the deletion wins.
 */
export function mergeEdits(edits: Edit[]): Edit[] {
  const deletions = edits.filter((e) => e.text === '' && e.end > e.start);
  const inside = (e: Edit, d: Edit) => e !== d && e.start >= d.start && e.end <= d.end && (e.end > e.start || (e.start > d.start && e.start < d.end));
  const seen = new Set<string>();
  return edits.filter((e) => {
    const key = `${e.start}:${e.end}:${e.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !deletions.some((d) => inside(e, d));
  });
}

/**
 * Appends a new rule at the end of a container: an @media block (pass its braces) or a
 * <style> element's content (pass its content range, with open pointing before the content).
 */
export function insertRule(
  src: string,
  container: { open: number; close: number },
  selector: string,
  declTexts: string[],
  isStyleElement = false,
): Edit {
  const contentStart = isStyleElement ? container.open : container.open + 1;
  const body = src.slice(contentStart, container.close);
  const firstRule = /\n([ \t]*)\S/.exec(body);
  const containerIndent = isStyleElement ? indentAt(src, container.close) : indentAt(src, container.open);
  const ruleIndent = firstRule ? firstRule[1] : containerIndent + '  ';
  const declIndent = ruleIndent + '  ';
  const rule = `${ruleIndent}${selector} {\n${declTexts.map((d) => `${declIndent}${d}`).join('\n')}\n${ruleIndent}}`;
  // Only a blank body is replaced: a block written on one line keeps the rules it holds.
  if (!body.trim()) {
    return { start: contentStart, end: container.close, text: `\n${rule}\n${containerIndent}` };
  }
  const closeLine = lineStart(src, container.close);
  if (!src.slice(closeLine, container.close).trim()) {
    return { start: closeLine, end: closeLine, text: `${rule}\n` };
  }
  return { start: container.close, end: container.close, text: `\n${rule}\n${containerIndent}` };
}
