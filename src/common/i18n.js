/**
 * The one translation helper, shared by every surface the extension paints.
 *
 * chrome.i18n already does the work; this exists to give it a short name, one
 * argument shape, and one behaviour that matters more than either: a message
 * that is missing falls back to its KEY, never to empty text. A button reading
 * `popup_reportButton` is an obvious bug somebody reports on sight; a blank
 * button just looks broken and gets lived with.
 *
 * Loaded before the page scripts on every extension page, first in the
 * content-script bundle, and imported first by the service worker, so
 * everything downstream may assume CB_T exists. It tolerates chrome.i18n being
 * absent on purpose: protocol.js loads this vocabulary too, and protocol.js is
 * also read by the Node harnesses, where there is no extension API at all.
 */
(function () {
  'use strict';

  const i18n = (typeof chrome !== 'undefined' && chrome.i18n &&
                typeof chrome.i18n.getMessage === 'function') ? chrome.i18n : null;

  /**
   * A locale the user asked for, overriding the browser's.
   *
   * chrome.i18n resolves against the BROWSER's language and offers no way to
   * ask it for another one, so an override means reading the same
   * _locales/<lang>/messages.json Chrome would have read and doing the lookup
   * here. Empty until load() has run and filled it, and empty is the ordinary
   * case: with no override this file behaves exactly as it did before.
   */
  let override = null;

  const SUPPORTED = ['en', 'vi'];

  /**
   * Chrome's own substitution, reimplemented for the override path only.
   * getMessage does this for us when it is doing the lookup; when we are, the
   * $1 placeholders still have to be filled or every message with an argument
   * comes out with the literal marker in it.
   */
  function substitute(message, args) {
    return String(message).replace(/\$(\d+)/g, (whole, n) => {
      const v = args[Number(n) - 1];
      return v === undefined ? whole : v;
    });
  }

  /**
   * Load an override dictionary, then hand back whether anything changed.
   *
   * Callers await this BEFORE painting, because CB_T is synchronous and a page
   * that translated itself first would have to be translated twice -- visibly,
   * in front of the reader.
   */
  async function load(lang) {
    if (!lang || lang === 'auto' || !SUPPORTED.includes(lang)) { override = null; return false; }
    if (!chrome || !chrome.runtime || !chrome.runtime.getURL) { override = null; return false; }
    try {
      const res = await fetch(chrome.runtime.getURL('_locales/' + lang + '/messages.json'));
      const json = await res.json();
      const flat = Object.create(null);
      for (const k of Object.keys(json)) flat[k] = json[k] && json[k].message;
      override = { lang, flat };
      return true;
    } catch (e) {
      // A missing or unreadable locale file must not take the page down with
      // it; falling back to the browser's language is a worse outcome than
      // the user asked for, not a broken one.
      override = null;
      return false;
    }
  }

  /** The language actually in force, for <html lang> and for the picker. */
  function current() {
    if (override) return override.lang;
    return i18n ? i18n.getMessage('@@ui_locale').replace(/_/g, '-') : 'en';
  }

  /**
   * CB_T('activity_needsTabMany', 4) -> "4 profiles from the list are waiting…"
   *
   * Substitution goes through getMessage's own $1 placeholders rather than
   * through concatenation at the call site, because a sentence glued together
   * out of translated fragments is a sentence no other language may reorder --
   * and Vietnamese reorders almost all of them. Arguments are stringified
   * first: getMessage silently drops a number.
   */
  function t(key, ...args) {
    const strs = args.map(String);
    if (override) {
      const m = override.flat[key];
      if (m) return substitute(m, strs);
      // Fall through rather than return the key: a message the override file
      // is missing may still exist in the browser's own locale, and half a
      // translation beats a page of identifiers.
    }
    if (!i18n) return key;
    return i18n.getMessage(key, strs) || key;
  }

  /**
   * A message may mark part of itself as emphasis (`<b>…</b>`) or as code
   * (`<c>…</c>`). That is the whole markup vocabulary, and the text is rebuilt
   * here out of nodes this function creates, so a translation can never
   * introduce an element of its own -- nothing is ever parsed as HTML.
   *
   * The alternative was to cut every emphasised sentence into three keys and
   * glue them back together in the page, which is exactly the concatenation
   * the rest of this file exists to avoid. This way the emphasis travels with
   * the sentence and a translator may put it wherever their grammar wants it.
   */
  const MARKED = /<(b|c)>([\s\S]*?)<\/\1>/g;
  const ELEMENT_FOR = { b: 'strong', c: 'code' };

  function fill(el, text) {
    el.textContent = '';
    let at = 0, m;
    MARKED.lastIndex = 0;
    while ((m = MARKED.exec(text))) {
      if (m.index > at) el.appendChild(document.createTextNode(text.slice(at, m.index)));
      const inner = document.createElement(ELEMENT_FOR[m[1]]);
      inner.textContent = m[2];
      el.appendChild(inner);
      at = m.index + m[0].length;
    }
    if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
  }

  /**
   * Translate the static markup of a page (or of one subtree).
   *
   * The pages carry `data-i18n` attributes and no text of their own, which is
   * what lets tools/check.js prove that a string added to a page later cannot
   * quietly skip translation.
   */
  function apply(scope) {
    const root = scope || document;
    for (const el of root.querySelectorAll('[data-i18n]')) fill(el, t(el.dataset.i18n));
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    }
    for (const el of root.querySelectorAll('[data-i18n-title]')) {
      el.title = t(el.dataset.i18nTitle);
    }
    for (const el of root.querySelectorAll('[data-i18n-label]')) {
      el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    }
  }

  /**
   * Resolves once the language override has been read from storage.
   *
   * CB_T is synchronous but the override behind it is not: it comes from
   * chrome.storage, which means there is a window after this file parses in
   * which t() knows nothing and quietly answers in the browser's language
   * instead. A page whose text is static data-i18n markup never notices,
   * because apply() runs on the far side of that await -- which is exactly why
   * this was invisible for so long. A page that BUILDS its text in script does
   * notice: it renders, calls t() during that window, and gets English.
   *
   * That was 34 strings across the activity page, the options page and the
   * popup: every chip, every list control, every tag label. So any page that
   * renders its own content awaits this before the first draw.
   */
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });

  globalThis.CB_I18N_READY = ready;
  globalThis.CB_T = t;
  globalThis.CB_FILL_I18N = fill;
  globalThis.CB_APPLY_I18N = apply;
  globalThis.CB_LOAD_LOCALE = load;
  globalThis.CB_LOCALE = current;
  globalThis.CB_LOCALES = SUPPORTED.slice();

  // Extension pages only. This file also runs as a content script at
  // document_start, and there the document belongs to Facebook or Threads:
  // sweeping their DOM would find nothing (our in-page UI lives in a shadow
  // root and translates itself) and rewriting their <html lang> would be
  // vandalism.
  if (typeof document !== 'undefined' && location.protocol === 'chrome-extension:') {
    const run = async () => {
      // Read the override before painting, not after. chrome.storage is async
      // and CB_T is not, so the alternative is a page that renders in one
      // language and then visibly rewrites itself in another.
      try {
        const got = await chrome.storage.sync.get('settings');
        await load(((got && got.settings) || {}).uiLanguage);
      } catch (e) { /* no storage access here: the browser's language stands */ }
      // Says what the page is actually written in, which is what spellcheck,
      // hyphenation and a screen reader's voice all key off.
      document.documentElement.lang = current();
      apply(document);
      markReady(current());
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
  } else {
    // Content script, or no document at all. There is no override to wait for
    // here, and a promise that never settles would hang every caller -- so it
    // settles immediately rather than not at all.
    markReady(current());
  }
})();
