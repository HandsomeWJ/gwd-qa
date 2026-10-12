// Plans the layout-neutral fixes as text edits on the ad's HTML, from what the checks observed in
// every size and on every page (plain data, never the frames). Design-changing problems (type
// below 8px) are reported, never fixed automatically.

import { insertDecl, insertRule, lineIndent, removeDecl, setValue, type Edit } from '../css/edit';
import { singleClass, sizeOfMedia, type CssModel, type Decl, type StyleRule } from '../css/parse';
import type { StaticReport } from '../audit/static';
import type { Box, CheckId } from '../audit/types';
import { describeSize } from '../sizes';

export interface PlannedFix {
  check: CheckId;
  title: string;
  detail: string;
  edits: Edit[];
  /** Set when the fix will visibly move something; the page offers it unticked. */
  moves?: string;
}

export interface FixPlan {
  fixes: PlannedFix[];
  manual: { check: CheckId; detail: string }[];
}

export interface PlanInput {
  html: string;
  css: CssModel;
  boxes: Box[];
  /** Per frame label, the media conditions that apply in that frame. */
  media: Map<string, Set<string>>;
  report: Pick<StaticReport, 'fadeDecls' | 'unchanged'>;
  /** Keyframes whose unchanged values differ from the element's own style. */
  safety: { animation: string }[];
}

const PADDING = /^padding(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const TEXT_TAGS = ['p', 'span', 'button'];
const px = (n: number) => `${+n.toFixed(2)}px`;

class Planner {
  readonly fixes: PlannedFix[] = [];
  readonly manual: FixPlan['manual'] = [];
  /** Declarations some fix deletes; new lines never anchor to them. */
  private readonly deleted = new Set<Decl>();
  private readonly html: string;
  private readonly css: CssModel;

  constructor(private readonly input: PlanInput) {
    this.html = input.html;
    this.css = input.css;
  }

  baseRule(cls: string): StyleRule | undefined {
    return this.css.rules.find((r) => r.media === null && singleClass(r.selector) === cls);
  }

  /** The last rule for a class that applies in a frame through @media and declares `prop`. */
  sizeRule(cls: string, frame: string, prop: string): StyleRule | undefined {
    const applies = this.input.media.get(frame);
    return this.css.rules
      .filter((r) => r.media !== null && applies?.has(r.media) && singleClass(r.selector) === cls && r.decls.some((d) => d.prop === prop))
      .pop();
  }

  /** The class GWD styles an element through: the one whose base rule carries the most declarations. */
  mainClass(classes: string[]): string | null {
    let best: string | null = null;
    let bestCount = -1;
    for (const cls of classes) {
      const n = this.baseRule(cls)?.decls.length ?? -1;
      if (n > bestCount) {
        best = cls;
        bestCount = n;
      }
    }
    return bestCount >= 0 ? best : null;
  }

  /** Elements with these tags, in every size and on every page, grouped by main class. */
  byClass(tags: string[]): Map<string, Box[]> {
    const out = new Map<string, Box[]>();
    for (const b of this.input.boxes) {
      if (!tags.includes(b.tag)) continue;
      const cls = this.mainClass(b.classes) ?? `#${b.id || b.target}`;
      out.set(cls, [...(out.get(cls) ?? []), b]);
    }
    return out;
  }

  manualNote(check: CheckId, detail: string) {
    if (!this.manual.some((m) => m.detail === detail)) this.manual.push({ check, detail });
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

  add(check: CheckId, title: string, detail: string, edits: Edit[], moves?: string) {
    if (edits.length) this.fixes.push({ check, title, detail, edits, ...(moves ? { moves } : {}) });
  }

  buttonPadding() {
    const edits: Edit[] = [];
    const done: string[] = [];
    const moving: string[] = [];
    const adds = new Map<string, string[]>();
    const movingAdds = new Map<string, string[]>();
    for (const [cls, seen] of this.byClass(['button'])) {
      const padded = seen.filter((b) => b.computed.padding.some((v) => v !== 0));
      if (!padded.length) continue;
      if (cls.startsWith('#')) {
        this.manualNote('buttonPadding', `${cls} has no class to set padding on; change it in GWD.`);
        continue;
      }
      const cs = padded[0].computed;
      const [top, right, bottom, left] = cs.padding;
      const rule = this.baseRule(cls);
      const padDecls = rule?.decls.filter((d) => PADDING.test(d.prop)) ?? [];
      const perSize = this.css.rules.some((r) => r.media && singleClass(r.selector) === cls && r.decls.some((d) => PADDING.test(d.prop)));
      // A left inset on centred single-line text moves the text exactly like text-indent does.
      const insetOnly = top === 0 && right === 0 && bottom === 0 && left > 0 && cs.textAlign === 'center' && !cs.whiteSpace.startsWith('pre');
      const fromUserAgent = !padDecls.length;
      if (perSize || (!insetOnly && !fromUserAgent)) {
        this.manualNote('buttonPadding', `.${cls} padding ${cs.paddingText} cannot be zeroed without moving its text; change it in GWD.`);
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
        // The browser's default padding: zeroing it keeps centred text in place only in a fixed-size button.
        const fixedSize = padded.every((b) => b.declared.width && b.declared.height);
        if (fixedSize) adds.set(cls, ['padding: 0px;']);
        else movingAdds.set(cls, ['padding: 0px;']);
        if (!fixedSize) {
          moving.push(`.${cls}`);
          continue;
        }
      }
      done.push(insetOnly ? `.${cls} (its ${left}px left inset becomes text-indent)` : `.${cls}`);
    }
    edits.push(...this.addToBase(adds));
    this.add('buttonPadding', 'Set button padding to 0px', done.join(', '), edits);
    this.add(
      'buttonPadding',
      'Set button padding to 0px where it resizes the button',
      moving.join(', '),
      this.addToBase(movingAdds),
      'These buttons size to their content, so removing the browser default padding (1px 6px) makes them smaller. Check the result in the preview.',
    );
  }

  buttonColor() {
    const adds = new Map<string, string[]>();
    const done: string[] = [];
    for (const [cls, seen] of this.byClass(['button'])) {
      const bare = seen.filter((b) => !b.declared.color);
      if (cls.startsWith('#') || !bare.length) continue;
      const colors = [...new Set(bare.map((b) => b.computed.color))];
      if (colors.length > 1) {
        this.manualNote('buttonColor', `.${cls} renders ${colors.join(' and ')} in different sizes; set its color per size in GWD.`);
        continue;
      }
      const color = colors[0];
      adds.set(cls, [`color: ${color};`]);
      done.push(`.${cls} (${color})`);
    }
    this.add('buttonColor', 'Declare button colors (the color they render now)', done.join(', '), this.addToBase(adds));
  }

  marginBlock() {
    const safe = new Map<string, string[]>();
    const moving = new Map<string, string[]>();
    const why: string[] = [];
    for (const [cls, seen] of this.byClass(['p', 'span'])) {
      const missing = seen.some((b) => b.declared.marginBlockStart !== '0px' || b.declared.marginBlockEnd !== 'auto');
      if (!missing) continue;
      if (cls.startsWith('#')) {
        this.manualNote('marginBlock', `${cls} has no class to add margin-block to; add it in GWD.`);
        continue;
      }
      // GWD zeroes paragraph margins; without that, the browser's default margin is in play and removing it moves text.
      const margined = seen.find(({ computed: cs }) => {
        const inline = cs.display === 'inline';
        const flowsBelow = cs.position === 'static' || cs.position === 'relative';
        return !inline && (cs.marginTop !== 0 || (flowsBelow && cs.marginBottom !== 0));
      });
      if (margined) {
        const cs = margined.computed;
        moving.set(cls, ['margin-block: 0px auto;']);
        why.push(`.${cls} has margin ${px(cs.marginTop)} / ${px(cs.marginBottom)} today`);
      } else {
        safe.set(cls, ['margin-block: 0px auto;']);
      }
    }
    this.add('marginBlock', 'Add margin-block: 0px auto', [...safe.keys()].map((c) => `.${c}`).join(', '), this.addToBase(safe));
    this.add(
      'marginBlock',
      'Add margin-block: 0px auto where it moves text',
      [...moving.keys()].map((c) => `.${c}`).join(', '),
      this.addToBase(moving),
      `This moves text: ${why.join('; ')}. The checklist still asks for it; check the result in the preview.`,
    );
  }

  lineHeight() {
    const planned = new Map<StyleRule, number>();
    const conflicts = new Set<StyleRule>();
    const inherit = new Map<string, string[]>();
    for (const b of this.input.boxes) {
      if (!TEXT_TAGS.includes(b.tag) || b.declared.lineHeight) continue;
      const cls = this.mainClass(b.classes);
      if (!cls) {
        this.manualNote('lineHeight', `${b.frame} ${b.target} has no styled class; set its line-height in GWD.`);
        continue;
      }
      if (b.tag === 'span' && b.inTextParent) {
        inherit.set(cls, ['line-height: inherit;']);
        continue;
      }
      // Declare it where this size's font-size lives, so other sizes keep theirs.
      const rule = this.sizeRule(cls, b.frame, 'font-size') ?? this.baseRule(cls);
      if (!rule || b.normalLineHeight === undefined) continue;
      const prior = planned.get(rule);
      if (prior !== undefined && prior !== b.normalLineHeight) {
        conflicts.add(rule);
        this.manualNote('lineHeight', `.${cls} renders ${prior}px and ${b.normalLineHeight}px in different sizes; set line-height per size in GWD.`);
        continue;
      }
      planned.set(rule, b.normalLineHeight);
    }
    conflicts.forEach((rule) => planned.delete(rule));
    const edits = [...planned].map(([rule, lh]) => insertDecl(this.html, rule, `line-height: ${lh}px;`, this.deleted));
    edits.push(...this.addToBase(inherit));
    const where = (media: string) => describeSize(sizeOfMedia(media) ?? media);
    const notes = [
      ...[...planned].map(([rule, lh]) => `${rule.selector}${rule.media ? ` in ${where(rule.media)}` : ''}: ${lh}px`),
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
        this.manualNote('keyframes', `${block.name}: deleting ${props.join(', ')} would change how it looks, because those values differ from the element's own style.`);
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
