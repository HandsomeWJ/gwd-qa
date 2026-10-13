import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { findAdHtml, isGwdBackup, readZip, writeZip } from '../src/zip';

const gwd = '<html><head><meta name="generator" content="Google Web Designer 16"></head><body><gwd-genericad></gwd-genericad></body></html>';

function makeZip(entries: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) input[k] = strToU8(v);
  return zipSync(input);
}

describe('readZip', () => {
  it('finds the GWD HTML and ignores stale copies and macOS junk', () => {
    const pkg = readZip('ad.zip', makeZip({
      'Ad/': '',
      'Ad/_revision/Responsive.html': gwd,
      'Ad/gwd_preview_Responsive/index.html': gwd,
      'Ad/Responsive.html': gwd,
      'Ad/assets/a b (1).png': 'png',
      '__MACOSX/Ad/._Responsive.html': 'junk',
      'Ad/.DS_Store': 'junk',
    }));
    expect(pkg.htmlPath).toBe('Ad/Responsive.html');
    expect(pkg.entries).toEqual(['Ad/', 'Ad/_revision/Responsive.html', 'Ad/gwd_preview_Responsive/index.html', 'Ad/Responsive.html', 'Ad/assets/a b (1).png']);
  });

  it('prefers a GWD page over other HTML at the same depth', () => {
    const files = new Map([['index.html', strToU8('<html>plain</html>')], ['Responsive.html', strToU8(gwd)]]);
    expect(findAdHtml(files)).toBe('Responsive.html');
  });
});

describe('writeZip', () => {
  it('keeps every entry in order and swaps in changed files', () => {
    const pkg = readZip('ad.zip', makeZip({ 'Ad/': '', 'Ad/Responsive.html': gwd, 'Ad/assets/x.png': 'png' }));
    const out = unzipSync(writeZip(pkg, new Map([['Ad/Responsive.html', strToU8('changed')]])));
    expect(Object.keys(out)).toEqual(['Ad/', 'Ad/Responsive.html', 'Ad/assets/x.png']);
    expect(strFromU8(out['Ad/Responsive.html'])).toBe('changed');
    expect(strFromU8(out['Ad/assets/x.png'])).toBe('png');
  });
});

describe('upload-ready zip', () => {
  it('leaves out GWD backup and preview copies, and nothing else', () => {
    const pkg = readZip('ad.zip', makeZip({
      'Ad/': '',
      'Ad/_revision/': '',
      'Ad/_revision/Responsive.html': gwd,
      'Ad/gwd_preview_Responsive/index.html': gwd,
      'Ad/_revisions/Responsive.html': gwd,
      'Ad/_revisions/gwd_preview_Responsive/index.html': gwd,
      'Ad/Responsive.html': gwd,
      'Ad/gwd_workspace.json': '{}',
    }));
    const out = unzipSync(writeZip(pkg, new Map(), isGwdBackup));
    expect(Object.keys(out)).toEqual(['Ad/', 'Ad/Responsive.html', 'Ad/gwd_workspace.json']);
  });
});
