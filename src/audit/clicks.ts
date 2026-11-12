// What the ad makes clickable, for the pointer cursor check: GWD event handlers for taps and clicks,
// StackAdapt's tap areas (class dynamicClick, which param.js opens the landing page from, or every
// element when none has it), inline handlers, links, and listeners the ad's own scripts add.

import type { CssModel } from '../css/parse';
import { readAd, type AdFiles } from './cssvalues';

/** How the frames find a clickable element: a GWD event reference ('id', or 'groupId grpId') or a selector. */
export interface ClickRef {
  ref: string;
  kind: 'gwd' | 'selector';
  why: string;
}

export interface ClickReport {
  refs: ClickRef[];
  /** param.js loads and no element has the class dynamicClick, so every element opens the landing page. */
  wholeAd: boolean;
}

const EVENTS = 'action|click|tap|dblclick|mousedown|mouseup|touchstart|touchend|pointerdown|pointerup';
const CLICK_EVENT = new RegExp(`^(${EVENTS})$`);
const INLINE = EVENTS.split('|').filter((e) => e !== 'action' && e !== 'tap').map((e) => `[on${e}]`).join(', ');
// A listener the ad's own code adds to an element it names: by id, by selector, or through jQuery.
const BY_ID = new RegExp(`getElementById\\(\\s*(['"])([\\w-]+)\\1\\s*\\)\\s*\\.\\s*(?:addEventListener\\(\\s*(['"])(${EVENTS})\\3|on(${EVENTS})\\s*=(?!=))`, 'g');
const BY_SELECTOR = new RegExp(`querySelector\\(\\s*(['"])([^'"]+)\\1\\s*\\)\\s*\\.\\s*(?:addEventListener\\(\\s*(['"])(${EVENTS})\\3|on(${EVENTS})\\s*=(?!=))`, 'g');
const JQUERY = new RegExp(`\\$\\(\\s*(['"])([^'"]+)\\1\\s*\\)\\s*\\.\\s*(?:on\\(\\s*(['"])(${EVENTS})\\3|(${EVENTS})\\s*\\()`, 'g');

/** Whether anything matches, on the page or in GWD's group definitions. */
function exists(doc: Document, selector: string): boolean {
  try {
    return [doc, ...[...doc.querySelectorAll('template')].map((t) => t.content)].some((root) => !!root.querySelector(selector));
  } catch {
    return false;
  }
}

export function clickAudit(html: string, doc: Document, css: CssModel, paramLoaded: boolean, ad?: AdFiles): ClickReport {
  const refs: ClickRef[] = [];
  const add = (r: ClickRef) => {
    if (!refs.some((x) => x.ref === r.ref && x.kind === r.kind)) refs.push(r);
  };
  // GWD registers each event handler with gwd.actions.events.addHandler(element, event, handler).
  for (const m of html.matchAll(/\baddHandler\(\s*(['"])(.*?)\1\s*,\s*(['"])(.*?)\3/g)) {
    if (CLICK_EVENT.test(m[4]) && m[2].trim()) add({ ref: m[2].trim(), kind: 'gwd', why: `a GWD ${m[4]} event` });
  }
  readAd(html, css, ad, [], {
    sheet: () => {},
    script: (text, from, to) => {
      const code = text.slice(from, to);
      for (const m of code.matchAll(BY_ID)) add({ ref: m[2], kind: 'gwd', why: `a ${m[4] ?? m[5]} listener in its code` });
      for (const m of [...code.matchAll(BY_SELECTOR), ...code.matchAll(JQUERY)]) {
        if (exists(doc, m[2])) add({ ref: m[2], kind: 'selector', why: `a ${m[4] ?? m[5]} listener in its code` });
      }
    },
  });
  if (exists(doc, INLINE)) add({ ref: INLINE, kind: 'selector', why: 'an inline event handler' });
  if (exists(doc, 'a[href]')) add({ ref: 'a[href]', kind: 'selector', why: 'a link' });
  const taps = exists(doc, '.dynamicClick');
  if (taps) add({ ref: '.dynamicClick', kind: 'selector', why: "the class dynamicClick, which StackAdapt's param.js opens the landing page from" });
  const wholeAd = paramLoaded && !taps;
  if (wholeAd) {
    // The pointer then belongs on the whole ad; form controls show their own cursor unless given one.
    const why = "StackAdapt's param.js, which opens the landing page from every element when none has the class dynamicClick";
    add({ ref: doc.querySelector('gwd-genericad') ? 'gwd-genericad' : 'body', kind: 'selector', why });
    if (exists(doc, 'button, input, select, textarea')) add({ ref: 'button, input, select, textarea', kind: 'selector', why });
  }
  return { refs, wholeAd };
}
