# GWD Ad QA

Checks a Google Web Designer HTML5 ad against the GWD QA checklist in every served size, fixes the items that can be fixed without changing the design, and gives you back the fixed files.

**Live:** https://handsomewj.github.io/gwd-qa/

Everything runs in your browser. The ad's files are read in the page and served to the preview frames by a service worker, so nothing is uploaded anywhere.

The preview also blocks the ad's own requests to other sites by default. The worker gives the ad's HTML a Content-Security-Policy, so trackers, pixels, ad-server scripts and beacons never fire from the preview, while stylesheets and fonts still load. A switch above the previews lets the ad contact other sites when it needs to; the page lists which hosts the ad's code refers to. While they are blocked, clicks that an ad server's script handles (such as a `dynamicClick` click-through) do nothing.

Each frame is placed on whole device pixels. GWD draws its pages with 3D transforms, which a browser blurs when a frame sits between pixels. A size wider than the window scrolls sideways inside its card, and says so.

## Using it

1. Drop the folder GWD saves to (the one with `Responsive.html` or `index.html`) on the page, or its zip, or choose either. Just the HTML file works too: see [Just the HTML](#just-the-html). Check one ad at a time: several ads (in one drop, one folder or one zip), several zips, or a zip with other files are refused, with a message that says so. When an ad cannot be checked, for example because it never starts, the page says why and shows the drop zone again; nothing of an ad checked before stays on the page.
2. Every served size loads at its exact dimensions. A size range such as `300x250:320x480` is previewed at its smallest and largest size, keeping its orientation. Each checklist item is checked as each size renders, on every page of the ad: GWD keeps pages it is not showing out of the page, so the checker shows each one in turn.
3. Small text that is a disclaimer is exempt from the 8px rule. Tick "Disclaimer" on it; text whose id names a disclaimer (`SA_disclaimer_1`, `legal`, `terms`, `tnc`) is ticked for you. The choice is remembered in this browser: for a zip or a folder by its name, and for just the HTML or loose files by that exact HTML, since GWD names every ad's HTML `Responsive.html`.
4. Open "Show the edits" under a fix to see the exact lines it changes, tick the fixes you want and apply them. Text positions and every text's line spacing are compared before and after, in every size and on every page, so you can see that nothing moved: the page counts the texts that kept their place and the line spacings that stayed the same apart. If the check after applying (or undoing) fails, the file is put back as it was, so the fixes listed still match it.
5. Read the copy list for typos, review the changes, then download:
   - **Download fixed zip** keeps the same files, in the same order, with only the HTML changed.
   - **Download for upload** also leaves out GWD's backup copies (`_revisions/` or `_revision/`, `gwd_preview_*/`). It appears when the zip has them.
   - A folder downloads as a zip named after it. Just the HTML downloads as the fixed HTML file, under the same name.

Keep the tab visible while it checks: GWD starts an ad from `requestAnimationFrame`, which browsers do not run in a hidden tab.

Each open tab keeps its ad in its own cache, so several ads can be checked side by side. A tab's cache is deleted when you check another ad, and the next load clears caches of tabs that were closed.

### Just the HTML

The HTML alone loads GWD's runtime (`gwd_webcomponents_v1_min.js`, `gwdpage_min.js`, `gwdpagedeck_min.js`, `gwd-events-support.1.0.js`, `groups_runtime.min.1.0.js`, `gwdpage_style.css`…) without having it, so the ad would never start. For any missing `gwd*.js` or `groups_runtime*.js` the service worker serves `public/gwd-standin.js` instead, the site's own code: it defines GWD's elements, starts the ad, shows each page, fills each group instance (`data-gwd-group`) with a copy of its definition, nested groups included, applies each size's `data-gwd-media-override` text and attributes, and draws a light box for each missing image. A missing `gwd*.css` is served empty. Layout and text are checked as with the full ad; images are missing and animations or interactions may differ, which the page says above the results. The exception is text that GWD's text helper fits to its box when the ad runs, which needs `gwd-text-fitting.js`: the stand-in shows it at its written size, so its type size is a note rather than a pass (text already below 8px still fails, as fitting only shrinks it) and its line-height is left to you. A folder or zip that lacks only some runtime files runs GWD's own files up to the first missing one, and the stand-in for the rest. The stand-in then loads GWD's own pages before it shows them, as GWD's deck does, and gives GWD's own overrides helper the rich-text binder of `gwd-dynamic-binders.js` when that file is missing.

## The checklist

| Check | Passes when | Fixed automatically |
|---|---|---|
| Type size | Rendered text is at least 8px (font-size × every ancestor scale), except text marked as a disclaimer | No: it changes the design. Each item says what scale or font-size would reach 8px |
| line-height | Every `<p>`, `<span>` and `<button>` declares one, in every size | Yes: the px value each size renders now (a value it inherits from its parent's declaration, else its font's normal spacing, measured after the ad's web fonts have loaded), declared in the media block that wins in that size (the base size in its base rule), so no value reaches another size. A size no frame shows, such as the inside of a range whose two ends are exact sizes, gets the value measured in its own font, or the base rule gets none: none where that size sets a line-height for the text or for what it sits in, or changes a font in a way that cannot be measured exactly (an inline style, an id or `!important` rule that may win, a size in `em`, a font only a text inside takes). A span gets `inherit` only where it renders its parent's value. A class is left to you where its texts render different values in one size, where its value would reach text inside it that renders another (a `<sup>`, a span without a class, text that inherits a multiplier or declares `inherit`), where it also sits on text styled by another class or on an element around text (a group's `<div>`), where some of its characters draw in another font (an emoji, Chinese, Japanese or Korean type its font lacks) so its lines are not all one height, where an animation changes its font, where a page it may sit on never showed in a size, where a media query that is not a GWD size changes it in sizes no frame shows, where its web font had not loaded, or where GWD fits its text to its box. Declarations browsers drop (the CSS values check lists them) count as not there. Word spans that text effects create while the ad runs are skipped |
| Button padding | Every `<button>` has `padding: 0px` | Yes, when the text cannot move: a left-only inset on centred text becomes `text-indent`. Left to you where a page the button may sit on never showed in a size |
| Button color | Every `<button>` declares `color` | Yes: the color it renders now. Left to you where a page the button may sit on never showed in a size |
| margin-block | Every `<p>` and `<span>` declares `margin-block: 0px auto` | Yes; offered unticked where a default margin is in play, or where a page the text may sit on never showed in a size |
| Non-Google Ad | `<meta name="environment" content="gwd-genericad">` | No: convert in GWD (File → Ad Environment → Non Google Ad → Convert) |
| Copy | No typos or grammar errors | No: the page lists every text, base and per size |
| Position animation | Keyframes move elements with `transform: translate3d`, never `top`/`left` | No |
| Text fade-in | Text starts at `opacity: 0.001`, not `0` | Yes |
| Keyframes | Keyframes hold only properties that change | Yes, after checking each unchanged value equals the element's own style in every size |
| CSS values | Every CSS value is valid, including the styles that events and scripts set (`opacity: 0.3`, not `0,3`): in `<style>`, `style=""`, `setInlineStyle`, `style.cssText`, `setAttribute('style')` and `style.<property>`. GWD's own runtime, when the HTML has it inline, and styles a browser never applies (in comments, `<noscript>` or `<iframe>`) are skipped | Yes, for decimal commas, and only those outside functions when `rgba(0,0,0,0.5)` or the like needs its commas; unticked where the value sizes or places something, or is a `filter` (which makes its element the containing block of positioned text). Other invalid values, and a comma written as `&#44;` or `\x2c`, are listed for you to correct in GWD |

Fixes are text edits on the original HTML that keep GWD's layout (one declaration per line, same indentation), so the file still opens in GWD.

## Development

```bash
npm install
npm run dev      # http://localhost:5173/gwd-qa/
npm test         # parser, planner, diff, sizes, zips and folders, position comparison (Vitest + happy-dom)
npm run build    # type-check and build to dist/
npx playwright install chromium   # once, for the browser tests
npm run test:e2e # the built site in Chromium (Playwright)
```

The browser tests load a small GWD-style ad built in `e2e/mock-ad.ts`: two pages, a range size, a disclaimer, a backup copy, a request to another site, and decimal commas in an event handler and a style attribute. A mock stands in for GWD's runtime, which is not ours to publish. They check every page and both ends of a range, the disclaimer exemption, the edits view, that applying fixes moves no text, both downloads, CSS values as Chromium reads them, request blocking, and two tabs side by side. `e2e/input.spec.ts` also loads the ad as a folder, as loose files, as a drop, and as just its HTML, where the stand-in runs it. `e2e/line-height.spec.ts` checks the line-height fix where the previews cannot show it: inside a range whose two ends are exact sizes, text inside a paragraph that takes the paragraph's line-height, and text GWD fits to its box. `e2e/line-height-guards.spec.ts` applies the fixes as offered and lays the original and the fixed HTML out side by side at sizes no frame shows: a range or nested range that sets a line-height or font only for what a text sits in, fonts an inline style, an id rule or `!important` keeps, `em` sizes, buttons, a dropped declaration, a media query that is not a GWD size, text that takes a multiplier or `inherit`, a group carrying a text's class, fallback fonts, font animations, and a page that never shows in one size. `e2e/standin.spec.ts` checks that the stand-in fills GWD groups, from just the HTML or when only the groups runtime is missing, and that it stands in for a missing rich-text binder or page deck beside GWD's other files. `e2e/flow.spec.ts` loads a second ad over the first that is refused or never starts, makes the check after applying fail, makes a fix move text to see how that is reported, and checks which ads share disclaimer marks.

`?zip=<path>` loads an ad straight away, for example `?zip=/gwd-qa/local-fixtures/my-ad.zip` in development. It only accepts zips stored on this site under `/gwd-qa/`: any other URL could run someone else's HTML on this origin, which every GitHub Pages site of the account shares. Put real ads in `local-fixtures/`, which git ignores: client files must never reach this repo.

Pushing to `main` runs both test suites and, when they pass, deploys to GitHub Pages through `.github/workflows/deploy.yml`.

### Layout

| Path | What |
|---|---|
| `src/css/parse.ts`, `src/css/edit.ts` | The HTML's start tags and the CSS of the `<style>` elements a browser applies, with source offsets; formatting-preserving edits |
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
