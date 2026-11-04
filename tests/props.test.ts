import { describe, expect, it } from 'vitest';
import { looksSame } from '../src/audit/props';

describe('looksSame', () => {
  it('passes values apart only by rounding', () => {
    expect(looksSame('51.36px', '51.3482px')).toBe(true);
    expect(looksSame('matrix(1, 0, 0, 1, 0, 0)', 'matrix(1, 0, 0, 1, 0, 6.12323e-17)')).toBe(true);
    expect(looksSame('rgba(0, 0, 0, 0.2)', 'rgba(0, 0, 0, 0.2000001)')).toBe(true);
    expect(looksSame('translate3d(0px, -114px, 0px)', 'translate3d(0.02px, -114.03px, 0px)')).toBe(true);
    expect(looksSame(undefined, undefined)).toBe(true);
  });

  it('fails any difference someone could see, and other words', () => {
    expect(looksSame('256px', '202px')).toBe(false);
    expect(looksSame('51.36px', '51.3px')).toBe(false);
    expect(looksSame('0.5', '1')).toBe(false);
    expect(looksSame('rgb(255, 200, 0)', 'rgb(255, 200, 1)')).toBe(false);
    expect(looksSame('matrix(1, 0, 0, 1, 0, 0)', 'matrix(1, 0, 0, 1, 0, 0.01)')).toBe(false);
    expect(looksSame('visible', 'hidden')).toBe(false);
    expect(looksSame('10px', '10%')).toBe(false);
    expect(looksSame('none', undefined)).toBe(false);
  });
});
