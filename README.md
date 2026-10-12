# GWD Ad QA

Checks a Google Web Designer HTML5 ad against the GWD QA checklist in every served size, fixes the items that can be fixed without changing the design, and gives you back the fixed zip.

**Live:** https://handsomewj.github.io/gwd-qa/

Everything runs in your browser. The zip is unpacked in the page and served to the preview frames by a service worker, so nothing is uploaded anywhere.

## Using it

1. Zip the folder GWD saves to (the one with `Responsive.html` or `index.html`) and drop it on the page.
2. Every served size loads at its exact dimensions, and each checklist item is checked as that size renders.
3. Tick the safe fixes and apply them. Text positions in every size are compared before and after, so you can see that nothing moved.
4. Read the copy list for typos, then download the fixed zip. It keeps the same files, in the same order, with only the HTML changed.

Keep the tab visible while it checks: GWD starts an ad from `requestAnimationFrame`, which browsers do not run in a hidden tab.

## The checklist

| Check | Passes when | Fixed automatically |
|---|---|---|
| Type size | Rendered text is at least 8px (font-size × every ancestor scale), except disclaimers | No: it changes the design. Each item says what scale or font-size would reach 8px |
| line-height | Every `<p>`, `<span>` and `<button>` declares one, in every size | Yes: the px value it renders now, in the rule where that size's font-size lives; `inherit` for inline spans |
| Button padding | Every `<button>` has `padding: 0px` | Yes, when the text cannot move: a left-only inset on centred text becomes `text-indent` |
| Button color | Every `<button>` declares `color` | Yes: the color it renders now |
| margin-block | Every `<p>` and `<span>` declares `margin-block: 0px auto` | Yes |
| Non-Google Ad | `<meta name="environment" content="gwd-genericad">` | No: convert in GWD (File → Ad Environment → Non Google Ad → Convert) |
| Copy | No typos or grammar errors | No: the page lists every text, base and per size |
| Position animation | Keyframes move elements with `transform: translate3d`, never `top`/`left` | No |
| Text fade-in | Text starts at `opacity: 0.001`, not `0` | Yes |
| Keyframes | Keyframes hold only properties that change | Yes, after checking each unchanged value equals the element's own style in every size |

Fixes are text edits on the original HTML that keep GWD's layout (one declaration per line, same indentation), so the file still opens in GWD.

## Development

```bash
npm install
npm run dev      # http://localhost:5173/gwd-qa/
npm test         # parser, checks and zip round-trips (Vitest + happy-dom)
npm run build    # type-check and build to dist/
```

`?zip=<url>` loads an ad straight away, for example `?zip=/gwd-qa/local-fixtures/my-ad.zip` in development. Put real ads in `local-fixtures/`, which git ignores: client files must never reach this repo.

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`.

### Layout

| Path | What |
|---|---|
| `src/css/parse.ts`, `src/css/edit.ts` | CSS parser that keeps source offsets, and formatting-preserving edits |
| `src/audit/static.ts` | Source checks: environment, keyframes, text fading from 0, copy list |
| `src/audit/render.ts` | In-frame checks: type size, line-height, buttons, margin-block; position snapshots |
| `src/fix/plan.ts` | Turns failures into safe edits |
| `src/session.ts`, `src/serve.ts`, `public/sw.js` | Loading, frames, the service worker that serves the unzipped ad |
| `src/main.ts` | The page |
