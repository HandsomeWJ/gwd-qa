import { describe, expect, it } from 'vitest';
import { layoutSizes } from '../src/audit/layout';

const keys = (served: string[], media?: string[]) => layoutSizes(served, media).map((s) => s.key);

describe('layoutSizes', () => {
  it('lays out every served exact size', () => {
    expect(layoutSizes(['300x250', '728x90'])).toEqual([
      { key: '300x250', width: 300, height: 250, previewed: true },
      { key: '728x90', width: 728, height: 90, previewed: true },
    ]);
  });

  it('lays out a range at both ends, its middle, and just around each exact size inside it', () => {
    const sizes = layoutSizes(['300x600', '300x250:320x480', '300x250', '320x480']);
    expect(sizes.map((s) => s.key)).toEqual([
      '300x600', '300x250', '320x480', '310x365',
      '300x251', '301x250', '301x251', // just inside the range from 300x250
      '319x479', '319x480', '320x479', // and from 320x480
    ]);
    expect(sizes.filter((s) => !s.previewed).map((s) => s.key)).toEqual(['310x365', '300x251', '301x250', '301x251', '319x479', '319x480', '320x479']);
  });

  it('lays out a range nested in another inside and around its corners, where its block starts or stops applying', () => {
    const sizes = keys(['300x250:336x480', '310x300:320x400']);
    for (const inside of ['315x350', '310x300', '320x400', '310x400', '320x300', '311x301', '319x399']) expect(sizes, inside).toContain(inside);
    for (const around of ['309x299', '321x401', '309x401', '321x299']) expect(sizes, around).toContain(around);
    expect(sizes).toContain('318x365'); // the middle of the outer range
  });

  it('keeps a range\'s orientation, and lays out the edge where it starts', () => {
    const portrait = keys(['300x250:320x480:p']);
    expect(portrait).toEqual(['300x300', '320x480', '310x365', '310x310']);
    const landscape = layoutSizes(['300x250:500x300:l']);
    expect(landscape.every((s) => s.width > s.height)).toBe(true);
    expect(landscape.map((s) => s.key)).toContain('300x299'); // the first landscape size inside its bounds
  });

  it('lays out either side of a width or height another media query names inside a range', () => {
    const sizes = keys(['300x250:320x480'], ['(min-width: 305px) and (max-width: 315px)', '(max-height: 400px)', '(width: 300px) and (height: 250px)']);
    for (const k of ['304x365', '305x365', '306x365', '314x365', '315x365', '316x365', '310x399', '310x400', '310x401']) expect(sizes, k).toContain(k);
  });

  it('lays out a size block for a size that is not served where a range reaches it', () => {
    expect(keys(['300x250:320x480'], ['(width: 310px) and (height: 400px)'])).toEqual(expect.arrayContaining(['310x400', '309x399', '311x401']));
  });

  it('skips what is not a size', () => {
    expect(keys(['300x250:200x100', 'banner'])).toEqual([]);
  });
});
