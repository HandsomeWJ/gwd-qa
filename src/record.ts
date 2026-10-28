// Sends the site's owner a copy of each ad checked here, and bug reports, through the Google Apps
// Script web app in apps-script/, which keeps them in the owner's Google Drive: an ad for KEEP_DAYS
// days, a bug report until it is dealt with. Off unless the build sets VITE_RECORD_URL.

import { zipSync, type Zippable } from 'fflate';
import type { PickedFile } from './input';

export const RECORD_URL = import.meta.env.VITE_RECORD_URL ?? '';
export const SITE_VERSION = (import.meta.env.VITE_COMMIT ?? 'local').slice(0, 7);
export const KEEP_DAYS = 7;
// The web app takes files base64-encoded in JSON, so a bigger ad is kept by name only.
export const MAX_FILE_BYTES = 30 * 1024 * 1024;

export interface OneFile {
  name: string;
  type: string;
  bytes: Uint8Array;
  picked: string; // what was picked, in words: "a zip", "a folder of 23 files"…
}

export interface SentFile {
  name: string;
  type: string;
  data: string; // base64
}

const typeOf = (name: string) => (/\.html?$/i.test(name) ? 'text/html' : /\.zip$/i.test(name) ? 'application/zip' : 'application/octet-stream');

export const megabytes = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** What was picked, as one file: a lone zip or HTML as it came, a folder or several files zipped. */
export function asOneFile(files: PickedFile[]): OneFile {
  if (files.length === 1 && !files[0].path.includes('/')) {
    const [f] = files;
    const kind = /\.html?$/i.test(f.path) ? 'an HTML file' : /\.zip$/i.test(f.path) ? 'a zip' : 'a file';
    return { name: f.path, type: typeOf(f.path), bytes: f.data, picked: kind };
  }
  const tops = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
  const folder = tops.size === 1 && !tops.has('') ? [...tops][0] : '';
  const entries: Zippable = {};
  for (const f of files) entries[f.path] = f.data;
  return {
    name: `${folder || 'files'}.zip`,
    type: 'application/zip',
    bytes: zipSync(entries),
    picked: folder ? `a folder of ${files.length} files` : `${files.length} files`,
  };
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  // In slices: spreading a whole file into fromCharCode would overflow the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The file to send, or null with the reason when it is over MAX_FILE_BYTES. */
export function sendable(file: OneFile): { file: SentFile | null; note: string } {
  if (file.bytes.length > MAX_FILE_BYTES) {
    return { file: null, note: `Not sent: ${megabytes(file.bytes.length)} is over the ${megabytes(MAX_FILE_BYTES)} limit.` };
  }
  return { file: { name: file.name, type: file.type, data: base64(file.bytes) }, note: '' };
}

/** Where and how the page ran, for the record. */
export function environment(): string[] {
  return [
    `Page: ${location.href}`,
    `Site version: ${SITE_VERSION}`,
    `Browser: ${navigator.userAgent}`,
    `Window: ${innerWidth}×${innerHeight} at ${devicePixelRatio}x`,
  ];
}

export function uploadBody(one: OneFile) {
  const { file, note } = sendable(one);
  const about = [`Picked: ${one.picked}, ${megabytes(one.bytes.length)}`, note, ...environment()].filter(Boolean).join('\n');
  return { kind: 'upload', name: one.name, file, about };
}

/** Posts to the web app and waits for its answer, which says whether it kept what it was sent. */
export async function send(url: string, body: object): Promise<void> {
  // As text/plain, the POST needs no preflight, which Apps Script cannot answer. Its reply comes
  // through a redirect to script.googleusercontent.com, which the fetch follows.
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
  const reply = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !reply?.ok) throw new Error(reply?.error || `It did not go through (${res.status || 'no answer'}).`);
}

/** Sends a copy of what was picked without waiting: a copy that fails never gets in the way of the check. */
export function recordUpload(url: string, files: PickedFile[]) {
  if (!url || !files.length) return;
  send(url, uploadBody(asOneFile(files))).catch((err) => console.warn('No copy of the ad was kept:', err));
}
