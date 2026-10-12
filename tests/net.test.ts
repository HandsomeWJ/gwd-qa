import { describe, expect, it } from 'vitest';
import { allowedZipUrl, outsideHosts } from '../src/net';

describe('outsideHosts', () => {
  it('lists the hosts an ad refers to, marks fonts, skips this site and namespaces', () => {
    const html = `
      <script src="https://creative.example-adserver.com/js/ct.js"></script>
      <link href="https://fonts.googleapis.com/css?family=Montserrat" rel="stylesheet">
      <svg xmlns="http://www.w3.org/2000/svg"></svg>
      <script>createPixel(["https://tags.example-adserver.com/conv?cid=1"]); fetch("https://me.github.io/x");</script>
      <p>// a comment, not a URL</p>`;
    expect(outsideHosts(html, 'me.github.io')).toEqual([
      { host: 'creative.example-adserver.com', fonts: false },
      { host: 'fonts.googleapis.com', fonts: true },
      { host: 'tags.example-adserver.com', fonts: false },
    ]);
  });
});

describe('allowedZipUrl', () => {
  const page = 'https://me.github.io/gwd-qa/?zip=x';
  const base = '/gwd-qa/';

  it('accepts zips stored under the app folder on this site', () => {
    expect(allowedZipUrl('/gwd-qa/local-fixtures/a.zip', page, base)?.pathname).toBe('/gwd-qa/local-fixtures/a.zip');
    expect(allowedZipUrl('samples/a.zip', page, base)?.pathname).toBe('/gwd-qa/samples/a.zip');
  });

  it('refuses other sites, other folders on this site, and odd schemes', () => {
    for (const raw of ['https://evil.example/a.zip', '//evil.example/a.zip', '/other-repo/a.zip', 'data:application/zip;base64,AA==', 'javascript:alert(1)', 'http://me.github.io/gwd-qa/a.zip']) {
      expect(allowedZipUrl(raw, page, base), raw).toBeNull();
    }
  });
});
