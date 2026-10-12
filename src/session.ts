// One loaded ad: its files, the preview frames, the checks, and the fixes applied to it.

import { applyEdits, mergeEdits } from './css/edit';
import { parseCss } from './css/parse';
import { comparePositions, keyframeSafety, positions, renderAudit, waitForAd, type AdFrame } from './audit/render';
import { staticAudit, type StaticReport } from './audit/static';
import type { Finding } from './audit/types';
import { planFixes, type FixPlan, type PlannedFix } from './fix/plan';
import { adUrl, publish, updateFile } from './serve';
import { readZip, writeZip, type AdPackage } from './zip';

export interface AuditResult {
  report: StaticReport;
  findings: Finding[];
  plan: FixPlan;
  safetyChecked: number;
}

export interface ApplyResult {
  applied: PlannedFix[];
  positions: ReturnType<typeof comparePositions>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class Session {
  readonly id = Math.random().toString(36).slice(2, 10);
  readonly originalHtml: string;
  html: string;
  frames: AdFrame[] = [];
  sizes: string[] = [];
  lastApply: ApplyResult | null = null;
  /** Off by default: the preview blocks the ad's requests to other sites, so no tracker fires. */
  allowThirdParty = false;

  private constructor(readonly pkg: AdPackage) {
    this.originalHtml = decoder.decode(pkg.files.get(pkg.htmlPath)!);
    this.html = this.originalHtml;
  }

  static async open(name: string, bytes: Uint8Array): Promise<Session> {
    const s = new Session(readZip(name, bytes));
    await publish(s.id, s.pkg.files);
    return s;
  }

  get changed(): boolean {
    return this.html !== this.originalHtml;
  }

  /** Creates one exact-size frame per served size inside `host`. */
  mountFrames(host: HTMLElement, sizes: string[], makeCard: (size: string, frame: HTMLIFrameElement) => HTMLElement) {
    this.sizes = sizes;
    host.replaceChildren();
    this.frames = sizes.map((size) => {
      const [w, h] = size.split('x').map(Number);
      const el = document.createElement('iframe');
      el.width = String(w);
      el.height = String(h);
      el.title = `${size} ad`;
      el.setAttribute('scrolling', 'no');
      host.appendChild(makeCard(size, el));
      return { size, el };
    });
  }

  /** (Re)loads every frame from the cache and waits until each ad has started. */
  async reloadAll(): Promise<void> {
    await Promise.all(this.frames.map((f) => this.reload(f)));
  }

  async reload(f: AdFrame): Promise<void> {
    // A unique query per load: a frame can still fire load for the page it is leaving,
    // and only the load of this exact URL counts.
    const token = `t=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    await new Promise<void>((done, fail) => {
      const onLoad = () => {
        if (!f.el.contentWindow?.location.search.includes(token)) return;
        clearTimeout(timer);
        f.el.removeEventListener('load', onLoad);
        done();
      };
      const timer = setTimeout(() => {
        f.el.removeEventListener('load', onLoad);
        fail(new Error(`The ${f.size} frame did not load.`));
      }, 30_000);
      f.el.addEventListener('load', onLoad);
      f.el.src = `${adUrl(this.id, this.pkg.htmlPath)}?${token}${this.allowThirdParty ? '&net=open' : ''}`;
    });
    // A page the service worker did not serve (say the host's 404) must never be checked as the ad.
    const nav = f.el.contentWindow?.performance.getEntriesByType('navigation')[0] as (PerformanceEntry & { responseStatus?: number }) | undefined;
    if (nav?.responseStatus !== undefined && nav.responseStatus !== 200) {
      throw new Error(`The ${f.size} preview got HTTP ${nav.responseStatus} instead of the ad. Reload this page and try again.`);
    }
    f.started = await waitForAd(f.el);
  }

  /** Checks need every size running; a GWD ad that never shows its page would look like a pass. */
  private assertStarted() {
    const stuck = this.frames.filter((f) => !f.started).map((f) => f.size);
    if (!stuck.length) return;
    const hidden = document.visibilityState === 'hidden' ? ' Keep this tab visible while it checks, then try again.' : '';
    const blocked = this.allowThirdParty ? '' : ' If it needs a script from another site, let it contact other sites and check again.';
    throw new Error(`The ad did not start in ${stuck.join(', ')}: GWD never showed its first page, so nothing was checked.${hidden}${blocked}`);
  }

  /** Runs every check. Leaves the frames freshly reloaded, playing from the start. */
  async audit(): Promise<AuditResult> {
    this.assertStarted();
    const css = parseCss(this.html);
    const report = staticAudit(this.html, css);
    const findings = [...report.findings, ...renderAudit(this.frames)];
    const safety = keyframeSafety(this.frames); // pauses and restarts animations
    const plan = planFixes({ html: this.html, css, frames: this.frames, report, safety: safety.mismatches });
    await this.reloadAll();
    return { report, findings, plan, safetyChecked: safety.checked };
  }

  /** Applies fixes, then proves text did not move by comparing every text node's position. */
  async apply(fixes: PlannedFix[]): Promise<ApplyResult> {
    this.assertStarted();
    const before = positions(this.frames);
    this.html = applyEdits(this.html, mergeEdits(fixes.flatMap((f) => f.edits)));
    await updateFile(this.id, this.pkg.htmlPath, encoder.encode(this.html));
    await this.reloadAll();
    this.assertStarted();
    const result = { applied: fixes, positions: comparePositions(before, positions(this.frames)) };
    this.lastApply = result;
    return result;
  }

  async undo(): Promise<void> {
    this.html = this.originalHtml;
    this.lastApply = null;
    await updateFile(this.id, this.pkg.htmlPath, encoder.encode(this.html));
    await this.reloadAll();
  }

  zip(): Blob {
    const changed = new Map([[this.pkg.htmlPath, encoder.encode(this.html)]]);
    return new Blob([writeZip(this.pkg, changed) as BlobPart], { type: 'application/zip' });
  }
}
