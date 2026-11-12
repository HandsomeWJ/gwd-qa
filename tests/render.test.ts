import { describe, expect, it } from 'vitest';
import { clickFindings, renderFindings } from '../src/audit/render';
import type { ClickBox } from '../src/audit/types';
import { box } from './boxes';

describe('renderFindings', () => {
  it('fails small text that can be seen, with how to fix it, and notes text that never shows', () => {
    const seen = box({ text: 'Tiny', declared: { lineHeight: '9px' }, type: { fontSize: 12, scale: 0.6, onScreen: true, moves: false, hidden: false } });
    const offCanvas = box({ text: 'Away', declared: { lineHeight: '9px' }, type: { fontSize: 6, scale: 1, onScreen: false, moves: false, hidden: false } });
    const [fail, note] = renderFindings([seen, offCanvas]);
    expect(fail).toMatchObject({ check: 'type', level: 'fail', message: '"Tiny" renders at 7.20px.' });
    expect(fail.hint).toBe('It is 12px scaled by 0.60. Scale its group to at least 0.67, raise its font-size to 14px in this size, or hide it in this size.');
    expect(note).toMatchObject({ check: 'type', level: 'note' });
  });

  it('notes, rather than passes, text GWD fits to its box when its fitting could not run', () => {
    const type = { fontSize: 12, scale: 1, onScreen: true, moves: false, hidden: false };
    const [fits] = renderFindings([box({ text: 'Fit me', declared: { lineHeight: '9px' }, fit: 'missing', type })]);
    expect(fits).toMatchObject({ check: 'type', level: 'note' });
    expect(fits.message).toBe('"Fit me" is 12.00px as written, but GWD fits this text to its box when the ad runs, which needs its gwd-text-fitting.js, so its size is not known here: check the whole folder or zip.');
    // fitting only ever shrinks text, so text below 8px still fails
    expect(renderFindings([box({ declared: { lineHeight: '9px' }, fit: 'missing', type: { ...type, fontSize: 6 } })])[0].level).toBe('fail');
    expect(renderFindings([box({ declared: { lineHeight: '9px' }, fit: 'runs', type })])).toEqual([]);
    expect(renderFindings([box({ declared: { lineHeight: '9px' }, fit: 'missing', type: { ...type, onScreen: false } })])).toEqual([]);
  });

  it('judges text hidden when measured where the timeline shows it, and says so where it never does', () => {
    const type = { fontSize: 8, scale: 0.75, onScreen: true, moves: false, hidden: true };
    const at = (shown?: { fontSize: number; scale: number }) => renderFindings([box({ text: 'Learn', declared: { lineHeight: '9px' }, type: { ...type, ...(shown ? { shown } : {}) } })]);
    // a pop-in from 0.75 that settles at 8px
    expect(at({ fontSize: 8, scale: 1 })).toEqual([]);
    const small = at({ fontSize: 8, scale: 0.9 })[0];
    expect(small.message).toBe('"Learn" renders at 7.20px when it shows.');
    expect(small.hint).toBe('It is 8px scaled by 0.90. Scale its group to at least 1.00, raise its font-size to 9px in this size, or hide it in this size.');
    expect(at()[0].message).toBe('"Learn" renders at 6.00px. It is hidden right now, so this only matters if something shows it.');
    // one that shows smaller than it was measured
    expect(renderFindings([box({ text: 'Shrinks', declared: { lineHeight: '9px' }, type: { ...type, scale: 1, shown: { fontSize: 8, scale: 0.5 } } })])[0].message).toBe('"Shrinks" renders at 4.00px when it shows.');
  });

  it('skips declaration checks on word spans a text effect makes at runtime', () => {
    expect(renderFindings([box({ tag: 'span', runtime: true, declared: { marginBlockStart: '' } })])).toEqual([]);
  });

  it('checks line-height, button padding and color, and margin-block, naming the page', () => {
    const button = box({ tag: 'button', page: 'page2', computed: { padding: [1, 6, 1, 6], paddingText: '1px 6px', lineHeight: '17px' } });
    const span = box({ tag: 'span', declared: { lineHeight: '10px', marginBlockStart: '' } });
    expect(renderFindings([button, span]).map((f) => [f.check, f.page, f.message])).toEqual([
      ['lineHeight', 'page2', 'No line-height (renders 17px).'],
      ['buttonPadding', 'page2', 'Padding is 1px 6px.'],
      ['buttonColor', 'page2', 'No explicit color (renders rgb(0, 0, 0)).'],
      ['marginBlock', undefined, 'Missing margin-block: 0px auto.'],
    ]);
  });
});

describe('pointer cursor', () => {
  const click = (cursor: string, more: Partial<ClickBox> = {}): ClickBox => ({ frame: '300x250', page: '', target: 'div#SA_x', id: 'SA_x', tag: 'div', classes: [], why: 'a GWD click event', cursor, own: '', inert: false, ...more });

  it('fails the default cursors, notes a custom one, and skips what no click reaches', () => {
    const out = clickFindings([click('pointer'), click('auto'), click('default', { own: 'default' }), click('grab'), click('auto', { inert: true })]);
    expect(out.map((f) => [f.level, f.message])).toEqual([
      ['fail', "Clickable through a GWD click event, but it shows the browser's default cursor (an arrow, or a text cursor over text), not the pointer."],
      ['fail', 'Clickable through a GWD click event, but it shows the arrow, not the pointer.'],
      ['note', 'Clickable through a GWD click event; it shows cursor: grab, taken as a custom cursor of its own.'],
    ]);
    expect(out[1].hint).toBe('Its own CSS sets cursor: default; set cursor: pointer in GWD.');
  });
});
