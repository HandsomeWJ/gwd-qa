// Network policy helpers: which outside hosts an ad's code refers to, and which ?zip= URLs the page accepts.

const FONT_HOSTS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.bunny\.net)$/i;
// Namespace identifiers, never requested.
const NOT_REQUESTED = /(^|\.)w3\.org$/i;

export interface OutsideHost {
  host: string;
  fonts: boolean;
}

/** Hosts other than this site that the ad's HTML refers to, with font hosts marked. */
export function outsideHosts(html: string, ownHost: string): OutsideHost[] {
  const hosts = new Set<string>();
  for (const m of html.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
    const host = m[1].toLowerCase();
    if (host !== ownHost.toLowerCase() && !NOT_REQUESTED.test(host)) hosts.add(host);
  }
  return [...hosts].sort().map((host) => ({ host, fonts: FONT_HOSTS.test(host) }));
}

/**
 * ?zip= loads only zips stored on this site under the app's own folder. Any other URL could
 * run someone else's HTML on this origin, which every Pages site of the account shares.
 */
export function allowedZipUrl(raw: string, pageHref: string, base: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw, pageHref);
  } catch {
    return null;
  }
  return url.origin === new URL(pageHref).origin && url.pathname.startsWith(base) ? url : null;
}
