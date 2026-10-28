// The layout safety net over the plan. Every fix is laid out without scripts in every size, including
// those no preview shows, at rest and in the ad's hover, focus and click states, and must leave every
// text and line spacing as it is. Whatever would change one is taken out of the plan and left to you,
// with a note: a class at a time where a fix has a part per class, else the whole fix.

import { applyEdits, mergeEdits } from '../css/edit';
import type { LayoutDiff } from '../audit/layout';
import type { CheckId } from '../audit/types';
import { withoutPart, type FixPlan, type PlannedFix } from './plan';

/** Lays `html` out and lists where it differs from the ad as planned, in every size or only those named. */
export type LayoutCheck = (html: string, sizes?: string[]) => Promise<LayoutDiff[]>;

type WithFixes = (fixes: PlannedFix[]) => string;

const where = (d: LayoutDiff) => `${d.size}${d.state ? ` ${d.state}` : d.previewed ? '' : ', which no preview shows'}`;
const sameSpot = (a: LayoutDiff, b: LayoutDiff) => a.size === b.size && a.index === b.index && a.state === b.state;
const changes = (d: LayoutDiff) => `${d.spacing ? 'change the line spacing of' : 'move'} ${d.target} at ${where(d)}`;

function note(plan: FixPlan, check: CheckId, detail: string) {
  if (!plan.manual.some((m) => m.detail === detail)) plan.manual.push({ check, detail });
}

/** Takes out of the plan whatever the layout check finds moving text, with a note for each. */
export async function guardPlan(plan: FixPlan, html: string, check: LayoutCheck): Promise<void> {
  const withFixes: WithFixes = (fixes) => applyEdits(html, mergeEdits(fixes.flatMap((f) => f.edits)));
  try {
    await guardParts(plan, plan.fixes.find((f) => f.check === 'lineHeight' && f.parts?.length), html, check, withFixes);
    await guardOthers(plan, html, check, withFixes);
  } catch (err) {
    // What could not be laid out was not checked: no fix is offered on the planner's word alone.
    const why = err instanceof Error ? err.message : String(err);
    for (const f of plan.fixes) {
      note(plan, f.check, `${f.title} (${f.detail}): it could not be laid out without scripts in the sizes no preview shows (${why}), so it was not checked there; check the ad again, or do it in GWD.`);
    }
    plan.fixes.length = 0;
  }
}

/** Takes out of a fix, part by part, each part that changes a layout. */
async function guardParts(plan: FixPlan, start: PlannedFix | undefined, html: string, check: LayoutCheck, withFixes: WithFixes) {
  if (!start) return;
  const i = plan.fixes.indexOf(start);
  let fix: PlannedFix | null = start;
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
    note(plan, fix.check, fix.check === 'lineHeight'
      ? `${culprit}: its line-height would change the spacing at ${where(d)}; set it in GWD.`
      : `${culprit}: "${fix.title}" would ${changes(d)}; do it in GWD.`);
    fix = withoutPart(fix, culprit);
    diffs = fix ? await check(withFixes([fix])) : [];
  }
  if (fix) plan.fixes[i] = fix;
  else plan.fixes.splice(i, 1);
}

/** Takes out each other fix, or part of one, that changes a layout: first all of them at once, then one by one. */
async function guardOthers(plan: FixPlan, html: string, check: LayoutCheck, withFixes: WithFixes) {
  for (;;) {
    const others = plan.fixes.filter((f) => !(f.check === 'lineHeight' && f.parts?.length));
    if (!others.length) return;
    const together = await check(withFixes(others));
    if (!together.length) return;
    const drop = (f: PlannedFix, d: LayoutDiff) => {
      plan.fixes.splice(plan.fixes.indexOf(f), 1);
      note(plan, f.check, `"${f.title}" (${f.detail}) would ${changes(d)}; do it in GWD.`);
    };
    let alone = false;
    for (const f of others) {
      const d = others.length === 1 ? together[0] : (await check(withFixes([f])))[0];
      if (!d) continue;
      alone = true;
      if (f.parts?.length) await guardParts(plan, f, html, check, withFixes);
      else drop(f, d);
    }
    // None moves it alone, so they do together: each is left to you.
    if (!alone) {
      for (const f of others) drop(f, together[0]);
      return;
    }
  }
}
