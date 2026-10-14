import './styles.css';
import { CHECKS, type CheckId, type Finding } from './audit/types';
import { staticAudit } from './audit/static';
import { applyEdits, mergeEdits } from './css/edit';
import { diffLines, diffStats, type Hunk } from './diff';
import type { PlannedFix } from './fix/plan';
import { adPackage, droppedFiles, pickedFiles, type PickedFile } from './input';
import { allowedZipUrl, outsideHosts } from './net';
import { startWorker } from './serve';
import { Session, type ApplyResult, type AuditResult } from './session';
import { describeSize, frameSizes, type FrameSize } from './sizes';
import { keyFor, legacyKey, type AdPackage } from './zip';

const app = document.getElementById('app')!;
let session: Session | null = null;
let result: AuditResult | null = null;
let busy = false;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

app.innerHTML = `
  <div class="wrap">
    <header class="top">
      <div>
        <h1>GWD Ad QA</h1>
        <p>Checks a Google Web Designer ad against the QA checklist in every served size, fixes the safe items, and gives you back the fixed files. Your files never leave this browser.</p>
      </div>
    </header>
    <div id="status"></div>
    <div class="drop" id="drop">
      <strong>Drop a GWD ad here: its zip, its folder, or just its HTML</strong>
      <p>The folder GWD saves to is the one with Responsive.html or index.html in it. With just the HTML, the preview runs on a stand-in for GWD's runtime, without the ad's images.</p>
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
        <div><h2>Preview</h2><p class="sub" style="margin:0">Every served size at its exact dimensions, running as it would live.</p></div>
        <button data-action="replay-all">Replay all</button>
      </div>
      <div class="net" id="net"></div>
      <div class="frames" id="frames" style="margin-top:14px"></div>
    </section>
    <footer class="foot">
      Runs entirely in your browser: the ad's files are read here and served to the preview by a service worker. Nothing is uploaded, and the ad's own requests to other sites are blocked unless you allow them.
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
}

document.addEventListener('visibilitychange', () => {
  if (busy && lastBusy) status(lastBusy, 'busy');
});

function setBusy(on: boolean) {
  busy = on;
  app.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = on || b.dataset.disabled === 'true'));
}

// Started at once; loading waits for it so frames never miss the worker on a first visit.
const workerReady = startWorker();

/** Loads the ad from what was picked or dropped: a zip, the ad's folder, or just its HTML. */
async function load(pick: () => Promise<PickedFile[]>) {
  if (busy) return;
  setBusy(true);
  let swapped = false;
  try {
    status('Reading the ad…', 'busy');
    // Whatever can refuse the new ad runs first, so a refusal leaves the loaded ad as it was.
    const pkg = adPackage(await pick());
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
  status('');
  $('#drop').hidden = true;
  render();
}

/** Takes the results off the page, so no button acts on results that no longer hold. */
function clearResults() {
  result = null;
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

// The checks read from the ad as it renders in the frames (src/audit/render.ts), on each page.
const RENDERED = new Set<CheckId>(['type', 'lineHeight', 'buttonPadding', 'buttonColor', 'marginBlock']);

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
function verdict(check: CheckId): 'fail' | 'review' | 'pass' {
  if (failing(check).length) return 'fail';
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
  return `GWD's runtime files were not included, so the preview uses a stand-in: layout and text are checked, but ${images ? '' : 'images are missing and '}animations or interactions may differ. Drop the whole folder or zip for the full preview.${which}`;
}

function renderSummary() {
  const s = session!;
  const failed = CHECKS.filter((c) => c.id !== 'copy' && verdict(c.id) === 'fail').length;
  const review = CHECKS.filter((c) => c.id !== 'copy' && verdict(c.id) === 'review').length;
  const unseen = unchecked();
  const lone = s.pkg.kind === 'html';
  const fileKind = lone ? 'HTML' : 'zip';
  const note = standinNote(s);
  const box = $('#summary');
  box.hidden = false;
  box.innerHTML = `
    <div class="bar">
      <div class="meta">
        <strong>${esc(s.pkg.zipName)}</strong>${lone ? '' : ` · ${esc(s.pkg.htmlPath)}`} · ${plural(s.sizes.length, 'size')}<br>
        ${failed ? `<span class="pill fail">${plural(failed, 'check')} failing</span>` : ''}
        ${review ? `<span class="pill info">${plural(review, 'check')} to review</span>` : ''}
        ${unseen ? `<span class="pill info">${unseen} not checked</span>` : ''}
        ${failed || review || unseen ? '' : '<span class="pill pass">Every check passes</span>'}
        ${s.changed ? '<span class="pill info">Fixed, not yet downloaded</span>' : ''}
      </div>
      <div class="actions">
        ${s.changed ? '<button data-action="undo">Undo fixes</button>' : ''}
        <button class="${s.changed ? 'primary' : ''}" data-action="download">${s.changed ? `Download fixed ${fileKind}` : `Download ${fileKind}`}</button>
        ${s.backups.length ? '<button data-action="download-upload">Download for upload</button>' : ''}
        <button data-action="reset">Check another ad</button>
      </div>
    </div>
    ${s.backups.length ? `<p class="sub upload-note">Download for upload leaves out GWD's backup copies: ${esc(backupFolders(s).join(', '))} (${plural(s.backups.length, 'file')}).</p>` : ''}
    ${note ? `<div class="banner warn standin">${esc(note)}</div>` : ''}
    ${s.changed ? diffBox(`Review the changes to ${s.pkg.htmlPath.split('/').pop()}`, s.originalHtml, s.html) : ''}`;
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
    const fixable = r.plan.fixes.some((f) => f.check === c.id);
    const targets = new Set(fails.map((f) => f.target)).size;
    const pill = { fail: '<span class="pill fail">Fail</span>', review: '<span class="pill info">Review</span>', pass: '<span class="pill pass">Pass</span>' }[verdict(c.id)];
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

function applyBanner(a: ApplyResult): string {
  const p = a.positions;
  const applied = `Applied ${plural(a.applied.length, 'fix', 'fixes')}`;
  if (!p.moved.length && !p.respaced.length) {
    const where = result && result.pages > 1 ? 'in every size and on every page' : 'in every size';
    const texts = p.texts === 1 ? 'The one text is exactly where it was' : `All ${p.texts} texts are exactly where they were`;
    const spacing = p.spacings ? ', and every line spacing is unchanged' : '';
    return `<div class="banner ok">${applied}. ${texts}${spacing}, ${where}.</div>`;
  }
  // A changed line spacing is usually why texts moved, so it comes first.
  const what = [
    p.respaced.length ? `${plural(p.respaced.length, 'line spacing')} changed` : '',
    p.moved.length ? `${plural(p.moved.length, 'text')} moved` : '',
  ].filter(Boolean).join(' and ');
  const list = [...p.respaced, ...p.moved].slice(0, 12).map((k) => `<li>${esc(k)}</li>`).join('');
  return `<div class="banner warn">${applied}, but ${what}. Check them in the preview, or undo.<ul>${list}</ul></div>`;
}

function renderFixes() {
  const r = result!;
  const box = $('#fixes');
  box.hidden = false;
  const fixes = r.plan.fixes;
  const typeFails = failing('type');
  const envFails = failing('environment');
  const manual = [
    ...envFails.map((f) => `<li>${esc(f.message)}</li>`),
    ...(typeFails.length ? [`<li>Text below 8px changes the design, so it is never fixed automatically. See the Type size row for each item and how to fix it.</li>`] : []),
    ...r.plan.manual.map((m) => `<li>${esc(m.detail)}</li>`),
    ...(failing('position').length ? ['<li>Re-animate top/left movement with transform: translate3d in GWD.</li>'] : []),
  ];
  const html = session!.html;
  const list = fixes.map((f: PlannedFix, i: number) => `
    <li>
      <input type="checkbox" id="fix-${i}" data-fix="${i}"${f.moves ? '' : ' checked'}>
      <div><label for="fix-${i}"><strong>${esc(f.title)}</strong> <span class="pill info">${esc(CHECKS.find((c) => c.id === f.check)!.title)}</span>
        <div class="detail">${esc(f.detail)}</div>${f.moves ? `<div class="detail"><span class="pill note">Moves text</span> ${esc(f.moves)}</div>` : ''}</label>
        ${diffBox('Show the edits', html, applyEdits(html, mergeEdits(f.edits)))}</div>
    </li>`).join('');
  box.innerHTML = `
    <h2>Fixes</h2>
    <p class="sub">These declare what the ad already renders, so nothing should move; any fix that would move text is marked and left unticked. Text positions in every size are compared before and after.</p>
    ${session!.lastApply ? applyBanner(session!.lastApply) : ''}
    ${fixes.length
      ? `<ul class="fixlist">${list}</ul><button class="primary" data-action="apply">Apply selected fixes</button>`
      : `<p>${session!.changed ? 'Nothing left to fix automatically.' : 'Nothing to fix automatically.'}</p>`}
    ${manual.length ? `<h3 style="margin:18px 0 0;font-size:15px">Needs your decision</h3><ul class="manual">${manual.join('')}</ul>` : ''}`;
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
  if (!chosen.length) return;
  return changeHtml('Applying fixes and comparing text positions…', (s) => s.apply(chosen));
}

/**
 * Changes the ad's HTML, then checks it again. If that fails, the HTML goes back to the version
 * the results on the page were checked on: their fixes are edits at places in that version.
 */
async function changeHtml(what: string, change: (s: Session) => Promise<unknown>) {
  const s = session!;
  const checked = { html: s.html, lastApply: s.lastApply, result };
  setBusy(true);
  try {
    status(what, 'busy');
    await change(s);
    await check();
  } catch (err) {
    const stale = s.html !== checked.html && result === checked.result;
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
  if (!btn || busy) return;
  const action = btn.dataset.action;
  if (action === 'apply') return applySelected();
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
    });
  }
}

(window as unknown as { gwdqa: unknown }).gwdqa = {
  get session() { return session; },
  get result() { return result; },
  load: (name: string, bytes: Uint8Array) => load(async () => [{ path: name, data: bytes }]),
};
boot();
