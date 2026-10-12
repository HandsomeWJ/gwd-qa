import { describe, expect, it } from 'vitest';
import { sizeOfMedia } from '../src/css/parse';
import { describeSize, frameSizes, parseSize } from '../src/sizes';

describe('parseSize', () => {
  it('reads exact sizes, ranges and orientations the way GWD writes them', () => {
    expect(parseSize('300x250')).toEqual({ key: '300x250', min: [300, 250], max: [300, 250], orientation: null });
    expect(parseSize('300x250:320x480')).toMatchObject({ min: [300, 250], max: [320, 480], orientation: null });
    expect(parseSize('320x50:728x90:l')?.orientation).toBe('landscape');
    expect(parseSize('300x600:320x1000:p')?.orientation).toBe('portrait');
  });

  it('refuses anything else', () => {
    for (const key of ['300', '300x', '300x250:l', '320x480:300x250', 'axb', '300 x 250']) expect(parseSize(key), key).toBeNull();
  });
});

describe('frameSizes', () => {
  it('previews an exact size once, at that size', () => {
    expect(frameSizes('300x250')).toEqual([{ size: '300x250', label: '300x250', width: 300, height: 250 }]);
  });

  it('previews a range at its smallest and largest sizes', () => {
    expect(frameSizes('300x250:320x480').map((f) => [f.width, f.height, f.label])).toEqual([
      [300, 250, '300x250 (range 300x250 to 320x480)'],
      [320, 480, '320x480 (range 300x250 to 320x480)'],
    ]);
  });

  it('keeps a range orientation: portrait needs height >= width, landscape width > height', () => {
    expect(frameSizes('300x250:600x500:p').map((f) => [f.width, f.height])).toEqual([[300, 300], [500, 500]]);
    expect(frameSizes('200x300:400x500:l').map((f) => [f.width, f.height])).toEqual([[301, 300], [400, 399]]);
  });

  it('gives no frames for a range no size fits, or a key that is not a size', () => {
    expect(frameSizes('400x100:500x300:p')).toEqual([]);
    expect(frameSizes('fluid')).toEqual([]);
  });

  it('dedupes a range whose two ends land on one size', () => {
    expect(frameSizes('300x300:300x300:p').map((f) => [f.width, f.height])).toEqual([[300, 300]]);
  });
});

describe('describeSize and sizeOfMedia', () => {
  it('names ranges in words and leaves exact sizes alone', () => {
    expect(describeSize('300x250')).toBe('300x250');
    expect(describeSize('320x50:728x90:l')).toBe('320x50 to 728x90, landscape');
    expect(describeSize('base')).toBe('base');
  });

  it('maps GWD media conditions back to their size keys', () => {
    expect(sizeOfMedia('(width: 300px) and (height: 250px)')).toBe('300x250');
    expect(sizeOfMedia('(min-width: 300px) and (max-width: 320px) and (min-height: 250px) and (max-height: 480px)')).toBe('300x250:320x480');
    expect(sizeOfMedia('(orientation: landscape) and (min-width: 320px) and (max-width: 728px) and (min-height: 50px) and (max-height: 90px)')).toBe('320x50:728x90:l');
    expect(sizeOfMedia('(max-width: 600px)')).toBeNull();
  });
});
