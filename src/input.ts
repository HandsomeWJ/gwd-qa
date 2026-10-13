// What the page accepts: a zip, the ad's folder (dropped or chosen), several files, or just the
// ad's HTML. Each becomes the same AdPackage, so the rest of the app does not care which it was.

import { readFolder, readHtml, readZip, type AdPackage } from './zip';

export interface PickedFile {
  path: string; // relative path with '/' separators, the folder's own name first
  data: Uint8Array;
}

const isZip = (f: PickedFile) => /\.zip$/i.test(f.path) || (f.data[0] === 0x50 && f.data[1] === 0x4b);

export function adPackage(files: PickedFile[]): AdPackage {
  if (!files.length) throw new Error('There are no files in it.');
  const [one] = files;
  if (files.length > 1 || one.path.includes('/')) return readFolder(files);
  if (isZip(one)) return readZip(one.path, one.data);
  if (/\.html?$/i.test(one.path)) return readHtml(one.path, one.data);
  throw new Error(`${one.path} is not a zip or an HTML file. Drop the ad's zip, its folder, or its HTML.`);
}

const read = async (file: File, path: string): Promise<PickedFile> => ({ path, data: new Uint8Array(await file.arrayBuffer()) });

/** Files from a picker; a folder picker gives each one its path inside the folder. */
export function pickedFiles(list: FileList | File[]): Promise<PickedFile[]> {
  return Promise.all([...list].map((f) => read(f, f.webkitRelativePath || f.name)));
}

/**
 * The files of a drop, walking any dropped folders. Call it while the drop event runs: the
 * browser empties the DataTransfer afterwards.
 */
export function droppedFiles(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry());
  const files = [...dt.files];
  return entries.length && entries.every((e) => e) ? entryFiles(entries as FileSystemEntry[]) : pickedFiles(files);
}

export async function entryFiles(entries: FileSystemEntry[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, dir: string): Promise<void> => {
    const path = dir + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((done, fail) => (entry as FileSystemFileEntry).file(done, fail));
      out.push(await read(file, path));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries gives a folder in batches (100 at a time in Chrome), then an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((done, fail) => reader.readEntries(done, fail));
        if (!batch.length) break;
        await Promise.all(batch.map((child) => walk(child, `${path}/`)));
      }
    }
  };
  await Promise.all(entries.map((e) => walk(e, '')));
  return out;
}
