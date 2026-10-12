// Plans the layout-neutral fixes as text edits on the ad's HTML. Design-changing problems
// (type below 8px) are reported, never fixed automatically.

import { insertDecl, insertRule, lineIndent, removeDecl, setValue, type Edit } from '../css/edit';
import { singleClass, sizeOfMedia, type CssModel, type Decl, type StyleRule } from '../css/parse';
import { declared, frameParts, normalLineHeight, type AdFrame, type SafetyMismatch } from '../audit/render';
import { label, type StaticReport } from '../audit/static';
import type { CheckId } from '../audit/types';

export interface PlannedFix {
  check: CheckId;
  title: string;
  detail: string;
  edits: Edit[];
}

export interface FixPlan {
  fixes: PlannedFix[];
  manual: { check: CheckId; detail: string }[];
}

export interface PlanInput {
  html: string;
  css: CssModel;
  frames: AdFrame[];
  report: StaticReport;
  safety: SafetyMismatch[];
}

const PADDING = /^padding(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
// An inline <span> inside one of these takes the parent's line-height.
const TEXT_PARENT = 'p, h1, h2, h3, h4, h5, h6, button, a, li, label, span';

class Planner {
  readonly fixes: PlannedFix[] = [];
  readonly manual: FixPlan['manual'] = [];
  /** Declarations some fix deletes; new lines never anchor to them. */
  private readonly deleted = new Set<Decl>();
  private readonly html: string;
  private readonly css: CssModel;
  private readonly frames: AdFrame[];

  constructor(private readonly input: PlanInput) {
    this.html = input.html;
    this.css = input.css;
    this.frames = input.frames;
  }

  baseRule(cls: string): StyleRule | undefined {
    return this.css.rules.find((r) => r.media === null && singleClass(r.selector) === cls);
  }

  mediaRule(cls: string, size: string): StyleRule | undefined {
    return this.css.rules.filter((r) => sizeOfMedia(r.media) === size && singleClass(r.selector) === cls).pop();
  }

  /** The class GWD styles an element through: the one whose base rule carries the most declarations. */
  mainClass(el: Element): string | null {
    let best: string | null = null;
    let bestCount = -1;
    for (const cls of el.classList) {
      const n = this.baseRule(cls)?.decls.length ?? -1;
      if (n > bestCount) {
        best = cls;
        bestCount = n;
      }
    }
    return bestCount >= 0 ? best : null;
  }

  /** Every element matching `selector`, in every size, grouped by its main class. */
  byClass(selector: string): Map<string, { el: Element; frame: AdFrame }[]> {
    const out = new Map<string, { el: Element; frame: AdFrame }[]>();
    for (const frame of this.frames) {
      for (const el of frameParts(frame).doc.querySelectorAll(selector)) {
        const cls = this.mainClass(el) ?? `#${el.id || label(el)}`;
        out.set(cls, [...(out.get(cls) ?? []), { el, frame }]);
      }
    }
    return out;
  }

  /** Edits that add declarations to classes' base rules, creating missing rules in the main <style>. */
  addToBase(adds: Map<string, string[]>): Edit[] {
    const edits: Edit[] = [];
    const missing: [string, string[]][] = [];
    for (const [cls, decls] of adds) {
      const rule = this.baseRule(cls);
      if (rule) decls.forEach((d) => edits.push(insertDecl(this.html, rule, d, this.deleted)));
      else missing.push([cls, decls]);
    }
    if (missing.length) {
      const block = [...this.css.styleBlocks].sort((a, b) => b.close - b.open - (a.close - a.open))[0];
      for (const [cls, decls] of missing) edits.push(insertRule(this.html, block, `.${cls}`, decls, true));
    }
    return edits;
  }

  add(check: CheckId, title: string, detail: string, edits: Edit[]) {
    if (edits.length) this.fixes.push({ check, title, detail, edits });
  }

  buttonPadding() {
    const edits: Edit[] = [];
    const done: string[] = [];
    const adds = new Map<string, string[]>();
    for (const [cls, seen] of this.byClass('button')) {
      const padded = seen.filter(({ el, frame }) => {
        const c = frameParts(frame).win.getComputedStyle(el);
        return [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].some((v) => v !== '0px');
      });
      if (!padded.length) continue;
      if (cls.startsWith('#')) {
        this.manual.push({ check: 'buttonPadding', detail: `${cls} has no class to set padding on; change it in GWD.` });
        continue;
      }
      const { el, frame } = padded[0];
      const cs = frameParts(frame).win.getComputedStyle(el);
      const [top, right, bottom, left] = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);
      const rule = this.baseRule(cls);
      const padDecls = rule?.decls.filter((d) => PADDING.test(d.prop)) ?? [];
      const perSize = this.css.rules.some((r) => r.media && singleClass(r.selector) === cls && r.decls.some((d) => PADDING.test(d.prop)));
      // A left inset on centred single-line text moves the text exactly like text-indent does.
      const insetOnly = top === 0 && right === 0 && bottom === 0 && left > 0 && cs.textAlign === 'center' && !cs.whiteSpace.startsWith('pre');
      const fromUserAgent = !padDecls.length;
      if (perSize || (!insetOnly && !fromUserAgent)) {
        this.manual.push({ check: 'buttonPadding', detail: `.${cls} padding ${cs.padding} cannot be zeroed without moving its text; change it in GWD.` });
        continue;
      }
      if (rule && padDecls.length) {
        const [first, ...rest] = padDecls;
        const indent = lineIndent(this.html, first.start);
        edits.push({ start: first.start, end: first.end, text: `padding: 0px;${insetOnly ? `\n${indent}text-indent: ${left}px;` : ''}` });
        for (const d of rest) {
          edits.push(removeDecl(this.html, d));
          this.deleted.add(d);
        }
        this.deleted.add(first);
      } else {
        adds.set(cls, ['padding: 0px;']);
      }
      done.push(insetOnly ? `.${cls} (its ${left}px left inset becomes text-indent)` : `.${cls}`);
    }
    edits.push(...this.addToBase(adds));
    this.add('buttonPadding', 'Set button padding to 0px', done.join(', '), edits);
  }

  buttonColor() {
    const adds = new Map<string, string[]>();
    const done: string[] = [];
    for (const [cls, seen] of this.byClass('button')) {
      if (cls.startsWith('#') || seen.every(({ el, frame }) => declared(frameParts(frame).win, el, 'color'))) continue;
      const { el, frame } = seen[0];
      const color = frameParts(frame).win.getComputedStyle(el).color;
      adds.set(cls, [`color: ${color};`]);
      done.push(`.${cls} (${color})`);
    }
    this.add('buttonColor', 'Declare button colors (the color they render now)', done.join(', '), this.addToBase(adds));
  }

  marginBlock() {
    const adds = new Map<string, string[]>();
    for (const [cls, seen] of this.byClass('p, span')) {
      const missing = seen.some(({ el, frame }) => {
        const { win } = frameParts(frame);
        return declared(win, el, 'margin-block-start') !== '0px' || declared(win, el, 'margin-block-end') !== 'auto';
      });
      if (!missing) continue;
      if (cls.startsWith('#')) {
        this.manual.push({ check: 'marginBlock', detail: `${cls} has no class to add margin-block to; add it in GWD.` });
        continue;
      }
      adds.set(cls, ['margin-block: 0px auto;']);
    }
    this.add('marginBlock', 'Add margin-block: 0px auto', [...adds.keys()].map((c) => `.${c}`).join(', '), this.addToBase(adds));
  }

  lineHeight() {
    const planned = new Map<StyleRule, number>();
    const inherit = new Map<string, string[]>();
    for (const frame of this.frames) {
      const { doc, win } = frameParts(frame);
      for (const el of doc.querySelectorAll('p, span, button')) {
        if (declared(win, el, 'line-height')) continue;
        const cls = this.mainClass(el);
        if (!cls) {
          this.manual.push({ check: 'lineHeight', detail: `${frame.size} ${label(el)} has no styled class; set its line-height in GWD.` });
          continue;
        }
        if (el.tagName === 'SPAN' && el.parentElement?.closest(TEXT_PARENT)) {
          inherit.set(cls, ['line-height: inherit;']);
          continue;
        }
        // Declare it where this size's font-size lives, so other sizes keep theirs.
        const own = this.mediaRule(cls, frame.size);
        const rule = own?.decls.some((d) => d.prop === 'font-size') ? own : this.baseRule(cls);
        if (!rule) continue;
        const px = normalLineHeight(win, el);
        const prior = planned.get(rule);
        if (prior !== undefined && prior !== px) {
          this.manual.push({ check: 'lineHeight', detail: `.${cls} renders ${prior}px and ${px}px in different sizes; set line-height per size in GWD.` });
          continue;
        }
        planned.set(rule, px);
      }
    }
    const edits = [...planned].map(([rule, px]) => insertDecl(this.html, rule, `line-height: ${px}px;`, this.deleted));
    edits.push(...this.addToBase(inherit));
    const notes = [
      ...[...planned].map(([rule, px]) => `${rule.selector}${rule.media ? ` in ${sizeOfMedia(rule.media)}` : ''}: ${px}px`),
      ...[...inherit.keys()].map((c) => `.${c}: inherit`),
    ];
    this.add('lineHeight', 'Declare line-height (the value it renders now)', notes.join(', '), edits);
  }

  textFade() {
    const decls = this.input.report.fadeDecls;
    this.add('textFade', 'Start text fades at opacity 0.001', `${decls.length} declaration${decls.length === 1 ? '' : 's'}`, decls.map((d) => setValue(d, '0.001')));
  }

  keyframes() {
    const unsafe = new Set(this.input.safety.map((m) => m.animation));
    const edits: Edit[] = [];
    let count = 0;
    let blocks = 0;
    for (const { block, props } of this.input.report.unchanged) {
      if (unsafe.has(block.name)) {
        this.manual.push({ check: 'keyframes', detail: `${block.name}: deleting ${props.join(', ')} would change how it looks, because those values differ from the element's own style.` });
        continue;
      }
      blocks++;
      for (const frame of block.frames) {
        for (const d of frame.decls.filter((x) => props.includes(x.prop))) {
          edits.push(removeDecl(this.html, d));
          count++;
        }
      }
    }
    this.add('keyframes', 'Delete keyframe properties that never change', `${count} declarations in ${blocks} keyframes blocks`, edits);
  }
}

export function planFixes(input: PlanInput): FixPlan {
  const p = new Planner(input);
  p.buttonPadding(); // first: it decides which declarations disappear
  p.buttonColor();
  p.marginBlock();
  p.lineHeight();
  p.textFade();
  p.keyframes();
  return { fixes: p.fixes, manual: p.manual };
}
