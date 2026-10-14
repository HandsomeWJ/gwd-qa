// Source-level checks: what the HTML alone can prove, plus the copy list for a typo review.

import { frameOffset, lastCompound, parseCss, type CssModel, type Decl, type KeyframesRule } from '../css/parse';
import { checkCssValues, cssSupports, describeIssue, type AdFiles, type CssValidator, type CssValueIssue } from './cssvalues';
import type { CopyItem, Finding } from './types';

const POSITION = ['top', 'left', 'right', 'bottom'];
const TEXT_TAGS = new Set(['P', 'SPAN', 'BUTTON', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'LI', 'LABEL']);

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

function holdsText(el: Element): boolean {
  return TEXT_TAGS.has(el.tagName) || hasDirectText(el) || !!el.querySelector('p, span, button');
}

function query(doc: Document, selector: string): Element[] {
  try {
    return [...doc.querySelectorAll(selector)];
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
  const findings: Finding[] = [];
  const fadeDecls: Decl[] = [];
  const unchanged: StaticReport['unchanged'] = [];
  const { issues: cssValues, unknown } = checkCssValues(html, css, valid, ad);
  // The browser ignores an invalid opacity, so it never starts a fade at 0.
  const ignored = new Set(cssValues.filter((v) => !v.file).map((v) => v.start));
  const opacityOf = (decls: Decl[]) => decls.find((d) => d.prop === 'opacity' && !ignored.has(d.valueStart));

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
      const textRunners = (runners.get(block.name) ?? []).flatMap((s) => query(doc, lastCompound(s))).filter(holdsText);
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

  // Text whose own rules start it at opacity 0 (fade-ins driven by script or transitions).
  for (const rule of css.rules) {
    const opacity = opacityOf(rule.decls);
    if (!opacity || parseFloat(opacity.value) !== 0) continue;
    const text = query(doc, lastCompound(rule.selector)).filter((el) => (TEXT_TAGS.has(el.tagName) || hasDirectText(el)) && (el.textContent ?? '').trim() !== '');
    if (!text.length) continue;
    fadeDecls.push(opacity);
    findings.push({
      check: 'textFade',
      level: 'fail',
      target: [...new Set(text.map(label))].join(', '),
      message: `${rule.selector}${rule.media ? ` (${rule.media})` : ''} starts it at opacity 0. Text that fades in must start at 0.001, and 0.001 still looks hidden.`,
    });
  }

  for (const v of cssValues) {
    const hint = v.file ? `Correct the value in ${v.file}.` : v.fixed ? null : 'Correct the value in GWD.';
    findings.push({ check: 'cssValues', level: 'fail', target: v.target, message: describeIssue(v), ...(hint ? { hint } : {}) });
  }
  for (const u of unknown) findings.push({ check: 'cssValues', level: 'note', target: u.target, message: u.message, unknown: true });

  return { sizes: servedSizes(doc, css), environment, findings, copy: copyList(doc), fadeDecls, unchanged, cssValues };
}

function copyList(doc: Document): CopyItem[] {
  const items: CopyItem[] = [];
  const isContainer = (el: Element) => hasDirectText(el) && !el.closest('script, style, template, noscript');
  for (const el of doc.body?.querySelectorAll('*') ?? []) {
    if (isContainer(el)) {
      let parent = el.parentElement;
      let nested = false;
      while (parent && !nested) {
        nested = isContainer(parent);
        parent = parent.parentElement;
      }
      if (!nested) items.push({ target: label(el), size: 'base', text: clean(el.textContent ?? '') });
    }
    const raw = el.getAttribute('data-gwd-media-override');
    if (!raw) continue;
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
  }
  return items;
}

const clean = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
