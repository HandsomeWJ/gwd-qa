import { defineConfig } from 'vitest/config';

// Served from https://handsomewj.github.io/gwd-qa/, so every URL is relative to /gwd-qa/.
export default defineConfig({
  base: '/gwd-qa/',
  build: { target: 'es2022' },
  test: { environment: 'happy-dom', include: ['tests/**/*.test.ts'] },
});
