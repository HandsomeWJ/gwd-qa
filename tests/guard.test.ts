import { describe, expect, it } from 'vitest';
import type { LayoutDiff } from '../src/audit/layout';
import type { Edit } from '../src/css/edit';
import { guardPlan } from '../src/fix/guard';
import type { FixPlan, PlannedFix } from '../src/fix/plan';

// The HTML is a string the edits insert markers into; the fake layout check says which markers move text.
const HTML = 'ad:';
const mark = (m: string): Edit => ({ start: HTML.length, end: HTML.length, text: `[${m}]` });
const diff = (over: Partial<LayoutDiff> = {}): LayoutDiff => ({
  size: '310x365', previewed: false, target: 'p#SA_t_1', text: 'Some text', spacing: true, classes: ['gwd-p-t', 'gwd-div-w'], index: 3, ...over,
});

/** A line-height fix with one part per class, each with one edit and one note. */
function lineHeight(...classes: string[]): PlannedFix {
  const parts = classes.map((c, at) => ({ name: `.${c}`, edits: [mark(c)], notes: [{ at, text: `.${c}: 18px` }] }));
  return { check: 'lineHeight', title: 'Declare line-height', detail: parts.map((p) => p.notes[0].text).join(', '), edits: parts.flatMap((p) => p.edits), parts };
}
const other = (check: PlannedFix['check'], m: string): PlannedFix => ({ check, title: check, detail: m, edits: [mark(m)] });

/** A layout check that moves text wherever all of a rule's markers are in the HTML. */
function checker(rules: [string[], LayoutDiff][]) {
  const calls: string[] = [];
  const check = async (html: string, sizes?: string[]) => {
    calls.push(sizes ? `${html} @${sizes.join(',')}` : html);
    return rules.filter(([marks]) => marks.every((m) => html.includes(`[${m}]`))).map(([, d]) => d).filter((d) => !sizes || sizes.includes(d.size));
  };
  return { check, calls };
}

describe('guardPlan', () => {
  it('leaves out of the line-height fix just the class that moves text, and says where', async () => {
    const plan: FixPlan = { fixes: [lineHeight('gwd-p-a', 'gwd-p-t', 'gwd-p-c')], manual: [] };
    const { check } = checker([[['gwd-p-t'], diff()]]);
    await guardPlan(plan, HTML, check);
    const [fix] = plan.fixes;
    expect(fix.moves).toBeUndefined();
    expect(fix.detail).toBe('.gwd-p-a: 18px, .gwd-p-c: 18px');
    expect(fix.edits.map((e) => e.text)).toEqual(['[gwd-p-a]', '[gwd-p-c]']);
    expect(plan.manual).toEqual([{ check: 'lineHeight', detail: '.gwd-p-t: its line-height would change the spacing at 310x365, which no preview shows; set it in GWD.' }]);
  });

  it('tries the classes that lay the text out first, at the size it moved in alone', async () => {
    const plan: FixPlan = { fixes: [lineHeight('gwd-p-a', 'gwd-p-c', 'gwd-p-t')], manual: [] };
    const { check, calls } = checker([[['gwd-p-t'], diff()]]);
    await guardPlan(plan, HTML, check);
    // the whole fix, then without .gwd-p-t (its own class) at 310x365 only, then what is left
    expect(calls).toEqual(['ad:[gwd-p-t][gwd-p-c][gwd-p-a]', 'ad:[gwd-p-c][gwd-p-a] @310x365', 'ad:[gwd-p-c][gwd-p-a]']);
  });

  it('removes the fix when every class moves text, and names a previewed size plainly', async () => {
    const plan: FixPlan = { fixes: [lineHeight('gwd-p-t')], manual: [] };
    await guardPlan(plan, HTML, checker([[['gwd-p-t'], diff({ size: '300x250', previewed: true })]]).check);
    expect(plan.fixes).toEqual([]);
    expect(plan.manual.map((m) => m.detail)).toEqual(['.gwd-p-t: its line-height would change the spacing at 300x250; set it in GWD.']);
  });

  it('leaves out the nearest class first where only several together move text, then looks again', async () => {
    const plan: FixPlan = { fixes: [lineHeight('gwd-p-a', 'gwd-p-t')], manual: [] };
    await guardPlan(plan, HTML, checker([[['gwd-p-a', 'gwd-p-t'], diff()]]).check);
    expect(plan.fixes[0].detail).toBe('.gwd-p-a: 18px');
    expect(plan.manual.map((m) => m.detail)).toEqual(['.gwd-p-t: its line-height would change the spacing at 310x365, which no preview shows; set it in GWD.']);
  });

  it('offers unticked each other fix that moves text, and keeps the rest ticked', async () => {
    const plan: FixPlan = { fixes: [lineHeight('gwd-p-a'), other('marginBlock', 'm'), other('textFade', 'f')], manual: [] };
    const { check, calls } = checker([[['m'], diff({ target: 'p#SA_z_1', spacing: false })]]);
    await guardPlan(plan, HTML, check);
    expect(plan.fixes.map((f) => f.moves)).toEqual([
      undefined,
      'Laid out without scripts, it moves p#SA_z_1 at 310x365, which no preview shows. Check that size in GWD.',
      undefined,
    ]);
    expect(calls).toEqual(['ad:[gwd-p-a]', 'ad:[f][m]', 'ad:[m]', 'ad:[f]']);
  });

  it('lays out each other fix alone only when something moved with all of them', async () => {
    const plan: FixPlan = { fixes: [lineHeight('gwd-p-a'), other('marginBlock', 'm'), other('textFade', 'f')], manual: [] };
    const { check, calls } = checker([]);
    await guardPlan(plan, HTML, check);
    expect(plan.fixes.every((f) => !f.moves)).toBe(true);
    expect(plan.manual).toEqual([]);
    expect(calls).toEqual(['ad:[gwd-p-a]', 'ad:[f][m]']);
  });

  it('offers nothing ticked that it could not lay out', async () => {
    const plan: FixPlan = { fixes: [lineHeight('gwd-p-a'), other('marginBlock', 'm')], manual: [] };
    await guardPlan(plan, HTML, async () => {
      throw new Error('its frame did not load');
    });
    expect(plan.fixes.map((f) => f.moves)).toEqual(Array(2).fill('It could not be laid out without scripts in the sizes no preview shows (its frame did not load). Check those sizes in GWD.'));
  });

  it('trusts no layout that differs without any fix', async () => {
    const plan: FixPlan = { fixes: [lineHeight('gwd-p-a')], manual: [] };
    await guardPlan(plan, HTML, async () => [diff()]);
    expect(plan.fixes[0].moves).toContain('p#SA_t_1 lays out differently each time at 310x365');
    expect(plan.manual).toEqual([]);
  });
});
