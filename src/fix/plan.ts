// Plans the layout-neutral fixes as text edits on the ad's HTML, from what the checks observed in
// every size and on every page (plain data, never the frames). Design-changing problems (type
// below 8px) are reported, never fixed automatically.

import { insertDecl, insertRule, lineIndent, removeDecl, setValue, type Edit } from '../css/edit';
import { singleClass, sizeOfMedia, type CssModel, type Decl, type MediaBlock, type StyleRule } from '../css/parse';
import type { StaticReport } from '../audit/static';
import type { Box, CheckId } from '../audit/types';
import { describeSize, parseSize } from '../sizes';

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
  /** Labels of the frames where a page never showed. */
  incomplete?: Set<string>;
}

const PADDING = /^padding(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const TEXT_TAGS = ['p', 'span', 'button'];
const px = (n: number) => `${+n.toFixed(2)}px`;
// Properties that only change how things look: a value that starts to apply never moves text.
// Not filter or backdrop-filter: they make their element the containing block of positioned text.
const PAINT_ONLY = new Set([
  'opacity', 'visibility', 'color', 'background', 'background-color', 'background-image', 'border-color', 'outline', 'outline-color',
  'box-shadow', 'text-shadow', 'cursor', 'z-index', 'transition', 'transition-delay', 'transition-duration', 'transition-property',
  'transition-timing-function',
]);

class Planner {
  readonly fixes: PlannedFix[] = [];
  readonly manual: FixPlan['manual'] = [];
  /** Declarations some fix deletes; new lines never anchor to them. */
  private readonly deleted = new Set<Decl>();
  private readonly blockRules = new Map<string, StyleRule[]>();
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
   * The size block that wins in a frame: the last GWD size block whose media applies there (GWD
   * writes ranges before exact sizes, so an exact size overrides the range that contains it). None
   * for the design's base size.
   */
  sizeBlock(frame: string, size?: string): MediaBlock | undefined {
    const applies = this.input.media.get(frame);
    const blocks = this.css.media.filter((m) => sizeOfMedia(m.media) !== null);
    if (applies) return blocks.filter((m) => applies.has(m.media)).pop();
    return size ? blocks.filter((m) => sizeOfMedia(m.media) === size).pop() : undefined;
  }

  /** The rules for a class inside a media block, in source order. */
  rulesIn(block: MediaBlock, cls: string): readonly StyleRule[] {
    const key = `${block.start}|${cls}`;
    if (!this.blockRules.has(key)) {
      this.blockRules.set(key, this.css.rules.filter((r) => r.start > block.open && r.start < block.close && singleClass(r.selector) === cls));
    }
    return this.blockRules.get(key)!;
  }

  /**
   * Declares the line-height each <p>, <span> and <button> renders now, in every size, so that no
   * text moves in any size, including sizes no frame shows. A class is left to you, in every size,
   * where one value cannot keep everything it reaches as it is.
   */
  lineHeight() {
    const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
    // What it renders now: the px it inherits from a parent's declaration, else its font's normal.
    const rendered = (b: Box) => (b.computed.lineHeight === 'normal' ? b.normalLineHeight : Math.round(parseFloat(b.computed.lineHeight) * 100) / 100);
    const where = (m: MediaBlock) => describeSize(sizeOfMedia(m.media) ?? m.media);
    const declares = (r?: StyleRule) => !!r?.decls.some((d) => d.prop === 'line-height' || d.prop === 'font');
    const open = this.input.boxes.filter((b) => TEXT_TAGS.includes(b.tag) && !b.declared.lineHeight && !b.runtime);
    const planned = new Set(open);
    const byCls = new Map<string, Box[]>();
    for (const b of open) {
      const cls = this.mainClass(b.classes);
      if (!cls) this.manualNote('lineHeight', `${b.frame} ${b.target} has no styled class; set its line-height in GWD.`);
      else byCls.set(cls, [...(byCls.get(cls) ?? []), b]);
    }

    const refused = new Map<string, string>(); // class -> why it is left to you
    const refuse = (cls: string, why: string) => !refused.has(cls) && !!refused.set(cls, why);
    for (const [cls, seen] of byCls) {
      const fit = seen.find((b) => b.fit)?.fit;
      if (fit === 'missing') {
        refuse(cls, `.${cls}: GWD fits this text when the ad runs, which needs its gwd-text-fitting.js; check the whole folder or zip.`);
      } else if (fit) {
        refuse(cls, `.${cls}: GWD fits this text to its box when the ad runs, and a fixed line-height would change how it fits; set its line-height in GWD.`);
      } else if (seen.some((b) => b.computed.lineHeight === 'normal' && b.fontLoaded === false)) {
        // Normal line-height comes from the font's metrics: a web font that had not loaded measures as
        // its fallback, and that value would change the spacing once the real font arrives.
        refuse(cls, `.${cls}: its font had not loaded when it was measured, so its line-height is not fixed automatically. Check the whole ad folder or zip, and let the ad contact other sites if a script loads its fonts, or set it in GWD.`);
      }
    }

    // Size blocks that win in no frame the class was measured in: a value in its base rule reaches
    // them unseen. A frame where a page never showed may have had the class on that page.
    const seenIn = new Map<string, Set<string>>();
    for (const b of this.input.boxes) {
      const cls = this.mainClass(b.classes);
      if (cls && !b.runtime) seenIn.set(cls, (seenIn.get(cls) ?? new Set()).add(b.frame));
    }
    const frames = new Map(this.input.boxes.map((b) => [b.frame, b.size]));
    for (const f of this.input.media.keys()) if (!frames.has(f)) frames.set(f, undefined);
    const unmeasured = (cls: string) => {
      const covered = new Set([...frames]
        .filter(([f]) => seenIn.get(cls)?.has(f) || !this.input.incomplete?.has(f))
        .map(([f, size]) => this.sizeBlock(f, size)));
      return this.css.media.filter((m) => sizeOfMedia(m.media) !== null && !covered.has(m));
    };

    // A span takes its text parent's line-height where that is what it renders now, in every size;
    // not where a size no frame shows changes its font or its parent's, which could part them there.
    const inherit = new Set<string>();
    for (const [cls, seen] of byCls) {
      const spans = seen.filter((b) => b.tag === 'span' && b.inTextParent);
      if (refused.has(cls) || !spans.length) continue;
      const followsParent = spans.every((b) => rendered(b) !== undefined && b.parentLineHeight !== undefined && same(rendered(b)!, b.parentLineHeight));
      const unseen = unmeasured(cls).map((m) => m.start);
      if (followsParent && !seen.some((b) => unseen.some((s) => b.probes?.[s] !== undefined))) inherit.add(cls);
    }

    // Every size gets its own value in its own size block (the base size, which has none, in the base
    // rule), so no value reaches a size with another font.
    type Write = { cls: string; px: number; rule?: StyleRule; block?: MediaBlock; base: boolean; where: string };
    const keyOf = (cls: string, block?: MediaBlock) => {
      const rule = block ? this.rulesIn(block, cls).at(-1) : this.baseRule(cls);
      return { rule, key: rule ? `r${rule.start}` : block ? `b${block.start}|${cls}` : `base|${cls}` };
    };
    const writes = new Map<string, Write>();
    for (const b of open) {
      const cls = this.mainClass(b.classes);
      const px = rendered(b);
      if (!cls || refused.has(cls) || inherit.has(cls) || px === undefined) continue;
      const block = this.sizeBlock(b.frame, b.size);
      const { rule, key } = keyOf(cls, block);
      const prior = writes.get(key);
      if (prior && !same(prior.px, px)) {
        refuse(cls, `.${cls} renders ${prior.px}px and ${px}px${block ? ` in ${where(block)}` : ''}; set its line-height in GWD.`);
      } else if (!prior) {
        writes.set(key, { cls, px, rule, block: rule ? undefined : block, base: !block, where: block ? where(block) : '' });
      }
    }

    // A base value reaches the size blocks no frame measured the class in. Where such a block changes
    // its font, the block gets the value measured in that font; where that cannot be measured exactly,
    // the base rule gets nothing.
    const noBase = new Map<string, string>(); // class -> why its base size gets nothing
    for (const base of [...writes.values()].filter((w) => w.base && !refused.has(w.cls))) {
      const cls = base.cls;
      const added: Write[] = [];
      for (const m of unmeasured(cls)) {
        const rules = this.rulesIn(m, cls);
        if (rules.some(declares)) continue;
        const probed = byCls.get(cls)!.filter((b) => b.probes?.[m.start] !== undefined);
        const values = probed.map((b) => b.probes![m.start]);
        if (!probed.length && !rules.some((r) => r.decls.some((d) => /^font(-|$)/.test(d.prop)))) continue; // same font as the base size
        // What a text that inherits a px renders there depends on its parent, which was not measured there.
        if (!probed.length || probed.some((b) => b.computed.lineHeight !== 'normal') || !values.every((v) => v !== null && same(v, values[0]!))) {
          noBase.set(cls, `.${cls} in ${where(m)} was not measured, and a value in its base rule would reach it there, so its base size gets none; set its line-height in GWD.`);
          break;
        }
        const rule = rules.at(-1);
        if (!same(values[0]!, base.px)) added.push({ cls, px: values[0]!, rule, block: rule ? undefined : m, base: false, where: where(m) });
      }
      if (!noBase.has(cls)) added.forEach((w) => writes.set(`u${(w.rule ?? w.block)!.start}|${cls}`, w));
    }

    // A value in a size block also reaches the other size blocks that apply in some of its sizes.
    // Where no frame measured such a block and it changes the font there, the value is right only if
    // the block comes later and gives the class a line-height of its own, or comes earlier and the
    // home block sets every font property it changes. Otherwise the class is left to you.
    const overlap = (a: MediaBlock, b: MediaBlock) => {
      const [x, y] = [parseSize(sizeOfMedia(a.media)!), parseSize(sizeOfMedia(b.media)!)];
      if (!x || !y) return true;
      if (x.orientation && y.orientation && x.orientation !== y.orientation) return false;
      return Math.max(x.min[0], y.min[0]) <= Math.min(x.max[0], y.max[0]) && Math.max(x.min[1], y.min[1]) <= Math.min(x.max[1], y.max[1]);
    };
    for (const w of [...writes.values()].filter((x) => !x.base && !refused.has(x.cls))) {
      const home = w.block ?? this.css.media.find((m) => w.rule!.start > m.open && w.rule!.start < m.close);
      const size = home && parseSize(sizeOfMedia(home.media)!);
      // An exact size was measured with every block that applies there.
      if (!home || (size && size.min[0] === size.max[0] && size.min[1] === size.max[1] && !size.orientation)) continue;
      const fontProps = (m: MediaBlock) => new Set(this.rulesIn(m, w.cls).flatMap((r) => r.decls.map((d) => d.prop).filter((p) => /^font(-|$)/.test(p))));
      // A probe means the block changes its font, perhaps through an element it sits in.
      const probed = (m: MediaBlock) => byCls.get(w.cls)!.some((b) => b.probes?.[m.start] !== undefined);
      const ownValue = (m: MediaBlock) => this.rulesIn(m, w.cls).some(declares) || writes.has(`u${(this.rulesIn(m, w.cls).at(-1) ?? m).start}|${w.cls}`);
      const yields = (m: MediaBlock) => {
        const mine = fontProps(home);
        if (mine.has('font')) return true;
        const theirs = fontProps(m);
        return (theirs.size || !probed(m) ? [...theirs] : ['font-family', 'font-size', 'font-weight', 'font-style']).every((p) => mine.has(p));
      };
      const loose = unmeasured(w.cls).find((m) => m !== home && overlap(m, home) && (fontProps(m).size > 0 || probed(m))
        && !(m.start > home.start ? ownValue(m) : yields(m)));
      if (loose) refuse(w.cls, `.${w.cls} in ${where(loose)} was not measured, and its value in ${w.where} would reach it there; set its line-height in GWD.`);
    }

    // The line-height a class's own rules give in a frame once the fix is in: a px, 'inherit', or
    // 'declared' where a declaration it already has wins there; undefined where they give none.
    const valueIn = (cls: string, frame: string, size?: string): number | 'inherit' | 'declared' | undefined => {
      if (refused.has(cls) || !byCls.has(cls)) return undefined;
      const base = keyOf(cls);
      let v: number | 'inherit' | 'declared' | undefined = declares(base.rule) ? 'declared' : undefined;
      if (inherit.has(cls)) v = 'inherit';
      else if (!noBase.has(cls)) v = writes.get(base.key)?.px ?? v;
      const applies = this.input.media.get(frame);
      for (const m of this.css.media) {
        if (sizeOfMedia(m.media) === null || !(applies ? applies.has(m.media) : sizeOfMedia(m.media) === size)) continue;
        if (this.rulesIn(m, cls).some(declares)) v = 'declared';
        const { key, rule } = keyOf(cls, m);
        v = writes.get(key)?.px ?? writes.get(`u${(rule ?? m).start}|${cls}`)?.px ?? v;
      }
      return v;
    };

    // Leaving one class to you can expose text it shielded to another class's value: check until settled.
    for (let changed = true; changed;) {
      changed = false;
      // A class's value reaches every element that carries it, not only the texts it was planned from.
      for (const g of this.input.boxes) {
        if (g.runtime) continue;
        const main = this.mainClass(g.classes);
        for (const cls of g.classes) {
          if (!byCls.has(cls) || refused.has(cls) || (cls === main && planned.has(g))) continue;
          const v = valueIn(cls, g.frame, g.size);
          if (v === undefined || v === 'declared') continue;
          const now = rendered(g);
          const after = v === 'inherit' ? g.parentLineHeight : v;
          if (now !== undefined && after !== undefined && same(now, after)) continue;
          changed = refuse(cls, `.${cls} is also on ${g.target}${g.declared.lineHeight ? ', which declares its own line-height' : ''}, whose spacing its line-height would change in ${g.frame}; set it in GWD.`) || changed;
        }
      }
      // A value reaches the texts inside that get none of their own (an 'inherit' passes it on).
      for (const b of open) {
        const cls = this.mainClass(b.classes);
        const px = cls ? valueIn(cls, b.frame, b.size) : undefined;
        if (!cls || typeof px !== 'number') continue;
        const passes = (e: { classes: string[] }) => {
          const own = this.mainClass(e.classes);
          const v = own ? valueIn(own, b.frame, b.size) : undefined;
          return v === undefined || v === 'inherit';
        };
        const d = (b.inherits ?? []).find((t) => t.path.every(passes) && (!t.fontLoaded || !same(t.normal, px)));
        if (!d) continue;
        const change = d.fontLoaded ? `would go from ${d.normal}px to ${px}px` : 'renders in a web font that had not loaded, so what it needs is not known';
        changed = refuse(cls, `.${cls}: ${d.target} inside it takes its line-height and ${change} in ${b.frame}; set their line-heights in GWD.`) || changed;
      }
    }

    const kept = [...writes.values()].filter((w) => !refused.has(w.cls) && !(w.base && noBase.has(w.cls)));
    const edits: Edit[] = [];
    const baseAdds = new Map<string, string[]>();
    for (const w of kept) {
      if (w.rule) edits.push(insertDecl(this.html, w.rule, `line-height: ${w.px}px;`, this.deleted));
      else if (w.block) edits.push(insertRule(this.html, w.block, `.${w.cls}`, [`line-height: ${w.px}px;`]));
      else baseAdds.set(w.cls, [`line-height: ${w.px}px;`]);
    }
    const inherits = [...inherit].filter((cls) => !refused.has(cls));
    inherits.forEach((cls) => baseAdds.set(cls, ['line-height: inherit;']));
    edits.push(...this.addToBase(baseAdds));
    refused.forEach((why) => this.manualNote('lineHeight', why));
    noBase.forEach((why, cls) => { if (!refused.has(cls)) this.manualNote('lineHeight', why); });
    const notes = [...kept.map((w) => `.${w.cls}${w.where ? ` in ${w.where}` : ''}: ${w.px}px`), ...inherits.map((c) => `.${c}: inherit`)];
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
      const invalid = `${v.target} ${v.prop}: ${v.value}${handler} is not valid CSS, so browsers ignore it`;
      if (!v.fixed) {
        this.manualNote('cssValues', `${invalid}; correct it in GWD.`);
        continue;
      }
      const located = Number.isFinite(v.start) && Number.isFinite(v.end);
      if (located && rewritten.some((e) => e.start < v.end && v.start < e.end)) continue;
      // Edited in place only when the source reads exactly as the browser does: a comma written as
      // &#44; or \x2c would stay, and a value without a place in the source has nothing to replace.
      if (!located || this.html.slice(v.start, v.end) !== v.value) {
        this.manualNote('cssValues', `${invalid}; write ${v.fixed} in GWD.`);
        continue;
      }
      const into = PAINT_ONLY.has(v.prop) ? safe : moving;
      into.edits.push({ start: v.start, end: v.end, text: v.fixed });
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
