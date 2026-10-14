// What changes how a text is spaced while someone hovers, focuses, presses or clicks the ad: CSS
// rules that wait for :hover and the like, and the fonts, line-heights and classes the ad's scripts
// set on its elements (GWD's setInlineStyle among them). The previews measure the ad at rest, so the
// layout safety net also lays every fix out with all of these applied at once.

import type { CssModel, StyleRule } from '../css/parse';
import { declList, gwdInlineStyles, readAd, scanScript, type AdFiles, type ScriptHits, type Where } from './cssvalues';

/** Pseudo-classes for a state a person puts an element in. */
const STATE = /:(hover|active|focus-visible|focus-within|focus|target)(?![\w-])/gi;
/** Properties that change a text's line spacing: its font and its line-height. */
const SPACING = /^(font(-[a-z-]+)?|line-height)$/;
const ANIMATION = /^(-webkit-)?animation(-name)?$/;
/** Never on an element, so ':not(.gwdqa-never)' always matches, with a pseudo-class's specificity. */
const ALWAYS = ':not(.gwdqa-never)';

/** A font or line-height a script sets. `ref` names the element as GWD does ("id grp-id…"), or is null where it is found while the ad runs. */
export interface ScriptStyle {
  ref: string | null;
  prop: string;
  value: string;
  label: string; // "setInlineStyle on SA_cta_1 in gwd.auto_click"
}

/** A class a script puts on or takes off an element; its rules change a font or line-height, or run an animation. */
export interface ScriptClass {
  ref: string | null;
  op: 'add' | 'remove' | 'toggle';
  name: string;
  label: string;
}

export interface States {
  /** Selectors of rules (in the HTML or a stylesheet of the ad's) that wait for a state and set a font or line-height. */
  rules: string[];
  styles: ScriptStyle[];
  classes: ScriptClass[];
  /** What scripts change on elements the code does not name, which cannot be laid out here. */
  unknown: string[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasClass = (selector: string, name: string) => new RegExp(`\\.${escapeRegExp(name)}(?![\\w-])`).test(selector);
const spacing = (rule: StyleRule) => rule.decls.some((d) => SPACING.test(d.prop));

/** The states the ad can be put in that change a font or line-height, from its CSS and scripts. */
export function findStates(html: string, css: CssModel, ad?: AdFiles): States {
  const rules: string[] = [];
  const spacingRules: string[] = [];
  const animated: string[] = [];
  const styles: ScriptStyle[] = [];
  const changes: ScriptClass[] = [];
  const label = (where: Where) => `${where.via} on ${where.target}${where.handler ? ` in ${where.handler}` : ''}`;
  const set = (prop: string, value: string, where: Where, ref: string | null) => {
    const name = prop.trim().toLowerCase();
    if (SPACING.test(name) && value.trim()) styles.push({ ref, prop: name, value: value.trim(), label: label(where) });
  };
  const hits: ScriptHits = {
    list: (src, where, ref) => {
      for (const d of declList(src.text) ?? []) set(d.prop, d.value, where, ref);
    },
    // GWD's setInlineStyle() keeps a name as written: one with spaces around it sets nothing.
    inline: (src, where, ref) => {
      for (const d of gwdInlineStyles(src.text)) if (d.name === d.name.trim()) set(d.name, src.text.slice(d.valueStart, d.valueEnd), where, ref);
    },
    property: (name, src, where, ref) => {
      if (name === name.trim()) set(name, src.text, where, ref);
    },
    single: (prop, src, where, ref) => set(prop, src.text, where, ref),
    unknown: () => {},
    classes: (op, names, where, ref) => {
      for (const name of names) changes.push({ ref, op, name, label: label(where) });
    },
  };
  readAd(html, css, ad, [], {
    sheet: (model) => {
      for (const r of model.rules) {
        if (spacing(r)) {
          spacingRules.push(r.selector);
          if (new RegExp(STATE.source, 'i').test(r.selector)) rules.push(r.selector);
        }
        if (r.decls.some((d) => ANIMATION.test(d.prop))) animated.push(r.selector);
      }
    },
    script: (text, from, to) => scanScript(text, from, to, hits),
  });
  const classes = changes.filter((c) => [...spacingRules, ...animated].some((sel) => hasClass(sel, c.name)));
  const unknown = [
    ...styles.filter((s) => s.ref === null).map((s) => `${s.label} sets ${s.prop}`),
    // A class put on elements the code does not name is laid out on every element its rules match;
    // one taken off them cannot be.
    ...classes.filter((c) => c.ref === null && c.op === 'remove').map((c) => `${c.label} takes off ${c.name}`),
  ];
  return {
    rules: [...new Set(rules)],
    styles: styles.filter((s) => s.ref !== null),
    classes: classes.filter((c) => c.ref !== null || c.op !== 'remove'),
    unknown,
  };
}

/** Whether the ad has a state to lay out. */
export const hasStates = (s: States) => s.rules.length + s.styles.length + s.classes.length > 0;

/** "in its hover, focus or click state (.gwd-button-b:hover; setInlineStyle on SA_cta_1)". */
export function describeStates(s: States): string {
  const what = [...new Set([...s.rules, ...s.styles.map((x) => x.label), ...s.classes.map((x) => x.label)])];
  const shown = what.slice(0, 2).join('; ') + (what.length > 2 ? `; and ${what.length - 2} more` : '');
  return `in its hover, focus or click state (${shown})`;
}

/** A GWD element reference: "id grp-id…" from an element with that id, or " group grp-id…" in each instance of a group. */
function parseRef(ref: string): { id: string; group: string; path: string[] } | null {
  const words = ref.split(' ');
  const relative = words[0] === '';
  const [head, ...path] = words.filter(Boolean);
  if (!head) return null;
  return relative ? { id: '', group: head, path } : { id: head, group: '', path };
}

/** As GWD's events support does: each step is the first element with that grp-id that is not in a nested group instance. */
function descend(root: Element | null, path: string[]): Element | null {
  let el = root;
  for (const step of path) {
    if (!el) return null;
    let found = el.querySelector(`[data-gwd-grp-id="${CSS.escape(step)}"]`);
    for (let n = found?.parentElement ?? null; found && n && n !== el; n = n.parentElement) {
      if (n.hasAttribute('data-gwd-group')) found = null;
    }
    el = found;
  }
  return el;
}

/** The elements a GWD reference names in `doc`: none when it names none. */
export function gwdElements(doc: Document, ref: string): Element[] {
  const r = parseRef(ref);
  if (!r) return [];
  const roots = r.id ? [doc.getElementById(r.id)] : [...doc.querySelectorAll(`[data-gwd-group="${CSS.escape(r.group)}"]`)];
  return roots.map((root) => descend(root, r.path)).filter((el): el is Element => !!el);
}

/** Whether `el` is an element the reference names: it, or an instance of its group, leads to `el`. */
export function gwdRefNames(el: Element, ref: string): boolean {
  const r = parseRef(ref);
  if (!r) return false;
  if (r.id) return descend(el.ownerDocument.getElementById(r.id) ?? el.closest(`#${CSS.escape(r.id)}`), r.path) === el;
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (n.getAttribute('data-gwd-group') === r.group && descend(n, r.path) === el) return true;
  }
  return false;
}

const isStyleRule = (rule: CSSRule): rule is CSSStyleRule => 'selectorText' in rule && 'style' in rule;
const isGroup = (rule: CSSRule): rule is CSSGroupingRule => 'cssRules' in rule && 'insertRule' in rule;

/**
 * Puts a laid-out document in every state at once: each rule that waits for a state and sets a font
 * or line-height gets a copy right after it that always applies, with the same specificity; the
 * classes and styles scripts set are set. A class put on elements the code does not name is
 * applied the same way, as if every element had it. Returns what it found no element for.
 */
export function forceStates(doc: Document, states: States): string[] {
  const unreached: string[] = [];
  const everywhere = states.classes.filter((c) => c.ref === null && c.op !== 'remove').map((c) => c.name);
  const stateRe = new RegExp(STATE.source, 'gi');
  const classRes = everywhere.map((name) => new RegExp(`\\.${escapeRegExp(CSS.escape(name))}(?![\\w-])`, 'g'));
  const setsSpacing = (style: CSSStyleDeclaration) => {
    for (let i = 0; i < style.length; i++) if (/^(font-|line-height$)/.test(style[i])) return true;
    return false;
  };
  const walk = (owner: CSSStyleSheet | CSSGroupingRule) => {
    // From the end, so that a copy put in after a rule is not visited.
    for (let i = owner.cssRules.length - 1; i >= 0; i--) {
      const rule = owner.cssRules[i];
      if (isGroup(rule)) walk(rule);
      if (!isStyleRule(rule) || !setsSpacing(rule.style)) continue;
      let forced = rule.selectorText.replace(stateRe, ALWAYS);
      for (const re of classRes) forced = forced.replace(re, ALWAYS);
      if (forced === rule.selectorText) continue;
      try {
        owner.insertRule(`${forced} { ${rule.style.cssText} }`, i + 1);
      } catch {
        // a selector this browser cannot take back, such as another engine's prefixed one
      }
    }
  };
  for (const sheet of [...doc.styleSheets]) {
    try {
      walk(sheet);
    } catch {
      // another site's stylesheet, whose rules a page cannot read
    }
  }
  for (const c of states.classes) {
    if (c.ref === null) continue;
    const els = gwdElements(doc, c.ref);
    if (!els.length) unreached.push(c.label);
    for (const el of els) el.classList.toggle(c.name, c.op === 'add' ? true : c.op === 'remove' ? false : undefined);
  }
  for (const s of states.styles) {
    const els = gwdElements(doc, s.ref!);
    if (!els.length) unreached.push(s.label);
    const important = /!\s*important$/i.test(s.value);
    for (const el of els) (el as HTMLElement).style.setProperty(s.prop, s.value.replace(/!\s*important$/i, '').trim(), important ? 'important' : '');
  }
  return [...new Set(unreached)];
}
