// Safari's and Firefox's engines have no host-resolver rules, so each is started with a proxy
// (playwright.config.ts): a local one that refuses every request for another site and notes it.
// It stops what page.route() cannot: WebKit offers it none of the requests of a page the preview's
// service worker controls, which is every page an ad is picked in.
import { createServer, type Server } from 'node:http';

export const PROXY_PORTS = { webkit: 4175, firefox: 4176 } as const;

export interface Refused {
  method: string;
  url: string; // host:port for a CONNECT, which starts every https request
  at: number;
}

/** Starts a proxy on each port. Resolves to a function that stops them. */
export async function startProxies(ports: number[]): Promise<() => Promise<void>> {
  const servers = await Promise.all(ports.map(listen));
  return async () => {
    await Promise.all(servers.map((server) => new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    })));
  };
}

function listen(port: number): Promise<Server> {
  const refused: Refused[] = [];
  const note = (method = '', url = '') => refused.push({ method, url, at: Date.now() });
  const server = createServer((req, res) => {
    // A test asks the proxy itself for the list; a browser's request names another site.
    if (req.url === '/refused') return res.end(JSON.stringify(refused));
    note(req.method, req.url);
    res.writeHead(403).end();
  });
  server.on('connect', (req, socket) => {
    note(req.method, req.url);
    socket.on('error', () => undefined);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  return new Promise((done, fail) => {
    server.once('error', (err) => fail(new Error(`The tests' proxy cannot listen on port ${port}: ${err.message}`)));
    server.listen(port, '127.0.0.1', () => done(server));
  });
}

/** What the proxy on `port` has refused so far. */
export async function refusedBy(port: number): Promise<Refused[]> {
  return (await (await fetch(`http://127.0.0.1:${port}/refused`)).json()) as Refused[];
}
