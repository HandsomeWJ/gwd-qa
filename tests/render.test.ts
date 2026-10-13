import { describe, expect, it } from 'vitest';
import { renderFindings } from '../src/audit/render';
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
