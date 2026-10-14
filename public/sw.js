// Serves the unzipped ad to the preview frames. The page stores each file in the ad's own
// cache, gwdqa-ad-<id>, under a canonical key; requests under <scope>__ad/<id>/ are answered
// from there, so the ad's relative paths work and every frame shares the page's origin.
const PREFIX = 'gwdqa-ad-';

// Unless the frame URL carries net=open, the ad's HTML gets this policy, so the browser blocks
// every request to another site (trackers, pixels, ad-server scripts, beacons, frames) at the
// source. Stylesheets and fonts from any https host still load, so text renders as it really does.
const BLOCK_THIRD_PARTY = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
].join('; ');

// GWD's runtime files, such as gwdpage_min.js, gwd-events-support.1.0.js, groups_runtime.min.1.0.js
// and gwdpage_style.css (the same rule as missingRuntime() in src/zip.ts). An ad dropped as just its
// HTML, or an incomplete folder, loads them without having them, so a missing script gets the site's
// own stand-in (gwd-standin.js) and a missing style is empty. The stand-in is told which of GWD's
// scripts the ad does include, so it leaves those to define their own elements.
const GWD_SCRIPT = /^(gwd|groups_runtime)[\w.-]*\.js$/i;
const GWD_STYLE = /^gwd[\w.-]*\.css$/i;
const INCLUDED = '/* included */ []'; // where the stand-in takes the names of those scripts
let standin = null; // the stand-in's text, fetched once per worker

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  const prefix = `${scope.pathname}__ad/`;
  if (url.origin !== scope.origin || !url.pathname.startsWith(prefix)) return;
  event.respondWith(serve(url, scope, prefix));
});

async function serve(url, scope, prefix) {
  const rest = url.pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  const id = rest.slice(0, slash);
  let path = rest.slice(slash + 1);
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path when it is not valid percent-encoding
  }
  const keys = `${scope.origin}${scope.pathname}__adkey/${id}/`;
  const key = `${keys}${encodeURIComponent(path)}`;
  // match() with a cacheName never creates the cache, unlike open().
  const hit = /^[a-z0-9]+$/.test(id) ? await caches.match(key, { cacheName: PREFIX + id }) : undefined;
  if (!hit) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (GWD_SCRIPT.test(name)) return standinScript(scope, path, await includedScripts(id, keys, path));
    if (GWD_STYLE.test(name)) return new Response('', { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' } });
    return notFound(path);
  }
  const isHtml = (hit.headers.get('Content-Type') ?? '').startsWith('text/html');
  if (!isHtml || url.searchParams.get('net') === 'open') return hit;
  const headers = new Headers(hit.headers);
  headers.set('Content-Security-Policy', BLOCK_THIRD_PARTY);
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
}

function notFound(path) {
  return new Response(`Not in this ad: ${path}`, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** The names of GWD's runtime scripts the ad includes in the folder of `path`. */
async function includedScripts(id, keys, path) {
  if (!/^[a-z0-9]+$/.test(id) || !(await caches.has(PREFIX + id))) return [];
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  const names = [];
  for (const req of await (await caches.open(PREFIX + id)).keys()) {
    if (!req.url.startsWith(keys)) continue;
    let file;
    try {
      file = decodeURIComponent(req.url.slice(keys.length));
    } catch {
      continue;
    }
    const name = file.slice(dir.length);
    if (file.startsWith(dir) && GWD_SCRIPT.test(name)) names.push(name);
  }
  return names;
}

async function standinScript(scope, path, included) {
  standin ??= fetch(new URL('gwd-standin.js', scope)).then((res) => {
    if (!res.ok) throw new Error(`gwd-standin.js: ${res.status}`);
    return res.text();
  });
  try {
    const text = (await standin).replace(INCLUDED, () => JSON.stringify(included));
    return new Response(text, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch {
    standin = null; // try again on the next request
    return notFound(path);
  }
}
