import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vitest runs from the project root; happy-dom's import.meta.url is not a file: URL.
export const fixture = (name: string) => readFileSync(resolve('tests/fixtures', name), 'utf8');
