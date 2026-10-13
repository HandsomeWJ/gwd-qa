// One loaded ad: its files, the preview frames, the checks, and the fixes applied to it.

import { applyEdits, mergeEdits } from './css/edit';
import { parseCss } from './css/parse';
import { comparePositions, observe, positions, waitForAd, type AdFrame } from './audit/observe';
import { renderFindings } from './audit/render';
import { staticAudit, type StaticReport } from './audit/static';
import type { Finding } from './audit/types';
import { planFixes, type FixPlan, type PlannedFix } from './fix/plan';
import { adUrl, ensurePublished, publish, updateFile } from './serve';
import { frameSizes, type FrameSize } from './sizes';
import { isGwdBackup, missingRuntime, writeZip, type AdPackage } from './zip';

export interface AuditResult {
  report: StaticReport;
  findings: Finding[];
  plan: FixPlan;
  safetyChecked: number;
  pages: number; // GWD pages in the ad; each is checked in every size
  skipped: string[]; // pages that never showed, so were not checked
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
  /** GWD runtime files the ad loads but did not come with; the preview runs a stand-in for them. */
  readonly missingRuntime: string[];
  html: string;
  frames: AdFrame[] = [];
  sizes: string[] = [];
  /** Served sizes with no preview: not a size GWD writes, or a range no size fits. */
  unknownSizes: string[] = [];
  lastApply: ApplyResult | null = null;
  /** Off by default: the preview blocks the ad's requests to other sites, so no tracker fires. */
  allowThirdParty = false;
  private unpublish: () => Promise<void> = async () => undefined;

  private constructor(readonly pkg: AdPackage) {
    this.originalHtml = decoder.decode(pkg.files.get(pkg.htmlPath)!);
    this.html = this.originalHtml;
    this.missingRuntime = missingRuntime(pkg);
  }

  static async open(pkg: AdPackage): Promise<Session> {
    const s = new Session(pkg);
    s.unpublish = await publish(s.id, s.pkg.files);
    return s;
  }

  /** Deletes this ad's files from the browser's cache. */
  close(): Promise<void> {
    return this.unpublish();
  }

  get changed(): boolean {
    return this.html !== this.originalHtml;
  }

  /** Every file, with the fixes applied. */
  files(): Map<string, Uint8Array> {
    return new Map([...this.pkg.files, [this.pkg.htmlPath, encoder.encode(this.html)]]);
  }

  /** GWD's backup copies, which the upload-ready zip leaves out. */
  get backups(): string[] {
    return [...this.pkg.files.keys()].filter(isGwdBackup);
  }

  /** Creates exact-size frames inside `host`: one per served size, and two (smallest, largest) per range. */
  mountFrames(host: HTMLElement, sizes: string[], makeCard: (frame: FrameSize, el: HTMLIFrameElement) => HTMLElement) {
    this.sizes = sizes;
    this.unknownSizes = sizes.filter((s) => !frameSizes(s).length);
    host.replaceChildren();
    this.frames = sizes.flatMap(frameSizes).map((fs) => {
      const el = document.createElement('iframe');
      el.width = String(fs.width);
      el.height = String(fs.height);
      el.title = `${fs.label} ad`;
      el.setAttribute('scrolling', 'no');
      host.appendChild(makeCard(fs, el));
      return { size: fs.size, label: fs.label, el };
    });
  }

  /** (Re)loads every frame from the cache and waits until each ad has started. */
  async reloadAll(): Promise<void> {
    await Promise.all(this.frames.map((f) => this.reload(f)));
  }

  async reload(f: AdFrame): Promise<void> {
    await ensurePublished(this.id, () => this.files());
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
        fail(new Error(`The ${f.label} frame did not load.`));
      }, 30_000);
      f.el.addEventListener('load', onLoad);
      f.el.src = `${adUrl(this.id, this.pkg.htmlPath)}?${token}${this.allowThirdParty ? '&net=open' : ''}`;
    });
    // A page the service worker did not serve (say the host's 404) must never be checked as the ad.
    const nav = f.el.contentWindow?.performance.getEntriesByType('navigation')[0] as (PerformanceEntry & { responseStatus?: number }) | undefined;
    if (nav?.responseStatus !== undefined && nav.responseStatus !== 200) {
      throw new Error(`The ${f.label} preview got HTTP ${nav.responseStatus} instead of the ad. Reload this page and try again.`);
    }
    f.started = await waitForAd(f.el);
  }

  /** Checks need every size running; a GWD ad that never shows its page would look like a pass. */
  private assertStarted() {
    const stuck = this.frames.filter((f) => !f.started).map((f) => f.label);
    if (!stuck.length) return;
    const hidden = document.visibilityState === 'hidden' ? ' Keep this tab visible while it checks, then try again.' : '';
    const blocked = this.allowThirdParty ? '' : ' If it needs a script from another site, let it contact other sites and check again.';
    const standin = this.missingRuntime.length ? " GWD's runtime files were not included and the stand-in could not start it: drop the whole folder or zip." : '';
    throw new Error(`The ad did not start in ${stuck.join(', ')}: GWD never showed its first page, so nothing was checked.${hidden}${blocked}${standin}`);
  }

  /** Runs every check on every page of every size. Leaves the frames freshly reloaded, playing from the start. */
  async audit(): Promise<AuditResult> {
    this.assertStarted();
    const css = parseCss(this.html);
    const report = staticAudit(this.html, css);
    const seen = await observe(this.frames, css); // shows each page in turn, pausing animations
    const findings = [...report.findings, ...renderFindings(seen.boxes)];
    const plan = planFixes({ html: this.html, css, boxes: seen.boxes, media: seen.media, report, safety: seen.safety, incomplete: seen.incomplete });
    await this.reloadAll();
    return { report, findings, plan, safetyChecked: seen.safetyChecked, pages: seen.pages, skipped: seen.skipped };
  }

  /** Applies fixes, then proves text did not move by comparing every text node's position on every page. */
  async apply(fixes: PlannedFix[]): Promise<ApplyResult> {
    await this.reloadAll(); // undo anything a click in the preview changed, so both runs start alike
    this.assertStarted();
    const before = await positions(this.frames);
    this.html = applyEdits(this.html, mergeEdits(fixes.flatMap((f) => f.edits)));
    await updateFile(this.id, this.pkg.htmlPath, encoder.encode(this.html));
    await this.reloadAll();
    this.assertStarted();
    const result = { applied: fixes, positions: comparePositions(before, await positions(this.frames)) };
    this.lastApply = result;
    await this.reloadAll(); // positions() leaves the frames paused on their last page
    return result;
  }

  async undo(): Promise<void> {
    this.html = this.originalHtml;
    this.lastApply = null;
    await updateFile(this.id, this.pkg.htmlPath, encoder.encode(this.html));
    await this.reloadAll();
  }

  /** The zip with the fixes applied; `forUpload` leaves out GWD's backup copies. */
  zip(forUpload = false): Blob {
    const changed = new Map([[this.pkg.htmlPath, encoder.encode(this.html)]]);
    return new Blob([writeZip(this.pkg, changed, forUpload ? isGwdBackup : undefined) as BlobPart], { type: 'application/zip' });
  }

  /** The HTML with the fixes applied, for an ad that came as just its HTML. */
  htmlFile(): Blob {
    return new Blob([this.html], { type: 'text/html' });
  }
}
