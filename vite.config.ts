import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Served from https://handsomewj.github.io/gwd-qa/, so every URL is relative to /gwd-qa/.
export default defineConfig(({ mode }) => {
  // The web app that keeps copies of checked ads and bug reports (src/record.ts). The page's CSP lets
  // requests reach it, and the host its replies are redirected to, and nothing else.
  const record = loadEnv(mode, process.cwd(), 'VITE_').VITE_RECORD_URL;
  if (record && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(record)) {
    throw new Error(`VITE_RECORD_URL must be an Apps Script web app's /exec URL, not ${record}`);
  }
  return {
    base: '/gwd-qa/',
    build: { target: 'es2022' },
    plugins: [
      {
        name: 'record-csp',
        transformIndexHtml: (html: string) =>
          record ? html.replace("connect-src 'self'", `connect-src 'self' ${record} https://script.googleusercontent.com`) : html,
      },
    ],
    test: { environment: 'happy-dom', include: ['tests/**/*.test.ts'] },
  };
});
