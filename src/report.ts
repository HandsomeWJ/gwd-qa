// The bug report dialog: what went wrong, an email for a reply if the reporter wants one, and the ad
// being checked unless they untick it. The report goes to the site's owner (src/record.ts) with the
// page's state: the results as shown, the errors it met, and the HTML with any fixes applied.

import type { PickedFile } from './input';
import { RECORD_URL, asOneFile, base64, environment, megabytes, send, sendable } from './record';

export interface ReportContext {
  /** The files last picked or dropped, whether or not they loaded. */
  picked(): PickedFile[] | null;
  /** The ad's HTML with the fixes applied, when it differs from the file picked. */
  fixed(): { name: string; html: string } | null;
  /** The page's results, as text. */
  state(): string;
}

const errors: string[] = [];

/** Remembers an error the page showed or the code threw, for the next report. */
export function noteError(message: string) {
  errors.push(`${new Date().toISOString().slice(11, 19)} UTC ${message}`);
  if (errors.length > 20) errors.shift();
}

addEventListener('error', (e) => noteError(e.message || String(e.error)));
addEventListener('unhandledrejection', (e) => noteError(`Unhandled: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Adds the dialog to the page; any element with data-report opens it. */
export function initReports(ctx: ReportContext) {
  if (!RECORD_URL) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'report';
  dialog.setAttribute('aria-labelledby', 'report-title');
  dialog.innerHTML = `
    <form>
      <h2 id="report-title">Report a bug</h2>
      <p class="sub">Say what you did, what happened and what you expected. The report goes to the site's owner with this page's results.</p>
      <label>What went wrong?<textarea name="description" rows="6" required></textarea></label>
      <label>Your email, if you'd like a reply<input type="email" name="email" autocomplete="email"></label>
      <label class="check" data-attach><input type="checkbox" name="attach" checked> <span></span></label>
      <p class="msg" role="status"></p>
      <div class="actions">
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Send report</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form')!;
  const field = <T extends Element>(name: string) => form.elements.namedItem(name) as unknown as T;
  const description = field<HTMLTextAreaElement>('description');
  const email = field<HTMLInputElement>('email');
  const attach = field<HTMLInputElement>('attach');
  const attachRow = form.querySelector<HTMLElement>('[data-attach]')!;
  const msg = form.querySelector<HTMLElement>('.msg')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const close = form.querySelector<HTMLButtonElement>('[data-close]')!;
  const say = (text: string, kind: 'err' | 'ok' | '' = '') => {
    msg.textContent = text;
    msg.className = `msg ${kind}`;
  };

  const open = () => {
    const files = ctx.picked();
    attachRow.hidden = !files?.length;
    if (files?.length) {
      const bytes = files.reduce((n, f) => n + f.data.length, 0);
      const name = files.length === 1 && !files[0].path.includes('/') ? files[0].path : `${files[0].path.split('/')[0]} (${files.length} files)`;
      attachRow.querySelector('span')!.innerHTML = `Include the ad: <strong>${esc(name)}</strong>, ${megabytes(bytes)}`;
    }
    submit.hidden = false;
    submit.disabled = false;
    close.textContent = 'Cancel';
    say('');
    dialog.showModal();
    description.focus();
  };

  document.addEventListener('click', (e) => {
    if ((e.target as Element).closest?.('[data-report]')) open();
  });
  close.addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const what = description.value.trim();
    if (!what) {
      say('Say what went wrong.', 'err');
      description.focus();
      return;
    }
    submit.disabled = true;
    say('Sending…');
    try {
      const files = attach.checked && !attachRow.hidden ? ctx.picked() : null;
      const one = files?.length ? asOneFile(files) : null;
      const { file, note } = one ? sendable(one) : { file: null, note: '' };
      const fixed = one ? ctx.fixed() : null;
      const ad = one ? `Ad: ${one.name}, ${one.picked}, ${megabytes(one.bytes.length)}${note ? `. ${note}` : ''}` : `Ad: ${attachRow.hidden ? 'none picked' : 'not included'}`;
      const about = [...environment(), ad, '', ctx.state(), '', `Errors:\n${errors.join('\n') || 'none'}`].join('\n');
      await send(RECORD_URL, {
        kind: 'bug',
        description: what,
        email: email.value.trim(),
        about,
        file,
        fixed: fixed ? { name: `${fixed.name.replace(/\.html?$/i, '')} (after fixes).html`, type: 'text/html', data: base64(new TextEncoder().encode(fixed.html)) } : null,
      });
      description.value = '';
      submit.hidden = true;
      close.textContent = 'Close';
      say('Thanks: your report was sent.', 'ok');
      close.focus();
    } catch (err) {
      say(`The report was not sent. ${err instanceof Error ? err.message : String(err)}`, 'err');
      submit.disabled = false;
    }
  });
}
