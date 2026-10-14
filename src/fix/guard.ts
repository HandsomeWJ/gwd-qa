// The layout safety net over the plan. Every fix offered ticked is laid out without scripts in every
// size, including those no preview shows, at rest and in the ad's hover, focus and click states, and
// must leave every text and line spacing as it is. A class whose line-height would change one is
// left to you; any other fix that would is offered unticked.

import { applyEdits, mergeEdits } from '../css/edit';
import type { LayoutDiff } from '../audit/layout';
import { withoutPart, type FixPlan, type PlannedFix } from './plan';

/** Lays `html` out and lists where it differs from the ad as planned, in every size or only those named. */
export type LayoutCheck = (html: string, sizes?: string[]) => Promise<LayoutDiff[]>;

const where = (d: LayoutDiff) => `${d.size}${d.state ? ` ${d.state}` : d.previewed ? '' : ', which no preview shows'}`;
const sameSpot = (a: LayoutDiff, b: LayoutDiff) => a.size === b.size && a.index === b.index && a.state === b.state;

/** Leaves out of the plan's ticked fixes whatever the layout check finds moving text. */
export async function guardPlan(plan: FixPlan, html: string, check: LayoutCheck): Promise<void> {
  const withFixes = (fixes: PlannedFix[]) => applyEdits(html, mergeEdits(fixes.flatMap((f) => f.edits)));
  try {
    await guardLineHeight(plan, html, check, withFixes);
    await guardOthers(plan, check, withFixes);
  } catch (err) {
    // What could not be laid out was not checked: nothing is offered ticked on the planner's word alone.
    const why = err instanceof Error ? err.message : String(err);
    for (const f of plan.fixes) {
      if (!f.moves) f.moves = `It could not be laid out without scripts in the sizes no preview shows (${why}). Check those sizes in GWD.`;
    }
  }
}

/** Takes out of the line-height fix, class by class, each class whose value changes a layout. */
async function guardLineHeight(plan: FixPlan, html: string, check: LayoutCheck, withFixes: (f: PlannedFix[]) => string) {
  const i = plan.fixes.findIndex((f) => f.check === 'lineHeight' && !f.moves && f.parts?.length);
  if (i < 0) return;
  let fix: PlannedFix | null = plan.fixes[i];
  let diffs = await check(withFixes([fix]));
  while (fix && diffs.length) {
    const d = diffs[0];
    const names = fix.parts!.map((p) => p.name);
    // The classes whose rules lay that text out come first: its own, what it sits in, what sits in it.
    const near = d.classes.map((c) => `.${c}`).filter((n) => names.includes(n));
    const suspects = [...near, ...names.filter((n) => !near.includes(n))];
    let culprit: string | undefined;
    for (const name of suspects) {
      const rest = withoutPart(fix, name);
      if (!(await check(rest ? withFixes([rest]) : html, [d.size])).some((x) => sameSpot(x, d))) {
        culprit = name;
        break;
      }
    }
    if (!culprit) {
      if ((await check(html, [d.size])).some((x) => sameSpot(x, d))) throw new Error(`${d.target} lays out differently each time at ${d.size}`);
      culprit = suspects[0]; // several classes move it together: leave the nearest out, then look again
    }
    const note = `${culprit}: its line-height would change the spacing at ${where(d)}; set it in GWD.`;
    if (!plan.manual.some((m) => m.detail === note)) plan.manual.push({ check: 'lineHeight', detail: note });
    fix = withoutPart(fix, culprit);
    diffs = fix ? await check(withFixes([fix])) : [];
  }
  if (fix) plan.fixes[i] = fix;
  else plan.fixes.splice(i, 1);
}

/** Offers unticked each other ticked fix that changes a layout: first all of them at once, then one by one. */
async function guardOthers(plan: FixPlan, check: LayoutCheck, withFixes: (f: PlannedFix[]) => string) {
  const ticked = plan.fixes.filter((f) => !f.moves && !(f.check === 'lineHeight' && f.parts?.length));
  if (!ticked.length) return;
  const together = await check(withFixes(ticked));
  if (!together.length) return;
  const found: [PlannedFix, LayoutDiff][] = [];
  for (const f of ticked) {
    const d = ticked.length === 1 ? together[0] : (await check(withFixes([f])))[0];
    if (d) found.push([f, d]);
  }
  // None moves it alone, so they do together: each is left to you.
  if (!found.length) ticked.forEach((f) => found.push([f, together[0]]));
  for (const [f, d] of found) {
    const look = d.state ? 'Check that state in the preview.' : d.previewed ? 'Check the result in the preview.' : 'Check that size in GWD.';
    f.moves = `Laid out without scripts, it ${d.spacing ? 'changes the line spacing of' : 'moves'} ${d.target} at ${where(d)}. ${look}`;
  }
}
