// A small GWD-style ad for the browser tests. GWD's own runtime is not ours to publish, so a
// mock stands in for it: <gwd-pagedeck> keeps inactive pages out of the DOM and shows a page by
// adding gwd-play-animation, the parts of GWD the checks rely on.
import { strToU8, zipSync } from 'fflate';

/** The mock runtime, which the mock ad loads as mock-gwd.js. */
export const MOCK_RUNTIME = `
customElements.define('gwd-page', class extends HTMLElement {});
customElements.define('gwd-pagedeck', class extends HTMLElement {
  // On first use, not on connect: the parser has not added the pages yet when the deck connects.
  register() {
    if (this.pages) return;
    this.pages = [...this.querySelectorAll(':scope > gwd-page')];
    this.pages.forEach((p) => p.remove());
    this.current = -1;
  }
  getPages() { this.register(); return this.pages; }
  getCurrentPage() { this.register(); return this.pages[this.current] ?? null; }
  goToPage(target) {
    this.register();
    const i = typeof target === 'number' ? target : this.pages.findIndex((p) => p.id === target);
    if (i < 0 || i === this.current || this.busy) return;
    const old = this.pages[this.current];
    if (old) {
      old.classList.remove('gwd-play-animation');
      old.remove();
    }
    this.current = i;
    const page = this.pages[i];
    this.appendChild(page);
    this.busy = true;
    setTimeout(() => {
      this.busy = false;
      page.classList.add('gwd-play-animation');
    }, 50);
  }
});
customElements.define('gwd-genericad', class extends HTMLElement {
  initAd() { this.querySelector('gwd-pagedeck').goToPage(0); }
});
// Like GWD, start from requestAnimationFrame.
window.addEventListener('load', () => requestAnimationFrame(() => document.getElementById('gwd-ad').initAd()));
`;

const RANGE = '(min-width: 300px) and (max-width: 320px) and (min-height: 250px) and (max-height: 480px)';

/** GWD's own runtime file names, which the site stands in for when an ad comes without them. */
export const GWD_RUNTIME = ['gwdpage_style.css', 'gwd_webcomponents_v1_min.js', 'gwdpage_min.js', 'gwdpagedeck_min.js', 'gwdgenericad_min.js'];

const runtimeTag = (file: string) => (file.endsWith('.css') ? `<link href="${file}" rel="stylesheet">` : `<script src="${file}"></script>`);

/** The ad's HTML, loading the mock runtime, or `runtime` such as GWD_RUNTIME. */
export function mockAdHtml(headline = 'Headline', runtime = ['mock-gwd.js']): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="generator" content="Google Web Designer 16.4.1.0219">
  <meta name="environment" content="gwd-genericad">
  <script>
    document.addEventListener('securitypolicyviolation', () => { document.documentElement.dataset.blocked = 'yes'; });
  </script>
  ${runtime.map(runtimeTag).join('\n  ')}
  <script type="text/javascript" src="https://creative.stackadapt.com/js/iframe-ct.js"></script>
  <script type="text/javascript" gwd-events="handlers">
    window.gwd = window.gwd || {};
    gwd.framechange_savings = function(event) {
      gwd.actions.events.setInlineStyle('SA_dot_1', 'opacity: 0,3;');
    };
  </script>
  <style type="text/css">
    .gwd-p-a {
      position: absolute;
      left: 10px;
      top: 10px;
      margin: 0px;
      font-family: Arial;
      font-size: 16px;
      transform: translate3d(0px, 0px, 0px);
    }
    .gwd-span-x {
      color: rgb(200, 0, 0);
    }
    .gwd-p-f {
      position: absolute;
      left: 10px;
      top: 110px;
      margin: 0px;
      font-family: Arial;
      font-size: 12px;
    }
    .gwd-span-big {
      font-size: 24px;
    }
    .gwd-button-b {
      position: absolute;
      left: 10px;
      top: 60px;
      width: 120px;
      height: 30px;
    }
    .gwd-p-c {
      position: absolute;
      left: 10px;
      top: 10px;
      margin: 0px;
      font-family: Arial;
      font-size: 16px;
    }
    .gwd-p-d {
      position: absolute;
      left: 10px;
      top: 60px;
      margin: 0px;
      font-family: Arial;
      font-size: 6px;
    }
    .gwd-p-e {
      position: absolute;
      left: 10px;
      top: 80px;
      margin: 0px;
      font-family: Arial;
      font-size: 6px;
    }
    @keyframes kf-in {
      0% {
        opacity: 0;
        transform: translate3d(0px, 0px, 0px);
      }
      100% {
        opacity: 1;
        transform: translate3d(0px, 0px, 0px);
      }
    }
    .gwd-play-animation .gwd-p-a {
      animation: 0.3s linear 0s 1 normal forwards kf-in;
    }
    @media ${RANGE} {
      .gwd-p-c {
        font-size: 12px;
      }
    }
    @media (width: 300px) and (height: 250px) {
      .gwd-p-c {
        font-size: 14px;
      }
    }
  </style>
</head>
<body>
  <script gwd-served-sizes="" type="application/json">["300x250", "300x250:320x480"]</script>
  <gwd-genericad id="gwd-ad">
    <gwd-pagedeck class="gwd-page-container" id="pagedeck">
      <gwd-page id="page1">
        <p class="gwd-p-a" id="SA_headline_1">${headline} <span class="gwd-span-x">one</span></p>
        <button class="gwd-button-b" id="SA_cta_1">Go</button>
        <p class="gwd-p-f" id="SA_body_1">Save<br><span class="gwd-span-big">50%</span> today</p>
        <div id="SA_dot_1"></div>
        <img src="https://pixel.invalid/p.gif" width="1" height="1" alt="">
      </gwd-page>
      <gwd-page id="page2">
        <p class="gwd-p-c" id="SA_headline_2">Page two text</p>
        <p class="gwd-p-d" id="SA_disclaimer_1">Small print</p>
        <p class="gwd-p-e" id="SA_note_1">Tiny</p>
        <div id="SA_rule_1" style="opacity: 0,5;"></div>
      </gwd-page>
    </gwd-pagedeck>
  </gwd-genericad>
  <script>
    // As GWD writes it: start the ad once the runtime has defined its elements. The mock starts it on load instead.
    window.addEventListener('WebComponentsReady', () => requestAnimationFrame(() => setTimeout(() => document.getElementById('gwd-ad').initAd(), 1)));
  </script>
  <script type="text/javascript" src="https://creative.stackadapt.com/js/param.js"></script>
</body>
</html>
`;
}

/** An ad's HTML in a zip with the mock runtime, without a backup copy. */
export function mockZip(html: string): Buffer {
  return Buffer.from(zipSync({ 'Mock Ad/Responsive.html': strToU8(html), 'Mock Ad/mock-gwd.js': strToU8(MOCK_RUNTIME) }));
}

/** The ad as GWD saves it, with a backup copy in _revision/. */
export function mockAdZip(headline?: string): Buffer {
  const html = strToU8(mockAdHtml(headline));
  return Buffer.from(zipSync({
    'Mock Ad/': new Uint8Array(0),
    'Mock Ad/Responsive.html': html,
    'Mock Ad/mock-gwd.js': strToU8(MOCK_RUNTIME),
    'Mock Ad/_revision/': new Uint8Array(0),
    'Mock Ad/_revision/Responsive.html': html,
  }));
}
