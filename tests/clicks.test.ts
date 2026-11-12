import { describe, expect, it } from 'vitest';
import { clickAudit } from '../src/audit/clicks';
import { parseCss } from '../src/css/parse';
import { fixture } from './fixture';

const audit = (html: string, param = true) => clickAudit(html, new DOMParser().parseFromString(html, 'text/html'), parseCss(html), param);
const INLINE = '[onclick], [ondblclick], [onmousedown], [onmouseup], [ontouchstart], [ontouchend], [onpointerdown], [onpointerup]';

describe('clickable elements', () => {
  it('takes the whole ad, and its form controls, where param.js loads and nothing has the class dynamicClick', () => {
    const r = audit(fixture('mini-ad.html'));
    expect(r.wholeAd).toBe(true);
    expect(r.refs.map((x) => x.ref)).toEqual(['gwd-genericad', 'button, input, select, textarea']);
    expect(audit(fixture('mini-ad.html'), false)).toEqual({ refs: [], wholeAd: false });
  });

  it("takes GWD tap and click events, listeners by id, inline handlers, links and StackAdapt's tap areas, never a hover", () => {
    const html = `<html><head><script>
      window.gwd = window.gwd || { actions: { events: {} } };
      gwd.actions.events.registerEventHandlers = function(event) {
        gwd.actions.events.addHandler('SA_clicktag_1', 'mouseover', gwd.over, false);
        gwd.actions.events.addHandler('replay_button', 'action', gwd.replay, false);
        gwd.actions.events.addHandler('SA_group_1 grp-cta', 'click', gwd.go, false);
      };
      function wire() { document.getElementById('SA_more').addEventListener('click', function () {}); }
    </script></head><body><gwd-genericad id="gwd-ad">
      <gwd-taparea id="SA_clicktag_1" class="dynamicClick gwd-taparea-a"></gwd-taparea>
      <div id="SA_more"></div><div onclick="go()"></div><a href="https://example.com/">x</a>
    </gwd-genericad></body></html>`;
    const r = audit(html);
    expect(r.wholeAd).toBe(false);
    expect(r.refs.map((x) => [x.kind, x.ref, x.why])).toEqual([
      ['gwd', 'replay_button', 'a GWD action event'],
      ['gwd', 'SA_group_1 grp-cta', 'a GWD click event'],
      ['gwd', 'SA_more', 'a click listener in its code'],
      ['selector', INLINE, 'an inline event handler'],
      ['selector', 'a[href]', 'a link'],
      ['selector', '.dynamicClick', "the class dynamicClick, which StackAdapt's param.js opens the landing page from"],
    ]);
  });
});
