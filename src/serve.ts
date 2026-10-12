// Publishes an unzipped ad to Cache Storage for the service worker (public/sw.js) to serve.
// Keys must match the worker's: <base>__adkey/<id>/<encodeURIComponent(path)>.

const CACHE = 'gwdqa-ads';
const BASE = import.meta.env.BASE_URL;

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  txt: 'text/plain; charset=utf-8',
};

export function mimeOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

function keyFor(id: string, path: string): string {
  return `${location.origin}${BASE}__adkey/${id}/${encodeURIComponent(path)}`;
}

/** URL a frame loads; each path segment is percent-encoded, the worker decodes it. */
export function adUrl(id: string, path: string): string {
  return `${BASE}__ad/${id}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export async function startWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) throw new Error('This browser has no service workers, which the preview needs.');
  await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    // First visit: wait for clients.claim() so the page itself is controlled too.
    await new Promise<void>((done) => {
      const timer = setTimeout(done, 3000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timer);
        done();
      }, { once: true });
    });
  }
}

export async function publish(id: string, files: Map<string, Uint8Array>): Promise<void> {
  await caches.delete(CACHE); // one ad at a time
  const cache = await caches.open(CACHE);
  await Promise.all([...files].map(([path, data]) => putFile(cache, id, path, data)));
}

export async function updateFile(id: string, path: string, data: Uint8Array): Promise<void> {
  await putFile(await caches.open(CACHE), id, path, data);
}

function putFile(cache: Cache, id: string, path: string, data: Uint8Array): Promise<void> {
  return cache.put(keyFor(id, path), new Response(new Blob([data as BlobPart]), {
    headers: { 'Content-Type': mimeOf(path), 'Cache-Control': 'no-store' },
  }));
}
