import { strFromU8, strToU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PickedFile } from '../src/input';
import { MAX_FILE_BYTES, asOneFile, base64, recordUpload, send, sendable, uploadBody } from '../src/record';

const picked = (entries: Record<string, string>): PickedFile[] => Object.entries(entries).map(([path, text]) => ({ path, data: strToU8(text) }));

describe('asOneFile', () => {
  it('keeps a lone zip or HTML file as it came', () => {
    const [zip] = picked({ 'Ad.zip': 'PK zip bytes' });
    expect(asOneFile([zip])).toMatchObject({ name: 'Ad.zip', type: 'application/zip', bytes: zip.data, picked: 'a zip' });
    expect(asOneFile(picked({ 'Responsive.html': '<html>' }))).toMatchObject({ name: 'Responsive.html', type: 'text/html', picked: 'an HTML file' });
  });

  it('zips a folder under its own name, keeping every path', () => {
    const one = asOneFile(picked({ 'Ad/Responsive.html': '<html>', 'Ad/assets/logo.png': 'png' }));
    expect(one).toMatchObject({ name: 'Ad.zip', type: 'application/zip', picked: 'a folder of 2 files' });
    const files = unzipSync(one.bytes);
    expect(Object.keys(files).sort()).toEqual(['Ad/Responsive.html', 'Ad/assets/logo.png']);
    expect(strFromU8(files['Ad/assets/logo.png'])).toBe('png');
  });

  it('zips loose files together', () => {
    expect(asOneFile(picked({ 'Responsive.html': '<html>', 'gwdpage_min.js': 'js' }))).toMatchObject({ name: 'files.zip', picked: '2 files' });
  });
});

describe('sendable', () => {
  it('encodes the file as base64', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) % 256); // more than one slice of base64()
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    const { file, note } = sendable({ name: 'Ad.zip', type: 'application/zip', bytes, picked: 'a zip' });
    expect(file).toEqual({ name: 'Ad.zip', type: 'application/zip', data: Buffer.from(bytes).toString('base64') });
    expect(note).toBe('');
  });

  it('sends a file over the limit by name only, and says why', () => {
    const big = { name: 'Big.zip', type: 'application/zip', bytes: new Uint8Array(MAX_FILE_BYTES + 1), picked: 'a zip' };
    expect(sendable(big)).toEqual({ file: null, note: 'Not sent: 30.0 MB is over the 30.0 MB limit.' });
    const body = uploadBody(big);
    expect(body).toMatchObject({ kind: 'upload', name: 'Big.zip', file: null });
    expect(body.about).toContain('Not sent:');
  });
});

describe('send', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts JSON as text, so the browser sends no preflight', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetch);
    await send('https://script.google.com/macros/s/x/exec', { kind: 'bug' });
    expect(fetch).toHaveBeenCalledWith('https://script.google.com/macros/s/x/exec', {
      method: 'POST',
      body: '{"kind":"bug"}',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    });
  });

  it("fails with the web app's own reason", async () => {
    vi.stubGlobal('fetch', async () => new Response('{"ok":false,"error":"Too many reports today."}'));
    await expect(send('https://x', {})).rejects.toThrow('Too many reports today.');
    vi.stubGlobal('fetch', async () => new Response('<html>Sign in</html>', { status: 401 }));
    await expect(send('https://x', {})).rejects.toThrow('It did not go through (401).');
  });

  it('records nothing without a web app, and a failed copy only warns', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"ok":false,"error":"down"}'));
    vi.stubGlobal('fetch', fetch);
    recordUpload('', picked({ 'Ad.zip': 'zip' }));
    expect(fetch).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordUpload('https://x', picked({ 'Ad.zip': 'zip' }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('No copy of the ad was kept:', expect.any(Error)));
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({ kind: 'upload', name: 'Ad.zip', file: { name: 'Ad.zip', data: btoa('zip') } });
    warn.mockRestore();
  });
});
