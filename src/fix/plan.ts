// Plans the layout-neutral fixes as text edits on the ad's HTML, from what the checks observed in
// every size and on every page (plain data, never the frames). A fix never moves text or changes how
// it looks: whatever would is left to the designer with a note, as are design-changing problems
// (type below 8px).

import { insertDecl, insertRule, lineIndent, removeDecl, setValue, type Edit } from '../css/edit';
import { elementClass, lastCompound, sizeOfMedia, type CssModel, type Decl, type KeyframesRule, type MediaBlock, type StyleRule } from '../css/parse';
import type { HiddenSubtree } from '../audit/observe';
import { STACKADAPT_SCRIPTS, stackAdaptTag, type Spot, type StackAdaptScript } from '../audit/stackadapt';
import { refStart, type Showers } from '../audit/states';
import type { StaticReport } from '../audit/static';
import type { Box, CheckId, Inheritor } from '../audit/types';
import { describeSize, parseSize } from '../sizes';

export interface PlannedFix {
  check: CheckId;
  title: string;
  detail: string;
  edits: Edit[];
  /** For a fix made of independent parts, such as one per class: each can be left out alone (withoutPart). */
  parts?: FixPart[];
  /** domPaths of elements it proved never show, whose texts may move with them (see comparePositions). */
  hidden?: string[];
}

export interface FixPart {
  name: string; // such as '.gwd-p-a'
  edits: Edit[]; // its edits, which are also the fix's
  notes: { at: number; text: string }[]; // its items in the fix's detail, and their places there
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
  report: Pick<StaticReport, 'fadeDecls' | 'unchanged' | 'cssValues'> & Partial<Pick<StaticReport, 'stackAdapt'>>;
  /** Keyframes whose unchanged values differ from the element's own style, and whether that element never shows. */
  safety: { animation: string; hidden?: HiddenSubtree }[];
  /** What in the ad's CSS and scripts could show a hidden element; without it, none counts as hidden. */
  showers?: Showers;
  /** Labels of the frames where a page never showed. */
  incomplete?: Set<string>;
}

const PADDING = /^padding(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const TEXT_TAGS = ['p', 'span', 'button'];
const px = (n: number) => `${+n.toFixed(2)}px`;
// Properties that only change how things look: a value that starts to apply never moves text.
// Not filter or backdrop-filter: they make their element the containing block of positioned text.
// Not transition-duration, -delay or -timing-function: they animate whatever transition-property
// names, by default all, so text that jumped would slide or grow; a transition is paint only when
// every property it names is (paintOnlyTransition).
const PAINT_ONLY = new Set([
  'opacity', 'visibility', 'color', 'background', 'background-color', 'background-image', 'border-color', 'outline', 'outline-color',
  'box-shadow', 'text-shadow', 'cursor', 'z-index',
]);
// The words of a transition that are not the property it animates.
const TRANSITION_WORDS = new Set(['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end', 'normal', 'allow-discrete']);

/** Whether a selector's subject could be one of these elements: it names one of their classes or ids, or none at all. */
function mayMatch(selector: string, ids: Set<string>, classes: Set<string>): boolean {
  return selector.split(',').some((part) => {
    const names = [...lastCompound(part).matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g)];
    return !names.length || names.some(([, kind, name]) => (kind === '.' ? classes : ids).has(name));
  });
}

/** Whether every property a transition value animates only changes how things look. */
function paintOnlyTransition(value: string): boolean {
  if (/\b(var|env|attr)\(/i.test(value)) return false;
  // Functions (cubic-bezier, steps) out, then each comma-separated transition; one naming no property animates all.
  return value.replace(/[\w-]+\([^()]*\)/g, ' ').split(',').every((item) => {
    const props = item.trim().split(/\s+/).filter((w) => /^-?[a-z][\w-]*$/i.test(w) && !TRANSITION_WORDS.has(w.toLowerCase()));
    return props.length === 1 && (props[0].toLowerCase() === 'none' || PAINT_ONLY.has(props[0].toLowerCase()));
  });
}

class Planner {
  readonly fixes: PlannedFix[] = [];
  readonly manual: FixPlan['manual'] = [];
  /** Declarations some fix deletes; new lines never anchor to them. */
  private readonly deleted = new Set<Decl>();
  private readonly blockRules = new Map<string, StyleRule[]>();
  private readonly html: string;
  private readonly css: CssModel;
  /** Declarations the CSS values check found invalid: browsers drop them, so they are as good as not there. */
  private readonly dropped: Set<number>;
  private risky?: Map<string, Set<string> | 'all'>;

  constructor(private readonly input: PlanInput) {
    this.html = input.html;
    this.css = input.css;
    this.dropped = new Set(input.report.cssValues.map((v) => v.start));
  }

  /** Whether a browser keeps this declaration of the ad's styles. */
  live(d: Decl): boolean {
    return !this.dropped.has(d.valueStart);
  }

  /**
   * The frames where a page never showed that may hold this class: where another frame showed it
   * on such a page, or, where no frame showed every page, every frame where a page never showed.
   */
  unseen(cls: string): string[] {
    const incomplete = this.input.incomplete;
    if (!incomplete?.size) return [];
    if (!this.risky) {
      const { boxes } = this.input;
      const frames = new Set([...boxes.map((b) => b.frame), ...this.input.media.keys()]);
      const complete = [...frames].some((f) => !incomplete.has(f));
      this.risky = new Map([...incomplete].map((f): [string, Set<string> | 'all'] => {
        if (!complete) return [f, 'all'];
        const shown = new Set(boxes.filter((b) => b.frame === f).map((b) => b.page));
        return [f, new Set(boxes.filter((b) => !shown.has(b.page)).flatMap((b) => b.classes))];
      }));
    }
    return [...this.risky].filter(([, classes]) => classes === 'all' || classes.has(cls)).map(([f]) => f);
  }

  /** Why a class-wide fix is not known to be safe where a page never showed; '' when it is. */
  unseenNote(cls: string): string {
    const frames = this.unseen(cls);
    return frames.length ? `.${cls} may sit on a page that never showed in ${frames.join(', ')}, so it was not checked there` : '';
  }

  /** The selector new rules for a class take: a GWD group's element keeps its group's form. */
  selectorOf(cls: string): string {
    const own = this.css.rules.find((r) => elementClass(r.selector) === cls);
    return own ? own.selector.trim() : `.${cls}`;
  }

  baseRule(cls: string): StyleRule | undefined {
    return this.css.rules.find((r) => r.media === null && elementClass(r.selector) === cls);
  }

  /** The last rule for a class that applies in a frame through @media and declares `prop`. */
  sizeRule(cls: string, frame: string, prop: string): StyleRule | undefined {
    const applies = this.input.media.get(frame);
    return this.css.rules
      .filter((r) => r.media !== null && applies?.has(r.media) && elementClass(r.selector) === cls && r.decls.some((d) => d.prop === prop))
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

  /**
   * Edits that add declarations to classes' base rules, creating missing rules in the main <style>.
   * `owner` learns the class each edit is for.
   */
  addToBase(adds: Map<string, string[]>, owner?: Map<Edit, string>): Edit[] {
    const edits: Edit[] = [];
    const missing: [string, string[]][] = [];
    const push = (cls: string, e: Edit) => {
      edits.push(e);
      owner?.set(e, cls);
    };
    for (const [cls, decls] of adds) {
      const rule = this.baseRule(cls);
      if (rule) decls.forEach((d) => push(cls, insertDecl(this.html, rule, d, this.deleted)));
      else missing.push([cls, decls]);
    }
    if (missing.length) {
      const block = [...this.css.styleBlocks].sort((a, b) => b.close - b.open - (a.close - a.open))[0];
      for (const [cls, decls] of missing) push(cls, insertRule(this.html, block, this.selectorOf(cls), decls, true));
    }
    return edits;
  }

  /** addToBase as one part per class, so a class that turns out to move text can be left out alone. */
  classParts(adds: Map<string, string[]>): { edits: Edit[]; parts: FixPart[] } {
    const owner = new Map<Edit, string>();
    const edits = this.addToBase(adds, owner);
    const parts = [...adds.keys()].map((cls, at) => ({ name: `.${cls}`, edits: edits.filter((e) => owner.get(e) === cls), notes: [{ at, text: `.${cls}` }] }));
    return { edits, parts };
  }

  add(check: CheckId, title: string, detail: string, edits: Edit[], parts?: FixPart[]) {
    if (edits.length) this.fixes.push({ check, title, detail, edits, ...(parts ? { parts } : {}) });
  }

  buttonPadding() {
    const edits: Edit[] = [];
    const done: string[] = [];
    const adds = new Map<string, string[]>();
    for (const [cls, seen] of this.byClass(['button'])) {
      const padded = seen.filter((b) => b.computed.padding.some((v) => v !== 0));
      if (!padded.length) continue;
      if (cls.startsWith('#')) {
        this.manualNote('buttonPadding', `${cls} has no class to set padding on; change it in GWD.`);
        continue;
      }
      if (this.unseenNote(cls)) {
        this.manualNote('buttonPadding', `${this.unseenNote(cls)}; set its padding in GWD.`);
        continue;
      }
      const cs = padded[0].computed;
      const [top, right, bottom, left] = cs.padding;
      const rule = this.baseRule(cls);
      const padDecls = rule?.decls.filter((d) => PADDING.test(d.prop)) ?? [];
      const perSize = this.css.rules.some((r) => r.media && elementClass(r.selector) === cls && r.decls.some((d) => PADDING.test(d.prop)));
      // A left inset on centred single-line text moves the text exactly like text-indent does.
      const insetOnly = top === 0 && right === 0 && bottom === 0 && left > 0 && cs.textAlign === 'center' && !cs.whiteSpace.startsWith('pre');
      const fromUserAgent = !padDecls.length;
      if (perSize || (!insetOnly && !fromUserAgent)) {
        const bySize = new Map<string, Set<string>>();
        for (const b of padded) bySize.set(b.computed.paddingText, (bySize.get(b.computed.paddingText) ?? new Set()).add(b.frame));
        const where = [...bySize].map(([text, frames]) => `${text} in ${[...frames].join(', ')}`).join(' and ');
        this.manualNote('buttonPadding', `.${cls} has padding ${where}, which cannot be zeroed without moving its text; change it in GWD.`);
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
        // The browser's default padding: zeroing it keeps text in place only in a fixed-size button
        // that centres it, as the padding is the same on both sides.
        const fixedSize = padded.every((b) => b.declared.width && b.declared.height);
        const centred = /center$/.test(cs.textAlign) && top === bottom && left === right;
        if (!fixedSize || !centred) {
          const why = fixedSize ? 'does not centre its text, so zeroing' : 'sizes to its content, so zeroing';
          this.manualNote('buttonPadding', `.${cls} ${why} the browser's default padding (${cs.paddingText}) would move its text; set its padding in GWD.`);
          continue;
        }
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
    for (const [cls, seen] of this.byClass(['button'])) {
      const bare = seen.filter((b) => !b.declared.color);
      if (cls.startsWith('#') || !bare.length) continue;
      const colors = [...new Set(bare.map((b) => b.computed.color))];
      if (this.unseenNote(cls)) {
        this.manualNote('buttonColor', `${this.unseenNote(cls)}; set its color in GWD.`);
        continue;
      }
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
        this.manualNote('marginBlock', `.${cls} has margin ${px(cs.marginTop)} / ${px(cs.marginBottom)} today, so margin-block: 0px auto would move its text; add it in GWD and put the text back in place.`);
      } else if (this.unseenNote(cls)) {
        this.manualNote('marginBlock', `${this.unseenNote(cls)}; add margin-block: 0px auto in GWD.`);
      } else {
        safe.set(cls, ['margin-block: 0px auto;']);
      }
    }
    const { edits, parts } = this.classParts(safe);
    this.add('marginBlock', 'Add margin-block: 0px auto', [...safe.keys()].map((c) => `.${c}`).join(', '), edits, parts);
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
      this.blockRules.set(key, this.css.rules.filter((r) => r.start > block.open && r.start < block.close && elementClass(r.selector) === cls));
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
    // Only what a browser keeps counts: a value the CSS values check finds invalid is dropped.
    const declares = (r?: StyleRule) => !!r?.decls.some((d) => (d.prop === 'line-height' || d.prop === 'font') && this.live(d));
    const fontDecls = (r: StyleRule) => r.decls.filter((d) => /^font(-|$)/.test(d.prop) && this.live(d));
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
      } else if (seen.some((b) => b.computed.lineHeight === 'normal' && b.mixedFonts)) {
        refuse(cls, `.${cls}: some of its characters draw in another font (an emoji, a symbol, or Chinese, Japanese or Korean type its font lacks), so its lines are not all one height; set its line-height in GWD.`);
      } else if (seen.some((b) => b.fontAnimated)) {
        refuse(cls, `.${cls}: an animation changes its font while the ad runs, and a fixed line-height would not follow it; set its line-height in GWD.`);
      } else {
        // A media query that is not a GWD size is not modelled: unless it applies in a frame the
        // class was measured in, what it does to the class's font or line-height was never seen.
        const shown = [...new Set(seen.map((b) => b.frame))];
        const other = this.css.media.find((m) => sizeOfMedia(m.media) === null
          && (this.rulesIn(m, cls).some((r) => declares(r) || fontDecls(r).length > 0) || seen.some((b) => b.probes?.[m.start] !== undefined))
          && !shown.some((f) => this.input.media.get(f)?.has(m.media)));
        if (other) refuse(cls, `.${cls}: @media ${other.media} changes its font or line-height in sizes no frame shows; set its line-height in GWD.`);
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
        // No probe: the block sets no font or line-height for it, an element it sits in, or a text inside.
        if (!probed.length && !rules.some((r) => fontDecls(r).length > 0)) continue; // same font as the base size
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
    // Where no frame measured such a block and it changes the font or line-height there, the value
    // is right only if the block comes later and gives the class a line-height of its own, or comes
    // earlier, sets no line-height in its chain (its own one the value would override), and the home
    // block sets every font property it changes. Otherwise the class is left to you.
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
      const fontProps = (m: MediaBlock) => new Set(this.rulesIn(m, w.cls).flatMap((r) => fontDecls(r).map((d) => d.prop)));
      // A probe means the block changes its font or line-height, perhaps through an element it sits in;
      // a null one that what it does there is not known.
      const probed = (m: MediaBlock) => byCls.get(w.cls)!.some((b) => b.probes?.[m.start] !== undefined);
      const ownValue = (m: MediaBlock) => this.rulesIn(m, w.cls).some(declares) || writes.has(`u${(this.rulesIn(m, w.cls).at(-1) ?? m).start}|${w.cls}`);
      const yields = (m: MediaBlock) => {
        if (this.rulesIn(m, w.cls).some(declares) || byCls.get(w.cls)!.some((b) => b.probes?.[m.start] === null)) return false;
        const mine = fontProps(home);
        if (mine.has('font')) return true;
        const theirs = fontProps(m);
        return (theirs.size || !probed(m) ? [...theirs] : ['font-family', 'font-size', 'font-weight', 'font-style']).every((p) => mine.has(p));
      };
      const loose = unmeasured(w.cls).find((m) => m !== home && overlap(m, home) && (fontProps(m).size > 0 || probed(m) || this.rulesIn(m, w.cls).some(declares))
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

    // A page that never showed in a frame may hold the class there, in another font or under
    // another line-height: where its value reaches that frame, nothing checked it.
    for (const cls of byCls.keys()) {
      const reaches = (f: string) => {
        const v = valueIn(cls, f, frames.get(f));
        return v !== undefined && v !== 'declared';
      };
      if (!refused.has(cls) && this.unseen(cls).some(reaches)) refuse(cls, `${this.unseenNote(cls)}; set its line-height in GWD.`);
    }

    // Why what a text inside needs is not known, or '' when it is.
    const unknown = (t: Inheritor) => (!t.fontLoaded ? 'renders in a web font that had not loaded, so what it needs is not known'
      : t.fontAnimated ? 'has its font changed by an animation, so what it needs changes as it plays' : '');
    const change = (t: Inheritor, px?: number) => unknown(t) || (px === undefined ? 'would take a value that is not known' : `would go from ${t.normal}px to ${px}px`);
    // An element on the way down to a text passes a value on where it gets none of its own (an 'inherit' passes it on).
    const passes = (frame: string, size?: string) => (e: { classes: string[] }) => {
      const own = this.mainClass(e.classes);
      const v = own ? valueIn(own, frame, size) : undefined;
      return v === undefined || v === 'inherit';
    };
    // Leaving one class to you can expose text it shielded to another class's value: check until settled.
    for (let changed = true; changed;) {
      changed = false;
      // A class's value reaches every element that carries it, not only the texts it was planned
      // from, and the texts inside such an element, whether or not it has text of its own.
      for (const g of this.input.boxes) {
        if (g.runtime) continue;
        const main = this.mainClass(g.classes);
        for (const cls of g.classes) {
          if (!byCls.has(cls) || refused.has(cls) || (cls === main && planned.has(g))) continue;
          const v = valueIn(cls, g.frame, g.size);
          if (v === undefined || v === 'declared') continue;
          const now = rendered(g);
          const after = v === 'inherit' ? g.parentLineHeight : v;
          if (!g.holder && (now === undefined || after === undefined || !same(now, after))) {
            changed = refuse(cls, `.${cls} is also on ${g.target}${g.declared.lineHeight ? ', which declares its own line-height' : ''}, whose spacing its line-height would change in ${g.frame}; set it in GWD.`) || changed;
            continue;
          }
          const t = (g.inherits ?? []).find((t) => t.path.every(passes(g.frame, g.size)) && (!!unknown(t) || after === undefined || !same(t.normal, after)));
          if (t) changed = refuse(cls, `.${cls} is also on ${g.target}, and ${t.target} inside it takes its line-height and ${change(t, after)} in ${g.frame}; set it in GWD.`) || changed;
        }
      }
      // A value reaches the texts inside that get none of their own.
      for (const b of open) {
        const cls = this.mainClass(b.classes);
        const px = cls ? valueIn(cls, b.frame, b.size) : undefined;
        if (!cls || typeof px !== 'number') continue;
        const d = (b.inherits ?? []).find((t) => t.path.every(passes(b.frame, b.size)) && (!!unknown(t) || !same(t.normal, px)));
        if (d) changed = refuse(cls, `.${cls}: ${d.target} inside it takes its line-height and ${change(d, px)} in ${b.frame}; set their line-heights in GWD.`) || changed;
      }
    }

    const kept = [...writes.values()].filter((w) => !refused.has(w.cls) && !(w.base && noBase.has(w.cls)));
    const edits: Edit[] = [];
    const owner = new Map<Edit, string>(); // the class each edit is for
    const own = (cls: string, e: Edit) => {
      owner.set(e, cls);
      return e;
    };
    const baseAdds = new Map<string, string[]>();
    for (const w of kept) {
      if (w.rule) edits.push(own(w.cls, insertDecl(this.html, w.rule, `line-height: ${w.px}px;`, this.deleted)));
      else if (w.block) edits.push(own(w.cls, insertRule(this.html, w.block, this.selectorOf(w.cls), [`line-height: ${w.px}px;`])));
      else baseAdds.set(w.cls, [`line-height: ${w.px}px;`]);
    }
    const inherits = [...inherit].filter((cls) => !refused.has(cls));
    inherits.forEach((cls) => baseAdds.set(cls, ['line-height: inherit;']));
    edits.push(...this.addToBase(baseAdds, owner));
    refused.forEach((why) => this.manualNote('lineHeight', why));
    noBase.forEach((why, cls) => { if (!refused.has(cls)) this.manualNote('lineHeight', why); });
    const notes = [
      ...kept.map((w) => ({ cls: w.cls, text: `.${w.cls}${w.where ? ` in ${w.where}` : ''}: ${w.px}px` })),
      ...inherits.map((cls) => ({ cls, text: `.${cls}: inherit` })),
    ];
    // One part per class, so a class whose value turns out to move text can be left out alone.
    const parts = [...new Set(notes.map((n) => n.cls))].map((cls) => ({
      name: `.${cls}`,
      edits: edits.filter((e) => owner.get(e) === cls),
      notes: notes.flatMap((n, at) => (n.cls === cls ? [{ at, text: n.text }] : [])),
    }));
    this.add('lineHeight', 'Declare line-height (the value it renders now)', notes.map((n) => n.text).join(', '), edits, parts);
  }

  textFade() {
    const decls = this.input.report.fadeDecls;
    this.add('textFade', 'Start text fades at opacity 0.001', `${decls.length} declaration${decls.length === 1 ? '' : 's'}`, decls.map((d) => setValue(d, '0.001')));
  }

  /**
   * Where a keyframes block runs, for a note: its size, or for one outside @media the frames no size
   * block redefines it in ('' where that is every frame).
   */
  runsIn(block: KeyframesRule): string {
    if (block.media) return ` in ${describeSize(sizeOfMedia(block.media) ?? block.media)}`;
    const frames = [...this.input.media]
      .filter(([, applies]) => !this.css.keyframes.some((k) => k.name === block.name && k.media !== null && applies.has(k.media)))
      .map(([f]) => f);
    return frames.length && frames.length < this.input.media.size ? ` in ${frames.join(', ')}` : '';
  }

  /**
   * Whether an element that draws nothing now can never be shown: no rule or keyframes in any size or
   * state make it, or anything in it, visible, and no script sets its visibility or changes its classes,
   * nor does so to elements the code does not name. Every page must have shown in every size.
   */
  neverShows(h: HiddenSubtree | undefined): boolean {
    const showers = this.input.showers;
    if (!h || !showers || this.input.incomplete?.size) return false;
    const ids = new Set(h.ids);
    const classes = new Set(h.classes);
    if ([...showers.rules, ...showers.animators].some((sel) => mayMatch(sel, ids, classes))) return false;
    if (h.animations.some((a) => showers.keyframes.includes(a))) return false;
    return !showers.scripts.some(({ ref }) => {
      const start = ref === null ? null : refStart(ref);
      return !start || start.deep || ids.has(start.id);
    });
  }

  keyframes() {
    // Where an unchanged value differs from the element's own style, deleting it moves or restyles that
    // element: safe only where every such element never shows.
    const mismatched = new Map<string, PlanInput['safety']>();
    for (const m of this.input.safety) mismatched.set(m.animation, [...(mismatched.get(m.animation) ?? []), m]);
    const edits: Edit[] = [];
    let count = 0;
    let blocks = 0;
    let hidden = 0;
    const roots = new Set<string>();
    for (const { block, props } of this.input.report.unchanged) {
      const ms = mismatched.get(block.name);
      if (ms && !ms.every((m) => this.neverShows(m.hidden))) {
        this.manualNote('keyframes', `${block.name}${this.runsIn(block)}: deleting ${props.join(', ')} would change how it looks, because those values differ from the element's own style.`);
        continue;
      }
      if (ms) {
        hidden++;
        ms.forEach((m) => roots.add(m.hidden!.path));
      }
      blocks++;
      for (const frame of block.frames) {
        for (const d of frame.decls.filter((x) => props.includes(x.prop))) {
          edits.push(removeDecl(this.html, d));
          count++;
        }
      }
    }
    const where = hidden ? `, ${hidden} of them on elements that never show` : '';
    this.add('keyframes', 'Delete keyframe properties that never change', `${count} declarations in ${blocks} keyframes blocks${where}`, edits);
    const fix = this.fixes.find((f) => f.check === 'keyframes');
    if (fix && roots.size) fix.hidden = [...roots];
  }

  cssValues() {
    // Declarations another fix rewrites; that fix replaces the bad value anyway.
    const rewritten = this.fixes.flatMap((f) => f.edits).filter((e) => e.text && e.end > e.start);
    const safe: { edits: Edit[]; notes: string[] } = { edits: [], notes: [] };
    for (const v of this.input.report.cssValues) {
      const handler = v.handler ? ` (in ${v.handler})` : '';
      const file = v.file ? ` in ${v.file}` : '';
      const invalid = `${v.target} ${v.prop}: ${v.value}${handler}${file} ${v.note ? `is ignored: ${v.note}` : 'is not valid CSS, so browsers ignore it'}`;
      if (!v.fixed) {
        this.manualNote('cssValues', `${invalid}; correct it in ${v.file ?? 'GWD'}.`);
        continue;
      }
      // Only the HTML is edited; another file's offsets are not the HTML's.
      if (v.file) {
        this.manualNote('cssValues', `${invalid}; write ${v.fixed} in ${v.file}.`);
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
      // Browsers ignore the value today, so once valid it changes what it styles: only paint on what
      // shows no text is left as it looks.
      const transition = v.prop === 'transition' || v.prop === 'transition-property';
      const paintOnly = transition ? paintOnlyTransition(v.fixed) : PAINT_ONLY.has(v.prop);
      if (!paintOnly || v.showsText !== false) {
        const what = !paintOnly ? 'size, place or animate what it styles, which can move text' : v.showsText ? 'change how its text looks' : 'change how what it styles looks, which may be text';
        this.manualNote('cssValues', `${invalid}; write ${v.fixed} in GWD. Once valid it would ${what}, so it is not changed here.`);
        continue;
      }
      safe.edits.push({ start: v.start, end: v.end, text: v.fixed });
      safe.notes.push(`${v.target} ${v.prop}: ${v.value} -> ${v.fixed}${handler}`);
    }
    this.add('cssValues', 'Write decimal points in CSS values', safe.notes.join(', '), safe.edits);
  }

  /**
   * Puts back a StackAdapt script no tag loads, where StackAdapt's templates load it. iframe-ct.js
   * only reports clicks; param.js opens the landing page, so it is added only where it would open it
   * from the ad's tap areas alone, and nothing in the ad opens pages itself.
   */
  stackAdapt() {
    const sa = this.input.report.stackAdapt;
    if (!sa) return;
    const missing = (name: StackAdaptScript) => !sa.loaded[name] && !sa.elsewhere[name].length;
    const insert = (spot: Spot, name: StackAdaptScript): Edit[] => [{ start: spot.at, end: spot.at, text: `\n${spot.indent}${stackAdaptTag(name)}` }];
    if (missing('iframe-ct.js')) {
      if (sa.head) this.add('stackAdapt', "Load StackAdapt's iframe-ct.js", "In the head, where StackAdapt's templates load it. It reports each click to StackAdapt.", insert(sa.head, 'iframe-ct.js'));
      else this.manualNote('stackAdapt', `iframe-ct.js: the HTML has no head to load it in; add ${stackAdaptTag('iframe-ct.js')} to the head in GWD's code view.`);
    }
    if (missing('param.js')) {
      const taps = `${sa.tapAreas} tap area${sa.tapAreas === 1 ? '' : 's'}`;
      if (!sa.body) {
        this.manualNote('stackAdapt', `param.js: the HTML has no body to load it in; add ${stackAdaptTag('param.js')} at the end of the ad in GWD's code view.`);
      } else if (!sa.tapAreas) {
        this.manualNote('stackAdapt', `param.js: no element has the class dynamicClick, so it would make every part of the ad open the landing page, its controls too; if that is right, add ${stackAdaptTag('param.js')} as the body's last tag in GWD's code view, else give the tap areas that class first.`);
      } else if (sa.ownExits.length) {
        this.manualNote('stackAdapt', `param.js: the ad opens pages itself (${sa.ownExits.join(', ')}), so one click could open two; keep one way, and for param.js add ${stackAdaptTag('param.js')} as the body's last tag in GWD's code view.`);
      } else {
        this.add('stackAdapt', "Load StackAdapt's param.js", `As the body's last tag, after its ${taps} (class dynamicClick), where StackAdapt's templates load it. It opens the landing page when one is clicked.`, insert(sa.body, 'param.js'));
      }
    }
    for (const name of STACKADAPT_SCRIPTS) {
      if (sa.loaded[name] > 1) this.manualNote('stackAdapt', `${name}: ${sa.loaded[name]} script tags load it; delete all but one in GWD's code view.`);
    }
    if (sa.tapAreasAfter) this.manualNote('stackAdapt', `param.js: its tag comes before tap areas it should find; move it to be the body's last tag in GWD's code view.`);
  }
}

/** The fix without one of its parts and that part's edits, or null when nothing is left of it. */
export function withoutPart(fix: PlannedFix, name: string): PlannedFix | null {
  const part = fix.parts?.find((p) => p.name === name);
  if (!part) return fix;
  const parts = fix.parts!.filter((p) => p !== part);
  if (!parts.length) return null;
  const detail = parts.flatMap((p) => p.notes).sort((a, b) => a.at - b.at).map((n) => n.text).join(', ');
  return { ...fix, detail, edits: fix.edits.filter((e) => !part.edits.includes(e)), parts };
}

export function planFixes(input: PlanInput): FixPlan {
  const p = new Planner(input);
  p.buttonPadding(); // first: it decides which declarations disappear
  p.buttonColor();
  p.marginBlock();
  p.lineHeight();
  p.textFade();
  p.keyframes();
  p.stackAdapt();
  p.cssValues(); // last: it skips declarations the other fixes rewrite
  return { fixes: p.fixes, manual: p.manual };
}
