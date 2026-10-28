// Which browser engine draws the preview. Fixes are planned only in Chrome's (Blink): GWD previews
// ads in it, and a fix keeps the ad exactly as the browser that measured it draws it, so one measured
// in Safari or Firefox could move text in Chrome.

export interface Engine {
  name: 'Chrome' | 'Safari' | 'Firefox' | 'this browser';
  /** Chrome's engine: Chrome, Edge, Brave and Opera on a computer or Android. */
  chrome: boolean;
}

export function engineOf(userAgent: string): Engine {
  // Every browser on an iPhone or iPad draws with Safari's engine, whatever it is called.
  if (/\b(CriOS|FxiOS|EdgiOS|OPiOS)\//.test(userAgent)) return { name: 'Safari', chrome: false };
  if (/\bFirefox\//.test(userAgent)) return { name: 'Firefox', chrome: false };
  if (/\b(Headless)?(Chrome|Chromium)\//.test(userAgent)) return { name: 'Chrome', chrome: true };
  if (/\bAppleWebKit\//.test(userAgent)) return { name: 'Safari', chrome: false };
  return { name: 'this browser', chrome: false };
}
