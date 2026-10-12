import './styles.css';
import { CHECKS, type CheckId, type Finding } from './audit/types';
import { staticAudit } from './audit/static';
import type { PlannedFix } from './fix/plan';
import { startWorker } from './serve';
import { Session, type ApplyResult, type AuditResult } from './session';

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
        <p>Checks a Google Web Designer ad against the QA checklist in every served size, fixes the safe items, and gives you back the fixed zip. Your files never leave this browser.</p>
      </div>
    </header>
    <div id="status"></div>
    <label class="drop" id="drop">
      <strong>Drop a GWD ad .zip here</strong>
      <p>Or choose one. Zip the folder GWD saves to, the one with Responsive.html or index.html in it.</p>
      <span class="button primary">Choose a zip</span>
      <input type="file" id="file" accept=".zip,application/zip" hidden>
    </label>
    <section id="summary" class="card" hidden></section>
    <section id="checklist" class="card" hidden></section>
    <section id="fixes" class="card" hidden></section>
    <section id="copy" class="card" hidden></section>
    <section id="preview" class="card" hidden>
      <div class="bar">
        <div><h2>Preview</h2><p class="sub" style="margin:0">Every served size at its exact dimensions. Interact with it like the live ad.</p></div>
        <button data-action="replay-all">Replay all</button>
      </div>
      <div class="frames" id="frames" style="margin-top:14px"></div>
    </section>
    <footer class="foot">
      Runs entirely in your browser: the zip is unpacked here and served to the preview by a service worker. Nothing is uploaded.
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

async function load(name: string, bytes: Uint8Array) {
  if (busy) return;
  setBusy(true);
  try {
    status('Unpacking the zip…', 'busy');
    session = await Session.open(name, bytes);
    const sizes = staticAudit(session.html).sizes;
    if (!sizes.length) throw new Error('No served sizes found: this does not look like a GWD ad.');
    $('#drop').hidden = true;
    $('#preview').hidden = false;
    session.mountFrames($('#frames'), sizes, frameCard);
    status(`Loading ${plural(sizes.length, 'size')}…`, 'busy');
    await session.reloadAll();
    await check();
  } catch (err) {
    status(esc(err instanceof Error ? err.message : String(err)), 'err');
  } finally {
    setBusy(false);
  }
}

async function check() {
  status('Checking every size…', 'busy');
  result = await session!.audit();
  status('');
  render();
}

function frameCard(size: string, frame: HTMLIFrameElement): HTMLElement {
  const card = document.createElement('div');
  card.className = 'frame';
  card.innerHTML = `<header><span>${size}</span><button data-action="replay" data-size="${size}">Replay</button></header><div class="viewport"></div>`;
  card.querySelector('.viewport')!.appendChild(frame);
  return card;
}

function render() {
  if (!session || !result) return;
  renderSummary();
  renderChecklist();
  renderFixes();
  renderCopy();
}

function failing(check: CheckId): Finding[] {
  return result!.findings.filter((f) => f.check === check && f.level === 'fail');
}

function renderSummary() {
  const s = session!;
  const failed = CHECKS.filter((c) => c.id !== 'copy' && failing(c.id).length).length;
  const box = $('#summary');
  box.hidden = false;
  box.innerHTML = `
    <div class="bar">
      <div class="meta">
        <strong>${esc(s.pkg.zipName)}</strong> · ${esc(s.pkg.htmlPath)} · ${plural(s.sizes.length, 'size')}<br>
        ${failed ? `<span class="pill fail">${plural(failed, 'check')} failing</span>` : '<span class="pill pass">Every check passes</span>'}
        ${s.changed ? '<span class="pill info">Fixed, not yet downloaded</span>' : ''}
      </div>
      <div class="actions">
        ${s.changed ? '<button data-action="undo">Undo fixes</button>' : ''}
        <button class="${s.changed ? 'primary' : ''}" data-action="download">${s.changed ? 'Download fixed zip' : 'Download zip'}</button>
        <button data-action="reset">Check another ad</button>
      </div>
    </div>`;
}

function groupFindings(list: Finding[]): string {
  const groups = new Map<string, { f: Finding; sizes: string[] }>();
  for (const f of list) {
    const key = `${f.target}|${f.message}`;
    const g = groups.get(key) ?? { f, sizes: [] };
    if (f.size) g.sizes.push(f.size);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ f, sizes }) => `<li><span class="target">${esc(f.target)}</span>${sizes.length ? ` <span class="sizes">${esc(sizes.join(', '))}</span>` : ''}: ${esc(f.message)}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</li>`)
    .join('');
}

function renderChecklist() {
  const r = result!;
  const box = $('#checklist');
  box.hidden = false;
  const rows = CHECKS.map((c) => {
    if (c.id === 'copy') {
      return `<li><details><summary><span class="pill info">Review</span><span><span class="title">${esc(c.title)}</span><br><span class="when">${esc(c.passWhen)}</span></span><span class="count">${plural(r.report.copy.length, 'text')} below</span></summary></details></li>`;
    }
    const fails = failing(c.id);
    const notes = r.findings.filter((f) => f.check === c.id && f.level === 'note');
    const fixable = r.plan.fixes.some((f) => f.check === c.id);
    const targets = new Set(fails.map((f) => f.target)).size;
    const pill = fails.length ? '<span class="pill fail">Fail</span>' : '<span class="pill pass">Pass</span>';
    const count = fails.length
      ? `${plural(targets, 'item')}${fixable ? ' · auto-fix ready' : ''}`
      : notes.length ? plural(notes.length, 'note') : '';
    const body = fails.length || notes.length
      ? `<div class="body"><ul class="findings">${groupFindings(fails)}${groupFindings(notes)}</ul></div>`
      : '';
    return `<li><details${fails.length ? '' : ''}><summary>${pill}<span><span class="title">${esc(c.title)}</span><br><span class="when">${esc(c.passWhen)}</span></span><span class="count">${count}</span></summary>${body}</details></li>`;
  }).join('');
  box.innerHTML = `<h2>QA checklist</h2><p class="sub">Open a row for the details. Each size is checked as it renders.</p><ul class="checks">${rows}</ul>`;
}

function applyBanner(a: ApplyResult): string {
  const p = a.positions;
  if (!p.changed.length && !p.missing.length) {
    return `<div class="banner ok">Applied ${plural(a.applied.length, 'fix', 'fixes')}. All ${plural(p.unchanged, 'text element')} are exactly where they were, in every size.</div>`;
  }
  const list = [...p.changed, ...p.missing].slice(0, 12).map((k) => `<li>${esc(k)}</li>`).join('');
  return `<div class="banner warn">Applied ${plural(a.applied.length, 'fix', 'fixes')}, but ${plural(p.changed.length + p.missing.length, 'text element')} moved. Check them in the preview, or undo.<ul>${list}</ul></div>`;
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
  const list = fixes.map((f: PlannedFix, i: number) => `
    <li>
      <input type="checkbox" id="fix-${i}" data-fix="${i}" checked>
      <label for="fix-${i}"><strong>${esc(f.title)}</strong> <span class="pill info">${esc(CHECKS.find((c) => c.id === f.check)!.title)}</span>
        <div class="detail">${esc(f.detail)}</div></label>
    </li>`).join('');
  box.innerHTML = `
    <h2>Fixes</h2>
    <p class="sub">These declare what the ad already renders, so nothing should move. Text positions in every size are compared before and after.</p>
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
    .map((c) => `<tr><td class="el">${esc(c.target)}</td><td>${esc(c.size)}</td><td>${esc(c.text)}</td></tr>`)
    .join('');
  box.innerHTML = `
    <h2>Copy</h2>
    <p class="sub">Every text in the ad, the base version and each size's override. Read it for typos and grammar.</p>
    <div class="scroll-x"><table class="copy"><thead><tr><th>Element</th><th>Size</th><th>Text</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function applySelected() {
  const chosen = [...app.querySelectorAll<HTMLInputElement>('input[data-fix]:checked')].map((i) => result!.plan.fixes[Number(i.dataset.fix)]);
  if (!chosen.length) return;
  setBusy(true);
  try {
    status('Applying fixes and comparing text positions…', 'busy');
    await session!.apply(chosen);
    await check();
  } catch (err) {
    status(esc(err instanceof Error ? err.message : String(err)), 'err');
  } finally {
    setBusy(false);
  }
}

function download() {
  const s = session!;
  const url = URL.createObjectURL(s.zip());
  const a = document.createElement('a');
  a.href = url;
  a.download = s.pkg.zipName.endsWith('.zip') ? s.pkg.zipName : `${s.pkg.zipName}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function reset() {
  session = null;
  result = null;
  for (const id of ['summary', 'checklist', 'fixes', 'copy', 'preview']) $(`#${id}`).hidden = true;
  $('#frames').replaceChildren();
  $('#drop').hidden = false;
  status('');
}

app.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!btn || busy) return;
  const action = btn.dataset.action;
  if (action === 'apply') return applySelected();
  if (action === 'download') return download();
  if (action === 'reset') return reset();
  if (action === 'undo') {
    setBusy(true);
    status('Restoring the original file…', 'busy');
    await session!.undo();
    await check();
    setBusy(false);
  }
  if (action === 'replay-all') await session?.reloadAll();
  if (action === 'replay') {
    const f = session?.frames.find((x) => x.size === btn.dataset.size);
    if (f) await session!.reload(f);
  }
});

const drop = $('#drop');
const input = $<HTMLInputElement>('#file');
const readFile = async (file: File) => load(file.name, new Uint8Array(await file.arrayBuffer()));
input.addEventListener('change', () => input.files?.[0] && readFile(input.files[0]));
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (file) readFile(file);
});

async function boot() {
  try {
    await startWorker();
  } catch (err) {
    status(esc(err instanceof Error ? err.message : String(err)), 'err');
    return;
  }
  // ?zip=<url> loads an ad straight away (same-origin or CORS-enabled URLs).
  const zipUrl = new URLSearchParams(location.search).get('zip');
  if (zipUrl) {
    try {
      const res = await fetch(zipUrl);
      if (!res.ok) throw new Error(`Could not fetch ${zipUrl}: ${res.status}`);
      await load(decodeURIComponent(zipUrl.split('/').pop() || 'ad.zip'), new Uint8Array(await res.arrayBuffer()));
    } catch (err) {
      status(esc(err instanceof Error ? err.message : String(err)), 'err');
    }
  }
}

(window as unknown as { gwdqa: unknown }).gwdqa = { get session() { return session; }, get result() { return result; }, load };
boot();
