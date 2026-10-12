// Publishes an unzipped ad to Cache Storage for the service worker (public/sw.js) to serve.
// Each loaded ad gets its own cache, gwdqa-ad-<id>, so tabs never touch each other's files.
// Keys must match the worker's: <base>__adkey/<id>/<encodeURIComponent(path)>.

const PREFIX = 'gwdqa-ad-';
const LEGACY = 'gwdqa-ads'; // the one shared cache earlier versions used
const BASE = import.meta.env.BASE_URL;

export const cacheName = (id: string) => `${PREFIX}${id}`;

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
  const reg = await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
  // A returning visitor still runs the previous worker. Fetch the current one and wait for it
  // to take over, so no preview is served by stale code (such as one without request blocking).
  await reg.update().catch(() => undefined);
  const pending = reg.installing ?? reg.waiting;
  if (pending) {
    await new Promise<void>((done) => {
      const timer = setTimeout(done, 5000);
      pending.addEventListener('statechange', () => {
        if (pending.state === 'activated' || pending.state === 'redundant') {
          clearTimeout(timer);
          done();
        }
      });
    });
  }
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

/**
 * Holds a Web Lock named after the ad's cache while this page keeps the ad open. The browser
 * releases it when the tab closes, so other tabs can tell which caches are still in use.
 */
function holdLock(name: string): Promise<() => void> {
  if (!navigator.locks) return Promise.resolve(() => undefined);
  return new Promise((granted) => {
    void navigator.locks.request(name, () => new Promise<void>((release) => granted(release)));
  });
}

/** Deletes the caches of ads that no open tab holds any more. */
async function sweep(): Promise<void> {
  await caches.delete(LEGACY);
  if (!navigator.locks) return;
  const held = new Set(((await navigator.locks.query()).held ?? []).map((l) => l.name));
  const stale = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && !held.has(name));
  await Promise.all(stale.map((name) => caches.delete(name)));
}

/** Stores the ad's files for the worker. Returns a function that deletes them again. */
export async function publish(id: string, files: Map<string, Uint8Array>): Promise<() => Promise<void>> {
  const release = await holdLock(cacheName(id));
  await sweep();
  await putAll(id, files);
  return async () => {
    await caches.delete(cacheName(id));
    release();
  };
}

/** Puts the files back when the cache has gone, for example after the site's data was cleared. */
export async function ensurePublished(id: string, files: () => Map<string, Uint8Array>): Promise<void> {
  if (!(await caches.has(cacheName(id)))) await putAll(id, files());
}

export async function updateFile(id: string, path: string, data: Uint8Array): Promise<void> {
  await putFile(await caches.open(cacheName(id)), id, path, data);
}

async function putAll(id: string, files: Map<string, Uint8Array>): Promise<void> {
  const cache = await caches.open(cacheName(id));
  await Promise.all([...files].map(([path, data]) => putFile(cache, id, path, data)));
}

function putFile(cache: Cache, id: string, path: string, data: Uint8Array): Promise<void> {
  return cache.put(keyFor(id, path), new Response(new Blob([data as BlobPart]), {
    headers: { 'Content-Type': mimeOf(path), 'Cache-Control': 'no-store' },
  }));
}
