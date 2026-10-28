// Source-level checks: what the HTML alone can prove, plus the copy list for a typo review.

import { frameOffset, lastCompound, parseCss, type CssModel, type Decl, type KeyframesRule } from '../css/parse';
import { checkCssValues, cssSupports, describeIssue, type AdFiles, type CssValidator, type CssValueIssue } from './cssvalues';
import type { CopyItem, Finding } from './types';

const POSITION = ['top', 'left', 'right', 'bottom'];

export interface StaticReport {
  sizes: string[];
  environment: string | null;
  findings: Finding[];
  copy: CopyItem[];
  /** Opacity declarations that make text start at 0; fixable by writing 0.001. */
  fadeDecls: Decl[];
  /** Keyframes properties that never change, per block; removable once checked safe. */
  unchanged: { block: KeyframesRule; props: string[] }[];
  /** CSS values the browser ignores; the ones that only need decimal points are fixable. */
  cssValues: CssValueIssue[];
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

  for (const block of css.keyframes) {
    const where = block.media ? ` (${block.media})` : '';
    const frames = block.frames.map((f) => new Map(f.decls.map((d) => [d.prop, d])));
    const props = [...new Set(frames.flatMap((f) => [...f.keys()]))].filter((p) => p !== 'animation-timing-function');
    for (const p of props.filter((p) => POSITION.includes(p))) {
      findings.push({ check: 'position', level: 'fail', target: block.name + where, message: `Animates ${p}; move it with transform: translate3d instead.` });
    }
    if (frames.length > 1) {
      const same = props.filter((p) => frames.every((f) => f.has(p)) && new Set(frames.map((f) => f.get(p)!.value)).size === 1);
      if (same.length) {
        unchanged.push({ block, props: same });
        for (const p of same) {
          findings.push({ check: 'keyframes', level: 'fail', target: block.name + where, message: `${p} never changes (${frames[0].get(p)!.value}).` });
        }
      }
    }
    const first = [...block.frames].sort((a, b) => frameOffset(a.selector) - frameOffset(b.selector))[0];
    const opacity = first && opacityOf(first.decls);
    if (opacity && parseFloat(opacity.value) === 0) {
      const textRunners = (runners.get(block.name) ?? []).flatMap((s) => query(doc, lastCompound(s))).filter((el) => holdsText(el, defs));
      if (textRunners.length) {
        fadeDecls.push(opacity);
        findings.push({
          check: 'textFade',
          level: 'fail',
          target: block.name + where,
          message: `Fades text in from opacity 0 (${[...new Set(textRunners.map(label))].join(', ')}); start at 0.001.`,
        });
      }
    }
  }

  // Text whose own rules start it at opacity 0, or a group it sits in: the value it shows before its
  // keyframes start (which may start at 0.001), or until a script or transition fades it in.
  for (const rule of css.rules) {
    const opacity = opacityOf(rule.decls);
    if (!opacity || parseFloat(opacity.value) !== 0) continue;
    const text = query(doc, lastCompound(rule.selector)).filter((el) => holdsText(el, defs));
    if (!text.length) continue;
    fadeDecls.push(opacity);
    findings.push({
      check: 'textFade',
      level: 'fail',
      target: [...new Set(text.map(label))].join(', '),
      message: `${rule.selector}${rule.media ? ` (${rule.media})` : ''} starts it at opacity 0. Text that fades in must start at 0.001, and 0.001 still looks hidden.`,
    });
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

  return { sizes: servedSizes(doc, css), environment, findings, copy: copyList(doc, defs), fadeDecls, unchanged, cssValues };
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
