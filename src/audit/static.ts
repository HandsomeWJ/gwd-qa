// Source-level checks: what the HTML alone can prove, plus the copy list for a typo review.

import { frameOffset, lastCompound, parseCss, type CssModel, type Decl, type KeyframesRule } from '../css/parse';
import { checkCssValues, cssSupports, describeIssue, type AdFiles, type CssValidator, type CssValueIssue } from './cssvalues';
import { clickAudit, type ClickReport } from './clicks';
import { fileFindings, fileRefs, type FileRef } from './package';
import { stackAdaptAudit, stackAdaptFindings, type StackAdaptReport } from './stackadapt';
import type { CopyItem, Finding } from './types';

export const POSITION = ['top', 'left', 'right', 'bottom'];

/** Where text that fades in must start: an opacity below it (0, 0.001) is flagged and raised to it. */
export const FADE_START = '0.01';
/**
 * The QA checklist's other wrong start (2026-11-13: "not 0 or 0.1"). A fade from above FADE_START up
 * to this is flagged but never changed: starting lower would make the text fainter at the start.
 */
export const VISIBLE_START = 0.1;

/**
 * The properties a keyframes block holds at one value throughout (animation-timing-function aside):
 * the first and last keyframes set them and every keyframe that sets them sets that value, as a
 * keyframe between them that leaves one out interpolates between equal values.
 */
export function heldInBlock(block: KeyframesRule): string[] {
  if (block.frames.length < 2) return [];
  const frames = block.frames.map((f) => new Map(f.decls.map((d) => [d.prop, d.value])));
  const props = [...new Set(frames.flatMap((f) => [...f.keys()]))].filter((p) => p !== 'animation-timing-function');
  const at = (offset: number) => block.frames.flatMap((f, i) => (f.selector.split(',').some((s) => frameOffset(s) === offset) ? [i] : []));
  const [starts, ends] = [at(0), at(100)];
  const values = (p: string) => frames.filter((f) => f.has(p)).map((f) => f.get(p));
  return props.filter((p) => starts.some((i) => frames[i].has(p)) && ends.some((i) => frames[i].has(p)) && new Set(values(p)).size === 1);
}

/** An opacity value as a number, percentages included; NaN for one it cannot read. */
const opacityValue = (v: string) => (/%\s*$/.test(v) ? parseFloat(v) / 100 : parseFloat(v));
const startsTooLow = (d: Decl) => opacityValue(d.value) < parseFloat(FADE_START);
const startsVisible = (d: Decl) => opacityValue(d.value) > parseFloat(FADE_START) && opacityValue(d.value) <= VISIBLE_START;
/** Whether a keyframe of the block raises opacity above `v`: a fade in from a start of v. */
const rises = (block: KeyframesRule, v: number) => block.frames.some((f) => f.decls.some((d) => d.prop === 'opacity' && opacityValue(d.value) > v));
const VISIBLE_HINT = `Starting at ${FADE_START} instead makes the text fainter at the start, so change it in GWD if that is right.`;
// Words in an id or class that make an element a call to action: SA_cta_1, cta-text, ctaButton.
const CTA = /(^|[^a-z])cta/i;

export interface StaticReport {
  sizes: string[];
  environment: string | null;
  findings: Finding[];
  copy: CopyItem[];
  /** Opacity declarations that make text start below FADE_START; fixable by writing FADE_START. */
  fadeDecls: Decl[];
  /**
   * Keyframes properties that never change, per block, and what runs them; removable once checked safe.
   * `unused` where nothing mentions the name but its own @keyframes rules, so nothing runs it.
   */
  unchanged: { block: KeyframesRule; props: string[]; subjects: Subjects | null; unused: boolean }[];
  /** CSS values the browser ignores; the ones that only need decimal points are fixable. */
  cssValues: CssValueIssue[];
  /** StackAdapt's click scripts: which load, and where a missing one goes. */
  stackAdapt: StackAdaptReport;
  /** Text fades that start visibly, from above FADE_START up to VISIBLE_START: for a person to change. */
  fadeVisible: { target: string; value: string; decl?: Decl }[];
  /** What the ad makes clickable, for the pointer cursor check. */
  clicks: ClickReport;
  /** Every file the HTML and its own CSS and scripts load, and whether the package has it; empty without the ad's files. */
  files: FileRef[];
}

/**
 * The elements a keyframes name runs on, as the planner names them. `effects` is set where one has a
 * GWD text effect, whose runtime sets its styles while the ad runs.
 */
export interface Subjects {
  ids: string[];
  classes: string[];
  tags: string[];
  effects: boolean;
}

export function label(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const cls = [...el.classList].filter((c) => !c.startsWith('gwd-play') && !c.startsWith('gwd-pause'));
  return cls.length ? `${tag}.${cls.join('.')}` : tag;
}

export function hasDirectText(el: Element): boolean {
  return [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
}

/** GWD's group definitions, by name: when the ad runs, GWD fills each group that names one with a copy. */
function groupDefs(doc: Document): Map<string, Element> {
  const defs = new Map<string, Element>();
  for (const t of doc.querySelectorAll('template')) {
    for (const def of t.content.querySelectorAll('[data-gwd-group-def]')) defs.set(def.getAttribute('data-gwd-group-def') ?? '', def);
  }
  return defs;
}

/** Whether it shows text: its own, or inside it, including what the GWD groups in it are filled with. */
function holdsText(el: Element, defs: Map<string, Element>): boolean {
  const filled = [el, ...el.querySelectorAll('[data-gwd-group]')].map((g) => defs.get(g.getAttribute('data-gwd-group') ?? ''));
  return [el, ...filled].some((e) => !!e && /\S/.test(e.textContent ?? ''));
}

/** A call to action or a GWD text effect, which the 0.01 fade start does not apply to (QA checklist, 2026-11-13). */
function fadeExempt(el: Element): boolean {
  return el.tagName.toLowerCase() === 'button' || el.hasAttribute('gwd-text-effect') || CTA.test(el.id) || [...el.classList].some((c) => CTA.test(c));
}

/** Whether text in it, below it, sits in no exempt element. */
function freeText(node: Node): boolean {
  for (const child of node.childNodes) {
    if (child.nodeType === 3 && /\S/.test(child.textContent ?? '')) return true;
    if (child.nodeType === 1 && !fadeExempt(child as Element) && !(child as Element).closest('script, style') && freeText(child)) return true;
  }
  return false;
}

/**
 * Whether it shows text the fade rule covers: as holdsText, leaving out what is in a CTA or a text
 * effect, itself, around it, or inside it.
 */
function fadesText(el: Element, defs: Map<string, Element>): boolean {
  for (let x: Element | null = el; x; x = x.parentElement) if (fadeExempt(x)) return false;
  if (freeText(el)) return true;
  // The GWD groups in it, outside exempt elements, filled with their definitions' content.
  const groups = [el, ...el.querySelectorAll('[data-gwd-group]')].filter((g) => {
    for (let x: Element | null = g; x && x !== el.parentElement; x = x.parentElement) if (fadeExempt(x)) return false;
    return g.hasAttribute('data-gwd-group');
  });
  return groups.some((g) => {
    const def = defs.get(g.getAttribute('data-gwd-group') ?? '');
    return !!def && !fadeExempt(def) && freeText(def);
  });
}

/** The element a GWD event action names: by its id, or by a group's id and its id in the group. */
function byGwdRef(doc: Document, defs: Map<string, Element>, ref: string): Element[] {
  const [id, ...inGroups] = ref.trim().split(/\s+/);
  let el: Element | null | undefined = id ? doc.getElementById(id) : null;
  for (const step of inGroups) {
    const def: Element | undefined = el ? defs.get(el.getAttribute('data-gwd-group') ?? '') : undefined;
    el = def ? [...def.querySelectorAll('[data-gwd-grp-id]')].find((e) => e.getAttribute('data-gwd-grp-id') === step) : null;
  }
  return el ? [el] : [];
}

/** The elements a selector matches, on the page and in GWD's group definitions. */
function query(doc: Document, selector: string): Element[] {
  try {
    return [doc, ...[...doc.querySelectorAll('template')].map((t) => t.content)].flatMap((root) => [...root.querySelectorAll(selector)]);
  } catch {
    return [];
  }
}

export function servedSizes(doc: Document, css: CssModel): string[] {
  const script = doc.querySelector('script[gwd-served-sizes]');
  if (script?.textContent) {
    try {
      const sizes = JSON.parse(script.textContent);
      if (Array.isArray(sizes) && sizes.length) return sizes.map(String);
    } catch {
      // fall through to the page size
    }
  }
  const meta = doc.querySelector('meta[name="ad.size"]')?.getAttribute('content') ?? '';
  const mw = /width=(\d+)/.exec(meta);
  const mh = /height=(\d+)/.exec(meta);
  if (mw && mh) return [`${mw[1]}x${mh[1]}`];
  const page = css.rules.find((r) => r.media === null && r.selector === '.gwd-page-size');
  const w = page?.decls.find((d) => d.prop === 'width')?.value;
  const h = page?.decls.find((d) => d.prop === 'height')?.value;
  return w && h ? [`${parseFloat(w)}x${parseFloat(h)}`] : [];
}

/** `ad` has the files the HTML loads, whose stylesheets and scripts the CSS values check reads too. */
export function staticAudit(html: string, css: CssModel = parseCss(html), valid: CssValidator = cssSupports, ad?: AdFiles): StaticReport {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const defs = groupDefs(doc);
  const findings: Finding[] = [];
  const fadeDecls: Decl[] = [];
  const fadeVisible: StaticReport['fadeVisible'] = [];
  const unchanged: StaticReport['unchanged'] = [];
  const { issues: cssValues, unknown } = checkCssValues(html, css, valid, ad);
  // The browser ignores an invalid opacity, so it never starts a fade at 0.
  const ignored = new Set(cssValues.filter((v) => !v.file).map((v) => v.start));
  const opacityOf = (decls: Decl[]) => decls.filter((d) => d.prop === 'opacity' && !ignored.has(d.valueStart)).pop();

  const environment = doc.querySelector('meta[name="environment"]')?.getAttribute('content') ?? null;
  if (environment !== 'gwd-genericad' || !doc.querySelector('gwd-genericad')) {
    findings.push({
      check: 'environment',
      level: 'fail',
      target: 'document',
      message: `Environment is "${environment ?? 'missing'}". In GWD: File → Ad Environment → Non Google Ad → Convert.`,
    });
  }

  // Which selectors run each keyframes name.
  const names = new Set(css.keyframes.map((k) => k.name));
  const runners = new Map<string, string[]>();
  for (const rule of css.rules) {
    for (const d of rule.decls) {
      if (!/^(-webkit-)?animation(-name)?$/.test(d.prop)) continue;
      for (const token of d.value.split(/[\s,]+/)) {
        if (names.has(token)) runners.set(token, [...(runners.get(token) ?? []), rule.selector]);
      }
    }
  }

  // Where else each name appears: in the HTML beyond its @keyframes rules, or in the ad's own files (not GWD's backups).
  const ownText = ad ? [...ad.files].filter(([p]) => p !== ad.htmlPath && /\.(js|css|html?)$/i.test(p) && !/(^|\/)(_revisions?|gwd_preview_[^/]*)\//.test(p)).map(([, data]) => new TextDecoder().decode(data)) : [];
  const mentioned = (name: string) => {
    const re = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
    return (html.match(re) ?? []).length > css.keyframes.filter((k) => k.name === name).length || ownText.some((t) => t.search(re) >= 0);
  };

  // What runs each name; null where no rule runs it, or one runs it on something not in the HTML.
  const subjects = new Map<string, Subjects | null>();
  const subjectsOf = (name: string): Subjects | null => {
    if (!subjects.has(name)) {
      const parts = (runners.get(name) ?? []).flatMap((s) => s.split(','));
      const found = parts.map((s) => query(doc, lastCompound(s).replace(/::?[a-z-]+(\([^)]*\))?/gi, '')));
      const els = found.flat();
      subjects.set(name, !parts.length || found.some((f) => !f.length) ? null : {
        ids: [...new Set(els.map((e) => e.id).filter(Boolean))],
        classes: [...new Set(els.flatMap((e) => [...e.classList]))],
        tags: [...new Set(els.map((e) => e.tagName.toLowerCase()))],
        effects: els.some((e) => e.hasAttribute('gwd-text-effect')),
      });
    }
    return subjects.get(name)!;
  };

  for (const block of css.keyframes) {
    const where = block.media ? ` (${block.media})` : '';
    const frames = block.frames.map((f) => new Map(f.decls.map((d) => [d.prop, d])));
    const props = [...new Set(frames.flatMap((f) => [...f.keys()]))].filter((p) => p !== 'animation-timing-function');
    for (const p of props.filter((p) => POSITION.includes(p))) {
      findings.push({ check: 'position', level: 'fail', target: block.name + where, prop: p, message: `Animates ${p}; move it with transform: translate3d instead.` });
    }
    const same = heldInBlock(block);
    if (same.length) {
      unchanged.push({ block, props: same, subjects: subjectsOf(block.name), unused: !mentioned(block.name) });
      for (const p of same) {
        findings.push({ check: 'keyframes', level: 'fail', target: block.name + where, message: `${p} never changes (${frames.find((f) => f.has(p))!.get(p)!.value}).` });
      }
    }
    const first = [...block.frames].sort((a, b) => frameOffset(a.selector) - frameOffset(b.selector))[0];
    const opacity = first && opacityOf(first.decls);
    if (opacity && (startsTooLow(opacity) || (startsVisible(opacity) && rises(block, opacityValue(opacity.value))))) {
      const textRunners = (runners.get(block.name) ?? []).flatMap((s) => query(doc, lastCompound(s))).filter((el) => fadesText(el, defs));
      const labels = [...new Set(textRunners.map(label))].join(', ');
      if (textRunners.length && startsTooLow(opacity)) {
        fadeDecls.push(opacity);
        findings.push({
          check: 'textFade',
          level: 'fail',
          target: block.name + where,
          message: `Fades text in from opacity ${opacity.value} (${labels}); start at ${FADE_START}.`,
        });
      } else if (textRunners.length) {
        fadeVisible.push({ target: block.name + where, value: opacity.value, decl: opacity });
        findings.push({ check: 'textFade', level: 'fail', target: block.name + where, message: `Fades text in from opacity ${opacity.value} (${labels}); the checklist wants ${FADE_START}.`, hint: VISIBLE_HINT });
      }
    }
  }

  // Text whose own rules start it below FADE_START, or a group it sits in: the value it shows before its
  // keyframes start (which may start at FADE_START), or until a script or transition fades it in.
  // From above FADE_START up to VISIBLE_START, only where a keyframes block then raises its opacity:
  // otherwise the text may simply be meant to look faint.
  const risesOn = (el: Element, v: number) => css.keyframes.some((k) => rises(k, v) && (runners.get(k.name) ?? []).some((sel) => query(doc, lastCompound(sel)).includes(el)));
  for (const rule of css.rules) {
    const opacity = opacityOf(rule.decls);
    if (!opacity) continue;
    const low = startsTooLow(opacity);
    if (!low && !startsVisible(opacity)) continue;
    let text = query(doc, lastCompound(rule.selector)).filter((el) => fadesText(el, defs));
    if (!low) text = text.filter((el) => risesOn(el, opacityValue(opacity.value)));
    if (!text.length) continue;
    const target = [...new Set(text.map(label))].join(', ');
    const where = `${rule.selector}${rule.media ? ` (${rule.media})` : ''}`;
    if (low) {
      fadeDecls.push(opacity);
      findings.push({ check: 'textFade', level: 'fail', target, message: `${where} starts it at opacity ${opacity.value}. Text that fades in must start at ${FADE_START}, and ${FADE_START} still looks hidden.` });
    } else {
      fadeVisible.push({ target, value: opacity.value, decl: opacity });
      findings.push({ check: 'textFade', level: 'fail', target, message: `${where} starts it at opacity ${opacity.value}, and a keyframes animation fades it in; the checklist wants ${FADE_START}.`, hint: VISIBLE_HINT });
    }
  }

  // What each ignored value styles, where that is known: making one valid leaves every text as it
  // looks only where none of what it styles shows text.
  for (const v of cssValues) {
    if (v.file) continue;
    let styled: Element[] = [];
    if (v.via === '') {
      const at = (d: Decl) => d.valueStart === v.start;
      const rule = css.rules.find((r) => r.decls.some(at));
      const block = rule ? undefined : css.keyframes.find((k) => k.frames.some((f) => f.decls.some(at)));
      const selectors = rule ? rule.selector.split(',') : block ? runners.get(block.name) ?? [] : [];
      styled = selectors.flatMap((s) => query(doc, lastCompound(s)));
    } else if (v.via === 'style attribute') {
      styled = query(doc, v.target);
    } else if (v.via === 'setInlineStyle') {
      styled = byGwdRef(doc, defs, v.target);
    }
    if (styled.length) v.showsText = styled.some((el) => holdsText(el, defs));
  }

  for (const v of cssValues) {
    const hint = v.file ? `Correct the value in ${v.file}.` : v.fixed ? null : 'Correct the value in GWD.';
    findings.push({ check: 'cssValues', level: 'fail', target: v.target, message: describeIssue(v), ...(hint ? { hint } : {}) });
  }
  for (const u of unknown) findings.push({ check: 'cssValues', level: 'note', target: u.target, message: u.message, unknown: true });

  const stackAdapt = stackAdaptAudit(html, doc, css, ad);
  findings.push(...stackAdaptFindings(stackAdapt));
  const clicks = clickAudit(html, doc, css, stackAdapt.loaded['param.js'] > 0, ad);
  // Only with the ad's files: a lone HTML says so, and tests of the HTML alone leave the row out.
  const files = ad ? fileRefs(html, css, ad) : [];
  if (ad) findings.push(...fileFindings(files, ad.files.size < 2));

  return { sizes: servedSizes(doc, css), environment, findings, copy: copyList(doc, defs), fadeDecls, fadeVisible, unchanged, cssValues, stackAdapt, clicks, files };
}

function copyList(doc: Document, defs: Map<string, Element>): CopyItem[] {
  const items: CopyItem[] = [];
  const listed = new Set<string>();
  const isContainer = (el: Element) => hasDirectText(el) && !el.closest('script, style, template, noscript');
  const visit = (root: ParentNode) => {
    for (const el of root.querySelectorAll('*')) {
      if (isContainer(el)) {
        let parent = el.parentElement;
        let nested = false;
        while (parent && !nested) {
          nested = isContainer(parent);
          parent = parent.parentElement;
        }
        if (!nested) items.push({ target: label(el), size: 'base', text: clean(el.textContent ?? '') });
      }
      overrides(el);
      // A GWD group's texts, where the group is first used: its elements are copies of its definition's.
      const group = el.getAttribute('data-gwd-group');
      const def = group === null ? undefined : defs.get(group);
      if (def && !listed.has(group!)) {
        listed.add(group!);
        visit(def);
      }
    }
  };
  const overrides = (el: Element) => {
    const raw = el.getAttribute('data-gwd-media-override');
    if (!raw) return;
    try {
      for (const [size, override] of Object.entries(JSON.parse(raw) as Record<string, Record<string, string>>)) {
        if (!override['data-gwd-text']) continue;
        const content = JSON.parse(override['data-gwd-text']).content as string;
        const text = new DOMParser().parseFromString(`<body>${content}</body>`, 'text/html').body.textContent ?? '';
        items.push({ target: label(el), size, text: clean(text) });
      }
    } catch {
      // malformed override JSON: skip it
    }
  };
  if (doc.body) visit(doc.body);
  return items;
}

const clean = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
