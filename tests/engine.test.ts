import { describe, expect, it } from 'vitest';
import { engineOf } from '../src/engine';

describe('engineOf', () => {
  const cases: [string, string, boolean][] = [
    ['Chrome on a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', true],
    ['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', true],
    ['Chrome run by a test', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36', true],
    ['Chrome on Android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', true],
    ['Safari on a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15', false],
    ['Safari on an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', false],
    ['Chrome on an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1', false],
    ['Firefox on a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0', false],
    ['Firefox on an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15', false],
  ];
  it.each(cases)('%s', (_, ua, chrome) => {
    expect(engineOf(ua).chrome).toBe(chrome);
  });

  it('names the engine that draws the page', () => {
    expect(cases.map(([, ua]) => engineOf(ua).name)).toEqual(['Chrome', 'Chrome', 'Chrome', 'Chrome', 'Safari', 'Safari', 'Safari', 'Firefox', 'Safari']);
    expect(engineOf('Lynx/2.9').name).toBe('this browser');
  });
});
