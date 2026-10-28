// One loaded ad: its files, the preview frames, the checks, and the fixes applied to it.

import { applyEdits, mergeEdits } from './css/edit';
import { parseCss } from './css/parse';
import { LayoutNet, layoutSizes, type LayoutDiff } from './audit/layout';
import { findStates, type States } from './audit/states';
import { comparePositions, observe, positions, waitForAd, type AdFrame } from './audit/observe';
import { renderFindings } from './audit/render';
import { staticAudit, type StaticReport } from './audit/static';
import type { Finding } from './audit/types';
import { guardPlan } from './fix/guard';
import { planFixes, type FixPlan, type PlannedFix } from './fix/plan';
import { adUrl, ensurePublished, publish, updateFile } from './serve';
import { frameSizes, type FrameSize } from './sizes';
import { adKey, isGwdBackup, missingRuntime, writeZip, type AdPackage } from './zip';

export interface AuditResult {
  report: StaticReport;
  findings: Finding[];
  plan: FixPlan;
  safetyChecked: number;
  pages: number; // GWD pages in the ad; each is checked in every size
  skipped: string[]; // pages that never showed, so were not checked
  /**
   * The fixes offered ticked, laid out without scripts: at how many sizes, how many of them no
   * preview shows, the hover, focus or click state they were laid out in too, and how long it took.
   */
  layout: { sizes: number; unseen: number; state: string | null; ms: number };
}

export interface ApplyResult {
  applied: PlannedFix[];
  positions: ReturnType<typeof comparePositions>;
  /** The HTML before and after, laid out without scripts at every size: what changed, or why it could not be compared. */
  layout: { diffs: LayoutDiff[]; sizes: number; ms: number; error?: string };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class Session {
  readonly id = Math.random().toString(36).slice(2, 10);
  /** What choices about this ad, such as disclaimer marks, are remembered under. */
  readonly key: string;
  readonly originalHtml: string;
  /** GWD runtime files the ad loads but did not come with; the preview runs a stand-in for them. */
  readonly missingRuntime: string[];
  /** GWD runtime files the ad came with that cannot run beside the stand-in, so it runs in their place too. */
  readonly displacedRuntime: string[] = [];
  html: string;
  frames: AdFrame[] = [];
  sizes: string[] = [];
  /** Served sizes with no preview: not a size GWD writes, or a range no size fits. */
  unknownSizes: string[] = [];
  lastApply: ApplyResult | null = null;
  /** Off by default: the preview blocks the ad's requests to other sites, so no tracker fires. */
  allowThirdParty = false;
  private unpublish: () => Promise<void> = async () => undefined;
  private net: LayoutNet | null = null;
  private found: States | null = null;

  private constructor(readonly pkg: AdPackage) {
    this.key = adKey(pkg);
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
    const standin = (f.el.contentWindow as (Window & { gwdStandin?: { displaced?: unknown } }) | null)?.gwdStandin;
    const displaced = Array.isArray(standin?.displaced) ? standin.displaced : [];
    for (const name of displaced) if (typeof name === 'string' && !this.displacedRuntime.includes(name)) this.displacedRuntime.push(name);
  }

  /** What the ad's CSS and scripts change in its hover, focus and click states; read once, as fixes never change them. */
  private states(): States {
    this.found ??= findStates(this.originalHtml, parseCss(this.originalHtml), this.pkg);
    return this.found;
  }

  /** Lays the ad out without scripts, at every served size and the sizes between that no preview shows, at rest and in its states. */
  private layoutNet(): LayoutNet {
    this.net ??= new LayoutNet(
      new URL(adUrl(this.id, this.pkg.htmlPath), location.href).href,
      layoutSizes(this.sizes, parseCss(this.originalHtml).media.map((m) => m.media)),
      this.states(),
    );
    return this.net;
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
    const report = staticAudit(this.html, css, undefined, this.pkg);
    const seen = await observe(this.frames, css, this.states()); // shows each page in turn, pausing animations
    const findings = [...report.findings, ...renderFindings(seen.boxes)];
    const plan = planFixes({ html: this.html, css, boxes: seen.boxes, media: seen.media, report, safety: seen.safety, incomplete: seen.incomplete });
    // Laid out while the frames restart: no fix is offered that moves text in a size no frame shows.
    const net = this.layoutNet();
    const html = this.html;
    const started = performance.now();
    const guarded = guardPlan(plan, html, (after, sizes) => net.compare(html, after, sizes)).then(() => performance.now() - started);
    const [, ms] = await Promise.all([this.reloadAll(), guarded]);
    // A state a script puts an element in that cannot be laid out here: no line-height is offered.
    const unknown = [...this.states().unknown, ...net.unreached];
    const lineHeight = plan.fixes.find((f) => f.check === 'lineHeight');
    if (unknown.length && lineHeight) {
      const which = `${unknown.slice(0, 2).join('; ')}${unknown.length > 2 ? `; and ${unknown.length - 2} more` : ''}`;
      plan.fixes.splice(plan.fixes.indexOf(lineHeight), 1);
      plan.manual.push({ check: 'lineHeight', detail: `A script changes a font or line-height on an element this check cannot find (${which}), so how text is spaced then was not laid out, and no line-height is added here (${lineHeight.detail}); set them in GWD.` });
    }
    const layout = { sizes: net.sizes.length, unseen: net.sizes.filter((s) => !s.previewed).length, state: net.state, ms };
    return { report, findings, plan, safetyChecked: seen.safetyChecked, pages: seen.pages, skipped: seen.skipped, layout };
  }

  /** Applies fixes, then proves text did not move by comparing every text node's position on every page. */
  async apply(fixes: PlannedFix[]): Promise<ApplyResult> {
    await this.reloadAll(); // undo anything a click in the preview changed, so both runs start alike
    this.assertStarted();
    const before = await positions(this.frames);
    const html = this.html;
    this.html = applyEdits(this.html, mergeEdits(fixes.flatMap((f) => f.edits)));
    await updateFile(this.id, this.pkg.htmlPath, encoder.encode(this.html));
    await this.reloadAll();
    this.assertStarted();
    const moved = comparePositions(before, await positions(this.frames));
    // The sizes no frame shows too, laid out without scripts while the frames restart.
    const net = this.layoutNet();
    const started = performance.now();
    const laid = net.compare(html, this.html).then(
      (diffs) => ({ diffs, sizes: net.sizes.length, ms: performance.now() - started }),
      (err: unknown) => ({ diffs: [], sizes: net.sizes.length, ms: performance.now() - started, error: err instanceof Error ? err.message : String(err) }),
    );
    const [, layout] = await Promise.all([this.reloadAll(), laid]); // positions() leaves the frames paused on their last page
    const result = { applied: fixes, positions: moved, layout };
    this.lastApply = result;
    return result;
  }

  undo(): Promise<void> {
    return this.revert({ html: this.originalHtml, lastApply: null });
  }

  /** Puts the HTML back as it was at an earlier point, such as when the results on the page were checked. */
  async revert(to: { html: string; lastApply: ApplyResult | null }): Promise<void> {
    this.html = to.html;
    this.lastApply = to.lastApply;
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
