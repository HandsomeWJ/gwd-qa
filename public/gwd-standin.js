// Stands in for Google Web Designer's runtime when an ad is checked without it, for example from
// its HTML file alone. This is the site's own code, not Google's: just enough of the runtime for
// the ad to start, show each of its pages, fill its groups and apply its per-size overrides, so the
// checks can read its layout and text. The service worker (sw.js) serves it for every gwd*.js and
// groups_runtime*.js the ad loads but does not include, so it can run several times in one page:
// the first run sets it up, and each run then does what the file it stands in for would have done.
(() => {
  const fileName = (url) => {
    const name = new URL(url, location.href).pathname.split('/').pop();
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  };
  const state = (window.gwdStandin ??= { scripts: [], displaced: [] });
  const file = document.currentScript?.src ? fileName(document.currentScript.src) : '';
  if (file) state.scripts.push(file);
  // The GWD runtime scripts the ad includes, in the folder of the file this run stands in for. The
  // service worker writes their names in here as it serves this file; left empty, none count as included.
  const included = /* included */ [];
  if (state.run) return state.run(file, included);

  // What GWD's component styles provide, under the ad's own CSS. <gwd-genericad> stays inline, so
  // the deck's height: 100% is the body's.
  const style = document.createElement('style');
  style.textContent = `
    gwd-pagedeck, gwd-page { display: block; }
    gwd-image { display: inline-block; }
    gwd-image > img[data-gwd-standin] { display: block; width: 100%; height: 100%; }`;
  document.head.prepend(style);

  // A light box where an image is missing, instead of the browser's broken-image icon.
  const PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#c6ccd5" fill-opacity="0.4"/></svg>')}`;
  const missing = new WeakSet();
  const placeholder = (img) => {
    if (missing.has(img)) return;
    missing.add(img);
    img.src = PLACEHOLDER;
    img.style.objectFit = 'fill';
  };
  document.addEventListener('error', (e) => {
    if (e.target instanceof HTMLImageElement) placeholder(e.target);
  }, true);

  // data-gwd-media-override, applied as GWD's overrides helper (gwdresponsiveattributeshelper_min.js)
  // applies it. Keys are sizes like "300x250", or ranges like "300x250:320x480" with ":l" or ":p" for
  // an orientation. Every key whose size matches applies: ranges first, then exact sizes, each in string
  // order, a later key's value winning per attribute. The value an override replaced is kept on the
  // element in data-gwd-media-override-<name>, as GWD keeps it, and put back once no key sets it.
  const OVERRIDE = 'data-gwd-media-override';
  const BASE = `${OVERRIDE}-`;
  const TEXT = 'data-gwd-text'; // its value is JSON: the element's content, and whether it is plain text
  const REMOVED = 'gwd-attribute-removed'; // the attribute was not there
  const NUM = '(?:0|[1-9]\\d*)(?:\\.\\d+)?';
  const SIZE = new RegExp(`^(${NUM})x(${NUM})(?::(${NUM})x(${NUM})(?::([lp]))?)?$`);
  const px = (n) => (n === '0' ? n : `${n}px`);
  const mediaOf = (key) => {
    const m = SIZE.exec(key);
    if (!m[3]) return `(width: ${px(m[1])}) and (height: ${px(m[2])})`;
    const orientation = m[5] ? `(orientation: ${m[5] === 'l' ? 'landscape' : 'portrait'}) and ` : '';
    return `${orientation}(min-width: ${px(m[1])}) and (max-width: ${px(m[3])}) and (min-height: ${px(m[2])}) and (max-height: ${px(m[4])})`;
  };
  const byGwdOrder = (a, b) => (a.includes(':') !== b.includes(':') ? (a.includes(':') ? -1 : 1) : a === b ? 0 : a < b ? -1 : 1);
  // GWD skips an element whose overrides are not all a valid size key with string values.
  const overridesOf = (el) => {
    try {
      const overrides = JSON.parse(el.getAttribute(OVERRIDE));
      const valid = Object.entries(overrides).every(([key, values]) => SIZE.test(key) && values instanceof Object && Object.values(values).every((v) => typeof v === 'string'));
      return valid ? overrides : null;
    } catch {
      return null;
    }
  };
  const savedBase = (el) => new Map([...el.attributes].filter((a) => a.name.startsWith(BASE)).map((a) => [a.name.slice(BASE.length), a.value]));
  const write = (el, values) => {
    const saved = savedBase(el);
    for (const [name, value] of values) {
      let now;
      if (name === TEXT) {
        const isPlainText = el.textContent === el.innerHTML;
        now = JSON.stringify({ content: isPlainText ? el.textContent : el.innerHTML, isPlainText });
      } else {
        now = el.hasAttribute(name) ? el.getAttribute(name) : REMOVED;
      }
      if (value === now) continue;
      if (!saved.has(name)) el.setAttribute(BASE + name, now);
      else if (saved.get(name) === value) el.removeAttribute(BASE + name);
      if (name === TEXT) {
        const text = JSON.parse(value);
        if (text.isPlainText || typeof window.gwd?.binders?.html !== 'function') el.textContent = text.content;
        else window.gwd.binders.html(el, text.content);
      } else if (value === REMOVED) {
        el.removeAttribute(name);
      } else {
        el.setAttribute(name, value);
      }
    }
  };
  // Per element, the keys applied last: they are applied again only when the ones that match change.
  const applied = new WeakMap();
  const applyOverride = (el) => {
    const overrides = overridesOf(el);
    if (!overrides) return;
    const keys = Object.keys(overrides).sort(byGwdOrder).filter((key) => matchMedia(mediaOf(key)).matches);
    const signature = JSON.stringify(keys);
    if (applied.get(el) === signature) return;
    applied.set(el, signature);
    const values = savedBase(el);
    for (const key of keys) for (const [name, value] of Object.entries(overrides[key])) values.set(name, value);
    write(el, values);
  };
  // GWD's helper takes the elements on the deck's pages, and the pages and the deck themselves; with
  // no deck, every element in the document.
  const inDeck = (el) => !document.querySelector('gwd-pagedeck') || el.localName === 'gwd-pagedeck' || !!el.closest('gwd-page');
  const ownHelper = () => customElements.get('gwd-responsive-attributes-helper') === GwdResponsiveAttributesHelper;
  const applyOverrides = (root) => {
    if (!ownHelper()) return;
    const els = [...(root.matches?.(`[${OVERRIDE}]`) ? [root] : []), ...root.querySelectorAll(`[${OVERRIDE}]`)];
    try {
      for (const el of els) if (inDeck(el)) applyOverride(el);
    } catch {
      // as GWD's helper, stop at text whose JSON does not parse
    }
  };

  // GWD's groups runtime (groups_runtime*.js), when the stand-in runs in its place: like GWD's, it
  // fills each group instance, [data-gwd-group="name"], with a copy of the group's definition from
  // <template id="gwd-group-definitions">, the groups inside that copy filled too. An instance's own
  // content is replaced, and an instance of a group with no definition is removed. Where definitions
  // hold each other, GWD walks them depth first in definition order and drops, from its copy of the
  // definitions, each instance that leads back to a definition still being walked; so does this.
  const GROUP = 'data-gwd-group';
  const GROUP_DEF = 'data-gwd-group-def';
  const groupsRuntime = () => state.layout || state.scripts.some((name) => /^groups_runtime/i.test(name));
  const filledGroups = new WeakSet(); // filled once, as GWD fills each instance once
  const clear = (el) => {
    for (const n of [...el.childNodes]) if (n.nodeType !== Node.COMMENT_NODE) n.remove();
  };
  const copyInto = (def, el) => el.append(...[...def.childNodes].map((n) => n.cloneNode(true)));
  let groupDefs = null;
  // The definitions, by name, with the groups in them filled. A plain object, as GWD keeps them, so
  // they are walked in the same order.
  const definitions = () => {
    if (groupDefs) return groupDefs;
    const defs = (groupDefs = Object.create(null));
    const template = document.getElementById('gwd-group-definitions');
    const copies = template?.content ? document.importNode(template.content, true) : null;
    for (const def of (copies ?? document).querySelectorAll(`[${GROUP_DEF}]`)) {
      const name = def.getAttribute(GROUP_DEF);
      if (name && !defs[name]) defs[name] = { el: def, uses: [] };
      else def.remove();
    }
    // Each instance inside a definition, noted on its group's definition with the one that holds it.
    const held = copies ? Object.values(defs).flatMap((def) => [...def.el.querySelectorAll(`[${GROUP}]`)]) : [...document.querySelectorAll(`[${GROUP}]`)];
    for (const el of held) {
      let holder = null;
      for (let n = el.parentElement; n && !holder; n = n.parentElement) {
        const name = n.getAttribute(GROUP_DEF);
        if (name && defs[name]) holder = name;
      }
      if (!holder) continue; // an instance in the page, filled by fillGroups
      filledGroups.add(el);
      clear(el);
      const def = defs[el.getAttribute(GROUP)];
      if (def) def.uses.push({ el, holder });
      else el.remove();
    }
    const order = new Map();
    const walking = new Set();
    const walk = (name) => {
      const index = order.size;
      order.set(name, index);
      walking.add(name);
      const { uses } = defs[name];
      for (let i = uses.length - 1; i >= 0; i--) {
        const { el, holder } = uses[i];
        if (!order.has(holder)) walk(holder);
        else if (walking.has(holder) && index > order.get(holder)) {
          el.remove();
          uses.splice(i, 1);
        }
      }
      walking.delete(name);
    };
    for (const name in defs) if (!order.has(name)) walk(name);
    // Fill the instances of each definition once every group it holds is filled.
    const waiting = Object.create(null); // per definition: how many instances of each group it holds
    for (const name in defs) waiting[name] = Object.create(null);
    for (const name in defs) for (const { holder } of defs[name].uses) waiting[holder][name] = (waiting[holder][name] ?? 0) + 1;
    const done = [];
    for (const name in waiting) {
      if (Object.keys(waiting[name]).length) continue;
      done.push(name);
      delete waiting[name];
    }
    for (let k = 0; k < done.length; k++) {
      const name = done[k];
      for (const { el, holder } of defs[name].uses) {
        copyInto(defs[name].el, el);
        const counts = waiting[holder];
        if (--counts[name]) continue;
        delete counts[name];
        if (Object.keys(counts).length) continue;
        done.push(holder);
        delete waiting[holder];
      }
    }
    return defs;
  };
  const fillGroups = (root) => {
    if (!groupsRuntime()) return;
    const defs = definitions();
    for (const el of root.querySelectorAll(`[${GROUP}]`)) {
      if (filledGroups.has(el)) continue;
      filledGroups.add(el);
      clear(el);
      const def = defs[el.getAttribute(GROUP)];
      if (!def) {
        el.remove();
        continue;
      }
      copyInto(def.el, el);
      for (const inner of el.querySelectorAll(`[${GROUP}]`)) filledGroups.add(inner);
    }
  };

  const decks = new Set();
  // By id, also on the pages a deck keeps out of the document.
  const byId = (id) => {
    if (typeof id !== 'string' || !id) return null;
    const found = document.getElementById(id);
    if (found) return found;
    for (const deck of decks) {
      for (const page of deck.pages) {
        const el = page.id === id ? page : page.querySelector(`#${CSS.escape(id)}`);
        if (el) return el;
      }
    }
    return null;
  };

  // Runs `fn` on the first `type` event that `el` itself fires.
  const once = (el, type, fn) => {
    const listener = (e) => {
      if (e.target !== el) return;
      el.removeEventListener(type, listener);
      fn();
    };
    el.addEventListener(type, listener);
  };

  // GWD's own gwd-page (gwdpage_min.js) stays hidden until what it holds, such as an image effect,
  // has loaded. Like GWD's deck: once the page is attached, activate and load it, and present it when
  // it has loaded, unless the deck has moved on (`current` is false).
  const OWN_PAGE = ['gwdActivate', 'gwdIsLoaded', 'gwdLoad', 'gwdPresent'];
  const showOwnPage = (page, current) => once(page, 'attached', () => {
    if (!current()) return;
    page.gwdActivate();
    const present = () => {
      if (!current()) return;
      void page.offsetWidth; // so its animations start from the beginning
      page.gwdPresent();
    };
    if (page.gwdIsLoaded()) return present();
    once(page, 'pageload', present);
    page.gwdLoad();
  });

  class GwdPage extends HTMLElement {}

  class GwdPageDeck extends HTMLElement {
    // On first use, not on connect: the parser has not added the pages yet when the deck connects.
    register() {
      if (this.pages) return;
      if (document.readyState === 'loading') {
        // Asked while the HTML is still being parsed (GWD's own overrides helper asks soon after it
        // connects), when later pages are not there yet: like GWD's own deck before web components are
        // ready, it has none, and leaves them in the document for GWD's groups runtime to fill.
        this.pages = [];
        this.current = -1;
        document.addEventListener('DOMContentLoaded', () => {
          this.pages = null;
          this.register();
        }, { once: true });
        return;
      }
      this.pages = [...this.children].filter((el) => el.localName === 'gwd-page');
      this.pages.forEach((page) => page.remove());
      this.current = -1;
      decks.add(this);
    }
    getPages() {
      this.register();
      return [...this.pages];
    }
    // GWD's own overrides helper finds the elements it applies them to through this.
    getElementsBySelector(selector) {
      this.register();
      return this.pages.flatMap((page) => [...page.querySelectorAll(selector)]);
    }
    getCurrentPage() {
      this.register();
      return this.pages[this.current] ?? null;
    }
    getDefaultPage() {
      this.register();
      const id = this.getAttribute('default-page');
      return this.pages.find((page) => id && page.id === id) ?? this.pages[0] ?? null;
    }
    getPage(target) {
      this.register();
      return this.pages[this.indexOf(target)] ?? null;
    }
    // GWD can pair a page with one for the other orientation; here every page is its own.
    getOrientationSpecificPage(orientation, id) {
      return this.getPage(id);
    }
    get currentIndex() {
      this.register();
      return this.current;
    }
    indexOf(target) {
      return typeof target === 'number' ? target : this.pages.findIndex((page) => page.id === target);
    }
    goToPage(target) {
      this.register();
      const i = this.indexOf(target);
      const page = this.pages[i];
      if (!page || i === this.current) return;
      const old = this.pages[this.current];
      if (old) {
        if (typeof old.gwdDeactivate === 'function') old.gwdDeactivate();
        else old.dispatchEvent(new CustomEvent('pagedeactivated', { bubbles: true }));
        old.classList.remove('gwd-play-animation');
        old.remove();
      }
      this.current = i;
      const visit = (this.visits = (this.visits ?? 0) + 1);
      page.classList.remove('gwd-play-animation');
      fillGroups(page);
      const own = OWN_PAGE.every((name) => typeof page[name] === 'function');
      if (own) showOwnPage(page, () => this.visits === visit);
      this.appendChild(page);
      applyOverrides(page);
      if (own) return;
      page.dispatchEvent(new CustomEvent('pagepresenting', { bubbles: true }));
      void page.offsetWidth; // so its animations start from the beginning
      page.classList.add('gwd-play-animation');
      page.dispatchEvent(new CustomEvent('pageactivated', { bubbles: true }));
    }
    nextPage() {
      this.goToPage(this.current + 1);
    }
    prevPage() {
      this.goToPage(this.current - 1);
    }
  }

  class GwdGenericAd extends HTMLElement {
    initAd() {
      if (this.started) return;
      this.started = true;
      this.dispatchEvent(new CustomEvent('adinitialized', { bubbles: true }));
      // Like GWD's ad element: the overrides helper applies them before the first page shows.
      document.querySelector('gwd-responsive-attributes-helper')?.applyOverrides?.();
      const deck = this.querySelector('gwd-pagedeck');
      if (typeof deck?.goToPage !== 'function') return;
      deck.goToPage(deck.getDefaultPage?.()?.id || 0);
    }
    goToPage(...args) {
      this.querySelector('gwd-pagedeck')?.goToPage?.(...args);
    }
  }

  const FIT = { stretch: 'fill', contain: 'contain', cover: 'cover', none: 'none' };

  class GwdImage extends HTMLElement {
    static observedAttributes = ['source', 'scaling', 'alt'];
    connectedCallback() {
      this.render();
    }
    attributeChangedCallback() {
      if (this.isConnected) this.render();
    }
    render() {
      if (!this.img) {
        this.img = document.createElement('img');
        this.img.dataset.gwdStandin = '';
        // Errors on a page the deck keeps out of the document never reach the document's listener.
        this.img.addEventListener('error', () => placeholder(this.img));
        this.appendChild(this.img);
      }
      const source = this.getAttribute('source') ?? '';
      if (source !== this.shown) {
        this.shown = source;
        missing.delete(this.img);
        if (source) this.img.src = source;
        else placeholder(this.img);
      }
      this.img.alt = this.getAttribute('alt') ?? '';
      if (!missing.has(this.img)) this.img.style.objectFit = FIT[this.getAttribute('scaling')] ?? 'fill';
    }
  }

  // GWD's actions, which the ad's event handlers call. Only the ones that change what the checks
  // see do anything; every other action, in any namespace, is a safe no-op.
  const noop = () => undefined;
  const namespace = (fns) => new Proxy(fns, {
    get: (target, key) => (typeof key !== 'string' || key === 'then' || key in target ? Reflect.get(target, key) : noop),
  });
  const events = {
    getElementById: byId,
    setInlineStyle(id, css) {
      const el = byId(id);
      if (el && typeof css === 'string') el.style.cssText += `;${css}`;
    },
    addHandler(id, type, handler, capture) {
      if (typeof handler === 'function') byId(id)?.addEventListener(type, handler, capture);
    },
    removeHandler(id, type, handler, capture) {
      if (typeof handler === 'function') byId(id)?.removeEventListener(type, handler, capture);
    },
  };
  const gwd = (window.gwd ??= {});
  gwd.actions ??= new Proxy({ events: namespace(events) }, {
    get: (target, key) => (typeof key !== 'string' || key === 'then' || key in target ? Reflect.get(target, key) : (target[key] = namespace({}))),
  });
  // GWD's own responsive helper writes each size's rich text through this (gwd-dynamic-binders.js);
  // without it, the helper shows the HTML as plain text.
  gwd.binders ??= {};
  gwd.binders.html ??= (el, html) => {
    if (html === undefined) return;
    // As GWD's binder does: the text helper notes the element's first text before it changes, which
    // decides whether text fitting may shrink it.
    document.querySelector('gwd-text-helper')?.saveInitialText?.(el);
    el.innerHTML = html;
  };

  // GWD's ad element asks this helper to apply the overrides.
  class GwdResponsiveAttributesHelper extends HTMLElement {
    applyOverrides() {
      applyOverrides(document);
    }
  }

  const define = (tag, element) => {
    if (customElements.get(tag)) return;
    try {
      customElements.define(tag, element);
    } catch {
      // not a name custom elements accept
    }
  };

  // GWD's core elements, each with the runtime file that defines it.
  const CORE = {
    'gwd-page': ['gwdpage_min.js', GwdPage],
    'gwd-pagedeck': ['gwdpagedeck_min.js', GwdPageDeck],
    'gwd-image': ['gwdimage_min.js', GwdImage],
    'gwd-genericad': ['gwdgenericad_min.js', GwdGenericAd],
    'gwd-responsive-attributes-helper': ['gwdresponsiveattributeshelper_min.js', GwdResponsiveAttributesHelper],
  };
  // What GWD's gwd_webcomponents_v1_min.js does where the browser has custom elements: lets GWD's
  // own elements, ES5 constructors that call HTMLElement.call(this), construct.
  const webComponents = () => {
    if (state.webComponents || window.Reflect === undefined || window.customElements === undefined || window.customElements.polyfillWrapFlushCallback) return;
    state.webComponents = true;
    const BuiltIn = window.HTMLElement;
    window.HTMLElement = function () {
      return Reflect.construct(BuiltIn, [], this.constructor);
    };
    window.HTMLElement.prototype = BuiltIn.prototype;
    window.HTMLElement.prototype.constructor = window.HTMLElement;
    Object.setPrototypeOf(window.HTMLElement, BuiltIn);
  };
  // Each run defines the core elements that GWD's own files will not: those whose file the ad does not
  // include, which come before or after this one, so GWD's own files still define theirs. GWD's own
  // deck and image need GWD's own page, so with the stand-in's page they are the stand-in's too; GWD's
  // files for them, if included, are noted as displaced.
  const run = (file, included) => {
    if (/webcomponents/i.test(file)) webComponents();
    const has = (name) => included.some((n) => n.toLowerCase() === name);
    for (const [tag, [name, element]] of Object.entries(CORE)) if (!has(name)) define(tag, element);
    if (customElements.get('gwd-page') !== GwdPage) return;
    for (const tag of ['gwd-pagedeck', 'gwd-image']) {
      const [name, element] = CORE[tag];
      if (customElements.get(tag)) continue;
      define(tag, element);
      if (has(name) && !state.displaced.includes(name)) state.displaced.push(name);
    }
  };
  // GWD's own page deck takes its pages out of the document as it registers them.
  document.addEventListener('pagesregistered', (e) => {
    for (const page of e.detail?.pages ?? []) {
      fillGroups(page);
      applyOverrides(page);
    }
  }, true);

  // Everything else GWD writes (tap areas, gestures, reveals, image effects...) does nothing here.
  const INERT = ['gwd-taparea', 'gwd-gesture', 'gwd-reveal', 'gwd-image-effect', 'gwd-attached', 'gwd-text-helper'];

  // In the frames that lay the fixes out (src/audit/layout.ts), where no other script may run: fill the
  // groups, so that the texts in them are laid out too, and start nothing.
  if (new URL(document.currentScript?.src || location.href, location.href).searchParams.has('layout')) {
    state.layout = true;
    const fill = () => fillGroups(document);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill, { once: true });
    else fill();
    return;
  }

  const setUp = () => {
    // A core element that no file defined after all, for example as the ad includes GWD's file for it
    // but does not load it.
    run('', []);
    fillGroups(document);
    applyOverrides(document);
    const found = [...document.querySelectorAll('*')].map((el) => el.localName).filter((tag) => tag.startsWith('gwd-'));
    for (const tag of new Set([...INERT, ...found])) define(tag, class extends HTMLElement {});
    for (const img of document.querySelectorAll('img:not([data-gwd-standin])')) {
      img.addEventListener('error', () => placeholder(img));
      if (img.complete && img.getAttribute('src') && !img.naturalWidth) placeholder(img);
    }
    window.addEventListener('resize', () => applyOverrides(document));
    // GWD's web components runtime announces this, and the ad's own code then calls initAd(). It comes
    // after every DOMContentLoaded handler, as GWD's does: its groups runtime fills the groups on
    // DOMContentLoaded, before its page deck takes the pages out of the document on this event.
    const scripts = [...document.scripts].filter((el) => el.src).map((el) => fileName(el.src));
    if (!scripts.some((name) => /webcomponents/i.test(name) && !state.scripts.includes(name))) setTimeout(() => window.dispatchEvent(new Event('WebComponentsReady')));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setUp, { once: true });
  else setTimeout(setUp);
  state.run = run;
  run(file, included);
})();
