import './styles.css';
import { CHECKS, type CheckId, type Finding } from './audit/types';
import { staticAudit } from './audit/static';
import { applyEdits, byFile, mergeEdits, type Edit } from './css/edit';
import { diffLines, diffStats, type Hunk } from './diff';
import { engineOf } from './engine';
import type { PlannedFix } from './fix/plan';
import { adPackage, droppedFiles, pickedFiles, type PickedFile } from './input';
import { allowedZipUrl, outsideHosts } from './net';
import { RECORD_URL, recordUpload } from './record';
import { initReports, noteError } from './report';
import { startWorker } from './serve';
import { Session, type ApplyResult, type AuditResult } from './session';
import { describeSize, frameSizes, type FrameSize } from './sizes';
import { loadedPaths, measureImages } from './compress/measure';
import { autoShrink, type AutoResult } from './compress/auto';
import { DEFAULT_OPTIONS, findSavings, shrinker, type Savings, type SavingsOptions } from './compress/plan';
import { isGwdBackup, keyFor, legacyKey, type AdPackage } from './zip';

const app = document.getElementById('app')!;
const ENGINE = engineOf(navigator.userAgent);
let session: Session | null = null;
let result: AuditResult | null = null;
let busy = false;
// The package weight fix once found, for the files as they were then (Session.version), with the
// object URLs of its before and after images; and the options it is found with.
let savings: { result: Savings; version: number; upload: number; urls: string[] } | null = null;
let savingsOptions: SavingsOptions = { ...DEFAULT_OPTIONS };
// What Fix package weight last did, for the files it left (Session.version), to say so where the zip is still over.
let lastAuto: { result: AutoResult; version: number } | null = null;
// The files last picked or dropped, for a bug report, whether or not they loaded.
let picked: PickedFile[] | null = null;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

app.innerHTML = `
  <div class="wrap">
    <header class="top">
      <div>
        <h1>GWD Ad QA</h1>
        <p>Checks a Google Web Designer ad against the QA checklist in every served size, fixes the safe items, and gives you back the fixed files.${RECORD_URL ? '' : ' Your files never leave this browser.'}</p>
      </div>
      ${RECORD_URL ? '<button type="button" class="link" data-report data-free>Report a bug</button>' : ''}
    </header>
    <div class="banner warn scope" role="note"><strong>Display ads only for now.</strong> Interactive video (VPAID) ads are not supported yet: their own checklist items (VPAID Bridge, SA_video settings, Vpaidtag.xml) are not checked, and the fixes here are not made for them.</div>
    <div id="status"></div>
    <div class="drop" id="drop">
      <strong>Drop a GWD ad here: its zip, its folder, or just its HTML</strong>
      <p>The folder GWD saves to is the one with Responsive.html or index.html in it. With just the HTML, the preview runs on a stand-in for GWD's runtime, without the ad's images.</p>
      <p>Works in Chrome, Safari and Firefox, and the preview shows the ad as the browser you open this page in draws it. Fixes are made in Chrome.</p>
      <div class="picks">
        <button type="button" class="primary">Choose a zip</button>
        <button type="button" data-pick="folder">Choose a folder</button>
      </div>
      <input type="file" id="file" accept=".zip,.html,.htm,application/zip,text/html" multiple hidden>
      <input type="file" id="folder" webkitdirectory hidden>
    </div>
    <section id="summary" class="card" hidden></section>
    <section id="checklist" class="card" hidden></section>
    <section id="fixes" class="card" hidden></section>
    <section id="copy" class="card" hidden></section>
    <section id="preview" class="card" hidden>
      <div class="bar">
        <div><h2>Preview</h2><p class="sub" style="margin:0">Every served size at its exact dimensions, running as it would live in ${ENGINE.name}. To see another browser's, open this page in Chrome, Safari or Firefox and drop the same file.</p></div>
        <button data-action="replay-all">Replay all</button>
      </div>
      <div class="net" id="net"></div>
      <div class="frames" id="frames" style="margin-top:14px"></div>
    </section>
    <footer class="foot">
      ${RECORD_URL
        ? "The checks run in your browser, which serves the ad's files to the preview through a service worker. The ad's own requests to other sites are blocked unless you allow them."
        : "Runs entirely in your browser: the ad's files are read here and served to the preview by a service worker. Nothing is uploaded, and the ad's own requests to other sites are blocked unless you allow them."}
      <a href="https://github.com/HandsomeWJ/gwd-qa">Source</a>
    </footer>
  </div>`;

let lastBusy = '';

function status(html: string, kind: 'busy' | 'err' | '' = '') {
  const box = $('#status');
  lastBusy = kind === 'busy' ? html : '';
  if (!html) return box.replaceChildren();
  const paused = kind === 'busy' && document.hidden ? ' <em>Paused: the ad only runs while this tab is visible.</em>' : '';
  box.innerHTML = kind === 'busy'
    ? `<div class="card"><span class="spinner"></span> ${html}${paused}</div>`
    : `<div class="banner ${kind === 'err' ? 'err' : 'ok'}">${html}</div>`;
  if (kind === 'err') {
    // An error goes into the next bug report, and offers one.
    noteError(box.textContent ?? '');
    if (RECORD_URL) box.insertAdjacentHTML('beforeend', '<p class="report-it">Looks like a fault in this site? <button type="button" class="link" data-report data-free>Report it</button></p>');
  }
}

document.addEventListener('visibilitychange', () => {
  if (busy && lastBusy) status(lastBusy, 'busy');
});

function setBusy(on: boolean) {
  busy = on;
  // A bug report stays open to the reporter, even while a check hangs.
  app.querySelectorAll<HTMLButtonElement>('button:not([data-free])').forEach((b) => (b.disabled = on || b.dataset.disabled === 'true'));
  // While checks run, a pointer resting on a preview must not put its text in a hover state to be measured.
  $('#frames').classList.toggle('busy', on);
}

// Started at once; loading waits for it so frames never miss the worker on a first visit.
const workerReady = startWorker();

/**
 * Loads the ad from what was picked or dropped: a zip, the ad's folder, or just its HTML. What a
 * person picked is also kept for the owner, unless `record` is false (an ad stored on this site).
 */
async function load(pick: () => Promise<PickedFile[]>, record = true) {
  if (busy) return;
  setBusy(true);
  let swapped = false;
  try {
    status('Reading the ad…', 'busy');
    const files = await pick();
    picked = files;
    if (record) setTimeout(() => recordUpload(RECORD_URL, files)); // after this check has started
    // Whatever can refuse the new ad runs first, so a refusal leaves the loaded ad as it was.
    const pkg = adPackage(files);
    const sizes = staticAudit(new TextDecoder().decode(pkg.files.get(pkg.htmlPath))).sizes;
    if (!sizes.length) throw new Error('No served sizes found: this does not look like a GWD ad.');
    if (!sizes.some((s) => frameSizes(s).length)) throw new Error(`None of the served sizes can be previewed: ${sizes.join(', ')}.`);
    await workerReady;
    const next = await Session.open(pkg);
    next.allowThirdParty = allowThirdPartySaved();
    const old = session;
    session = next;
    swapped = true;
    clearResults();
    clearPreview();
    await old?.close();
    loadDisclaimers(next.key, next.pkg);
    next.mountFrames($('#frames'), sizes, frameCard);
    layoutFrames();
    $('#drop').hidden = true;
    $('#preview').hidden = false;
    renderNet();
    status(`Loading ${plural(next.frames.length, 'size')}…`, 'busy');
    await next.reloadAll();
    await check();
  } catch (err) {
    // The old ad is gone: nothing of it may stay on the page, and another ad can be dropped.
    if (swapped) {
      clearResults();
      $('#drop').hidden = false;
    }
    status(esc(err instanceof Error ? err.message : String(err)), 'err');
  } finally {
    setBusy(false);
  }
}

async function check() {
  status('Checking every size…', 'busy');
  result = await session!.audit();
  // A fix keeps the ad as the browser that measured it draws it, so only Chrome's are offered.
  if (!ENGINE.chrome) result.plan = { fixes: [], manual: [] };
  status('');
  $('#drop').hidden = true;
  render();
}

/** Takes the results off the page, so no button acts on results that no longer hold. */
function dropSavings() {
  savings?.urls.forEach((u) => URL.revokeObjectURL(u));
  savings = null;
}

function clearResults() {
  result = null;
  lastAuto = null;
  dropSavings();
  for (const id of ['summary', 'checklist', 'fixes', 'copy']) $(`#${id}`).hidden = true;
}

function clearPreview() {
  $('#preview').hidden = true;
  $('#frames').replaceChildren();
}

const NET_KEY = 'gwdqa.allowThirdParty';
const DISCLAIMER_KEY = 'gwdqa.disclaimers';
// An id that names a disclaimer. Only ids count: GWD's generated class names are random.
const DISCLAIMER_ID = /disclaim|legal|terms|tnc|t&c|fine-?print|small-?print/i;
// Per element label: marked (true) or unmarked (false) as a disclaimer, for the loaded ad. Maps,
// not objects: labels and keys come from the ad, and one named __proto__ or constructor must not
// find what every object inherits.
let disclaimerChoices = new Map<string, boolean>();
// The keys the loaded ad's marks are saved under: its own, and those of the fixed files it was
// downloaded as, so they come back when a fixed file is checked again.
let disclaimerKeys = new Set<string>();

/** Every ad's marks, by the ad's key (adKey in src/zip.ts). */
function storedDisclaimers(): Map<string, Map<string, boolean>> {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(DISCLAIMER_KEY) ?? '{}');
    const own = (v: unknown): [string, unknown][] => (v && typeof v === 'object' ? Object.entries(v) : []);
    return new Map(own(all).map(([key, marks]) => [key, new Map(own(marks).filter((m): m is [string, boolean] => typeof m[1] === 'boolean'))]));
  } catch {
    return new Map();
  }
}

function storeDisclaimers(all: Map<string, Map<string, boolean>>) {
  try {
    localStorage.setItem(DISCLAIMER_KEY, JSON.stringify(Object.fromEntries([...all].map(([key, marks]) => [key, Object.fromEntries(marks)]))));
  } catch {
    // private mode: the marks just aren't remembered
  }
}

/**
 * Loads the marks saved under the ad's key. A zip or a folder went by its name alone before; marks
 * saved under that name move to the ad's key, so they go on applying to this ad and to no other.
 */
function loadDisclaimers(key: string, pkg: AdPackage) {
  const all = storedDisclaimers();
  const old = legacyKey(pkg);
  disclaimerKeys = new Set([key]);
  disclaimerChoices = new Map(all.get(key) ?? (old !== undefined ? all.get(old) : undefined));
  if (old === undefined || all.has(key) || !all.has(old)) return;
  all.set(key, disclaimerChoices);
  all.delete(old);
  storeDisclaimers(all);
}

function saveDisclaimers() {
  const all = storedDisclaimers();
  for (const key of disclaimerKeys) all.set(key, disclaimerChoices);
  storeDisclaimers(all);
}

const namedDisclaimer = (target: string) => DISCLAIMER_ID.test(/#([^.]+)/.exec(target)?.[1] ?? '');
const isDisclaimer = (target: string) => disclaimerChoices.get(target) ?? namedDisclaimer(target);

function allowThirdPartySaved(): boolean {
  try {
    return localStorage.getItem(NET_KEY) === '1';
  } catch {
    return false;
  }
}

function renderNet() {
  const s = session!;
  const others = outsideHosts(s.html, location.host).filter((h) => !h.fonts).map((h) => h.host);
  const refers = others.length ? ` Its code refers to ${others.join(', ')}.` : ' Its code refers to no other sites apart from fonts.';
  const state = s.allowThirdParty
    ? 'The ad can contact other sites, so its trackers and pixels can fire from this preview.'
    : 'The ad\'s requests to other sites are blocked, so its trackers and pixels do not fire from this preview. Fonts still load. Code written to get around a preview can still reach other sites, for example by opening a window.';
  const clicks = !s.allowThirdParty && others.length ? ' Clicks that those sites\' scripts handle do nothing until you let the ad contact them.' : '';
  $('#net').innerHTML = `
    <label class="switch"><input type="checkbox" id="allow-net"${s.allowThirdParty ? ' checked' : ''}> Let the ad contact other sites</label>
    <p class="sub">${esc(state + refers + clicks)}</p>`;
}

async function setThirdParty(allow: boolean) {
  if (!session) return;
  if (busy) return renderNet(); // undo the click: a check is running
  try {
    localStorage.setItem(NET_KEY, allow ? '1' : '0');
  } catch {
    // private mode: the choice just isn't remembered
  }
  session.allowThirdParty = allow;
  renderNet();
  setBusy(true);
  try {
    status('Reloading every size…', 'busy');
    await session.reloadAll();
    await check();
  } catch (err) {
    status(esc(err instanceof Error ? err.message : String(err)), 'err');
  } finally {
    setBusy(false);
  }
}

function frameCard(fs: FrameSize, frame: HTMLIFrameElement): HTMLElement {
  const card = document.createElement('div');
  card.className = 'frame';
  card.innerHTML = `<header><span>${esc(fs.label)}</span><button data-action="replay" data-frame="${esc(fs.label)}">Replay</button></header><div class="viewport"></div><p class="clipped" hidden>Wider than this window: scroll sideways in it to see the right edge.</p>`;
  card.querySelector('.viewport')!.appendChild(frame);
  return card;
}

/**
 * GWD pages are 3D-transformed, so an ad drawn between device pixels comes out blurred: each frame
 * is nudged onto whole device pixels whenever the layout around it moves. Frames wider than the
 * window scroll inside their card, which overlay scrollbars hide, so those say so.
 */
function layoutFrames() {
  for (const frame of $('#frames').querySelectorAll<HTMLIFrameElement>('iframe')) {
    frame.style.translate = '';
    const r = frame.getBoundingClientRect();
    const off = (v: number) => ((v * devicePixelRatio) % 1) / devicePixelRatio;
    const [x, y] = [off(r.left + scrollX), off(r.top + scrollY)];
    if (x || y) frame.style.translate = `${-x}px ${-y}px`;
    const viewport = frame.parentElement!;
    viewport.nextElementSibling!.toggleAttribute('hidden', viewport.scrollWidth <= viewport.clientWidth);
  }
}
new ResizeObserver(layoutFrames).observe(app);
addEventListener('resize', layoutFrames);

function render() {
  if (!session || !result) return;
  renderSummary();
  renderChecklist();
  renderFixes();
  renderCopy();
}

function failing(check: CheckId): Finding[] {
  return result!.findings.filter((f) => f.check === check && f.level === 'fail' && !(check === 'type' && isDisclaimer(f.target)));
}

/** Whether a planned fix of another check clears this finding too: a held top or left the keyframes fix, still offered, deletes. */
const cleared = (f: Finding) => result!.plan.fixes.some((x) => x.check === 'keyframes')
  && (result!.plan.clears ?? []).some((c) => c.check === f.check && c.target === f.target && c.prop === f.prop);

// The checks read from the ad as it renders in the frames (src/audit/render.ts), on each page.
const RENDERED = new Set<CheckId>(['type', 'lineHeight', 'buttonPadding', 'buttonColor', 'marginBlock', 'cursor']);

/**
 * What the rendered checks never saw, such as "1 page and 1 size": pages that never showed in a
 * size, and served sizes with no preview. '' when they saw every page in every size.
 */
function unchecked(): string {
  const pages = result!.skipped.length;
  const sizes = session!.unknownSizes.length;
  return [pages ? plural(pages, 'page') : '', sizes ? plural(sizes, 'size') : ''].filter(Boolean).join(' and ');
}

/**
 * Pass only when the check saw everything it checks. A note where it could not decide, or a page or
 * size it never saw, leaves that to the user: Review.
 */
function verdict(check: CheckId): 'fail' | 'advise' | 'review' | 'pass' {
  // The QA checklist calls some items recommendations: what they find never counts as failing.
  if (failing(check).length) return CHECKS.find((c) => c.id === check)?.advisory ? 'advise' : 'fail';
  if (result!.findings.some((f) => f.check === check && f.unknown)) return 'review';
  return RENDERED.has(check) && unchecked() ? 'review' : 'pass';
}

/** Type findings for text marked as a disclaimer, which the 8px rule exempts. */
function exempt(): Finding[] {
  return result!.findings.filter((f) => f.check === 'type' && f.level === 'fail' && isDisclaimer(f.target));
}

const diffClass = { '+': 'add', '-': 'del', ' ': 'ctx' } as const;

function diffHtml(hunks: Hunk[]): string {
  const head = '<div class="hunk"><span class="ln">Was</span><span class="ln">Now</span></div>';
  return head + hunks.map((h) => `<div class="hunk">Line ${h.old}</div>${h.lines
    .map((l) => `<div class="${diffClass[l.kind]}"><span class="ln">${l.old ?? ''}</span><span class="ln">${l.new ?? ''}</span>${esc(`${l.kind} ${l.text.replace(/\r$/, '')}`)}</div>`)
    .join('')}`).join('');
}

/** A collapsed view of the line changes from `before` to `after`. */
function diffBox(title: string, before: string, after: string): string {
  const hunks = diffLines(before, after);
  const { added, removed } = diffStats(hunks);
  return `<details class="edits"><summary>${esc(title)} <span class="stat">+${added} / -${removed} lines</span></summary><div class="diff">${diffHtml(hunks)}</div></details>`;
}

/** Says that GWD's runtime is missing and the preview runs the site's stand-in, or '' when it is not. */
function standinNote(s: Session): string {
  if (!s.missingRuntime.length) return '';
  const images = [...s.pkg.files.keys()].some((p) => /\.(png|jpe?g|gif|webp|svg)$/i.test(p));
  const which = s.pkg.kind === 'html' ? '' : ` Not included: ${s.missingRuntime.map((p) => p.split('/').pop()).join(', ')}.`;
  const also = s.displacedRuntime.length ? ` The stand-in also runs in place of ${s.displacedRuntime.join(', ')}, which cannot run without them.` : '';
  return `GWD's runtime files were not included, so the preview uses a stand-in: layout and text are checked, but ${images ? '' : 'images are missing and '}animations or interactions may differ. Drop the whole folder or zip for the full preview.${which}${also}`;
}

function renderSummary() {
  const s = session!;
  const failed = CHECKS.filter((c) => c.id !== 'copy' && verdict(c.id) === 'fail').length;
  const review = CHECKS.filter((c) => c.id !== 'copy' && verdict(c.id) === 'review').length;
  const advised = CHECKS.filter((c) => c.id !== 'copy' && verdict(c.id) === 'advise').length;
  const files = [...s.pkg.files.keys()];
  const published = s.pkg.kind !== 'html' && !s.backups.length && !files.some((p) => /(^|\/)gwd_workspace\.json$/i.test(p));
  const video = files.some((p) => /vpaid/i.test(p)) || /vpaid/i.test(s.html);
  const unseen = unchecked();
  const lone = s.pkg.kind === 'html';
  const fileKind = lone ? 'HTML' : 'zip';
  const note = standinNote(s);
  const box = $('#summary');
  box.hidden = false;
  box.innerHTML = `
    <div class="bar">
      <div class="meta">
        <strong>${esc(s.pkg.zipName)}</strong>${lone ? '' : ` · ${esc(s.pkg.htmlPath)} · ${published ? 'published package' : 'working package'}`} · ${plural(s.sizes.length, 'size')} · checked in ${ENGINE.name}<br>
        ${failed ? `<span class="pill fail">${plural(failed, 'check')} failing</span>` : ''}
        ${review ? `<span class="pill info">${plural(review, 'check')} to review</span>` : ''}
        ${advised ? `<span class="pill advise">${plural(advised, 'recommendation')}</span>` : ''}
        ${unseen ? `<span class="pill info">${unseen} not checked</span>` : ''}
        ${failed || review || unseen ? '' : '<span class="pill pass">Every check passes</span>'}
        ${s.changed ? '<span class="pill info">Fixed, not yet downloaded</span>' : ''}
      </div>
      <div class="actions">
        ${s.changed ? '<button data-action="undo">Undo fixes</button>' : ''}
        <button class="${s.changed ? 'primary' : ''}" data-action="download">${s.changed ? `Download fixed ${fileKind}` : `Download ${fileKind}`}</button>
        ${s.backups.length || s.omitted.size ? '<button data-action="download-upload">Download for upload</button>' : ''}
        <button data-action="reset">Check another ad</button>
      </div>
    </div>
    ${s.backups.length || s.omitted.size ? `<p class="sub upload-note">Download for upload leaves out ${[s.backups.length ? `GWD's backup copies: ${esc(backupFolders(s).join(', '))} (${plural(s.backups.length, 'file')})` : '', s.omitted.size ? `${plural(s.omitted.size, 'file')} the ad never loads` : ''].filter(Boolean).join(', and ')}.</p>` : ''}
    ${video ? '<div class="banner warn standin">This looks like an interactive video (VPAID) ad, which this site does not support yet: its own checklist items were not checked, and the results and fixes here may not suit it.</div>' : ''}
    ${note ? `<div class="banner warn standin">${esc(note)}</div>` : ''}
    ${s.changed ? changesHtml(s) : ''}`;
}

/** A file size as people read it: KB below 0.1 MB, else MB to two decimals. */
const mb = (n: number) => (n < 100_000 ? `${Math.max(1, Math.round(n / 1000))} KB` : `${(n / 1_000_000).toFixed(2)} MB`);

/** What the fixes changed so far: each text file's edits, the files replaced by smaller ones, the files left out. */
function changesHtml(s: Session): string {
  const parts: string[] = [];
  if (s.html !== s.originalHtml) parts.push(diffBox(`Review the changes to ${s.pkg.htmlPath.split('/').pop()}`, s.originalHtml, s.html));
  const decoder = new TextDecoder();
  const images: string[] = [];
  for (const c of s.changes) {
    if (/\.(css|js|html?|json|txt|svg)$/i.test(c.path)) parts.push(diffBox(`Review the changes to ${c.path.split('/').pop()}`, decoder.decode(c.before), decoder.decode(c.after)));
    else images.push(`${c.path.split('/').pop()}: ${mb(c.before.length)} → ${mb(c.after.length)}`);
  }
  if (images.length) parts.push(`<p class="sub">Replaced with smaller versions: ${esc(listed(images, 8))}.</p>`);
  if (s.omitted.size) parts.push(`<p class="sub">Left out of the zip for upload: ${esc(listed([...s.omitted].map((p) => p.split('/').pop()!), 8))}.</p>`);
  return parts.join('');
}

/** The edits views of a set of edits: the HTML's, and each of the ad's other files'. */
function editsHtml(edits: Edit[]): string {
  const s = session!;
  return [...byFile(edits)].map(([path, list]) => {
    const before = path ? s.text(path) ?? '' : s.html;
    return diffBox(path ? `Show the edits in ${path.split('/').pop()}` : 'Show the edits', before, applyEdits(before, mergeEdits(list)));
  }).join('');
}

function backupFolders(s: Session): string[] {
  return [...new Set(s.backups.map((n) => /(?:^|\/)(_revisions?|gwd_preview_[^/]*)\//.exec(n)?.[1] ?? n))].map((d) => `${d}/`);
}

function groupFindings(list: Finding[], control: (f: Finding) => string = () => ''): string {
  const groups = new Map<string, { f: Finding; sizes: string[] }>();
  for (const f of list) {
    const key = `${f.target}|${f.page ?? ''}|${f.message}`;
    const g = groups.get(key) ?? { f, sizes: [] };
    if (f.size) g.sizes.push(f.size);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ f, sizes }) => `<li><span class="target">${esc(f.target)}</span>${f.page ? ` <span class="page">on ${esc(f.page)}</span>` : ''}${sizes.length ? ` <span class="sizes">${esc(sizes.join(', '))}</span>` : ''}: ${esc(f.message)}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}${control(f)}</li>`)
    .join('');
}

function disclaimerToggle(f: Finding): string {
  const byName = !disclaimerChoices.has(f.target) && namedDisclaimer(f.target);
  return `<label class="exempt"><input type="checkbox" data-disclaimer="${esc(f.target)}"${isDisclaimer(f.target) ? ' checked' : ''}> Disclaimer, exempt from 8px${byName ? ' (from its id)' : ''}</label>`;
}

function renderChecklist() {
  const r = result!;
  const box = $('#checklist');
  box.hidden = false;
  // Re-rendering must not close the rows that are open.
  const open = new Set([...box.querySelectorAll<HTMLDetailsElement>('details[data-check]')].filter((d) => d.open).map((d) => d.dataset.check));
  const rows = CHECKS.map((c) => {
    if (c.id === 'copy') {
      return `<li><details><summary><span class="pill info">Review</span><span><span class="title">${esc(c.title)}</span><br><span class="when">${esc(c.passWhen)}</span></span><span class="count">${plural(r.report.copy.length, 'text')} below</span></summary></details></li>`;
    }
    const fails = failing(c.id);
    const exempted = c.id === 'type' ? exempt().map((f) => ({ ...f, hint: undefined })) : [];
    const notes = r.findings.filter((f) => f.check === c.id && f.level === 'note');
    const fixable = r.plan.fixes.some((f) => f.check === c.id) || fails.some(cleared);
    const targets = new Set(fails.map((f) => f.target)).size;
    const pill = { fail: '<span class="pill fail">Fail</span>', advise: '<span class="pill advise">Recommendation</span>', review: '<span class="pill info">Review</span>', pass: '<span class="pill pass">Pass</span>' }[verdict(c.id)];
    const extra = [
      exempted.length ? `${plural(new Set(exempted.map((f) => f.target)).size, 'disclaimer')} exempt` : '',
      !fails.length && notes.length ? plural(notes.length, 'note') : '',
      RENDERED.has(c.id) && unchecked() ? `${unchecked()} not checked` : '',
    ].filter(Boolean);
    const count = [fails.length ? `${plural(targets, 'item')}${fixable ? ' · auto-fix ready' : ''}` : '', ...extra].filter(Boolean).join(' · ');
    const toggle = c.id === 'type' ? disclaimerToggle : undefined;
    const body = fails.length || exempted.length || notes.length
      ? `<div class="body"><ul class="findings">${groupFindings(fails, toggle)}${groupFindings(exempted, toggle)}${groupFindings(notes)}</ul></div>`
      : '';
    return `<li><details data-check="${c.id}"${open.has(c.id) ? ' open' : ''}><summary>${pill}<span><span class="title">${esc(c.title)}</span><br><span class="when">${esc(c.passWhen)}</span></span><span class="count">${count}</span></summary>${body}</details></li>`;
  }).join('');
  const s = session!;
  const warnings = [
    ...s.unknownSizes.map((size) => `Served size "${size}" has no preview: it is not a size like 300x250 or a range like 300x250:320x480 that a size fits. It was not checked.`),
    ...r.skipped.map((page) => `${page} never showed, so it was not checked there.`),
  ];
  const pages = r.pages > 1 ? `, on each of its ${r.pages} pages` : '';
  box.innerHTML = `<h2>QA checklist</h2><p class="sub">Open a row for the details. Each size is checked as it renders${pages}.</p>${warnings.length ? `<div class="banner warn"><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}<ul class="checks">${rows}</ul>`;
}

/** "a, b and c", or the first few and how many more. */
function listed(items: string[], most = 6): string {
  const shown = items.length > most ? [...items.slice(0, most - 1), `${items.length - most + 1} more`] : items;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown.join('');
}

function applyBanner(a: ApplyResult): string {
  const p = a.positions;
  const laid = a.layout;
  const applied = `Applied ${plural(a.applied.length, 'fix', 'fixes')}`;
  // A changed line spacing is usually why texts moved, so it comes first.
  const what = (spacings: number, texts: number) => [
    spacings ? `${plural(spacings, 'line spacing')} changed` : '',
    texts ? `${plural(texts, 'text')} moved` : '',
  ].filter(Boolean).join(' and ');
  const live = what(p.respaced.length, p.moved.length);
  // The previews compare their own sizes with the ad running; the layout without scripts adds the sizes
  // between them, and the hover, focus and click states, which no preview is in.
  const between = laid.diffs.filter((d) => !d.previewed && !d.state);
  const inState = laid.diffs.filter((d) => d.state);
  const stateWhat = what(inState.filter((d) => d.spacing).length, inState.filter((d) => !d.spacing).length);
  const stateSizes = listed([...new Set(inState.map((d) => d.size))]);
  const state = inState[0]?.state ?? '';
  const respaced = between.filter((d) => d.spacing);
  const moved = between.filter((d) => !d.spacing);
  const net = what(respaced.length, moved.length);
  const where = [...new Set(between.map((d) => d.size))];
  const sizes = listed(where);
  const texts = p.texts === 1 ? 'The one text is exactly where it was' : `All ${p.texts} texts are exactly where they were`;
  const spacing = p.spacings ? ', and every line spacing is unchanged' : '';
  // Texts inside elements the keyframes fix proved never show may move with them.
  const unseen = p.unseen.length
    ? ` ${p.unseen.length === 1 ? 'One text' : `${p.unseen.length} texts`} inside elements that never show moved with ${p.unseen.length === 1 ? 'its element' : 'them'}, where nobody sees ${p.unseen.length === 1 ? 'it' : 'them'}.`
    : '';
  if (!live && !net && !stateWhat) {
    if (laid.error) {
      return `<div class="banner warn">${applied}. ${texts}${spacing}, in every preview.${unseen} The sizes between them could not be laid out to compare (${esc(laid.error)}): check them in GWD, or undo.</div>`;
    }
    const every = result && result.pages > 1 ? 'in every size and on every page' : 'in every size';
    const missed = result ? unchecked() : '';
    if (missed) return `<div class="banner warn">${applied}. ${texts}${spacing}, wherever the previews showed them; ${missed} not checked, so compare ${missed.includes('and') ? 'those' : 'that'} in GWD.${unseen}</div>`;
    return `<div class="banner ok">${applied}. ${texts}${spacing}, ${every}.${unseen}</div>`;
  }
  // The sizes no preview shows are laid out without scripts, so they are told apart.
  const inStateText = stateWhat ? ` ${state[0].toUpperCase()}${state.slice(1)}, ${stateWhat} at ${stateSizes}.` : '';
  const head = live
    ? `${applied}, but ${live}.${net ? ` Laid out without scripts, ${net} too, at ${sizes}.` : laid.error ? ` The sizes between the previews could not be laid out to compare (${laid.error}).` : ''}${inStateText} Check them in the preview, or undo.`
    : net
      ? `${applied}. Every text in the previews is where it was, but laid out without scripts, ${net} at ${sizes}.${inStateText} Check ${where.length === 1 ? 'that size' : 'those sizes'} in GWD, or undo.`
      : `${applied}. Every text is where it was at rest, but ${state}, ${stateWhat} at ${stateSizes}. Check that state in the preview, or undo.`;
  const keys = [
    ...p.respaced,
    ...p.moved,
    ...respaced.map((d) => `${d.size} ${d.target} line-height`),
    ...moved.map((d) => `${d.size} ${d.target} "${d.text}"`),
    ...inState.map((d) => `${d.size} ${d.target} ${d.spacing ? 'line-height' : `"${d.text}"`}, hovered, focused or clicked`),
  ];
  const list = keys.slice(0, 12).map((k) => `<li>${esc(k)}</li>`).join('');
  return `<div class="banner warn">${esc(head)}<ul>${list}</ul></div>`;
}

function renderFixes() {
  const r = result!;
  const box = $('#fixes');
  box.hidden = false;
  if (!ENGINE.chrome) {
    box.innerHTML = `
      <h2>Fixes</h2>
      <p class="sub">Fixes are made in Chrome only. Each one keeps the ad exactly as the browser that measured it draws it, and GWD previews ads in Chrome's engine, so a fix measured in ${ENGINE.name} could move text in Chrome. To fix this ad, open this page in Chrome, Edge or Brave.</p>`;
    return;
  }
  const fixes = r.plan.fixes;
  const typeFails = failing('type');
  const envFails = failing('environment');
  const decisions: { check: CheckId; note: string }[] = [
    ...envFails.map((f) => ({ check: f.check, note: f.message })),
    ...(typeFails.length ? [{ check: 'type' as const, note: 'Text below 8px changes the design, so it is never fixed automatically; see the Type size row for each text and how to fix it.' }] : []),
    ...r.plan.manual.map((m) => ({ check: m.check, note: m.detail })),
    ...(failing('position').some((f) => !cleared(f)) ? [{ check: 'position' as const, note: 'Keyframes move elements with top or left; re-animate that movement with transform: translate3d in GWD.' }] : []),
  ];
  // A note's fix, written out, for someone who accepts that it may change how the ad looks: its index
  // in plan.anyway, and the edits view, or null where it has none or its edits cannot go in together.
  const anyway = r.plan.anyway ?? [];
  const risky = new Map<string, { k: number; diff: string }>();
  anyway.forEach((a, k) => {
    try {
      risky.set(a.detail, { k, diff: editsHtml(a.edits) });
    } catch {
      // edits that overlap each other: offered to no one
    }
  });
  const anywayHtml = (note: string, check: CheckId) => {
    const a = risky.get(note);
    return a ? `<div class="anyway"><label><input type="checkbox" data-anyway="${a.k}" data-anyway-check="${check}"> Fix anyway</label>${a.diff}</div>` : '';
  };
  // Grouped under their checklist items, in the checklist's order.
  const groups = CHECKS.filter((c) => decisions.some((d) => d.check === c.id)).map((c) => {
    const notes = decisions.filter((d) => d.check === c.id);
    const fixable = notes.filter((d) => risky.has(d.note)).length;
    const all = fixable > 1 ? `<label class="anyway-all"><input type="checkbox" data-anyway-all="${c.id}"> Fix all ${fixable} anyway</label>` : '';
    return `<li><h4><button type="button" class="link" data-action="open-check" data-check="${c.id}">${esc(c.title)}</button><span class="count">${plural(notes.length, 'item')}</span>${all}</h4>
      <ul>${notes.map((d) => `<li>${decisionHtml(d.note, d.check)}${anywayHtml(d.note, d.check)}</li>`).join('')}</ul></li>`;
  });
  const applyButton = '<button class="primary" data-action="apply">Apply selected fixes</button>';
  const list = fixes.map((f: PlannedFix, i: number) => `
    <li>
      <input type="checkbox" id="fix-${i}" data-fix="${i}" checked>
      <div><label for="fix-${i}"><strong>${esc(f.title)}</strong> <span class="pill info">${esc(CHECKS.find((c) => c.id === f.check)!.title)}</span>
        <div class="detail">${esc(f.detail)}</div></label>
        ${editsHtml(f.edits)}</div>
    </li>`).join('');
  box.innerHTML = `
    <h2>Fixes</h2>
    <p class="sub">These keep the ad looking exactly as it does: no fix moves text or changes how it looks, and one that would is listed under Needs your decision instead. Each fix is laid out without scripts at ${plural(r.layout.sizes, 'size')} first${r.layout.unseen ? `, ${r.layout.unseen} of them between the previews` : ''}${r.layout.state ? `, at rest and ${esc(r.layout.state)}` : ''}, to prove that. Text positions in every size are compared before and after.</p>
    ${session!.lastApply ? applyBanner(session!.lastApply) : ''}
    ${fixes.length
      ? `<ul class="fixlist">${list}</ul>${applyButton}`
      : `<p>${session!.changed ? 'Nothing left to fix automatically.' : 'Nothing to fix automatically.'}</p>`}
    ${groups.length ? `<h3 class="decide">Needs your decision</h3><p class="decide-sub">Fixing these here could move text or change the design, so they are left to you. Open an item for its checklist row.${risky.size ? ` Where the fix can be written, tick Fix anyway to apply it with the fixes${fixes.length ? ' above' : ''} if you accept that risk, as when it is a false alarm. The check after applying lists every text that moved and line spacing that changed, but not images or shapes, so look at the preview too; Undo fixes puts everything back.` : ''}</p><ul class="manual">${groups.join('')}</ul>${!fixes.length && risky.size ? applyButton : ''}` : ''}
    ${weightHtml()}`;
  // The estimate reads the boxes, which exist only now.
  const total = box.querySelector('#savings-total');
  if (total) total.textContent = savingsTotal();
}


// Rounded down, so a file that is still there never reads as 100% smaller.
const pct = (part: number, whole: number) => Math.min(99, Math.floor((part / whole) * 100));

/** The upload zip's size with the ticked savings, from the one it had when they were found. */
function savingsTotal(): string {
  if (!savings) return '';
  let size = savings.upload;
  for (const box of app.querySelectorAll<HTMLInputElement>('input[data-shrink]:checked')) {
    const x = savings.result.shrinks[Number(box.dataset.shrink)];
    size -= x.before.bytes - x.after.bytes;
  }
  for (const box of app.querySelectorAll<HTMLInputElement>('input[data-unused]:checked')) size -= savings.result.unused[Number(box.dataset.unused)].bytes;
  return `With what is ticked, the zip for upload goes from ${mb(savings.upload)} to about ${mb(size)}${size <= 4_000_000 ? ', under the 4 MB limit' : ', still over the 4 MB limit'}.`;
}

/** The package weight fix: its options, and once found, every image it makes smaller and every file it can leave out. */
function weightHtml(): string {
  const s = session!;
  if (s.pkg.kind === 'html') return '';
  if (savings && savings.version !== s.version) dropSavings();
  const over = failing('weight').length > 0;
  if (!over && !savings) return '';
  const o = savingsOptions;
  const select = (name: string, options: [string, string][], current: number) =>
    `<select data-savings="${name}">${options.map(([v, label]) => `<option value="${v}"${Number(v) === current ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const controls = `<div class="savings-options">
      <label>Keep images sharp on ${select('dpr', [['2', '2× screens: most laptops and phones'], ['3', '3× screens: the sharpest phones']], o.dpr)}</label>
      <label>JPEG quality ${select('quality', [['0.9', '90'], ['0.85', '85'], ['0.75', '75']], o.quality)}</label>
      <label>PNG colors ${select('colors', [['256', '256, smaller'], ['0', 'every color']], o.colors)}</label>
      <button type="button" data-action="find-savings">${savings ? 'Find again' : 'Find savings'}</button>
    </div>`;
  const auto = lastAuto && lastAuto.version === s.version ? lastAuto.result : null;
  const still = auto && !auto.reached
    ? `<div class="banner warn">Fix package weight compressed as far as it goes: the zip for upload went from ${mb(auto.before)} to ${mb(auto.after)}, still over the 4 MB limit. Make the largest files smaller in an editor (a video most often), or choose images yourself below at a lower quality.</div>`
    : '';
  const intro = `<h3 class="decide">Package weight</h3><p class="decide-sub">${over ? 'The zip for upload is over the 4 MB limit. ' : ''}Fix package weight makes the images as small as it takes and no smaller, in this browser: first what nobody can see (each image resized to twice its largest size on screen, saved again without visible loss, and GWD's working files left out of the zip for upload), then, only while the zip is still over, stronger compression, the images that save most first. Undo fixes puts everything back.</p>${still}
    ${over ? '<div class="weight-actions"><button class="primary" data-action="fix-weight">Fix package weight</button></div>' : ''}`;
  if (!savings) return `${intro}<details class="choose"><summary>Or choose images yourself</summary>${controls}</details>`;
  const r = savings.result;
  const name = (path: string) => esc(path.split('/').pop()!);
  const shrinks = r.shrinks.map((x, i) => {
    const dims = x.after.width !== x.before.width ? `${x.before.width} × ${x.before.height} → ${x.after.width} × ${x.after.height}` : `${x.before.width} × ${x.before.height}`;
    const pixels = x.lossy ? `pixels differ by ${x.mean.toFixed(1)} of 255 on average, by at most ${x.p99} for 99% of them` : 'the same pixels, stored more tightly';
    const width = Math.round(Math.min(360, x.shows?.w ?? x.after.width));
    return `<li><input type="checkbox" id="shrink-${i}" data-shrink="${i}"${x.recommended ? ' checked' : ''}>
      <div><label for="shrink-${i}"><strong>${name(x.path)}</strong> ${mb(x.before.bytes)} → ${mb(x.after.bytes)} <span class="stat">−${pct(x.before.bytes - x.after.bytes, x.before.bytes)}%</span>
        <div class="detail">${esc(dims)} · ${esc(x.why)} · ${esc(pixels)}${x.recommended ? '' : ' · not ticked: compare it first'}</div></label>
        <details class="compare"><summary>Compare before and after</summary><div class="pair">
          <figure><img src="${savings!.urls[2 * i]}" alt="" style="width:${width}px"><figcaption>Before</figcaption></figure>
          <figure><img src="${savings!.urls[2 * i + 1]}" alt="" style="width:${width}px"><figcaption>After</figcaption></figure>
        </div></details></div></li>`;
  });
  const unused = r.unused.map((u, i) => `<li><input type="checkbox" id="unused-${i}" data-unused="${i}">
      <div><label for="unused-${i}"><strong>${name(u.path)}</strong> ${mb(u.bytes)}
        <div class="detail">Nothing in the ad names it and no preview loaded it: left out of the zip for upload, kept in the full zip. Tick it only if no script builds its name.</div></label></div></li>`);
  const skipped = r.skipped.length ? `<p class="sub">Left as they are: ${esc(listed(r.skipped.map((x) => `${x.path.split('/').pop()} (${x.why})`), 8))}.</p>` : '';
  const none = !shrinks.length && !unused.length ? '<p>Nothing here to make smaller: compress the largest files in an image editor, or shorten the video.</p>' : '';
  return `${intro}<details class="choose" open><summary>Or choose images yourself</summary>${controls}
    ${shrinks.length || unused.length ? `<ul class="fixlist savings">${shrinks.join('')}${unused.join('')}</ul>` : none}
    ${skipped}
    ${shrinks.length || unused.length ? `<p class="savings-total" id="savings-total">${esc(savingsTotal())}</p><button data-action="apply-savings">Apply compression</button>` : ''}</details>`;
}

/**
 * The package weight fixed for the user: measures how large each image shows, picks the least
 * compression that brings the zip for upload under 4 MB, and applies it, proving no text moved.
 */
async function fixWeight() {
  const r = result!;
  return changeHtml('Measuring how large each image shows…', async (s) => {
    const uses = await measureImages(s.frames, s.id);
    const loaded = loadedPaths(s.frames, s.id);
    const files = s.files();
    const upload = [...files.keys()].filter((path) => !isGwdBackup(path) && !s.omitted.has(path));
    const worker = shrinker();
    let auto: AutoResult;
    try {
      auto = await autoShrink({ files, upload, htmlPath: s.pkg.htmlPath, refs: r.report.files, uses, loaded }, s.zip(true).size, worker.run, (step, done, total) => {
        status(`Compressing images, ${step ? `step ${step + 1}` : 'first what nobody can see'}: ${done + 1} of ${total}…`, 'busy');
      });
    } finally {
      worker.close();
    }
    if (!auto.picks.length && !auto.omit.length) {
      lastAuto = { result: auto, version: s.version };
      return;
    }
    status('Applying and comparing text positions…', 'busy');
    const detail = [auto.picks.length ? `${plural(auto.picks.length, 'image')} made smaller` : '', auto.omit.length ? `${plural(auto.omit.length, 'file')} left out of the zip for upload` : ''].filter(Boolean).join(', ');
    await s.applyFiles(new Map(auto.picks.map((p) => [p.path, p.after.data])), auto.omit.map((f) => f.path), { check: 'weight', title: 'Fix package weight', detail, edits: [] });
    lastAuto = { result: auto, version: s.version };
  });
}

/** Measures how large each image shows, then makes the smaller versions, one at a time, in a worker. */
async function findAllSavings() {
  const s = session!;
  const r = result!;
  const uses = await measureImages(s.frames, s.id);
  const loaded = loadedPaths(s.frames, s.id);
  const files = s.files();
  const upload = [...files.keys()].filter((path) => !isGwdBackup(path) && !s.omitted.has(path));
  const worker = shrinker();
  try {
    const found = await findSavings({ files, upload, htmlPath: s.pkg.htmlPath, refs: r.report.files, uses, loaded }, savingsOptions, worker.run, (done, total) => {
      if (total) status(`Compressing images: ${done} of ${total}…`, 'busy');
    });
    dropSavings();
    const urls = found.shrinks.flatMap((x) => [
      URL.createObjectURL(new Blob([files.get(x.path)! as BlobPart], { type: x.type })),
      URL.createObjectURL(new Blob([x.after.data as BlobPart], { type: x.type })),
    ]);
    savings = { result: found, version: s.version, upload: s.zip(true).size, urls };
  } finally {
    worker.close();
  }
  status('');
  renderFixes();
  $('#fixes').querySelector('.savings-options')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function applySavings() {
  if (!savings) return;
  const found = savings.result;
  const replace = new Map<string, Uint8Array>();
  for (const box of app.querySelectorAll<HTMLInputElement>('input[data-shrink]:checked')) {
    const x = found.shrinks[Number(box.dataset.shrink)];
    replace.set(x.path, x.after.data);
  }
  const omit = [...app.querySelectorAll<HTMLInputElement>('input[data-unused]:checked')].map((b) => found.unused[Number(b.dataset.unused)].path);
  if (!replace.size && !omit.length) return;
  const detail = [replace.size ? `${plural(replace.size, 'image')} made smaller` : '', omit.length ? `${plural(omit.length, 'file')} left out of the zip for upload` : ''].filter(Boolean).join(', ');
  return changeHtml('Compressing and comparing text positions…', (s) => s.applyFiles(replace, omit, { check: 'weight', title: 'Compress the package', detail, edits: [] }));
}

/**
 * A note as the planner writes it, "target: why; what to do.", with the element or keyframes it is
 * about set as code and what to do on a line of its own. Its text stays as written.
 */
function decisionHtml(note: string, check: CheckId): string {
  const cut = note.lastIndexOf('; ');
  const [why, todo] = cut > 0 ? [note.slice(0, cut), note.slice(cut + 2)] : [note, ''];
  const target = (check === 'keyframes' ? /^[^\s:]+/ : /^[a-z0-9-]*(?:[.#][\w-]+)+/i).exec(why)?.[0] ?? '';
  // A colon straight after the code reads as a gap, so it is hidden there, but kept in the text.
  const colon = target && why.startsWith(':', target.length) ? ':' : '';
  const rest = `<span class="why${todo ? ' cut' : ''}">${esc(why.slice(target.length + colon.length))}</span>`;
  return `${target ? `<span class="target">${esc(target)}</span>${colon ? '<span class="sep">:</span>' : ''}` : ''}${rest}${todo ? `<span class="sep">; </span><span class="todo">${esc(todo)}</span>` : ''}`;
}

function renderCopy() {
  const box = $('#copy');
  box.hidden = false;
  const rows = result!.report.copy
    .map((c) => `<tr><td class="el">${esc(c.target)}</td><td>${esc(describeSize(c.size))}</td><td>${esc(c.text)}</td></tr>`)
    .join('');
  box.innerHTML = `
    <h2>Copy</h2>
    <p class="sub">Every text in the ad, the base version and each size's override. Read it for typos and grammar.</p>
    <div class="scroll-x"><table class="copy"><thead><tr><th>Element</th><th>Size</th><th>Text</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function applySelected() {
  const chosen = [...app.querySelectorAll<HTMLInputElement>('input[data-fix]:checked')].map((i) => result!.plan.fixes[Number(i.dataset.fix)]);
  // The notes ticked to fix anyway, whose risk the user accepts. Their edits win over a ticked fix's
  // where both change the same text: a value written instead of the declaration deleted around it.
  const anyway = [...app.querySelectorAll<HTMLInputElement>('input[data-anyway]:checked')].flatMap((box) => {
    const a = result!.plan.anyway?.[Number(box.dataset.anyway)];
    return a ? [{ check: a.check, title: 'Fixed anyway', detail: a.detail, edits: a.edits }] : [];
  });
  const taken = anyway.flatMap((f) => f.edits);
  const clashes = (e: Edit) => taken.some((a) => (a.file ?? '') === (e.file ?? '') && a.start < Math.max(e.end, e.start + 1) && e.start < Math.max(a.end, a.start + 1));
  const kept = chosen.map((f) => ({ ...f, edits: f.edits.filter((e) => !clashes(e)) })).filter((f) => f.edits.length);
  chosen.splice(0, chosen.length, ...kept, ...anyway);
  if (!chosen.length) return;
  return changeHtml('Applying fixes and comparing text positions…', (s) => s.apply(chosen));
}

/**
 * Changes the ad's HTML, then checks it again. If that fails, the HTML goes back to the version
 * the results on the page were checked on: their fixes are edits at places in that version.
 */
async function changeHtml(what: string, change: (s: Session) => Promise<unknown>) {
  const s = session!;
  const checked = { ...s.state(), version: s.version, result };
  setBusy(true);
  try {
    status(what, 'busy');
    await change(s);
    await check();
  } catch (err) {
    const stale = s.version !== checked.version && result === checked.result;
    if (stale) await s.revert(checked).catch(() => undefined);
    status(esc(err instanceof Error ? err.message : String(err)) + (stale ? ' The file was put back as it was, so the results below still match it.' : ''), 'err');
  } finally {
    setBusy(false);
  }
}

function download(forUpload = false) {
  const s = session!;
  const lone = s.pkg.kind === 'html';
  const url = URL.createObjectURL(lone ? s.htmlFile() : s.zip(forUpload));
  const stem = s.pkg.zipName.replace(/\.zip$/i, '');
  const a = document.createElement('a');
  a.href = url;
  a.download = lone ? s.pkg.zipName : forUpload ? `${stem}-upload.zip` : `${stem}.zip`;
  // The file holds the HTML as it is now, so checked again it has another key: the marks go there too.
  disclaimerKeys.add(keyFor(a.download, new TextEncoder().encode(s.html)));
  saveDisclaimers();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function reset() {
  void session?.close();
  session = null;
  clearResults();
  clearPreview();
  $('#drop').hidden = false;
  status('');
}

app.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'open-check') return openCheck(btn.dataset.check ?? '');
  if (busy) return;
  if (action === 'apply') return applySelected();
  if (action === 'fix-weight') return fixWeight();
  if (action === 'find-savings') return run('Measuring how large each image shows…', findAllSavings);
  if (action === 'apply-savings') return applySavings();
  if (action === 'download') return download();
  if (action === 'download-upload') return download(true);
  if (action === 'reset') return reset();
  if (action === 'undo') return changeHtml('Restoring the original file…', (s) => s.undo());
  if (action === 'replay-all') return run('Replaying every size…', () => session!.reloadAll());
  if (action === 'replay') {
    const f = session?.frames.find((x) => x.label === btn.dataset.frame);
    if (f) return run(`Replaying ${esc(f.label)}…`, () => session!.reload(f));
  }
});

/** Opens a checklist row and brings it into view. */
function openCheck(id: string) {
  const row = $('#checklist').querySelector<HTMLDetailsElement>(`details[data-check="${CSS.escape(id)}"]`);
  if (!row) return;
  row.open = true;
  row.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Runs a page action with the buttons disabled, showing its progress and any error. */
async function run(what: string, action: () => Promise<unknown>) {
  if (!session) return;
  setBusy(true);
  try {
    status(what, 'busy');
    await action();
    if (lastBusy === what) status('');
  } catch (err) {
    status(esc(err instanceof Error ? err.message : String(err)), 'err');
  } finally {
    setBusy(false);
  }
}

const drop = $('#drop');
const input = $<HTMLInputElement>('#file');
const folderInput = $<HTMLInputElement>('#folder');
// The whole drop zone opens the file picker; its real buttons make the pickers reachable by keyboard.
drop.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (busy || target instanceof HTMLInputElement) return;
  (target.closest('[data-pick="folder"]') ? folderInput : input).click();
});
app.addEventListener('change', (e) => {
  const box = e.target as HTMLInputElement;
  if (box.id === 'allow-net') setThirdParty(box.checked);
  if (box.dataset.savings !== undefined) savingsOptions = { ...savingsOptions, [box.dataset.savings]: Number(box.value) };
  if (box.dataset.shrink !== undefined || box.dataset.unused !== undefined) {
    const total = app.querySelector('#savings-total');
    if (total) total.textContent = savingsTotal();
  }
  // "Fix all anyway" ticks or clears every item of its checklist item, and follows them.
  if (box.dataset.anywayAll !== undefined) {
    for (const item of app.querySelectorAll<HTMLInputElement>(`input[data-anyway-check="${CSS.escape(box.dataset.anywayAll)}"]`)) item.checked = box.checked;
  }
  if (box.dataset.anywayCheck !== undefined) {
    const all = app.querySelector<HTMLInputElement>(`input[data-anyway-all="${CSS.escape(box.dataset.anywayCheck)}"]`);
    const items = [...app.querySelectorAll<HTMLInputElement>(`input[data-anyway-check="${CSS.escape(box.dataset.anywayCheck)}"]`)];
    if (all) {
      all.checked = items.every((i) => i.checked);
      all.indeterminate = !all.checked && items.some((i) => i.checked);
    }
  }
  if (box.dataset.disclaimer !== undefined && session && result) {
    const target = box.dataset.disclaimer;
    if (box.checked === namedDisclaimer(target)) disclaimerChoices.delete(target);
    else disclaimerChoices.set(target, box.checked);
    saveDisclaimers();
    renderSummary();
    renderChecklist();
    app.querySelector<HTMLInputElement>(`input[data-disclaimer="${CSS.escape(target)}"]`)?.focus();
  }
});
for (const picker of [input, folderInput]) {
  picker.addEventListener('change', () => {
    const files = [...(picker.files ?? [])];
    picker.value = ''; // so choosing the same files again loads them again
    if (files.length) load(() => pickedFiles(files));
  });
}
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
// A file dropped anywhere else must not open in place of the page, which an HTML file would.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (!e.dataTransfer || busy) return;
  const files = droppedFiles(e.dataTransfer); // the drop's files are only readable during the event
  load(() => files);
});

async function boot() {
  try {
    await workerReady;
  } catch (err) {
    status(esc(err instanceof Error ? err.message : String(err)), 'err');
    return;
  }
  // ?zip=<path> loads an ad straight away, but only a zip stored on this site under the app's folder.
  const raw = new URLSearchParams(location.search).get('zip');
  if (raw) {
    const url = allowedZipUrl(raw, location.href, import.meta.env.BASE_URL);
    if (!url) {
      status(esc(`?zip= only loads zips stored on this site under ${import.meta.env.BASE_URL}. Drop the file instead.`), 'err');
      return;
    }
    await load(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not fetch ${url.pathname}: ${res.status}`);
      return [{ path: decodeURIComponent(url.pathname.split('/').pop() || 'ad.zip'), data: new Uint8Array(await res.arrayBuffer()) }];
    }, false);
  }
}

(window as unknown as { gwdqa: unknown }).gwdqa = {
  get session() { return session; },
  get result() { return result; },
  load: (name: string, bytes: Uint8Array) => load(async () => [{ path: name, data: bytes }], false),
};

initReports({
  picked: () => picked,
  fixed: () => (session?.changed ? { name: session.pkg.htmlPath.split('/').pop()!, html: session.html } : null),
  state: pageState,
});

/** The page's results as text, as the reporter sees them, for a bug report. */
function pageState(): string {
  const text = (sel: string) => {
    const el = app.querySelector<HTMLElement>(sel);
    return el && !el.hidden ? el.innerText.replace(/\s*\n\s*/g, ' · ').trim() : '';
  };
  const rows = [...app.querySelectorAll<HTMLElement>('#checklist details[data-check]')].map((d) => {
    const part = (s: string) => d.querySelector(s)?.textContent?.trim() ?? '';
    return `  ${part('.pill').padEnd(6)} ${part('.title')}${part('.count') ? ` (${part('.count')})` : ''}`;
  });
  return [
    `Status: ${text('#status > .banner') || text('#status > .card') || 'nothing shown'}`,
    `Summary: ${text('#summary') || 'no results'}`,
    rows.length ? `Checklist:\n${rows.join('\n')}` : 'Checklist: not shown',
    `Fixes applied: ${session?.changed ? 'yes' : 'no'}`,
    `Requests to other sites: ${session?.allowThirdParty ? 'allowed' : 'blocked'}`,
  ].join('\n');
}

boot();
