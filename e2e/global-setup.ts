// Runs once the site is served, before any test: refuses a site that posts copies and bug reports
// anywhere but the stand-in web app, then starts the proxies of Safari's and Firefox's engines.
import type { FullConfig } from '@playwright/test';
import { TEST_RECORD_URL } from '../playwright.config';
import { PROXY_PORTS, startProxies } from './proxy';

export default async function globalSetup(config: FullConfig) {
  const site = config.webServer?.url;
  if (site) {
    // Outside CI a server already running on the port is reused, whatever it was built with. The
    // page's CSP names every web app it can post to.
    const html = await (await fetch(site)).text();
    for (const url of new Set(html.match(/https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec/g))) {
      if (url !== TEST_RECORD_URL) {
        throw new Error(`The site at ${site} posts copies of the ads it checks to ${url}. The browser tests run only against a build that posts them to ${TEST_RECORD_URL}: stop that server and let the tests build their own.`);
      }
    }
  }
  return startProxies(Object.values(PROXY_PORTS));
}
