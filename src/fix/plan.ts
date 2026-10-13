// Plans the layout-neutral fixes as text edits on the ad's HTML, from what the checks observed in
// every size and on every page (plain data, never the frames). Design-changing problems (type
// below 8px) are reported, never fixed automatically.

import { insertDecl, insertRule, lineIndent, removeDecl, setValue, type Edit } from '../css/edit';
import { singleClass, sizeOfMedia, type CssModel, type Decl, type MediaBlock, type StyleRule } from '../css/parse';
import type { StaticReport } from '../audit/static';
import { pointDecimals } from '../audit/cssvalues';
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
  report: Pick<StaticReport, 'fadeDecls' | 'unchanged' | 'cssValues'>;
  /** Keyframes whose unchanged values differ from the element's own style. */
  safety: { animation: string }[];
}

const PADDING = /^padding(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const TEXT_TAGS = ['p', 'span', 'button'];
const px = (n: number) => `${+n.toFixed(2)}px`;
// Properties that only change how things look: a value that starts to apply never moves text.
const PAINT_ONLY = new Set([
  'opacity', 'visibility', 'color', 'background', 'background-color', 'background-image', 'border-color', 'outline', 'outline-color',
  'box-shadow', 'text-shadow', 'filter', 'cursor', 'z-index', 'transition', 'transition-delay', 'transition-duration', 'transition-property',
  'transition-timing-function',
]);

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
      if (!tags.includes(b.tag) || b.runtime) continue;
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

  /**
   * A line-height added to a class's base rule also reaches every size whose own rule changes the
   * font-size but not the line-height. Where such a size was not measured (its text was hidden, or
   * the size has no preview), give its rule the value the font's ratio says it renders.
   */
  coverUnmeasuredSizes(planned: Map<StyleRule, number>, ratios: Map<string, number[]>) {
    const measured = new Map<string, Set<string>>(); // class -> frames where it was measured
    for (const b of this.input.boxes) {
      const cls = this.mainClass(b.classes);
      if (cls) measured.set(cls, (measured.get(cls) ?? new Set()).add(b.frame));
    }
    for (const [rule] of [...planned]) {
      const cls = rule.media === null ? singleClass(rule.selector) : null;
      if (!cls) continue;
      const rs = [...ratios].filter(([k]) => k.startsWith(`${cls}|`)).flatMap(([, v]) => v).sort((a, b) => a - b);
      if (!rs.length) continue;
      const ratio = rs[Math.floor(rs.length / 2)];
      for (const r of this.css.rules) {
        if (r.media === null || singleClass(r.selector) !== cls || planned.has(r)) continue;
        const fs = r.decls.find((d) => d.prop === 'font-size');
        if (!fs || r.decls.some((d) => d.prop === 'line-height')) continue;
        const frames = [...this.input.media].filter(([, m]) => m.has(r.media!)).map(([f]) => f);
        if (frames.some((f) => measured.get(cls)?.has(f))) continue; // measured there: handled above
        const size = /^([\d.]+)px$/.exec(fs.value.trim());
        if (!size || r.decls.some((d) => d.prop === 'font-family')) {
          this.manualNote('lineHeight', `.${cls} in ${describeSize(sizeOfMedia(r.media) ?? r.media)} was not measured; set its line-height there in GWD.`);
          continue;
        }
        planned.set(r, Math.round(ratio * parseFloat(size[1]) * 100) / 100);
      }
    }
  }

  /**
   * The size block that wins in a box's frame: the last GWD size block whose media applies there
   * (GWD writes ranges before exact sizes, so an exact size overrides the range that contains it).
   * None for the design's base size.
   */
  sizeBlock(b: Box): MediaBlock | undefined {
    const applies = this.input.media.get(b.frame);
    const blocks = this.css.media.filter((m) => sizeOfMedia(m.media) !== null);
    if (applies) return blocks.filter((m) => applies.has(m.media)).pop();
    return b.size ? blocks.filter((m) => sizeOfMedia(m.media) === b.size).pop() : undefined;
  }

  lineHeight() {
    // Normal line-height comes from the font's metrics; a web font that had not loaded measures as
    // its fallback, and writing that value would change the spacing once the real font arrives.
    const open = this.input.boxes.filter((b) => TEXT_TAGS.includes(b.tag) && !b.declared.lineHeight && !b.runtime);
    const ratios = new Map<string, number[]>();
    const unreliable = new Set<string>();
    for (const b of open) {
      const cls = this.mainClass(b.classes);
      if (!cls || b.normalLineHeight === undefined) continue;
      if (b.fontLoaded === false) unreliable.add(cls);
      else if (b.computed.fontSize) {
        const key = `${cls}|${b.computed.fontFamily}`;
        ratios.set(key, [...(ratios.get(key) ?? []), b.normalLineHeight / b.computed.fontSize]);
      }
    }
    unreliable.forEach((cls) => this.manualNote('lineHeight',
      `.${cls}: its web font had not loaded when it was measured, so its line-height is not fixed automatically. Check again, or set it in GWD.`));

    // A span takes its text parent's line-height only when that equals its own in every size: a span
    // in a bigger or different font would otherwise get a smaller line box and pull the lines together.
    const inheritOk = new Map<string, boolean>();
    for (const b of open) {
      const cls = this.mainClass(b.classes);
      if (!cls || b.tag !== 'span' || !b.inTextParent) continue;
      const same = b.normalLineHeight !== undefined && b.parentLineHeight !== undefined && Math.abs(b.normalLineHeight - b.parentLineHeight) < 0.05;
      inheritOk.set(cls, (inheritOk.get(cls) ?? true) && same);
    }

    // Every size gets its own value in its own media block (the base size, which has none, in the
    // base rule). A value in a base rule would otherwise reach sizes with another font-size.
    type Target = { rule?: StyleRule; block?: MediaBlock; cls: string; px: number; where: string };
    const targets = new Map<string, Target>();
    const conflicts = new Set<string>();
    for (const b of open) {
      const cls = this.mainClass(b.classes);
      if (!cls) {
        this.manualNote('lineHeight', `${b.frame} ${b.target} has no styled class; set its line-height in GWD.`);
        continue;
      }
      if (unreliable.has(cls) || inheritOk.get(cls) || b.normalLineHeight === undefined) continue;
      const block = this.sizeBlock(b);
      let t: Target;
      if (block) {
        const rule = this.css.rules.filter((r) => r.start > block.open && r.start < block.close && singleClass(r.selector) === cls).pop();
        t = { rule, block: rule ? undefined : block, cls, px: b.normalLineHeight, where: describeSize(sizeOfMedia(block.media) ?? block.media) };
      } else {
        t = { rule: this.baseRule(cls), cls, px: b.normalLineHeight, where: '' };
      }
      const key = t.rule ? `r${t.rule.start}` : t.block ? `b${t.block.start}|${cls}` : `base|${cls}`;
      const prior = targets.get(key);
      if (prior && prior.px !== t.px) {
        conflicts.add(key);
        this.manualNote('lineHeight', `.${cls} renders ${prior.px}px and ${t.px}px${t.where ? ` in ${t.where}` : ''}; set its line-height in GWD.`);
        continue;
      }
      targets.set(key, t);
    }
    conflicts.forEach((key) => targets.delete(key));

    const edits: Edit[] = [];
    const baseAdds = new Map<string, string[]>();
    const planned = new Map<StyleRule, number>();
    for (const t of targets.values()) {
      if (t.rule) planned.set(t.rule, t.px);
      else if (t.block) edits.push(insertRule(this.html, t.block, `.${t.cls}`, [`line-height: ${t.px}px;`]));
      else baseAdds.set(t.cls, [`line-height: ${t.px}px;`]);
    }
    this.coverUnmeasuredSizes(planned, ratios);
    edits.push(...[...planned].map(([rule, lh]) => insertDecl(this.html, rule, `line-height: ${lh}px;`, this.deleted)));
    const inherit = new Map([...inheritOk].filter(([, ok]) => ok).map(([cls]) => [cls, ['line-height: inherit;']]));
    edits.push(...this.addToBase(new Map([...baseAdds, ...inherit])));
    const notes = [
      ...[...targets.values()].map((t) => `.${t.cls}${t.where ? ` in ${t.where}` : ''}: ${t.px}px`),
      ...[...planned].filter(([r]) => ![...targets.values()].some((t) => t.rule === r)).map(([r, lh]) => `${r.selector} in ${describeSize(sizeOfMedia(r.media) ?? String(r.media))}: ${lh}px`),
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

  cssValues() {
    // Declarations another fix rewrites; that fix replaces the bad value anyway.
    const rewritten = this.fixes.flatMap((f) => f.edits).filter((e) => e.text && e.end > e.start);
    const safe: { edits: Edit[]; notes: string[] } = { edits: [], notes: [] };
    const moving: { edits: Edit[]; notes: string[] } = { edits: [], notes: [] };
    for (const v of this.input.report.cssValues) {
      const handler = v.handler ? ` (in ${v.handler})` : '';
      if (!v.fixed) {
        this.manualNote('cssValues', `${v.target} ${v.prop}: ${v.value}${handler} is not valid CSS, so browsers ignore it; correct it in GWD.`);
        continue;
      }
      if (rewritten.some((e) => e.start < v.end && v.start < e.end)) continue;
      const into = PAINT_ONLY.has(v.prop) ? safe : moving;
      into.edits.push({ start: v.start, end: v.end, text: pointDecimals(this.html.slice(v.start, v.end)) });
      into.notes.push(`${v.target} ${v.prop}: ${v.value} -> ${v.fixed}${handler}`);
    }
    this.add('cssValues', 'Write decimal points in CSS values', safe.notes.join(', '), safe.edits);
    this.add(
      'cssValues',
      'Write decimal points in CSS values where it moves text',
      moving.notes.join(', '),
      moving.edits,
      'Browsers ignore these values today, so once valid they size or place what they style. Check the result in the preview.',
    );
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
  p.cssValues(); // last: it skips declarations the other fixes rewrite
  return { fixes: p.fixes, manual: p.manual };
}
