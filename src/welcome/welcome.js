/**
 * The tab that opens once, the first time the extension is installed.
 *
 * Scope is deliberately one thing: how to block somebody. Not the pacing, not
 * the ceilings, not the hide layer, not the list -- all of which are real and
 * all of which are in Settings, where somebody who wants them will look. A
 * first run that explains everything is a first run nobody finishes, and the
 * one action worth learning on day one is the one the extension is named for.
 *
 * There is no "next" and no state: it is a page, it says three things, and
 * closing it is the whole of finishing it.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Opened in a new tab rather than by navigating this one. Somebody who
  // wants to re-read step 2 after looking at a profile should still have it.
  const open = (url) => chrome.tabs.create({ url });

  $('openFacebook').addEventListener('click', () => open('https://www.facebook.com/'));
  $('openThreads').addEventListener('click', () => open('https://www.threads.com/'));

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  /**
   * The language, chosen here rather than found later in Settings.
   *
   * The extension follows the browser's own language and is right for almost
   * everybody, which is precisely why the exception matters: plenty of people
   * run an English-language Chrome and would rather read Vietnamese, and on a
   * page whose entire content is prose, being unable to change that is the
   * first thing wrong with it.
   *
   * Re-rendered in place, not reloaded. This tab is somebody's first minute
   * with the extension; throwing it away and starting again to change a
   * dropdown would be a strange way to begin.
   */
  (async () => {
    const P = globalThis.CB_PROTOCOL;
    const sel = $('uiLanguage');
    if (!sel || !P) return;

    const sw = (type, payload) => new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (e) { resolve(null); }
    });

    const got = await sw(P.SW.GET_SETTINGS);
    const current = (got && got.settings && got.settings.uiLanguage) || 'auto';
    sel.value = current;

    sel.addEventListener('change', async () => {
      const chosen = sel.value;
      await sw(P.SW.SET_SETTINGS, { uiLanguage: chosen });
      if (globalThis.CB_LOAD_LOCALE) await globalThis.CB_LOAD_LOCALE(chosen);
      // APPLY, not FILL. CB_FILL_I18N writes ONE element from a string it is
      // given; CB_APPLY_I18N is the one that sweeps a root for data-i18n. This
      // line said FILL, which meant fill(document, undefined) -- and that
      // throws on `text.length` before it changes anything, so choosing
      // Tiếng Việt here did nothing at all and did it silently.
      if (globalThis.CB_APPLY_I18N) globalThis.CB_APPLY_I18N(document);
      // The sweep rewrites the option labels too, which resets the select, so
      // put the choice back on the control that was just used.
      sel.value = chosen;
      document.documentElement.lang = chosen === 'auto'
        ? (globalThis.CB_LOCALE ? globalThis.CB_LOCALE() : '') : chosen;
    });
  })();
})();
