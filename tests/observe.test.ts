import { describe, expect, it } from 'vitest';
import { comparePositions } from '../src/audit/observe';

describe('comparePositions', () => {
  const before = new Map([
    ['300x250 p#a "Headline"', '10,10,80,18 block'],
    ['300x250 p#a "Headline" (2)', '10,40,80,18 block'],
    ['300x250 span.x "one"', '50,10,20,18 inline'],
    ['300x250 p#a line-height', '18px'],
    ['300x250 p#a line-height (2)', '18px'],
    ['300x250 span.x line-height', '18px'],
  ]);

  it('counts texts and line spacings apart', () => {
    const same = comparePositions(before, new Map(before));
    expect(same).toMatchObject({ texts: 3, moved: [], spacings: 3, respaced: [] });
  });

  it('counts apart the texts inside elements a fix proved never show', () => {
    const at = new Map([
      ['300x250 p#a "Headline"', '10,10,80,18 block @1/2'],
      ['300x250 p#t "Ghost"', '40,200,80,18 block @1/3/0'],
      ['300x250 p#t "Ghost" (2)', '40,220,80,18 block @1/30'],
    ]);
    const after = new Map([...at].map(([k, v]) => [k, v.replace('40,', '10,')]));
    // only what sits inside 1/3 is unseen; 1/30 is another element
    expect(comparePositions(at, after, ['1/3'])).toMatchObject({ texts: 2, moved: ['300x250 p#t "Ghost" (2)'], unseen: ['300x250 p#t "Ghost"'] });
    expect(comparePositions(at, after)).toMatchObject({ texts: 3, moved: ['300x250 p#t "Ghost"', '300x250 p#t "Ghost" (2)'], unseen: [] });
  });

  it('lists moved texts and changed line spacings apart, a missing one as changed', () => {
    const after = new Map(before);
    after.set('300x250 p#a "Headline"', '10,11,80,18 block');
    after.set('300x250 span.x line-height', '19px');
    after.delete('300x250 p#a line-height (2)');
    after.delete('300x250 span.x "one"');
    expect(comparePositions(before, after)).toMatchObject({
      texts: 3,
      moved: ['300x250 p#a "Headline"', '300x250 span.x "one"'],
      spacings: 3,
      respaced: ['300x250 p#a line-height (2)', '300x250 span.x line-height'],
    });
  });
});
