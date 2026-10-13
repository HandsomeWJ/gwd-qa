import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { adPackage, entryFiles, type PickedFile } from '../src/input';
import { isGwdBackup, missingRuntime, readFolder, writeZip } from '../src/zip';

const gwd = '<html><head><meta name="generator" content="Google Web Designer 16"></head><body><gwd-genericad></gwd-genericad></body></html>';
const picked = (entries: Record<string, string>): PickedFile[] => Object.entries(entries).map(([path, text]) => ({ path, data: strToU8(text) }));

describe('adPackage', () => {
  it('takes a lone HTML file as the whole ad', () => {
    const pkg = adPackage(picked({ 'Responsive.html': gwd }));
    expect(pkg).toMatchObject({ kind: 'html', zipName: 'Responsive.html', htmlPath: 'Responsive.html', entries: ['Responsive.html'] });
    expect([...pkg.files.keys()]).toEqual(['Responsive.html']);
  });

  it('unpacks a zip, by its name or its contents', () => {
    const zip = zipSync({ 'Ad/Responsive.html': strToU8(gwd) });
    expect(adPackage([{ path: 'ad.zip', data: zip }])).toMatchObject({ kind: 'zip', zipName: 'ad.zip', htmlPath: 'Ad/Responsive.html' });
    expect(adPackage([{ path: 'download', data: zip }]).kind).toBe('zip');
  });

  it('takes a folder by its relative paths, named after the folder', () => {
    const pkg = adPackage(picked({
      'Ad/assets/logo.png': 'png',
      'Ad/Responsive.html': gwd,
      'Ad/_revision/Responsive.html': gwd,
      'Ad/.DS_Store': 'junk',
      'Ad/gwdpage_min.js': 'js',
    }));
    expect(pkg).toMatchObject({ kind: 'folder', zipName: 'Ad.zip', htmlPath: 'Ad/Responsive.html' });
    expect(pkg.entries).toEqual(['Ad/', 'Ad/Responsive.html', 'Ad/_revision/', 'Ad/_revision/Responsive.html', 'Ad/assets/', 'Ad/assets/logo.png', 'Ad/gwdpage_min.js']);
  });

  it('zips a folder as the folder, and leaves its backups out of the upload', () => {
    const pkg = readFolder(picked({ 'Ad/Responsive.html': gwd, 'Ad/_revision/Responsive.html': gwd }));
    const full = unzipSync(writeZip(pkg, new Map([['Ad/Responsive.html', strToU8('changed')]])));
    expect(Object.keys(full)).toEqual(['Ad/', 'Ad/Responsive.html', 'Ad/_revision/', 'Ad/_revision/Responsive.html']);
    expect(strFromU8(full['Ad/Responsive.html'])).toBe('changed');
    expect(Object.keys(unzipSync(writeZip(pkg, new Map(), isGwdBackup)))).toEqual(['Ad/', 'Ad/Responsive.html']);
  });

  it('names several loose files after their HTML', () => {
    const pkg = adPackage(picked({ 'Responsive.html': gwd, 'gwdpage_min.js': 'js' }));
    expect(pkg).toMatchObject({ kind: 'folder', zipName: 'Responsive.zip', entries: ['Responsive.html', 'gwdpage_min.js'] });
  });

  it('refuses a lone file that is not a zip or HTML, and a folder without HTML', () => {
    expect(() => adPackage(picked({ 'logo.png': 'png' }))).toThrow('not a zip or an HTML file');
    expect(() => adPackage(picked({ 'Ad/logo.png': 'png' }))).toThrow('No HTML file found');
    expect(() => adPackage([])).toThrow();
  });
});

type Fake = { name: string; isFile: boolean; isDirectory: boolean; file?: (done: (f: File) => void) => void; createReader?: () => { readEntries: (done: (e: Fake[]) => void) => void } };
const fakeFile = (name: string, text: string): Fake => ({ name, isFile: true, isDirectory: false, file: (done) => done(new File([text], name)) });
/** A folder whose reader hands out its children in batches of two, then an empty batch. */
function fakeDir(name: string, children: Fake[], reads: number[]): Fake {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (done) => {
          reads.push(1);
          const batch = children.slice(at, at + 2);
          at += batch.length;
          setTimeout(() => done(batch));
        },
      };
    },
  };
}

describe('entryFiles', () => {
  it('walks dropped folders, reading every batch, and keeps relative paths', async () => {
    const reads: number[] = [];
    const assets = fakeDir('assets', [fakeFile('a.png', 'a'), fakeFile('b.png', 'b'), fakeFile('c.png', 'c')], reads);
    const ad = fakeDir('Ad', [fakeFile('Responsive.html', gwd), assets], reads);
    const files = await entryFiles([ad, fakeFile('notes.txt', 'n')] as unknown as FileSystemEntry[]);
    expect(files.map((f) => f.path).sort()).toEqual(['Ad/Responsive.html', 'Ad/assets/a.png', 'Ad/assets/b.png', 'Ad/assets/c.png', 'notes.txt']);
    expect(strFromU8(files.find((f) => f.path === 'Ad/assets/c.png')!.data)).toBe('c');
    expect(reads).toHaveLength(5); // Ad: 1 batch + empty; assets: 2 batches + empty
  });
});

describe('missingRuntime', () => {
  // happy-dom fetches the scripts and styles of a parsed document, which a browser never does.
  beforeAll(() => {
    Object.assign((window as unknown as { happyDOM: { settings: object } }).happyDOM.settings, {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    });
  });

  const html = `<html><head>
    <link href="gwdpage_style.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css?family=Inter" rel="stylesheet">
    <script src="gwd_webcomponents_v1_min.js"></script>
    <script src="./gwdpage_min.js"></script>
    <script src="gwd-events-support.1.0.js"></script>
    <script src="https://cdn.example.com/gwdtracker_min.js"></script>
    <script src="app.js"></script>
  </head><body></body></html>`;

  it('lists the GWD runtime files the HTML loads but the ad does not have', () => {
    expect(missingRuntime(adPackage(picked({ 'Responsive.html': html })))).toEqual([
      'gwdpage_style.css',
      'gwd_webcomponents_v1_min.js',
      'gwdpage_min.js',
      'gwd-events-support.1.0.js',
    ]);
  });

  it('resolves them next to the HTML, folder names and all', () => {
    const pkg = adPackage(picked({ 'My Ad #2/Responsive.html': html, 'My Ad #2/gwdpage_min.js': 'js', 'My Ad #2/gwdpage_style.css': 'css' }));
    expect(missingRuntime(pkg)).toEqual(['My Ad #2/gwd_webcomponents_v1_min.js', 'My Ad #2/gwd-events-support.1.0.js']);
  });

  it('counts GWD\'s groups runtime, whose name does not start with gwd', () => {
    const groups = html.replace('<script src="app.js">', '<script type="text/javascript" src="groups_runtime.min.1.0.js" gwd-groups-version="1.0"></script>\n    <script src="app.js">');
    const files = { 'Responsive.html': groups, 'gwdpage_style.css': 'css', 'gwd_webcomponents_v1_min.js': 'js', 'gwdpage_min.js': 'js', 'gwd-events-support.1.0.js': 'js' };
    expect(missingRuntime(adPackage(picked(files)))).toEqual(['groups_runtime.min.1.0.js']);
    expect(missingRuntime(adPackage(picked({ ...files, 'groups_runtime.min.1.0.js': 'js' })))).toEqual([]);
  });
});
