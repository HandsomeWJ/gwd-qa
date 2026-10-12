// Serves the unzipped ad to the preview frames. The page stores each file in Cache Storage
// under a canonical key; requests under <scope>__ad/<id>/ are answered from there, so the
// ad's relative paths work and every frame shares the page's origin.
const CACHE = 'gwdqa-ads';

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
  const key = `${scope.origin}${scope.pathname}__adkey/${id}/${encodeURIComponent(path)}`;
  const hit = await (await caches.open(CACHE)).match(key);
  if (!hit) {
    return new Response(`Not in this ad: ${path}`, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const isHtml = (hit.headers.get('Content-Type') ?? '').startsWith('text/html');
  if (!isHtml || url.searchParams.get('net') === 'open') return hit;
  const headers = new Headers(hit.headers);
  headers.set('Content-Security-Policy', BLOCK_THIRD_PARTY);
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
}
