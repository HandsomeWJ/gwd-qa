// Stands in for Google Web Designer's runtime when an ad is checked without it, for example from
// its HTML file alone. This is the site's own code, not Google's: just enough of the runtime for
// the ad to start, show each of its pages and apply its per-size overrides, so the checks can read
// its layout and text. The service worker (sw.js) serves it for every gwd*.js and groups_runtime*.js
// the ad loads but does not include, so it can run several times in one page; only the first run
// sets it up.
(() => {
  const fileName = (url) => {
    const name = new URL(url, location.href).pathname.split('/').pop();
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  };
  const state = (window.gwdStandin ??= { scripts: [], started: false });
  if (document.currentScript?.src) state.scripts.push(fileName(document.currentScript.src));
  if (state.started) return;
  state.started = true;

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

  // data-gwd-media-override: per served size, attributes and text that replace the base ones.
  // Keys are sizes like "300x250", or ranges like "300x250:320x480" with ":l" or ":p" for an
  // orientation; an exact size wins over a range.
  const SIZE = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?::([lp]))?)?$/;
  const mediaOf = (key) => {
    const m = SIZE.exec(key.trim());
    if (!m) return null;
    if (!m[3]) return `(width: ${m[1]}px) and (height: ${m[2]}px)`;
    const orientation = m[5] === 'l' ? '(orientation: landscape) and ' : m[5] === 'p' ? '(orientation: portrait) and ' : '';
    return `${orientation}(min-width: ${m[1]}px) and (max-width: ${m[3]}px) and (min-height: ${m[2]}px) and (max-height: ${m[4]}px)`;
  };
  const matchingKey = (overrides) => {
    const keys = Object.keys(overrides).filter((key) => {
      const media = mediaOf(key);
      return media && matchMedia(media).matches;
    });
    return keys.find((key) => !key.includes(':')) ?? keys[0] ?? '';
  };
  const TEXT = 'data-gwd-text'; // its value is JSON whose content is the element's HTML
  const textOf = (value) => {
    try {
      return JSON.parse(value).content ?? null;
    } catch {
      return null;
    }
  };
  // Per element: the size key applied, and the base values it replaced.
  const applied = new WeakMap();
  const restore = (el, name, value) => {
    if (name === TEXT) el.innerHTML = value;
    else if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  };
  const applyOverrides = (root) => {
    if (!state.overrides) return;
    const els = [...(root.matches?.('[data-gwd-media-override]') ? [root] : []), ...root.querySelectorAll('[data-gwd-media-override]')];
    for (const el of els) {
      let overrides;
      try {
        overrides = JSON.parse(el.getAttribute('data-gwd-media-override'));
      } catch {
        continue;
      }
      const key = matchingKey(overrides);
      const before = applied.get(el) ?? { key: '', base: {} };
      if (before.key === key) continue;
      for (const [name, value] of Object.entries(before.base)) restore(el, name, value);
      const base = {};
      for (const [name, value] of Object.entries(key ? overrides[key] : {})) {
        if (name === TEXT) {
          const html = textOf(value);
          if (html === null) continue;
          base[name] = el.innerHTML;
          el.innerHTML = html;
        } else {
          base[name] = el.getAttribute(name);
          el.setAttribute(name, String(value));
        }
      }
      applied.set(el, { key, base });
    }
  };

  // GWD's groups runtime fills each group instance, [data-gwd-group="name"], with a copy of the
  // group's definition from <template id="gwd-group-definitions">, and the groups inside that copy
  // in turn. Only empty instances are filled, so this can run again, or after GWD's own runtime.
  const groupDefs = () => {
    const defs = new Map();
    const template = document.getElementById('gwd-group-definitions');
    for (const def of (template?.content ?? document).querySelectorAll('[data-gwd-group-def]')) {
      const name = def.getAttribute('data-gwd-group-def');
      if (name && !defs.has(name)) defs.set(name, def);
    }
    return defs;
  };
  const isEmpty = (el) => [...el.childNodes].every((n) => n.nodeType === Node.COMMENT_NODE || (n.nodeType === Node.TEXT_NODE && !n.data.trim()));
  // A group inside a copy of itself would never end; GWD leaves it out.
  const insideItself = (el, name) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.getAttribute('data-gwd-group') === name || n.getAttribute('data-gwd-group-def') === name) return true;
    }
    return false;
  };
  const fillGroups = (root, defs = groupDefs()) => {
    if (!defs.size) return;
    for (const el of root.querySelectorAll('[data-gwd-group]')) {
      const name = el.getAttribute('data-gwd-group');
      const def = defs.get(name);
      if (!def || !isEmpty(el) || insideItself(el, name)) continue;
      el.append(...[...def.childNodes].map((n) => n.cloneNode(true)));
      fillGroups(el, defs);
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
      this.pages = [...this.children].filter((el) => el.localName === 'gwd-page');
      this.pages.forEach((page) => page.remove());
      this.current = -1;
      decks.add(this);
    }
    getPages() {
      this.register();
      return [...this.pages];
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

  // GWD's core elements. The stand-in defines each one that is not defined yet, now, so GWD's own
  // files that load after it find theirs taken: the ad runs on GWD's files that came before the
  // first missing one and the stand-in for the rest, never on a mix it cannot start.
  const core = {
    'gwd-page': GwdPage,
    'gwd-pagedeck': GwdPageDeck,
    'gwd-image': GwdImage,
    'gwd-genericad': GwdGenericAd,
    'gwd-responsive-attributes-helper': GwdResponsiveAttributesHelper,
  };
  for (const [tag, element] of Object.entries(core)) define(tag, element);
  state.overrides = customElements.get('gwd-responsive-attributes-helper') === GwdResponsiveAttributesHelper;
  // GWD's own page deck takes its pages out of the document as it registers them.
  document.addEventListener('pagesregistered', (e) => {
    for (const page of e.detail?.pages ?? []) {
      fillGroups(page);
      applyOverrides(page);
    }
  }, true);

  // Everything else GWD writes (tap areas, gestures, reveals, image effects...) does nothing here.
  const INERT = ['gwd-taparea', 'gwd-gesture', 'gwd-reveal', 'gwd-image-effect', 'gwd-attached', 'gwd-text-helper'];

  const setUp = () => {
    fillGroups(document);
    applyOverrides(document);
    const found = [...document.querySelectorAll('*')].map((el) => el.localName).filter((tag) => tag.startsWith('gwd-'));
    for (const tag of new Set([...INERT, ...found])) define(tag, class extends HTMLElement {});
    for (const img of document.querySelectorAll('img:not([data-gwd-standin])')) {
      img.addEventListener('error', () => placeholder(img));
      if (img.complete && img.getAttribute('src') && !img.naturalWidth) placeholder(img);
    }
    window.addEventListener('resize', () => applyOverrides(document));
    // GWD's web components runtime announces this, and the ad's own code then calls initAd().
    const scripts = [...document.scripts].filter((el) => el.src).map((el) => fileName(el.src));
    if (!scripts.some((name) => /webcomponents/i.test(name) && !state.scripts.includes(name))) window.dispatchEvent(new Event('WebComponentsReady'));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setUp, { once: true });
  else setTimeout(setUp);
})();
