/**
 * Options page: what the extension is allowed to block, blocklist status, and
 * everything else folded into Advanced.
 *
 * The page used to open on a text field asking for a server endpoint, which is
 * a question a new user has no way to answer. The address is baked into
 * protocol.js now, so the first thing here is the real decision: which of the
 * two jobs the extension should do.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const T = globalThis.CB_T;
  const KEYS = globalThis.CB_KEYS;
  const blockModes = globalThis.CB_BLOCK_MODES;
  const $ = (id) => document.getElementById(id);

  // Fields that map straight onto a settings key of the same name. One thing
  // deliberately stays out: `platformBlockEnabled`, which is shown inverted as
  // "Pause blocking".
  //
  // `blockSeen` and `blockFromList` are in here even though load() reads them
  // through CB_BLOCK_MODES rather than straight off the settings object: being
  // listed is what gets them saved, wired to `change` and -- the part worth
  // the small redundancy -- checked by tools/check.js against the ids in the
  // HTML, so a box that is renamed in one file and not the other fails the
  // build instead of silently never saving.
  const TEXT_FIELDS = ['apiBase', 'submitToken'];
  const NUM_FIELDS = ['maxBlocksPerHour', 'maxBlocksPerDay',
    'minDelayMs', 'maxDelayMs', 'maxColdBlocksPerHour', 'targetBudget',
    'warmMinDelayMs', 'warmMaxDelayMs'];

  // Shown in seconds, stored in milliseconds.
  //
  // These are waits a person is choosing -- "about five seconds between
  // blocks" -- and nobody thinks in thousands of milliseconds. The stored unit
  // does not change: every consumer in the worker and the content script reads
  // milliseconds, and a settings object written by an older build still means
  // what it said. Only the box on this page counts differently.
  const SECOND_FIELDS = new Set(['minDelayMs', 'maxDelayMs',
    'warmMinDelayMs', 'warmMaxDelayMs']);
  // Two decimals is well past what anybody will type and enough that 500ms
  // survives the round trip without turning into 0.5000000000000001.
  const msToSec = (ms) => Math.round((Number(ms) || 0) / 100) / 10;
  const secToMs = (sec) => Math.round(Number(sec) * 1000);
  const BOOL_FIELDS = ['blockSeen', 'blockFromList', 'shareRegion',
    'hideEnabled', 'hideFeedPosts', 'hideComments',
    'platformBlockDryRun', 'allowRawNetworkFallback', 'experimentalOwnTab',
    'reportUiEnabled', 'debug'];
  const SELECT_FIELDS = ['uiLanguage', 'hideMode'];

  // `blockTags` is none of the above: an array of tags, rendered as one
  // checkbox per tag and read back as the list of ticked ones.
  const TAGS = globalThis.CB_TAGS || [];
  const TAG_LABELS = globalThis.CB_TAG_LABELS || {};

  function sw(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(res || { ok: false, error: T('common_noResponse') });
      });
    });
  }

  function setStatus(el, text, cls) {
    el.textContent = text;
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  function ago(ts) {
    if (!ts) return T('time_never');
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return T('time_secondsAgo', s);
    if (s < 3600) return T('time_minutesAgo', Math.floor(s / 60));
    if (s < 86400) return T('time_hoursAgo', Math.floor(s / 3600));
    return T('time_daysAgo', Math.floor(s / 86400));
  }

  /**
   * A count and the thing being counted, as one message per case.
   *
   * English needs the plural s and Vietnamese needs no agreement at all, which
   * is exactly why the noun cannot be a fragment glued to a number here. Two
   * keys per noun is the cheap version of a plural rule, and enough for
   * counts that are only ever "one" or "more than one".
   */
  const counted = (n, one, many) => (n === 1 ? T(one) : T(many, n));

  /**
   * The "which kinds get blocked" boxes, built from the shared tag list.
   *
   * Generated rather than written into the HTML because protocol.js is where
   * the vocabulary lives; a hand-written copy here would be the one that
   * forgets a category the day one is added. Insertion order is TAGS order, so
   * the boxes read in the same order as the report sheet's reasons.
   */
  const tagInputs = new Map();
  for (const tag of TAGS) {
    const label = document.createElement('label');
    label.className = 'toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'blockTag_' + tag;
    const text = document.createElement('span');
    // Both, and for different moments. The textContent is a sensible value
    // right now -- this loop runs while the page parses, which is BEFORE the
    // language override has been read from storage, so the getter behind
    // TAG_LABELS can only answer in the browser's language. The data-i18n
    // attribute is what puts the span under the sweep that runs after the
    // override lands, and under the re-sweep the language picker triggers, so
    // it ends up right and stays right when the reader changes their mind.
    text.textContent = TAG_LABELS[tag] || tag;
    text.dataset.i18n = 'tag_' + tag;
    label.appendChild(box);
    label.appendChild(text);
    $('blockTags').appendChild(label);
    tagInputs.set(tag, box);
  }

  /** Ticking none of them is a real choice, but a silent one. Say it out loud. */
  function renderTagNote() {
    const none = [...tagInputs.values()].every(b => !b.checked);
    $('blockTagsNote').classList.toggle('hidden', !none);
  }

  async function load() {
    const res = await sw(P.SW.GET_SETTINGS);
    const s = (res && res.settings) || {};
    for (const f of TEXT_FIELDS) $(f).value = s[f] || '';
    for (const f of NUM_FIELDS) {
      $(f).value = s[f] != null ? (SECOND_FIELDS.has(f) ? msToSec(s[f]) : s[f]) : '';
    }
    for (const f of BOOL_FIELDS) $(f).checked = !!s[f];
    for (const f of SELECT_FIELDS) if (s[f]) $(f).value = s[f];

    // Read through CB_BLOCK_MODES rather than off the two keys directly: an
    // install written before the pair existed carries `mode` or the older
    // `acceptServerTargets` instead, and the boxes have to show what the
    // service worker will actually do, not what this object happens to spell.
    const modes = blockModes(s);
    $('blockSeen').checked = modes.seen;
    $('blockFromList').checked = modes.fromList;
    renderBlockNothing();

    // Inverted on purpose: the switch means "blocking is on", the control means
    // "pause it". Only an explicit false counts as paused, so a settings object
    // missing the key reads as running, exactly like the default.
    $('pauseBlocking').checked = s.platformBlockEnabled === false;
    renderPaused();

    // An install written before this setting existed blocks every kind, which
    // is exactly what it did then. An empty array is a deliberate "block
    // nothing", so it is not treated as missing.
    const chosen = Array.isArray(s.blockTags) ? s.blockTags : TAGS;
    for (const [tag, box] of tagInputs) box.checked = chosen.includes(tag);
    renderTagNote();

    await refreshList();
    await refreshDiag();
    await refreshLearnedStatus();
  }

  async function save() {
    const patch = {};
    for (const f of TEXT_FIELDS) patch[f] = $(f).value.trim();
    for (const f of NUM_FIELDS) {
      // parseFloat, not parseInt: a delay in seconds is allowed a half.
      const raw = parseFloat($(f).value);
      if (Number.isNaN(raw)) continue;
      patch[f] = SECOND_FIELDS.has(f) ? secToMs(raw) : Math.round(raw);
    }
    for (const f of BOOL_FIELDS) patch[f] = $(f).checked;
    for (const f of SELECT_FIELDS) patch[f] = $(f).value;

    patch.platformBlockEnabled = !$('pauseBlocking').checked;
    // Filtered through TAGS so the stored array is always vocabulary, in
    // vocabulary order, whatever the DOM happens to contain.
    patch.blockTags = TAGS.filter(t => tagInputs.get(t).checked);

    // Keep the delay ranges coherent rather than letting them invert. In
    // milliseconds, because that is what the patch carries whatever the boxes
    // show -- and for both ranges, since the warm one could invert too.
    if (patch.maxDelayMs <= patch.minDelayMs) patch.maxDelayMs = patch.minDelayMs + 5000;
    if (patch.warmMaxDelayMs <= patch.warmMinDelayMs) {
      patch.warmMaxDelayMs = patch.warmMinDelayMs + 2000;
    }

    await sw(P.SW.SET_SETTINGS, patch);
    renderPaused();
    renderSubStates();
    renderBlockNothing();
    renderTagNote();
  }

  for (const f of TEXT_FIELDS.concat(NUM_FIELDS)) {
    $(f).addEventListener('change', save);
  }
  for (const f of BOOL_FIELDS.concat(SELECT_FIELDS)) {
    $(f).addEventListener('change', save);
  }
  $('pauseBlocking').addEventListener('change', save);
  for (const box of tagInputs.values()) box.addEventListener('change', save);

  /**
   * Pause lives in Advanced, so on a collapsed page the two boxes above would
   * otherwise claim work is happening while nothing is. Say so where the claim
   * is made.
   */
  function renderPaused() {
    $('pausedNote').classList.toggle('hidden', !$('pauseBlocking').checked);
    renderSubStates();
  }

  /**
   * Dim the controls whose parent says they have nothing to act on.
   *
   * Every indented control on this page means "governed by the box above",
   * and everywhere except one place that box is positive: tick it and the
   * children matter. Under "Pause blocking" the sense is reversed -- ticking
   * it makes the two below inert -- so the indentation alone told the reader
   * the opposite of the truth, which is exactly what was reported.
   *
   * Dimmed rather than disabled, deliberately. Disabling dry run while paused
   * would mean the only way to turn simulation on is to make blocking live
   * first, which is backwards for the one workflow dry run exists for. It
   * stays fully usable; it simply stops looking like it is doing something.
   */
  function renderSubStates() {
    const paused = $('pauseBlocking').checked;
    $('pausedChildrenNote').classList.toggle('hidden', !paused);
    for (const id of ['platformBlockDryRun', 'allowRawNetworkFallback']) {
      const label = $(id).closest('label');
      if (label) label.classList.toggle('inactive', paused);
    }

    // The mirror case: here the grammar points the right way and was still
    // never honoured, so the children of an unticked Hide box looked as live
    // as any other control.
    const hiding = $('hideEnabled').checked;
    for (const id of ['hideFeedPosts', 'hideComments']) {
      const label = $(id).closest('label');
      if (label) label.classList.toggle('inactive', !hiding);
    }
    const modeField = $('hideMode').closest('.field');
    if (modeField) modeField.classList.toggle('inactive', !hiding);
  }

  /**
   * Untick both and the extension blocks nobody. That is a setting someone may
   * genuinely want -- the list still syncs, hiding still runs, Block now still
   * works -- but two empty boxes look exactly like a page that failed to load,
   * so the state has to name itself.
   */
  function renderBlockNothing() {
    const none = !$('blockSeen').checked && !$('blockFromList').checked;
    $('blockNothingNote').classList.toggle('hidden', !none);
  }

  // -- blocklist status ------------------------------------------------------
  async function refreshList() {
    const state = await sw(P.SW.GET_STATE);
    const bl = state && state.ok && state.blocklist;
    if (!bl) {
      $('listSynced').textContent = T('time_never');
      $('listCounts').textContent = T('options_listNotLoaded');
      return;
    }
    $('listSynced').textContent = ago(bl.fetchedAt);
    $('listSynced').title = bl.fetchedAt ? new Date(bl.fetchedAt).toLocaleString() : '';
    $('listCounts').textContent =
      counted(bl.ids.length, 'options_profileIdOne', 'options_profileIdMany') + ' · ' +
      counted(bl.usernames.length, 'options_usernameOne', 'options_usernameMany');
  }

  $('refreshList').addEventListener('click', async () => {
    setStatus($('listStatus'), T('options_checking'));
    const res = await sw(P.SW.REFRESH_NOW);
    setStatus($('listStatus'),
      res.ok ? T(res.unchanged ? 'options_upToDate' : 'options_updated')
             : (res.error || T('options_failed')),
      res.ok ? 'ok' : 'bad');
    await refreshList();
    refreshDiag();
  });

  // -- actions --------------------------------------------------------------
  $('clearLearned').addEventListener('click', async () => {
    await chrome.storage.local.remove(['learnedTemplate_facebook', 'learnedTemplate_threads']);
    setStatus($('learnedStatus'), T('options_cleared'), 'ok');
    refreshLearnedStatus();
  });

  $('resetQueue').addEventListener('click', async () => {
    await chrome.storage.local.remove([KEYS.QUEUE, KEYS.DONE, KEYS.STATS, 'leases']);
    try { await chrome.action.setBadgeText({ text: '' }); } catch (e) { /* ignore */ }
    refreshDiag();
  });

  $('refreshDiag').addEventListener('click', refreshDiag);


  async function refreshLearnedStatus() {
    const got = await chrome.storage.local.get(['learnedTemplate_facebook', 'learnedTemplate_threads']);
    const parts = [];
    for (const p of ['facebook', 'threads']) {
      const t = got['learnedTemplate_' + p];
      if (t) parts.push(`${p}: ${t.friendlyName || t.url}`);
    }
    setStatus($('learnedStatus'), parts.length ? parts.join(' · ') : T('options_noneCaptured'),
      parts.length ? 'ok' : '');
  }

  /**
   * Page capability, read from a real tab.
   *
   * This used to occupy a quarter of the popup -- Bridge, Relay store, Block
   * mutation, doc_ids -- which is diagnostics, not something anyone acts on.
   * The options page cannot use the active tab (that is this page), so it
   * looks for the first supported tab that is open.
   */
  async function pageCapability() {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({
        url: ['*://*.facebook.com/*', '*://*.threads.net/*', '*://*.threads.com/*']
      });
    } catch (e) { return { error: String((e && e.message) || e) }; }
    const tab = tabs && tabs[0];
    // These two are instructions to a reader, so they are translated. The rest
    // of the dump below is field names and terse status words -- diagnostics,
    // read by whoever is debugging, and not worth a translator's time.
    if (!tab) return T('options_diagNoTab');
    const status = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'tab:status' }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res || null);
      });
    });
    if (!status) return T('options_diagNoAnswer');

    const cap = status.capability || {};
    const cands = cap.blockMutationCandidates || [];
    return {
      tab: tab.url ? tab.url.slice(0, 90) : null,
      platform: status.platform,
      bridge: status.handshake ? 'connected' : 'not connected',
      signedInAs: status.viewerId || 'signed out',
      relayStore: cap.hasRelay ? `${cap.relayEnv} (${cap.relayRecords} records)` : 'unavailable',
      blockMutation: cands.length
        ? (cands[0].params ? `${cands[0].params.name} (doc_id ${cands[0].params.id})` : cands[0].name)
        : (cap.hasLearnedTemplate ? 'learned from a captured request' : 'not loaded on this page yet'),
      hiddenOnPage: status.dom ? status.dom.hidden : null,
      profile: status.profile || null
    };
  }

  async function refreshDiag() {
    const state = await sw(P.SW.GET_STATE);
    if (!state.ok) { $('diag').textContent = state.error || T('options_diagUnavailable'); return; }
    const bl = state.blocklist;
    const modes = blockModes(state.settings || {});
    const view = {
      blockSeen: modes.seen,
      blockFromList: modes.fromList,
      blocklist: bl ? {
        ids: bl.ids.length,
        usernames: bl.usernames.length,
        fetchedAt: new Date(bl.fetchedAt).toLocaleString(),
        etag: bl.etag,
        source: bl.source
      } : null,
      queue: Object.fromEntries(Object.entries(state.queue || {}).map(([k, v]) => [k, v.length])),
      blocked: Object.fromEntries(Object.entries(state.done || {}).map(([k, v]) => [k, v.length])),
      stats: state.stats || {}
    };
    if (view.stats.blockTimes) {
      view.stats.blocksLastHour = view.stats.blockTimes.filter(t => Date.now() - t < 3600e3).length;
      view.stats.blocksLast24h = view.stats.blockTimes.length;
      delete view.stats.blockTimes;
    }
    if (view.stats.pausedUntil) {
      view.stats.pausedUntil = new Date(view.stats.pausedUntil).toLocaleString();
    }
    view.page = await pageCapability();
    $('diag').textContent = JSON.stringify(view, null, 2);
  }

  // Repaint in place. A picker that needs a reload to show its own effect is
  // a picker people press twice and then distrust.
  document.getElementById('uiLanguage').addEventListener('change', async () => {
    const lang = document.getElementById('uiLanguage').value;
    await sw(P.SW.SET_SETTINGS, { uiLanguage: lang });
    if (globalThis.CB_LOAD_LOCALE) {
      await globalThis.CB_LOAD_LOCALE(lang);
      document.documentElement.lang = globalThis.CB_LOCALE();
      globalThis.CB_APPLY_I18N(document);
      // Anything drawn by script rather than by markup has to be asked again.
      load();
    }
  });

  document.getElementById('openActivity').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/activity/activity.html') });
  });

  // The first draw waits for the language.
  //
  // CB_T is synchronous but the override behind it arrives from storage, so
  // rendering before this resolves means building the page out of whatever
  // chrome.i18n happened to return -- the browser's language, not the reader's
  // choice. Static data-i18n markup is immune because apply() runs after the
  // same await; text built in script is not, which is why this page needed the
  // gate and the welcome page did not.
  (globalThis.CB_I18N_READY || Promise.resolve()).then(load);
})();
