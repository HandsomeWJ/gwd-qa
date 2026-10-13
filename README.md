# GWD Ad QA

Checks a Google Web Designer HTML5 ad against the GWD QA checklist in every served size, fixes the items that can be fixed without changing the design, and gives you back the fixed files.

**Live:** https://handsomewj.github.io/gwd-qa/

Everything runs in your browser. The ad's files are read in the page and served to the preview frames by a service worker, so nothing is uploaded anywhere.

The preview also blocks the ad's own requests to other sites by default. The worker gives the ad's HTML a Content-Security-Policy, so trackers, pixels, ad-server scripts and beacons never fire from the preview, while stylesheets and fonts still load. A switch above the previews lets the ad contact other sites when it needs to; the page lists which hosts the ad's code refers to.

## Using it

1. Drop the folder GWD saves to (the one with `Responsive.html` or `index.html`) on the page, or its zip, or choose either. Just the HTML file works too: see [Just the HTML](#just-the-html).
2. Every served size loads at its exact dimensions. A size range such as `300x250:320x480` is previewed at its smallest and largest size, keeping its orientation. Each checklist item is checked as each size renders, on every page of the ad: GWD keeps pages it is not showing out of the page, so the checker shows each one in turn.
3. Small text that is a disclaimer is exempt from the 8px rule. Tick "Disclaimer" on it; text whose id names a disclaimer (`SA_disclaimer_1`, `legal`, `terms`, `tnc`) is ticked for you. The choice is remembered for that zip name in this browser.
4. Open "Show the edits" under a fix to see the exact lines it changes, tick the fixes you want and apply them. Text positions and every text's line spacing are compared before and after, in every size and on every page, so you can see that nothing moved.
5. Read the copy list for typos, review the changes, then download:
   - **Download fixed zip** keeps the same files, in the same order, with only the HTML changed.
   - **Download for upload** also leaves out GWD's backup copies (`_revisions/` or `_revision/`, `gwd_preview_*/`). It appears when the zip has them.
   - A folder downloads as a zip named after it. Just the HTML downloads as the fixed HTML file, under the same name.

Keep the tab visible while it checks: GWD starts an ad from `requestAnimationFrame`, which browsers do not run in a hidden tab.

Each open tab keeps its ad in its own cache, so several ads can be checked side by side. A tab's cache is deleted when you check another ad, and the next load clears caches of tabs that were closed.

### Just the HTML

The HTML alone loads GWD's runtime (`gwd_webcomponents_v1_min.js`, `gwdpage_min.js`, `gwdpagedeck_min.js`, `gwd-events-support.1.0.js`, `gwdpage_style.css`…) without having it, so the ad would never start. For any missing `gwd*.js` the service worker serves `public/gwd-standin.js` instead, the site's own code: it defines GWD's elements, starts the ad, shows each page, applies each size's `data-gwd-media-override` text and attributes, and draws a light box for each missing image. A missing `gwd*.css` is served empty. Layout and text are checked as with the full ad; images are missing and animations or interactions may differ, which the page says above the results. A folder or zip that lacks only some runtime files runs GWD's own files up to the first missing one, and the stand-in for the rest.

## The checklist

| Check | Passes when | Fixed automatically |
|---|---|---|
| Type size | Rendered text is at least 8px (font-size × every ancestor scale), except text marked as a disclaimer | No: it changes the design. Each item says what scale or font-size would reach 8px |
| line-height | Every `<p>`, `<span>` and `<button>` declares one, in every size | Yes: the px value each size renders now, measured after the ad's web fonts have loaded and declared in the media block that wins in that size (the base size in its base rule), so no value reaches another size; a span gets `inherit` only where that already equals its own spacing. Word spans that text effects create while the ad runs are skipped |
| Button padding | Every `<button>` has `padding: 0px` | Yes, when the text cannot move: a left-only inset on centred text becomes `text-indent` |
| Button color | Every `<button>` declares `color` | Yes: the color it renders now |
| margin-block | Every `<p>` and `<span>` declares `margin-block: 0px auto` | Yes |
| Non-Google Ad | `<meta name="environment" content="gwd-genericad">` | No: convert in GWD (File → Ad Environment → Non Google Ad → Convert) |
| Copy | No typos or grammar errors | No: the page lists every text, base and per size |
| Position animation | Keyframes move elements with `transform: translate3d`, never `top`/`left` | No |
| Text fade-in | Text starts at `opacity: 0.001`, not `0` | Yes |
| Keyframes | Keyframes hold only properties that change | Yes, after checking each unchanged value equals the element's own style in every size |
| CSS values | Every CSS value is valid, including the styles that events and scripts set (`opacity: 0.3`, not `0,3`): in `<style>`, `style=""`, `setInlineStyle`, `style.cssText`, `setAttribute('style')` and `style.<property>` | Yes, for decimal commas; unticked where the value sizes or places something. Other invalid values are listed for you to correct in GWD |

Fixes are text edits on the original HTML that keep GWD's layout (one declaration per line, same indentation), so the file still opens in GWD.

## Development

```bash
npm install
npm run dev      # http://localhost:5173/gwd-qa/
npm test         # parser, planner, diff, sizes, zips and folders (Vitest + happy-dom)
npm run build    # type-check and build to dist/
npx playwright install chromium   # once, for the browser tests
npm run test:e2e # the built site in Chromium (Playwright)
```

The browser tests load a small GWD-style ad built in `e2e/mock-ad.ts`: two pages, a range size, a disclaimer, a backup copy, a request to another site, and decimal commas in an event handler and a style attribute. A mock stands in for GWD's runtime, which is not ours to publish. They check every page and both ends of a range, the disclaimer exemption, the edits view, that applying fixes moves no text, both downloads, request blocking, and two tabs side by side. `e2e/input.spec.ts` also loads the ad as a folder, as loose files, as a drop, and as just its HTML, where the stand-in runs it.

`?zip=<path>` loads an ad straight away, for example `?zip=/gwd-qa/local-fixtures/my-ad.zip` in development. It only accepts zips stored on this site under `/gwd-qa/`: any other URL could run someone else's HTML on this origin, which every GitHub Pages site of the account shares. Put real ads in `local-fixtures/`, which git ignores: client files must never reach this repo.

Pushing to `main` runs both test suites and, when they pass, deploys to GitHub Pages through `.github/workflows/deploy.yml`.

### Layout

| Path | What |
|---|---|
| `src/css/parse.ts`, `src/css/edit.ts` | CSS parser that keeps source offsets, and formatting-preserving edits |
| `src/audit/static.ts` | Source checks: environment, keyframes, text fading from 0, copy list |
| `src/audit/cssvalues.ts` | Invalid CSS values in style blocks, style attributes and the styles scripts set, checked with the browser's `CSS.supports` |
| `src/audit/observe.ts` | Reads each frame on each GWD page into plain data; position snapshots |
| `src/audit/render.ts` | Rendered checks on that data: type size, line-height, buttons, margin-block |
| `src/fix/plan.ts` | Turns failures into safe edits, from that data |
| `src/sizes.ts` | Served sizes and ranges, and the frames that preview them |
| `src/diff.ts` | Line diff for the edits views |
| `src/input.ts`, `src/zip.ts` | What was dropped or picked (zip, folder, files, lone HTML) as one package, and the zips it downloads as |
| `src/session.ts`, `src/serve.ts`, `public/sw.js` | Loading, frames, per-tab caches, the service worker that serves the unzipped ad |
| `public/gwd-standin.js` | The stand-in for GWD's runtime, served when an ad does not include it |
| `src/main.ts` | The page |
| `e2e/` | Browser tests and the mock ad they load |
