/**
 * Unit tests for the service worker's queue, leases and rate limiter.
 *
 * The browser test runs with platform blocking disabled (deliberately -- it
 * must never block anyone for real), which leaves this logic uncovered there:
 * the two switches that decide what gets queued at all, and the gate that
 * decides how fast the browser as a whole may spend it. It is also the logic
 * most likely to misbehave in ways a user would not notice quickly: a starved
 * queue or a limiter that fails to count looks like "nothing is happening"
 * rather than an error.
 *
 * Drives the real message handler, so serialize() and the storage round-trips
 * are exercised exactly as they run in the extension.
 *
 *   node tools/queue-test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

// ---- chrome API mock ------------------------------------------------------
const store = { local: {}, sync: {} };
function area(name) {
  return {
    async get(key) {
      // get(null) is the real API's "everything", which the wipe relies on.
      if (key === null || key === undefined) return clone(store[name]);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (store[name][k] !== undefined) out[k] = clone(store[name][k]);
      return out;
    },
    async set(obj) { for (const k of Object.keys(obj)) store[name][k] = clone(obj[k]); },
    async remove(key) {
      for (const k of (Array.isArray(key) ? key : [key])) delete store[name][k];
    }
  };
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

let messageHandler = null;
let alarmHandler = null;
const alarms = new Map();

// Tabs and the toolbar badge are things the worker READS, not just calls it
// makes: a queued cold block has nowhere to run unless a Facebook or Threads
// tab is open, and the badge is the only place that says so. So the mock has
// to be able to answer "nothing is open" and to remember what the badge was
// last told.
let openTabs = [];                       // [{ id, url }] as chrome.tabs.query sees them
const badge = { text: null, color: null };
let nextTabId = 500;
let tabEvents = [];                      // what the worker did to the tab strip
let tabRemovedHandler = null;
// What chrome.runtime.getManifest() answers. An unpacked build has no
// update_url and a store build does, which is how the extension tells the two
// apart without asking for the management permission.
let manifest = { version: '1.0.1' };

/**
 * chrome.tabs.query, matching url patterns the way the real one does.
 *
 * Answering every query with every tab would let a "no Facebook tab open"
 * case pass while a Threads tab was open, which is the opposite of the
 * condition under test.
 */
function tabMatches(tab, patterns) {
  if (!patterns) return true;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((p) => new RegExp('^' + String(p)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*') + '$').test(tab.url || ''));
}

global.chrome = {
  storage: { local: area('local'), sync: area('sync'), onChanged: { addListener() {} } },
  alarms: {
    onAlarm: { addListener(fn) { alarmHandler = fn; } },
    async get(n) { return alarms.get(n) || null; },
    async clear(n) { alarms.delete(n); },
    async create(n, o) { alarms.set(n, Object.assign({ name: n }, o)); }
  },
  runtime: {
    lastError: null,
    getManifest() { return clone(manifest); },
    getURL(rel) { return 'chrome-extension://test/' + String(rel || ''); },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { messageHandler = fn; } }
  },
  tabs: {
    async query(info) { return openTabs.filter(t => tabMatches(t, info && info.url)).map(clone); },
    sendMessage() {},
    // The worker can open a tab of its own to work the queue when nobody is
    // browsing, so the mock has to be able to be opened, read and closed --
    // and to report a tab that is gone, which is what the worker's bookkeeping
    // is built around.
    async create(props) {
      const tab = { id: nextTabId++, url: (props && props.url) || '',
                    active: !!(props && props.active), pinned: !!(props && props.pinned) };
      openTabs.push(tab);
      tabEvents.push({ what: 'create', url: tab.url, active: tab.active, pinned: tab.pinned });
      return clone(tab);
    },
    // Pinning is what makes a permanent tab bearable, so the worker pins one
    // back if it is unpinned -- which it can only do through here.
    async update(id, props) {
      const t = openTabs.find(x => x.id === id);
      if (!t) throw new Error('No tab with id: ' + id);
      if (props && typeof props.pinned === 'boolean') t.pinned = props.pinned;
      tabEvents.push({ what: 'update', id, props: clone(props || {}) });
      return clone(t);
    },
    async get(id) {
      const t = openTabs.find(x => x.id === id);
      if (!t) throw new Error('No tab with id: ' + id);
      return clone(t);
    },
    async reload(id) {
      const t = openTabs.find(x => x.id === id);
      if (!t) throw new Error('No tab with id: ' + id);
      t.discarded = false;
      tabEvents.push({ what: 'reload', id });
      return undefined;
    },
    async remove(id) {
      const i = openTabs.findIndex(x => x.id === id);
      if (i < 0) throw new Error('No tab with id: ' + id);
      openTabs.splice(i, 1);
      tabEvents.push({ what: 'remove', id });
    },
    onRemoved: { addListener(fn) { tabRemovedHandler = fn; } }
  },
  windows: {
    async create(props) {
      const tab = { id: nextTabId++, url: (props && props.url) || '', active: false, pinned: false };
      openTabs.push(tab);
      tabEvents.push({ what: 'window', url: tab.url, active: false, pinned: false });
      return { id: nextTabId++, tabs: [clone(tab)] };
    }
  },
  action: {
    async setBadgeText(o) { badge.text = o ? o.text : undefined; },
    async setBadgeBackgroundColor(o) { badge.color = o ? o.color : undefined; }
  },
  permissions: { async contains() { return true; } }
};

// ---- harness --------------------------------------------------------------
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * Drive the real message handler.
 *
 * `sender` matters for one thing and it is worth being able to say: the worker
 * decides whether to close a tab by checking whether the claim came FROM the
 * tab it opened, so a claim has to be able to arrive from a particular tab.
 */
function send(type, payload, sender) {
  return new Promise((resolve) => {
    const ret = messageHandler({ type, payload }, sender || {}, resolve);
    if (ret !== true) resolve({ ok: false, error: 'handler did not keep the port open' });
  });
}
const fromTab = (id) => ({ tab: { id } });

/**
 * Let work that deliberately happens AFTER the reply settle.
 *
 * The worker answers a claim and only then closes the tab it opened, because
 * closing tears down the content script that is waiting on that answer. So a
 * caller who has its reply has not yet seen the consequences of it, and a test
 * that asserts immediately is asserting too early.
 */
const flush = () => new Promise(r => setTimeout(r, 20));

async function setSettings(patch) {
  return send('sw:set-settings', patch);
}
async function state() { return send('sw:get-state'); }

/**
 * Fast-forward past the pacing gate.
 *
 * One gate paces the whole browser: after a block, nobody may claim again
 * until the randomised delay has run. A real tab gets past it by sleeping for
 * seconds; a test gets past it by moving the clock, because the suite is
 * about which target is served and in what order, not about waiting. The
 * tests that are genuinely about the gate never call this.
 */
function openGate() {
  if (store.local.stats) delete store.local.stats.gateUntil;
}

/**
 * Time passing, expressed as every deadline moving back.
 *
 * A lease is ninety seconds, so the tests that are genuinely about waiting
 * cannot wait. Rather than mock the clock out from under the whole worker,
 * this ages what the queue actually keeps -- the gate, the leases, the
 * cooldowns -- which is what the passage of time looks like from storage. Only
 * deadlines: the timestamps the rate limiter counts are a different question
 * and the tests that care about those set them directly.
 */
function rewind(ms) {
  const st = store.local.stats;
  if (st && st.gateUntil) st.gateUntil -= ms;
  for (const map of ['leases', 'cooldowns']) {
    const m = store.local[map];
    if (m) for (const k of Object.keys(m)) m[k] -= ms;
  }
}

async function reset(settings) {
  store.local = {};
  store.sync = {};
  openTabs = [];
  tabEvents = [];
  badge.text = null;
  badge.color = null;
  // Unpacked by default, which is what the harness itself is.
  manifest = { version: '1.0.1' };
  await setSettings(Object.assign({
    platformBlockEnabled: true,
    platformBlockDryRun: false,
    maxBlocksPerHour: 100,
    maxBlocksPerDay: 100,
    listUrl: ''
  }, settings || {}));
}

(async () => {
  // CB_SW lets the regression check below point this at a modified copy.
  const swFile = process.env.CB_SW || path.join(__dirname, '..', 'src', 'background', 'service-worker.js');
  const swPath = pathToFileURL(swFile).href;
  await import(swPath);
  if (!messageHandler) { check('service worker registered a message handler', false); finish(); return; }
  check('service worker registered a message handler', true);

  // -- 1. a permanently failing target must not starve the queue ------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['1111111111', '2222222222', '3333333333'] });

  openGate();
  const first = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: first.target, ok: false, dryRun: false, detail: 'simulated failure'
  });
  openGate();
  const second = await send('sw:queue-claim', { platform: 'facebook' });

  check('a failed target goes into cooldown instead of being retried immediately',
    second.target && second.target !== first.target,
    `first=${first.target} second=${second.target}`);

  // -- 2. repeated failures abandon the target ------------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['4444444444'] });
  let abandonedAfter = null;
  for (let i = 1; i <= 8; i++) {
    // Clear the cooldown so we can drive the failure count deterministically
    // without waiting out the real backoff.
    store.local.cooldowns = {};
    openGate();
    const c = await send('sw:queue-claim', { platform: 'facebook' });
    if (!c.target) { abandonedAfter = i - 1; break; }
    await send('sw:queue-result', { platform: 'facebook', target: c.target, ok: false, dryRun: false, detail: 'x' });
  }
  const st2 = await state();
  check('a target is abandoned after repeated failures rather than retried forever',
    (st2.queue.facebook || []).length === 0 && (st2.stats.abandoned || 0) === 1,
    `queue=${JSON.stringify(st2.queue.facebook)} abandoned=${st2.stats.abandoned} afterClaims=${abandonedAfter}`);

  // -- 2b. "not loaded on this page yet" is not the target's fault ----------
  //
  // The site's block operation loads lazily; a tab parked on the feed has
  // not got it, and with raw fallbacks off the page-world script attempts
  // nothing. That result used to count like any other failure, so five of
  // them -- twenty minutes of a tab sitting on the feed -- abandoned a
  // perfectly good target. It now steps aside and says why.
  {
    await reset();
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['7700000777'] });
    const NOT_READY = 'the site\'s own block operation is not loaded on this page yet';
    for (let i = 0; i < 7; i++) {   // well past MAX_TARGET_FAILURES (5)
      openGate();
      if (store.local.cooldowns) delete store.local.cooldowns['threads:7700000777'];
      const c = await send('sw:queue-claim', { platform: 'threads' });
      if (!c.target) break;
      await send('sw:queue-result', { platform: 'threads', target: c.target, ok: false,
        dryRun: true, notReady: true, attempts: [], detail: NOT_READY });
    }
    const st = await state();
    check('a page without the block operation never abandons the target',
      (st.queue.threads || []).length === 1 && !(st.stats.abandoned) &&
      !(store.local.failures || {})['threads:7700000777'],
      `queue=${JSON.stringify(st.queue.threads)} abandoned=${st.stats.abandoned} ` +
      `failures=${JSON.stringify(store.local.failures)}`);
    // The message is the localised sw_notReady line (the key itself under this
    // harness, which has no chrome.i18n), never the page's English detail.
    check('but steps aside for a while and says why nothing is happening',
      (store.local.cooldowns || {})['threads:7700000777'] > Date.now() + 60000 &&
      st.stats.lastErrorCode === 'not-ready' && !!st.stats.lastError &&
      !(st.stats.lastError || '').includes('raw request fallbacks are disabled') &&
      (st.stats.notReady || 0) >= 2 && !(st.stats.failed),
      `cooldown=${JSON.stringify(store.local.cooldowns)} code=${st.stats.lastErrorCode} ` +
      `notReady=${st.stats.notReady} failed=${st.stats.failed}`);

    // Once the module is there, a dry run that resolves a strategy clears
    // the explanation -- the message must not outlive the condition.
    openGate();
    delete store.local.cooldowns['threads:7700000777'];
    const c2 = await send('sw:queue-claim', { platform: 'threads' });
    await send('sw:queue-result', { platform: 'threads', target: c2.target, ok: true,
      dryRun: true, attempts: [{ strategy: 'relay:x', ok: true }], detail: 'dry run' });
    const st3 = await state();
    check('and the explanation is cleared by the next resolved attempt',
      c2.target === '7700000777' && !st3.stats.lastError && !st3.stats.lastErrorCode,
      `target=${c2.target} lastError=${st3.stats.lastError}`);
  }

  // -- 2c. the block operation, remembered ----------------------------------
  //
  // Meta loads the block mutation only while its own block dialog is on
  // screen, and it cannot be pulled by name -- Bootloader, requireLazy and
  // JSResource were each tried against a live page and each returned nothing.
  // So a page that HAS it reports the doc_id here, and every later page load
  // drives the site's Relay network layer with it instead. This is the memory
  // that turns "open a menu first" into something that happens once, ever.
  {
    await reset();
    const REAL = { useTHUserBlockMutation: '26803837702651619' };
    const r1 = await send('sw:remember-doc-ids', { platform: 'threads', docIds: REAL });
    check('a doc_id read off the page is remembered for the platform',
      r1.ok && r1.changed === true &&
      (store.local.learnedDocIds || {}).threads.useTHUserBlockMutation === REAL.useTHUserBlockMutation,
      JSON.stringify(store.local.learnedDocIds));

    const r2 = await send('sw:remember-doc-ids', { platform: 'threads', docIds: REAL });
    check('remembering the same one again changes nothing',
      r2.ok && r2.changed === false, JSON.stringify(r2));

    // A rotation: the id just read off the page is right, the remembered one
    // is stale.
    const r3 = await send('sw:remember-doc-ids',
      { platform: 'threads', docIds: { useTHUserBlockMutation: '99999999999999999' } });
    check('a rotated doc_id replaces the one remembered before it',
      r3.changed === true &&
      store.local.learnedDocIds.threads.useTHUserBlockMutation === '99999999999999999',
      JSON.stringify(store.local.learnedDocIds));

    await send('sw:remember-doc-ids',
      { platform: 'facebook', docIds: { ProfileCometActionBlockUserMutation: '12345678901' } });
    check('the two platforms are remembered apart',
      store.local.learnedDocIds.facebook.ProfileCometActionBlockUserMutation === '12345678901' &&
      store.local.learnedDocIds.threads.useTHUserBlockMutation === '99999999999999999',
      JSON.stringify(store.local.learnedDocIds));

    // The map selects which operation the page-world code calls against Meta
    // and with what id, so it is validated here exactly as the published
    // overrides are.
    const before = JSON.stringify(store.local.learnedDocIds);
    const r4 = await send('sw:remember-doc-ids', { platform: 'threads', docIds: {
      'not an operation': '123456', useTHUserBlockMutation2: 'javascript:x', junk: {} } });
    check('anything that is not an operation name and a numeric id is dropped',
      r4.ok && r4.stored === 0 && JSON.stringify(store.local.learnedDocIds) === before,
      JSON.stringify(r4) + ' ' + JSON.stringify(store.local.learnedDocIds));

    const r5 = await send('sw:remember-doc-ids', { platform: 'mastodon', docIds: REAL });
    check('and a platform this extension does not know is refused',
      r5.ok === false && !store.local.learnedDocIds.mastodon, JSON.stringify(r5));

    // Meta rotates these. One that the site refuses when it is used is worth
    // forgetting -- otherwise it leads the ladder forever and spends a real
    // request against every future target before the good one is tried.
    const r6 = await send('sw:remember-doc-ids',
      { platform: 'threads', forget: { useTHUserBlockMutation: '99999999999999999' } });
    check('a doc_id the site rejected is forgotten',
      r6.changed === true && !store.local.learnedDocIds.threads.useTHUserBlockMutation,
      JSON.stringify(store.local.learnedDocIds));

    await send('sw:remember-doc-ids', { platform: 'threads', docIds: REAL });
    const r7 = await send('sw:remember-doc-ids',
      { platform: 'threads', forget: { useTHUserBlockMutation: '99999999999999999' } });
    check('but a fresher one that arrived since is not thrown away with it',
      r7.changed === false &&
      store.local.learnedDocIds.threads.useTHUserBlockMutation === REAL.useTHUserBlockMutation,
      JSON.stringify(store.local.learnedDocIds));
  }

  // -- 2b2. retrying a target that is waiting --------------------------------
  //
  // A waiting row can be waiting on the half-hour cooldown after a dry run, on
  // the growing backoff after a failure, or on nothing at all. Asking somebody
  // to work out which before they may press a button is asking them to know
  // how the queue is built, so Retry clears both -- and nothing else: the
  // gate, the leases and the hourly caps are the pacing that keeps Meta from
  // issuing a checkpoint.
  {
    await reset({ experimentalOwnTab: false });
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['9600000001', '9600000002'], warm: true });
    openGate();
    const c = await send('sw:queue-claim', { platform: 'threads' });
    await send('sw:queue-result', { platform: 'threads', target: c.target,
      ok: false, dryRun: false, attempts: [], detail: 'simulated' });
    const key = 'threads:' + c.target;
    check('a failed target is left waiting out a backoff',
      store.local.cooldowns[key] > Date.now() && store.local.failures[key] === 1,
      JSON.stringify({ cool: store.local.cooldowns[key] - Date.now(), fails: store.local.failures[key] }));

    const out = await send('sw:retry-target', { platform: 'threads', id: c.target });
    check('retrying it clears the wait and the failure count',
      out.ok && out.cleared === 1 &&
      !store.local.cooldowns[key] && !store.local.failures[key],
      JSON.stringify(out));
    const entry = (await state()).queue.threads.find(e => e.id === c.target);
    check('and marks it as asked for, so it is served first',
      entry && entry.user === true, JSON.stringify(entry));

    // The pacing it must not touch.
    const gate = (await state()).stats.gateUntil;
    check('but it does not reach past the gate that paces the whole browser',
      gate === store.local.stats.gateUntil, String(gate));

    // Retry all is a bulk clear, and deliberately does NOT mark everything as
    // asked for: that would exempt the whole queue from the job switches.
    await reset({ experimentalOwnTab: false });
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['9700000001', '9700000002'], warm: true });
    store.local.cooldowns = { 'threads:9700000001': Date.now() + 600000,
                              'threads:9700000002': Date.now() + 600000 };
    store.local.failures = { 'threads:9700000001': 3 };
    const all = await send('sw:retry-all', { platform: 'threads' });
    check('retry all clears every wait on that platform',
      all.cleared === 2 && Object.keys(store.local.cooldowns).length === 0 &&
      Object.keys(store.local.failures).length === 0,
      JSON.stringify(all));
    check('and does not quietly exempt the queue from the job switches',
      (await state()).queue.threads.every(e => !e.user),
      JSON.stringify((await state()).queue.threads));

    const empty = await send('sw:retry-all', { platform: 'facebook' });
    check('with nothing queued it says so rather than pretending',
      empty.ok && empty.cleared === 0 && empty.waiting === 0, JSON.stringify(empty));
  }

  // -- 2b3. a block the user pressed a button for jumps the pacing gate ------
  //
  // The report sheet's "block this profile too" and the popup's Block now both
  // enqueue userInitiated. Waking the tab is not enough: the browser-wide gate
  // is checked at claim time, so a block that lands mid-delay would still be
  // told to come back later -- which reads as "the button did nothing". A
  // deliberate act should run now, so a userInitiated enqueue opens the gate.
  // Two things it must NOT override: a block genuinely in flight (a live
  // lease), and a hard pause from a rate limit or checkpoint.
  {
    await reset({ experimentalOwnTab: false });
    // A closed gate with nothing in flight: the pause after some earlier
    // block. A user-pressed block should clear it and run.
    store.local.stats = { gateUntil: Date.now() + 90000 };
    await send('sw:enqueue-platform-block',
      { platform: 'threads', ids: ['9300000001'], warm: true, userInitiated: true });
    await flush();   // the gate is opened AFTER the reply, like the wake broadcast
    check('a userInitiated block clears the pacing gate so it runs now',
      !store.local.stats.gateUntil, JSON.stringify(store.local.stats));

    // The same enqueue while a block is in flight (a live lease) must leave
    // the gate shut: clearing it could put a second block on the wire
    // alongside the first, which is the exact burst the gate prevents.
    await reset({ experimentalOwnTab: false });
    const gate = Date.now() + 90000;
    store.local.stats = { gateUntil: gate };
    store.local.leases = { 'threads:9999999999': Date.now() + 90000 };
    await send('sw:enqueue-platform-block',
      { platform: 'threads', ids: ['9300000002'], warm: true, userInitiated: true });
    await flush();
    check('but not while another block is in flight',
      store.local.stats.gateUntil === gate, JSON.stringify(store.local.stats));

    // And a hard pause (rate limit / checkpoint) always wins.
    await reset({ experimentalOwnTab: false });
    const paused = Date.now() + 20 * 60 * 1000;
    store.local.stats = { gateUntil: Date.now() + 90000, pausedUntil: paused };
    await send('sw:enqueue-platform-block',
      { platform: 'threads', ids: ['9300000003'], warm: true, userInitiated: true });
    await flush();
    check('and never past a hard pause from a rate limit or a checkpoint',
      store.local.stats.gateUntil > Date.now() && store.local.stats.pausedUntil === paused,
      JSON.stringify(store.local.stats));

    // A NON-userInitiated enqueue (the extension's own sweep) never touches
    // the gate, whatever is or is not in flight.
    await reset({ experimentalOwnTab: false });
    const g2 = Date.now() + 90000;
    store.local.stats = { gateUntil: g2 };
    await send('sw:enqueue-platform-block',
      { platform: 'threads', ids: ['9300000004'], warm: true });
    await flush();
    check('an unattended sweep enqueue leaves the gate exactly as it was',
      store.local.stats.gateUntil === g2, JSON.stringify(store.local.stats));
  }

  // -- 2c0. the setup guide, and who is allowed to see it twice -------------
  //
  // Chrome fires onInstalled with reason "install" on every reload of an
  // UNPACKED extension, which is why a flag guards this at all: without it a
  // published install would reopen the guide on events that merely look like
  // an install. Reloading is the edit-and-check loop while developing, though,
  // and reopening the guide is exactly what is wanted there -- so the flag
  // still governs a real install and only a development build steps past it.
  {
    await reset();
    manifest = { version: '1.0.1' };                    // unpacked
    store.local.welcomedAt = Date.now() - 60000;
    const opened = () => tabEvents.filter(e =>
      (e.what === 'create') && /welcome\.html/.test(e.url || '')).length;
    tabEvents = [];
    await send('sw:open-welcome');
    check('an unpacked build reopens the guide on reload',
      opened() === 1, JSON.stringify(tabEvents));

    manifest = { version: '1.0.1', update_url: 'https://clients2.google.com/service/update2/crx' };
    tabEvents = [];
    await send('sw:open-welcome');
    check('a published build shows it once and never again',
      opened() === 0, JSON.stringify(tabEvents));

    delete store.local.welcomedAt;
    tabEvents = [];
    await send('sw:open-welcome');
    check('and a genuine first install still sees it',
      opened() === 1 && store.local.welcomedAt > 0, JSON.stringify(tabEvents));
  }

  // -- 2c1. the list is polled often enough to matter -----------------------
  //
  // The gap between a moderator approving a clone and every installation
  // acting on it is exactly this interval. It was an hour, which is a long
  // time for something the whole product is about; the list is a static CDN
  // file answered with a 304 when unchanged, so a shorter one costs a few
  // hundred bytes and no database read.
  {
    await reset();
    const s = (await send('sw:get-settings')).settings;
    check('the list is refreshed every ten minutes by default',
      s.refreshMinutes === 10, String(s.refreshMinutes));
    const alarm = alarms.get('cb-refresh-blocklist');
    check('and the alarm that does it agrees',
      alarm && alarm.periodInMinutes === 10, JSON.stringify(alarm));

    // Somebody who chose their own interval keeps it.
    await setSettings({ refreshMinutes: 45 });
    check('a chosen interval still wins',
      alarms.get('cb-refresh-blocklist').periodInMinutes === 45,
      JSON.stringify(alarms.get('cb-refresh-blocklist')));
  }

  // -- 2c2. the job switches govern the queue, not just admission -----------
  //
  // blockSeen and blockFromList filtered what could ENTER the queue and
  // nothing else, so an entry already queued went on being blocked after the
  // switch that put it there was turned off -- against strangers, in the cold
  // case, which is the exact thing the ranked list is and the cold ceiling
  // rations. Both the popup and the Activity page say in so many words that
  // such work "stays parked until you switch it back on". Now it does.
  {
    await reset({ mode: 'active', maxColdBlocksPerHour: 50, experimentalOwnTab: false });
    await send('sw:enqueue-platform-block', { platform: 'facebook', warm: false,
      ids: [{ id: '9100000001', rank: 3 }] });
    await send('sw:enqueue-platform-block', { platform: 'facebook', warm: true, ids: ['9100000002'] });

    await setSettings({ blockFromList: false });
    openGate();
    const c1 = await send('sw:queue-claim', { platform: 'facebook' });
    check('with the ranked list switched off its targets are not served',
      c1.target === '9100000002',
      'served ' + JSON.stringify(c1.target) + ' (cold 9100000001 must stay parked)');

    await send('sw:queue-result', { platform: 'facebook', target: c1.target, ok: true, dryRun: false });
    await setSettings({ blockSeen: false });
    openGate();
    const c2 = await send('sw:queue-claim', { platform: 'facebook' });
    check('and with both switched off nothing is served at all',
      !c2.target, JSON.stringify(c2));
    check('but nothing is thrown away either -- it is parked, not dropped',
      (await state()).queue.facebook.length === 1, JSON.stringify((await state()).queue.facebook));

    await setSettings({ blockFromList: true });
    openGate();
    const c3 = await send('sw:queue-claim', { platform: 'facebook' });
    check('switching it back on resumes the same work',
      c3.target === '9100000001', JSON.stringify(c3));
  }

  // -- 2c3. an explicit request goes first, and is never parked -------------
  //
  // Pressing Block now, or ticking "block this profile too" in the report
  // sheet, used to append to the END of the queue and then sort behind every
  // warm target the feed had already collected: the one block a person
  // actually asked for was the last one served. It also has to outrank the job
  // switches -- someone pressing a button about THIS account is not the
  // extension acting on its own initiative.
  {
    await reset({ mode: 'active', experimentalOwnTab: false });
    await send('sw:enqueue-platform-block', { platform: 'threads', warm: true,
      ids: ['9200000001', '9200000002', '9200000003'] });
    await send('sw:enqueue-platform-block', { platform: 'threads',
      ids: ['9200000009'], warm: true, userInitiated: true });

    openGate();
    const first = await send('sw:queue-claim', { platform: 'threads' });
    check('the target somebody asked for is served before the backlog',
      first.target === '9200000009',
      'served ' + JSON.stringify(first.target) + ' of a queue of four');

    const entry = (await state()).queue.threads.find(e => e.id === '9200000009');
    check('and the queue remembers that a person asked for it',
      entry && entry.user === true, JSON.stringify(entry));

    // The switches are the extension's own initiative. A button is not.
    await reset({ mode: 'active', experimentalOwnTab: false });
    await setSettings({ blockSeen: false, blockFromList: false });
    await send('sw:enqueue-platform-block', { platform: 'threads',
      ids: ['9300000001'], warm: true, userInitiated: true });
    openGate();
    const asked = await send('sw:queue-claim', { platform: 'threads' });
    check('and it is served even with both job switches off',
      asked.target === '9300000001', JSON.stringify(asked));
  }

  // -- 2c4. asking again for something already done -------------------------
  //
  // The done list is the extension's memory of what IT blocked, and for its own
  // sweeping that memory is essential -- without it every refresh re-blocks the
  // same accounts. For somebody pressing a button it is just stale: it records
  // what we did, not the account's state now, and it goes stale exactly when
  // they unblocked someone by hand. That press used to hit the done check and
  // vanish -- no queue entry, nothing to act on -- while the popup and the
  // report sheet both answered "Queued".
  {
    await reset({ mode: 'active', experimentalOwnTab: false });
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['9400000001'], warm: true });
    openGate();
    const c = await send('sw:queue-claim', { platform: 'threads' });
    await send('sw:queue-result', { platform: 'threads', target: c.target, ok: true, dryRun: false });
    check('a real block retires the target to the done list',
      ((await state()).done.threads || []).includes('9400000001'),
      JSON.stringify((await state()).done));

    // The extension's own sweep must still skip it.
    const sweep = await send('sw:enqueue-platform-block',
      { platform: 'threads', ids: ['9400000001'], warm: true });
    check('the extension\'s own sweep still skips what it already blocked',
      sweep.added === 0 && !sweep.revived &&
      !((await state()).queue.threads || []).some(e => e.id === '9400000001'),
      JSON.stringify(sweep));

    // A person asking for it is a different statement, and it has to do
    // something rather than report success and do nothing.
    const asked = await send('sw:enqueue-platform-block',
      { platform: 'threads', ids: ['9400000001'], warm: true, userInitiated: true });
    check('but asking for it explicitly queues it again rather than silently doing nothing',
      asked.added === 1 && asked.revived === 1, JSON.stringify(asked));
    check('and it leaves the done list, or the next sweep would retire it unacted on',
      !((await state()).done.threads || []).includes('9400000001'),
      JSON.stringify((await state()).done));

    openGate();
    const again = await send('sw:queue-claim', { platform: 'threads' });
    check('so there is really something to act on',
      again.target === '9400000001', JSON.stringify(again));
  }

  // -- 2d. a tab of our own, and that it holds still -------------------------
  //
  // Blocking runs through the site's own code and the site's own code needs a
  // page, so a queue with nobody browsing never moves. The worker keeps a
  // PINNED tab for it.
  //
  // The first version opened one, drained the queue and closed it again --
  // which put a tab in and out of the strip several times an hour. So the
  // property under test here is mostly the opposite of doing something: an
  // empty queue must NOT close it.
  {
    const openWork = () => send('sw:open-work-tab');
    const created = () => tabEvents.filter(e => e.what === 'create' || e.what === 'window');

    await reset({ experimentalOwnTab: true });
    const idle = await openWork();
    check('with nothing queued no tab is opened',
      idle.skipped === 'nothing to do' && created().length === 0, JSON.stringify(idle));

    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['8100000001'] });
    const opened = await openWork();
    check('with work queued and nobody browsing, the worker opens one itself',
      opened.opened === 'threads' && created().length === 1 &&
      created()[0].url === 'https://www.threads.com/',
      JSON.stringify(opened) + ' ' + JSON.stringify(created()));
    check('pinned, and in the background rather than stealing focus',
      created()[0].pinned === true && created()[0].active === false,
      JSON.stringify(created()[0]));
    check('and it remembers which tab is its own',
      store.local.ownWorkTab.threads && store.local.ownWorkTab.threads.tabId === opened.tabId,
      JSON.stringify(store.local.ownWorkTab));

    const again = await openWork();
    check('a second look does not open a second tab',
      again.platforms.threads === 'already open' && created().length === 1, JSON.stringify(again));

    // The heart of it: the queue empties and the tab stays.
    const ownId = opened.tabId;
    openGate();
    const c = await send('sw:queue-claim', { platform: 'threads' }, fromTab(ownId));
    await flush();
    check('the tab it keeps can claim the work it was opened for',
      c.target === '8100000001', JSON.stringify(c));

    await send('sw:queue-result', { platform: 'threads', target: '8100000001',
      ok: true, dryRun: false, attempts: [] });
    openGate();
    const drained = await send('sw:queue-claim', { platform: 'threads' }, fromTab(ownId));
    await flush();
    check('and with the queue drained it STAYS open rather than flickering away',
      !drained.target && openTabs.some(t => t.id === ownId) &&
      !tabEvents.some(e => e.what === 'remove'),
      JSON.stringify({ target: drained.target, events: tabEvents }));
    check('with the record still pointing at it',
      store.local.ownWorkTab.threads.tabId === ownId, JSON.stringify(store.local.ownWorkTab));

    // Unpinning it by hand is answered by pinning it back -- being pinned is
    // what makes a permanent tab bearable to live with.
    openTabs.find(t => t.id === ownId).pinned = false;
    const repin = await openWork();
    check('and if it gets unpinned, it is pinned again',
      repin.repinned === true && openTabs.find(t => t.id === ownId).pinned === true,
      JSON.stringify(repin));

    // Chrome reclaims memory by discarding background tabs. The tab is still
    // listed and still ours, but the page -- and the content script doing the
    // blocking -- is gone. Without this the queue would sit still forever
    // behind a tab that looks perfectly healthy.
    openTabs.find(t => t.id === ownId).discarded = true;
    const woken = await openWork();
    check('a tab Chrome discarded is reloaded rather than trusted',
      woken.reloaded === 'discarded' &&
      tabEvents.some(e => e.what === 'reload' && e.id === ownId),
      JSON.stringify(woken) + ' ' + JSON.stringify(tabEvents.slice(-2)));
  }

  // -- 2e. closing it by hand ------------------------------------------------
  //
  // The one thing this must never become is a tab nobody can get rid of. An
  // accidental close comes back a minute later; a second and third push that
  // out, because somebody closing it repeatedly is saying something.
  {
    const openWork = () => send('sw:open-work-tab');
    await reset({ experimentalOwnTab: true });
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['8300000001'] });
    const opened = await openWork();
    const id1 = opened.tabId;

    openTabs = openTabs.filter(t => t.id !== id1);
    tabRemovedHandler(id1, {});
    await flush();
    check('closing it by hand is noticed and counted',
      store.local.ownWorkTab.threads.tabId == null && store.local.ownWorkTab.threads.manualCloses === 1,
      JSON.stringify(store.local.ownWorkTab));
    check('and another is not opened on the spot',
      (await openWork()).platforms.threads === 'closed by hand, waiting',
      JSON.stringify(store.local.ownWorkTab));
    check('a reopen is scheduled instead, a minute out',
      alarms.get('cb-reopen-work-tab') &&
      alarms.get('cb-reopen-work-tab').delayInMinutes === 1,
      JSON.stringify(alarms.get('cb-reopen-work-tab')));

    // Once the back-off has run out, it comes back.
    store.local.ownWorkTab.threads.closedAt = Date.now() - 61 * 1000;
    const back = await openWork();
    check('and once that minute is up it comes back, pinned',
      back.opened === 'threads' && back.pinned === true, JSON.stringify(back));

    // Closed again straight away: they mean it. The wait gets longer.
    const id2 = back.tabId;
    openTabs = openTabs.filter(t => t.id !== id2);
    tabRemovedHandler(id2, {});
    await flush();
    check('closing it again pushes the next attempt further out',
      store.local.ownWorkTab.threads.manualCloses === 2 &&
      alarms.get('cb-reopen-work-tab').delayInMinutes === 5,
      JSON.stringify([store.local.ownWorkTab.threads.manualCloses,
                      alarms.get('cb-reopen-work-tab').delayInMinutes]));

    // A tab that lived a long time was not being rejected: the count resets,
    // so an accidental close a week later is treated as the first one.
    store.local.ownWorkTab.threads.closedAt = Date.now() - 6 * 60 * 1000;
    const third = await openWork();
    store.local.ownWorkTab.threads.openedAt = Date.now() - 30 * 60 * 1000;
    openTabs = openTabs.filter(t => t.id !== third.tabId);
    tabRemovedHandler(third.tabId, {});
    await flush();
    check('but a tab that had lived a long while starts the count again',
      store.local.ownWorkTab.threads.manualCloses === 1 &&
      alarms.get('cb-reopen-work-tab').delayInMinutes === 1,
      JSON.stringify(store.local.ownWorkTab));

    // Five closes, each within ten minutes of opening, is not mis-clicking.
    // The ladder on its own would mean a tab returning hourly forever, which
    // is the same problem more slowly. The fifth close is taken as an answer --
    // and the answer is recorded by switching the experiment OFF, not by a
    // private flag, so that the options page agrees with what just happened.
    for (let i = 0; i < 5; i++) {
      store.local.ownWorkTab.threads.closedAt = 0;      // back-off already served
      const t = await openWork();
      if (!t.tabId) break;
      openTabs = openTabs.filter(x => x.id !== t.tabId);
      tabRemovedHandler(t.tabId, {});
      await flush();
    }
    const settledSettings = (await send('sw:get-settings')).settings;
    check('closed by hand enough times, it switches itself off',
      settledSettings.experimentalOwnTab === false &&
      !alarms.has('cb-reopen-work-tab') &&
      !openTabs.some(t => (t.url || '').includes('threads.com')),
      JSON.stringify(settledSettings.experimentalOwnTab) + ' alarms=' + JSON.stringify([...alarms.keys()]));
    check('and stays off however often it is asked',
      (await openWork()).skipped === 'experiment off',
      JSON.stringify(store.local.ownWorkTab));

    // The bug this shape exists to prevent. The options page does NOT send
    // only the field that changed -- save() posts every checkbox on every
    // change -- so a private "we gave up" flag was undone by editing any
    // unrelated option, and the tab came straight back. Sending the real
    // payload shape is the only way to test that.
    const bulkSave = (ownTab) => ({
      blockSeen: true, blockFromList: true, shareRegion: true,
      hideEnabled: true, hideFeedPosts: true, hideComments: true,
      platformBlockDryRun: false, allowRawNetworkFallback: false,
      experimentalOwnTab: ownTab, reportUiEnabled: true, debug: false,
      maxBlocksPerHour: 42
    });
    // The box is unticked now, so what the page posts carries false.
    await setSettings(bulkSave(false));
    await flush();
    check('and an unrelated options save cannot bring it back',
      (await send('sw:get-settings')).settings.experimentalOwnTab === false &&
      !openTabs.some(t => (t.url || '').includes('threads.com')),
      JSON.stringify((await send('sw:get-settings')).settings.experimentalOwnTab));

    // Ticking the box again is the one thing that means the opposite -- and
    // the proof is a tab, in the same call.
    await setSettings(bulkSave(true));
    await flush();
    check('but ticking the box again is taken as asking for it back',
      store.local.ownWorkTab.threads.tabId != null &&
      store.local.ownWorkTab.threads.manualCloses === 0 &&
      openTabs.some(t => t.id === store.local.ownWorkTab.threads.tabId && t.pinned === true),
      JSON.stringify(store.local.ownWorkTab));
  }

  // -- 2f. the gates on having a tab at all ----------------------------------
  //
  // Each of these is a reason not to put a page in front of somebody -- and,
  // now that the tab is permanent, a reason to take one away that already
  // exists.
  {
    const openWork = () => send('sw:open-work-tab');
    const seed = async (settings) => {
      await reset(settings);
      await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['8200000001'] });
    };

    await seed({ experimentalOwnTab: false });
    check('the experiment being off is a reason not to',
      (await openWork()).skipped === 'experiment off' && tabEvents.length === 0);

    await seed({ experimentalOwnTab: true, platformBlockEnabled: false });
    check('blocking being paused is a reason not to',
      (await openWork()).skipped === 'blocking off' && tabEvents.length === 0);

    await seed({ experimentalOwnTab: true });
    store.local.stats = Object.assign({}, store.local.stats, { halted: true });
    check('a halted worker is a reason not to',
      (await openWork()).skipped === 'halted' && tabEvents.length === 0);

    // The one that matters most: somebody is already there. Their page does
    // the work, and costs nobody an extra tab.
    await seed({ experimentalOwnTab: true });
    openTabs.push({ id: 77, url: 'https://www.threads.com/@someone' });
    check('a page they already have open is a reason not to',
      (await openWork()).skipped === 'nothing to do' && tabEvents.length === 0,
      JSON.stringify(tabEvents));

    // ... but a tab on the OTHER platform is not, and the queue that has work
    // is the one that gets a tab.
    await seed({ experimentalOwnTab: true });
    openTabs.push({ id: 78, url: 'https://www.facebook.com/' });
    const other = await openWork();
    check('a tab on the other platform is not, and the right site is opened',
      other.opened === 'threads' &&
      tabEvents.some(e => e.url === 'https://www.threads.com/'),
      JSON.stringify(other) + ' ' + JSON.stringify(tabEvents));

    // Switching the experiment off has to take the tab away at once. A tab
    // that outlives the switch governing it is a tab you cannot get rid of.
    await seed({ experimentalOwnTab: true });
    const live = await openWork();
    check('with the experiment on there is a tab', live.opened === 'threads');
    await setSettings({ experimentalOwnTab: false });
    await flush();
    check('and switching the experiment off closes it there and then',
      !openTabs.some(t => t.id === live.tabId) &&
      store.local.ownWorkTab.threads.tabId == null &&
      store.local.ownWorkTab.threads.reason === 'experiment off',
      JSON.stringify(store.local.ownWorkTab) + ' ' + JSON.stringify(openTabs.map(t => t.id)));
    check('and closing it that way is not counted against the person',
      store.local.ownWorkTab.threads.manualCloses === 0,
      JSON.stringify(store.local.ownWorkTab));
  }

  // -- 2f2. one tab per platform, and one opener at a time -------------------
  //
  // Two findings from an adversarial review of this feature, both reproduced
  // against the real worker before being fixed here.
  //
  // Facebook work can only be done on a facebook.com page and Threads work on
  // a threads.com one. While the tab closed itself on an empty queue, a single
  // "the tab" recovered on its own; once it stays open forever, the platform
  // it is NOT on starves for the whole browser session -- and the badge, which
  // counts any Meta tab as somewhere for work to run, reports all is well.
  {
    await reset({ experimentalOwnTab: true });
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['8400000001'] });
    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['8400000002'] });
    await send('sw:open-work-tab');
    const rec = store.local.ownWorkTab;
    check('work on both platforms gets a tab on both',
      rec.threads && rec.threads.tabId != null &&
      rec.facebook && rec.facebook.tabId != null &&
      openTabs.some(t => t.url.includes('threads.com') && t.pinned) &&
      openTabs.some(t => t.url.includes('facebook.com') && t.pinned),
      JSON.stringify(rec));

    // And draining one does not stop the other being served.
    await reset({ experimentalOwnTab: true });
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['8400000003'] });
    await send('sw:open-work-tab');
    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['8400000004'] });
    await send('sw:open-work-tab');
    check('and work arriving later for the other platform is not stranded',
      store.local.ownWorkTab.facebook &&
      store.local.ownWorkTab.facebook.tabId != null,
      JSON.stringify(store.local.ownWorkTab));
  }

  {
    // Two alarms can come due at the same instant. Interleaved between reading
    // the record and writing the new tab id, each would create a pinned tab
    // while only the second was remembered -- and the first would then be a
    // tab nothing owns: not closed by the off switch, not reopened, not
    // reloaded, just there. Serialising the whole thing is what prevents it.
    await reset({ experimentalOwnTab: true });
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['8500000001'] });
    const both = await Promise.all([send('sw:open-work-tab'), send('sw:open-work-tab')]);
    const threadsTabs = openTabs.filter(t => (t.url || '').includes('threads.com'));
    check('two openers racing still produce exactly one tab',
      threadsTabs.length === 1 &&
      threadsTabs[0].id === store.local.ownWorkTab.threads.tabId,
      JSON.stringify(both.map(b => b.opened || b.skipped)) + ' tabs=' +
      JSON.stringify(threadsTabs.map(t => t.id)));
  }

  {
    // A page that loaded but stopped working looks exactly like a healthy one
    // from out here: the tab exists, so nothing reopens it, and any Meta tab
    // suppresses the badge that used to say work was waiting. The content
    // script's loop stops for good on a rejected session, and nothing in the
    // page restarts it -- a reload is the only cure available.
    await reset({ experimentalOwnTab: true });
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['8600000001'] });
    const t = await send('sw:open-work-tab');
    check('a tab that is claiming is left alone',
      (await send('sw:open-work-tab')).reloaded === undefined, 't just opened');

    // Rewind the last sign of life past the stall window, with work waiting.
    store.local.ownWorkTab.threads.openedAt = Date.now() - 25 * 60 * 1000;
    delete store.local.ownWorkTab.threads.lastClaimAt;
    const woken = await send('sw:open-work-tab');
    check('but one with work in front of it and no sign of life is reloaded',
      woken.reloaded === 'stalled' &&
      tabEvents.some(e => e.what === 'reload' && e.id === t.tabId),
      JSON.stringify(woken));

    // A claim is the proof of life, and it has to come from that tab.
    store.local.ownWorkTab.threads.openedAt = Date.now() - 25 * 60 * 1000;
    delete store.local.ownWorkTab.threads.wokeAt;
    openGate();
    await send('sw:queue-claim', { platform: 'threads' }, fromTab(t.tabId));
    await flush();
    check('and a claim from that tab is what counts as one',
      store.local.ownWorkTab.threads.lastClaimAt > Date.now() - 5000 &&
      (await send('sw:open-work-tab')).reloaded === undefined,
      JSON.stringify(store.local.ownWorkTab.threads.lastClaimAt));
  }

  // -- 2g. which build turns the experiment on -------------------------------
  //
  // Enabled by default while developing, off in anything that came from the
  // store, and an explicit choice beats both. Chrome puts update_url in the
  // manifest of a store install and leaves it out of an unpacked one, which is
  // the only signal available without asking for the management permission.
  {
    manifest = { version: '1.0.1' };                     // unpacked
    await reset();
    delete store.sync.settings.experimentalOwnTab;
    const dev = await send('sw:get-settings');
    check('an unpacked build has the experiment on by default',
      dev.settings.experimentalOwnTab === true, JSON.stringify(dev.settings.experimentalOwnTab));

    manifest = { version: '1.0.1', update_url: 'https://clients2.google.com/service/update2/crx' };
    const store_ = await send('sw:get-settings');
    check('a store build has it off by default',
      store_.settings.experimentalOwnTab === false, JSON.stringify(store_.settings.experimentalOwnTab));

    await setSettings({ experimentalOwnTab: true });
    const chosen = await send('sw:get-settings');
    check('and a choice that was actually made outranks the build',
      chosen.settings.experimentalOwnTab === true, JSON.stringify(chosen.settings.experimentalOwnTab));

    manifest = { version: '1.0.1' };
    await setSettings({ experimentalOwnTab: false });
    const off = await send('sw:get-settings');
    check('in both directions',
      off.settings.experimentalOwnTab === false, JSON.stringify(off.settings.experimentalOwnTab));
  }

  // -- 3. failed real attempts count toward the hourly cap ------------------
  await reset({ maxBlocksPerHour: 2 });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['5555555555', '6666666666', '7777777777'] });
  let realAttempts = 0;
  for (let i = 0; i < 6; i++) {
    openGate();
    const c = await send('sw:queue-claim', { platform: 'facebook' });
    if (!c.target) break;
    realAttempts++;
    await send('sw:queue-result', { platform: 'facebook', target: c.target, ok: false, dryRun: false, detail: 'x' });
  }
  check('failed real attempts count toward the hourly cap',
    realAttempts === 2, `made ${realAttempts} attempts with cap 2`);

  // -- 4. dry runs do not count toward the cap, but do rotate ---------------
  await reset({ maxBlocksPerHour: 2, platformBlockDryRun: true });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['8888888888', '9999999999'] });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    openGate();
    const c = await send('sw:queue-claim', { platform: 'facebook' });
    if (!c.target) break;
    seen.push(c.target);
    await send('sw:queue-result', { platform: 'facebook', target: c.target, ok: true, dryRun: true });
  }
  const st4 = await state();
  check('dry runs rotate through the queue instead of repeating the first entry',
    new Set(seen).size === 2, `claimed ${JSON.stringify(seen)}`);
  check('dry runs do not consume the rate limit',
    !(st4.stats.attemptTimes || []).length && (st4.stats.dryRuns || 0) === 2,
    `attemptTimes=${(st4.stats.attemptTimes || []).length} dryRuns=${st4.stats.dryRuns}`);
  check('dry runs leave targets queued',
    (st4.queue.facebook || []).length === 2, JSON.stringify(st4.queue.facebook));

  // -- 5. concurrent claims are serialised, not shared out ------------------
  //
  // This used to assert that two tabs claiming at once got two DIFFERENT
  // targets, which is the flooding it should have been preventing: five open
  // tabs meant five blocks in the same second, five times the rate the caps
  // were chosen for. Leases only stopped two tabs taking the same profile.
  // One gate now paces the whole browser, so the second tab is told to wait.
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['1212121212', '3434343434'] });
  const [a, b] = await Promise.all([
    send('sw:queue-claim', { platform: 'facebook' }),
    send('sw:queue-claim', { platform: 'facebook' })
  ]);
  const got = [a, b].filter(x => x.target);
  const waiting = [a, b].filter(x => !x.target);
  check('two tabs claiming at once yield exactly one block',
    got.length === 1 && waiting.length === 1, `a=${a.target} b=${b.target}`);
  check('and the other tab is told when to come back, not left guessing',
    waiting[0] && waiting[0].retryInMs > 0, JSON.stringify(waiting[0]));

  // Five tabs, one after another, with nothing reported: still one block.
  await reset();
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['1111111111', '2222222222', '3333333333', '4444444444', '5555555555'] });
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => send('sw:queue-claim', { platform: 'facebook' })));
  check('five tabs claiming at once still yield exactly one block',
    five.filter(x => x.target).length === 1,
    JSON.stringify(five.map(x => x.target)));

  // The gate opens again once the result lands, so work does not stall.
  const served = five.find(x => x.target);
  await send('sw:queue-result',
    { platform: 'facebook', target: served.target, ok: true, dryRun: true, warm: true });
  // The gate re-arms with the DELAY, not with the lease: work resumes after
  // seconds, not after a minute and a half. Both halves matter -- a gate that
  // never reopened would be a queue that stopped.
  const stillWaiting = await send('sw:queue-claim', { platform: 'facebook' });
  const settings0 = (await state()).settings;
  check('the pause after a result is the warm delay, not the lease',
    !stillWaiting.target &&
    stillWaiting.retryInMs > 0 &&
    stillWaiting.retryInMs <= (settings0.warmMaxDelayMs | 0) + 500,
    `retryInMs=${stillWaiting.retryInMs} warmMax=${settings0.warmMaxDelayMs}`);
  openGate();
  const nextServed = await send('sw:queue-claim', { platform: 'facebook' });
  check('and once it has run, the next tab is served',
    !!nextServed.target && nextServed.target !== served.target,
    `${served.target} -> ${nextServed.target}`);

  // -- 6. success retires the target ---------------------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['5656565656'] });
  openGate();
  const c6 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', { platform: 'facebook', target: c6.target, ok: true, dryRun: false });
  const st6 = await state();
  check('a successful block is retired from the queue and recorded as done',
    (st6.queue.facebook || []).length === 0 &&
    (st6.done.facebook || []).includes('5656565656') &&
    (st6.stats.attemptTimes || []).length === 1,
    `queue=${JSON.stringify(st6.queue.facebook)} done=${JSON.stringify(st6.done.facebook)}`);

  // -- 7. a checkpoint halts everything -------------------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7878787878'] });
  openGate();
  const c7 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: c7.target, ok: false, dryRun: false, checkpoint: true, detail: 'challenge'
  });
  const st7 = await state();
  openGate();
  const after7 = await send('sw:queue-claim', { platform: 'facebook' });
  check('a checkpoint disables platform blocking and stops handing out work',
    st7.settings.platformBlockEnabled === false && !after7.target,
    `enabled=${st7.settings.platformBlockEnabled} nextTarget=${after7.target}`);

  // -- 8. already-blocked targets are not re-queued -------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['9090909090'] });
  openGate();
  const c8 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', { platform: 'facebook', target: c8.target, ok: true, dryRun: false });
  const re = await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['9090909090'] });
  check('a completed target is not re-queued when the list is re-sent',
    re.added === 0, `added=${re.added}`);

  // -- 9. removing someone from the list must un-queue them -----------------
  // The queue used to only ever grow, so taking a profile off the server list
  // did not stop it being blocked -- its id was already pending from an
  // earlier fetch.
  await reset();
  store.local.blocklist = { ids: ['111111111', '222222222'], usernames: [] };
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['111111111', '222222222'] });
  const beforePrune = (await state()).queue.facebook || [];

  // Simulate the next fetch returning a list with one entry removed.
  const { pruneForTest } = globalThis;
  store.local.blocklist = { ids: ['111111111'], usernames: [] };
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: [] });   // no-op enqueue
  // Drive the prune the same way refreshBlocklist does.
  await send('sw:prune-test', { ids: ['111111111'] });
  const afterPrune = (await state()).queue.facebook || [];

  const idOf = (e) => (typeof e === 'string' ? e : e && e.id);
  check('removing a profile from the list removes it from the queue',
    beforePrune.length === 2 && afterPrune.length === 1 && idOf(afterPrune[0]) === '111111111',
    `before=${JSON.stringify(beforePrune.map(idOf))} after=${JSON.stringify(afterPrune.map(idOf))}`);

  // -- 8. warm before cold --------------------------------------------------
  //
  // Blocking someone whose profile is on the page is what an ordinary person
  // does; working through a list of accounts they have never seen is what gets
  // an account checkpointed. The queue has to know the difference.
  await reset({ maxColdBlocksPerHour: 2 });
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: [{ id: '6000000001', rank: 99 }], warm: false });
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6000000002'], warm: true });

  openGate();
  const w1 = await send('sw:queue-claim', { platform: 'facebook' });
  check('a profile that was on screen is claimed before a server-nominated one',
    w1.target === '6000000002' && w1.warm === true,
    `${w1.target} warm=${w1.warm}`);
  check('the claim carries a short pause after a warm block',
    w1.nextDelayMs > 0 && w1.nextDelayMs <= 12000, String(w1.nextDelayMs));

  await send('sw:queue-result',
    { platform: 'facebook', target: '6000000002', ok: true, warm: true });

  openGate();
  const c1 = await send('sw:queue-claim', { platform: 'facebook' });
  check('the cold target is claimed once nothing warm is left',
    c1.target === '6000000001' && c1.warm === false, `${c1.target} warm=${c1.warm}`);
  check('a cold block is paced within its configured cold window',
    c1.nextDelayMs >= 4000 && c1.nextDelayMs <= 10000, String(c1.nextDelayMs));

  // -- 9. the cold ceiling must not stop warm work --------------------------
  await send('sw:queue-result',
    { platform: 'facebook', target: '6000000001', ok: true, warm: false });
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6000000003', '6000000004'], warm: false });
  openGate();
  const c2 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result',
    { platform: 'facebook', target: c2.target, ok: true, warm: false });

  // Two cold blocks spent against a ceiling of two.
  openGate();
  const c3 = await send('sw:queue-claim', { platform: 'facebook' });
  check('cold work stops at its hourly ceiling',
    !c3.target && c3.coldHeld === true, `${c3.target} held=${c3.coldHeld}`);

  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6000000005'], warm: true });
  openGate();
  const w2 = await send('sw:queue-claim', { platform: 'facebook' });
  check('warm work continues after the cold ceiling is reached',
    w2.target === '6000000005' && w2.warm === true, `${w2.target} warm=${w2.warm}`);

  // -- 10. seeing a cold target on screen promotes it -----------------------
  await reset({ maxColdBlocksPerHour: 0 });
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: [{ id: '6100000001', rank: 5 }], warm: false });
  openGate();
  const before = await send('sw:queue-claim', { platform: 'facebook' });
  check('with no cold budget at all, a cold target is not handed out',
    !before.target, String(before.target));

  const promo = await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6100000001'], warm: true });
  check('re-seeing it on screen promotes it rather than duplicating it',
    promo.promoted === 1 && promo.added === 0 && promo.queued === 1,
    JSON.stringify(promo));
  openGate();
  const after = await send('sw:queue-claim', { platform: 'facebook' });
  check('once promoted it is claimable, because it is now the ordinary case',
    after.target === '6100000001' && after.warm === true,
    `${after.target} warm=${after.warm}`);

  // -- 11. rank orders cold work --------------------------------------------
  await reset({ maxColdBlocksPerHour: 50 });
  await send('sw:enqueue-platform-block', {
    platform: 'facebook', warm: false,
    ids: [{ id: '6200000001', rank: 1 }, { id: '6200000002', rank: 50 }, { id: '6200000003', rank: 10 }]
  });
  openGate();
  const r1 = await send('sw:queue-claim', { platform: 'facebook' });
  check('the highest-ranked cold target goes first',
    r1.target === '6200000002', `${r1.target} rank=${r1.rank}`);

  // -- 12. warmth survives a blocklist refresh ------------------------------
  await send('sw:prune-test', { ids: ['6200000002', '6200000003'] });
  const st = await state();
  const remaining = (st.queue.facebook || []).map(e => (typeof e === 'string' ? e : e.id));
  check('pruning to the fresh list keeps entries with their warmth intact',
    remaining.length === 2 && remaining.indexOf('6200000001') < 0,
    JSON.stringify(remaining));

  // -- 13. a recorded failure stops being shown once it stops being true ----
  //
  // stats.lastError was written in three places and cleared in none, so the
  // first block that could not run pinned its message to the popup for good --
  // through later successes, through signing back in, through turning platform
  // blocking off. These lock the clearing behaviour in.
  await reset({ maxColdBlocksPerHour: 50 });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000001'], warm: true });
  openGate();
  const f1 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: f1.target, ok: false, dryRun: false,
    detail: "the site's own block operation is not loaded on this page yet"
  });
  const afterFail = await state();
  check('a failed block records what went wrong',
    /not loaded on this page/.test(afterFail.stats.lastError || ''),
    JSON.stringify(afterFail.stats.lastError));
  check('and records when, so a stale one can be told apart from a live one',
    typeof afterFail.stats.lastErrorAt === 'number' && afterFail.stats.lastErrorAt > 0,
    String(afterFail.stats.lastErrorAt));

  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000002'], warm: true });
  openGate();
  const f2 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', { platform: 'facebook', target: f2.target, ok: true, dryRun: false });
  const afterOk = await state();
  check('a block that works clears the earlier failure',
    !afterOk.stats.lastError && !afterOk.stats.lastErrorAt,
    JSON.stringify(afterOk.stats.lastError));

  // A dry run resolves a strategy end to end, so it settles the question too.
  await reset({ platformBlockDryRun: true, maxColdBlocksPerHour: 50 });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000003'], warm: true });
  openGate();
  const d1 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: d1.target, ok: false, dryRun: true, detail: 'nothing to drive' });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000004'], warm: true });
  openGate();
  const d2 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', { platform: 'facebook', target: d2.target, ok: true, dryRun: true });
  const afterDry = await state();
  check('a successful dry run clears it as well',
    !afterDry.stats.lastError, JSON.stringify(afterDry.stats.lastError));

  // Every recorded error is about blocking, so switching blocking off makes
  // all of them historical.
  await reset({ maxColdBlocksPerHour: 50 });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000005'], warm: true });
  openGate();
  const f3 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: f3.target, ok: false, dryRun: false, detail: 'signed out' });
  check('the failure is recorded before blocking is turned off',
    !!(await state()).stats.lastError, 'recorded');
  await setSettings({ platformBlockEnabled: false });
  const afterOff = await state();
  check('turning platform blocking off clears the message it was about',
    !afterOff.stats.lastError, JSON.stringify(afterOff.stats.lastError));

  // -- 14. the published list path ------------------------------------------
  //
  // The blocklist can now live in a Firestore document; the service worker
  // must decode the envelope, rank the published metadata LOCALLY (nothing
  // about the browser is sent), and file reports as create-only documents.
  // The shipped default: the list comes off Hosting as plain JSON with a real
  // HTTP ETag, and reports go to Firestore through an apiBase that can no
  // longer be derived from the list URL. Both halves are checked, because the
  // failure mode of getting this wrong is a working list and silently broken
  // reporting.
  {
    const CDN = 'https://cdn.example/blocklist.json';
    const FS  = 'https://api.example/v1';
    const published = { v: 1, ids: ['5100000001'], usernames: ['someclone'],
                        idTags: { '5100000001': 'redbull' }, targets: [] };
    const seen = [];
    global.fetch = async (url, opts) => {
      seen.push({ url: String(url), method: (opts || {}).method || 'GET' });
      if (String(url).startsWith(CDN)) {
        return { ok: true, status: 200,
          headers: { get: (h) => (h.toLowerCase() === 'etag' ? 'W/"abc123"' : null) },
          text: async () => JSON.stringify(published),
          json: async () => published };
      }
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => '{}', json: async () => ({}) };
    };

    await reset({ platformBlockEnabled: true });
    await setSettings({ listUrl: CDN, apiBase: FS });
    const r = await send('sw:refresh-now');
    // The refresh also kicks an unawaited pointer walk; let it finish before
    // reading the request log, or its tail lands in the next block's stub.
    await new Promise(res => setTimeout(res, 25));
    check('a plain JSON list on the CDN decodes',
      r.ok && r.blocklist.ids.includes('5100000001') &&
      r.blocklist.usernames.includes('someclone'),
      JSON.stringify(r.blocklist && r.blocklist.ids));
    check('and its HTTP ETag is kept for the next poll',
      r.blocklist.etag === 'W/"abc123"', String(r.blocklist.etag));
    check('the published tag survives the CDN shape',
      (r.blocklist.idTags || {})['5100000001'] === 'redbull',
      JSON.stringify(r.blocklist.idTags));
    // The list poll, and since 1.0.4 the pointer poll riding alongside it,
    // may only ever ask for FIXED urls compiled into the build or configured
    // by the owner of this browser -- never one shaped by who is asking.
    {
      const FIXED = [CDN].concat(globalThis.CB_POINTER_URLS || []);
      check('reading the list touches nothing but fixed static files',
        seen.filter(c => c.method === 'GET').every(c => FIXED.includes(c.url)),
        JSON.stringify(seen.map(c => c.url)));
    }
    // A static file cannot use a ranking hint, and on a CDN a per-user query
    // string is the difference between an edge-cached 304 and a fresh
    // transfer per install per hour -- besides putting the reader's timezone
    // in somebody's HTTP logs for nothing.
    check('and the CDN is asked for the plain URL, describing nobody',
      seen.some(c => c.url === CDN), JSON.stringify(seen.map(c => c.url)));

    seen.length = 0;
    await send('sw:submit-report', { platform: 'threads', profileId: '5100000009',
      username: 'someclone', reason: 'redbull', viewerId: '778899' });
    const wrote = seen.find(c => c.method === 'POST');
    check('a report goes to the API, not to the file the list is served from',
      !!wrote && wrote.url === FS + '/reports',
      wrote ? wrote.url.slice(0, 100) : JSON.stringify(seen));
  }

  // The pin door. With NO host permission at all, a report must still reach a
  // pointer-pinned host over plain CORS -- this is what lets 1.0.4 rescue an
  // install whose primary domain an ISP has blocked, without the manifest
  // change that would disable the extension pending re-approval. And a custom
  // apiBase that is neither permitted nor pinned must stay refused, exactly
  // as it always was.
  {
    const RELAY_BASE = 'https://h0w1lwun39.execute-api.ap-southeast-1.amazonaws.com/v1';
    const seen = [];
    global.fetch = async (url, opts) => {
      seen.push({ url: String(url), method: (opts || {}).method || 'GET' });
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => '{"ok":true,"status":"pending"}',
               json: async () => ({ ok: true, status: 'pending' }) };
    };
    const hadPermission = chrome.permissions.contains;
    chrome.permissions.contains = async () => false;

    await reset({ platformBlockEnabled: true });
    await setSettings({ apiBase: RELAY_BASE });
    const r1 = await send('sw:submit-report', { platform: 'threads', profileId: '5100000010',
      username: 'some.clone', reason: 'clone', viewerId: '778899' });
    const posted = seen.find(c => c.method === 'POST');
    check('a pinned host takes reports with no host permission at all',
      !!posted && posted.url === RELAY_BASE + '/reports' && !(r1 && r1.needsPermission),
      JSON.stringify({ posted: posted && posted.url, r: r1 }));

    seen.length = 0;
    await setSettings({ apiBase: 'https://somebody-elses.example/v1' });
    const r2 = await send('sw:submit-report', { platform: 'threads', profileId: '5100000011',
      username: 'other.clone', reason: 'clone', viewerId: '778899' });
    check('an unpinned custom apiBase without permission is still refused',
      !!r2 && r2.needsPermission === true && !seen.some(c => c.method === 'POST'),
      JSON.stringify({ r: r2, posts: seen.filter(c => c.method === 'POST').length }));

    chrome.permissions.contains = hadPermission;
  }

  // The default list now lives on a host this build has no permission for
  // (raw.githubusercontent.com), read over CORS -- and it is a PUBLIC file, so
  // it is trusted exactly like a mirror: a refresh must succeed with permission
  // denied, but only for a SIGNED list. An unsigned list on the shipped default
  // is an attacker who can write that file stripping the signature, and must be
  // refused -- the exemption that accepts an unsigned list "from the primary"
  // is for a self-hosted URL only.
  {
    const crypto = require('crypto');
    const GH = globalThis.CB_DEFAULT_SETTINGS.listUrl;   // the shipped default
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
    const signed = (p) => ({ payload: p,
      sig: crypto.sign(null, Buffer.from(JSON.stringify(p)), privateKey).toString('base64url'),
      alg: 'ed25519' });
    const list = { v: 2, updatedAt: new Date().toISOString(),
                   ids: ['5200000001', '5200000002'], usernames: ['ghclone'], targets: [] };
    const serve = (o) => async (url) => (String(url) === GH)
      ? { ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify(o), json: async () => o }
      : { ok: true, status: 200, headers: { get: () => null },
          text: async () => '{}', json: async () => ({}) };

    const hadKey = globalThis.CB_POINTER_KEY;
    const hadPermission = chrome.permissions.contains;
    globalThis.CB_POINTER_KEY = pubRaw;
    chrome.permissions.contains = async () => false;

    await reset();
    await setSettings({ listUrl: GH });
    global.fetch = serve(signed(list));
    const r = await send('sw:refresh-now');
    check('the GitHub default list refreshes, signed, with host permission denied',
      r.ok && r.blocklist && r.blocklist.ids.includes('5200000001') &&
      r.blocklist.verified === true && !r.needsPermission,
      JSON.stringify({ ok: r.ok, needs: r.needsPermission, verified: r.blocklist && r.blocklist.verified }));

    // An UNSIGNED list on the shipped default is refused, and the verified
    // cache from the step above is left untouched.
    global.fetch = serve({ v: 2, updatedAt: new Date(Date.now() + 3600000).toISOString(),
                           ids: ['6660000666'], usernames: [], targets: [] });
    const r2 = await send('sw:refresh-now');
    check('an unsigned list on the GitHub default is refused',
      !r2.ok && store.local.blocklist.ids.includes('5200000001') &&
      !store.local.blocklist.ids.includes('6660000666'),
      JSON.stringify({ ok: r2.ok, error: r2.error, ids: store.local.blocklist.ids }));

    globalThis.CB_POINTER_KEY = hadKey;
    chrome.permissions.contains = hadPermission;
  }

  // Forced config migration, rev 3: a clean slate. Every install below the rev
  // has its synced settings returned to the shipped defaults and its local
  // storage wiped -- except the keys whose loss would cost the person
  // something (reporting identity, unsent reports, who is already blocked,
  // the worker's own tab, the tour flag) -- and the rev is stamped so it
  // happens exactly once per device.
  {
    const migrate = globalThis.CB_MIGRATE_CONFIG;
    const D = globalThis.CB_DEFAULT_SETTINGS;
    const SECRET = 'ab'.repeat(32);

    // (a) an upgraded install: a rev-2 stamp, frozen URLs and customised caps
    // in sync, and a full set of local state including the junk template that
    // broke Facebook blocking on 1.0.4.
    store.local = {
      configRev: 2,
      learnedTemplate_facebook: { friendlyName: 'RTWebCallBlockSettingHooksQuery', docId: '9989124061109700' },
      learnedTemplate_threads: { friendlyName: 'useTHUserBlockMutation', docId: '26803837702651619' },
      learnedDocIds: { threads: { useTHUserBlockMutation: '26803837702651619' } },
      docIdOverrides: { useTHUserBlockMutation: '26803837702651619' },
      blocklist: { ids: ['1'], usernames: [] }, platformQueue: { facebook: [{ id: '2' }] },
      stats: { attempts: 37 }, aliasMap: { a: 1 }, idNames: { b: 2 }, backendHosts: { hosts: ['x'] },
      failures: {}, leases: {}, cooldowns: {}, blockLog: [{ id: '3' }], reportedCache: { k: 1 },
      reporterSecret: SECRET, reportOutbox: [{ key: 'threads:9', payload: {}, tries: 0 }],
      platformDone: { threads: ['4'] }, ownWorkTab: { id: 7 }, welcomedAt: 123
    };
    store.sync = { settings: {
      listUrl: 'https://cloneblocker.tree55.com/blocklist.json',
      apiBase: 'https://my.own.server/v1', maxBlocksPerHour: 15, platformBlockEnabled: false } };
    await migrate();
    check('migration returns synced settings to the shipped defaults wholesale',
      JSON.stringify(store.sync.settings) === '{}', JSON.stringify(store.sync.settings));
    const kept = Object.keys(store.local).sort().join(',');
    check('migration wipes local storage except identity, outbox, done list, own tab and tour flag',
      kept === 'configRev,ownWorkTab,platformDone,reportOutbox,reporterSecret,welcomedAt', kept);
    check('the kept keys are kept intact',
      store.local.reporterSecret === SECRET && store.local.reportOutbox.length === 1 &&
      store.local.platformDone.threads[0] === '4' && store.local.ownWorkTab.id === 7 &&
      store.local.welcomedAt === 123,
      JSON.stringify({ outbox: store.local.reportOutbox, done: store.local.platformDone }));
    check('migration stamps the rev so it does not run twice',
      store.local.configRev === 3, String(store.local.configRev));
    const s = await send('sw:get-settings');
    check('settings read after the wipe are the shipped defaults',
      s.ok && s.settings.listUrl === D.listUrl && s.settings.apiBase === D.apiBase &&
      s.settings.maxBlocksPerHour === D.maxBlocksPerHour &&
      s.settings.platformBlockEnabled === D.platformBlockEnabled,
      JSON.stringify({ listUrl: s.settings.listUrl, apiBase: s.settings.apiBase,
                       hour: s.settings.maxBlocksPerHour, on: s.settings.platformBlockEnabled }));

    // (b) a second run at the current rev changes nothing, settings or data.
    store.sync.settings = { apiBase: 'https://someone.example/v1' };
    store.local.blocklist = { ids: ['5'], usernames: [] };
    await migrate();
    check('a migration already at the current rev is a no-op',
      store.sync.settings.apiBase === 'https://someone.example/v1' &&
      store.local.blocklist.ids[0] === '5',
      JSON.stringify({ apiBase: store.sync.settings.apiBase, list: store.local.blocklist }));

    // (c) a fresh install has nothing to wipe and is simply stamped, with
    // nothing frozen into sync.
    store.local = {}; store.sync = {};
    await migrate();
    check('a fresh install is stamped and left with nothing frozen',
      store.local.configRev === 3 && Object.keys(store.local).length === 1 &&
      JSON.stringify(store.sync.settings) === '{}',
      JSON.stringify({ local: store.local, sync: store.sync }));
  }

  // A private list credential must reach ONLY the self-hosted primary, never a
  // fallback candidate. The compiled fallbacks include the author's own origin,
  // which is host-permissioned — so a leaked Authorization would arrive there
  // with no CORS preflight to stop it.
  {
    const PRIMARY = 'https://my.private.list/blocklist.json';
    const MIRROR = 'https://cdn.example/blocklist.json';
    const seen = [];
    global.fetch = async (u, opts) => {
      seen.push({ url: String(u), auth: ((opts || {}).headers || {}).authorization || null });
      if (String(u) === PRIMARY) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => '{}', json: async () => ({}) };
    };
    const hadPermission = chrome.permissions.contains;
    chrome.permissions.contains = async () => true;   // self-hoster granted their own host
    await reset();
    await setSettings({ listUrl: PRIMARY, listAuthHeader: 'Bearer secret123' });
    store.local.backendHosts = { hosts: ['my.private.list'], listMirrors: [MIRROR], at: Date.now() };
    await send('sw:refresh-now');
    const primaryCall = seen.find(c => c.url === PRIMARY);
    const leaked = seen.filter(c => c.url !== PRIMARY && c.auth);
    check('a private list credential is sent to the self-hosted primary',
      !!primaryCall && primaryCall.auth === 'Bearer secret123',
      JSON.stringify(primaryCall));
    check('and never to any fallback candidate (origin, mirrors, relay)',
      leaked.length === 0, JSON.stringify(leaked));
    chrome.permissions.contains = hadPermission;
  }

  // An unchanged list on a SCHEDULED (non-forced) refresh short-circuits: the
  // GitHub default cannot use an HTTP 304 (its ETag is not exposed over CORS),
  // so the signed payload's updatedAt stands in. The reprocess-and-broadcast
  // tail — including re-seeding cold targets — must be skipped when the list
  // has not changed, and must still run when it has.
  {
    const URL = 'https://cdn.example/blocklist.json';
    const withTargets = (updatedAt) => ({ v: 2, updatedAt, ids: ['7300000001'],
      usernames: [], targets: [{ platform: 'threads', id: '7300000002', rank: 1 }] });
    let served;
    global.fetch = async (u) => (String(u) === URL)
      ? { ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify(served), json: async () => served }
      : { ok: true, status: 200, headers: { get: () => null },
          text: async () => '{}', json: async () => ({}) };

    // The refresh alarm kicks refreshBlocklist(false) off fire-and-forget, so
    // settle after each fire before reading the queue.
    const settle = () => new Promise(r => setTimeout(r, 80));

    await reset({ platformBlockEnabled: true, maxColdBlocksPerHour: 50 });
    await setSettings({ listUrl: URL, mode: 'active' });
    served = withTargets('2026-08-27T10:00:00.000Z');
    await send('sw:refresh-now');                          // forced: full reprocess, seeds the target
    const seededFirst = ((store.local.platformQueue || {}).threads || []).length;
    store.local.platformQueue = {};                        // clear it
    await alarmHandler({ name: 'cb-refresh-blocklist' });  // scheduled, SAME updatedAt
    await settle();
    const afterUnchanged = ((store.local.platformQueue || {}).threads || []).length;
    check('an unchanged scheduled refresh skips the reprocess tail (no re-seed)',
      seededFirst >= 1 && afterUnchanged === 0,
      JSON.stringify({ seededFirst, afterUnchanged }));

    served = withTargets('2026-08-27T11:00:00.000Z');      // a genuinely newer list
    await alarmHandler({ name: 'cb-refresh-blocklist' });  // scheduled, CHANGED updatedAt
    await settle();
    const afterChanged = ((store.local.platformQueue || {}).threads || []).length;
    check('a changed scheduled refresh does reprocess and re-seed',
      afterChanged >= 1, JSON.stringify({ afterChanged }));
  }

  // These drive the real refresh/submit/status handlers with fetch stubbed.
  {
    const FS_URL = 'http://127.0.0.1:8080/blocklist.json';
    const today = new Date().toISOString().slice(0, 10);
    const old10 = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const published = {
      v: 1, updatedAt: new Date().toISOString(),
      ids: ['4100000001', '4100000002', '63082166531'],
      usernames: ['threads'],
      // One real-looking hot patch and two that are not: a value that is not
      // a doc_id, and a key that is not an operation name.
      docIdOverrides: { useBlockMutation: '7123456789012345', probe: 'x', 'bad key': '123456' },
      pending: ['threads:@maybe.clone'],
      // Covers every listed id, including the ones no ranked target record
      // was kept for. That is the whole point of it.
      idNames: {
        threads: {
          '63082166531': { u: 'unranked.clone', d: 'Unranked Clone' },
          '4100000001': { u: 'fresh.clone', d: 'Fresh Clone' }
        }
      },
      targets: [
        // Fresh + active vs stale + idle, equal trust. The fresh one must win
        // in EVERY region: worst-case locality 0.25 gives 2*1*(1+3)*0.25 = 2,
        // the stale one at best 2*0.5^(10/7)*1*1 ~= 0.74 -- so the assertion
        // holds no matter what timezone the test machine is in.
        { platform: 'threads', id: '4100000002', trust: 2, last: old10,
          username: 'stale.clone', displayName: null,
          days: {}, regions: { 'America/Sao_Paulo': 2 }, langs: { 'pt-br': 2 } },
        { platform: 'threads', id: '4100000001', trust: 2, last: today,
          username: 'fresh.clone', displayName: 'Fresh Clone',
          days: { [today]: 3 }, regions: { 'Asia/Ho_Chi_Minh': 3 }, langs: { 'vi-vn': 3 } }
      ]
    };
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts: opts || {} });
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(published),
        json: async () => published
      };
    };

    await reset({ maxColdBlocksPerHour: 50, platformBlockEnabled: true });
    await setSettings({ listUrl: FS_URL });
    const r = await send('sw:refresh-now');
    // Drain the unawaited pointer walk before reading the request log.
    await new Promise(res => setTimeout(res, 25));
    check('the published list decodes',
      r.ok && r.blocklist && r.blocklist.ids.length === 3 &&
      r.blocklist.usernames.includes('threads'),
      JSON.stringify(r.blocklist && r.blocklist.ids));
    // The published list is the one name source that arrives without anybody
    // having laid eyes on the account. It has to be read whatever the user's
    // switches say: whether they want the list WORKED THROUGH is a different
    // question from whether Activity may say who an account is.
    check('a refresh learns the names the list carries',
      store.local.idNames &&
      store.local.idNames['threads:4100000001'] &&
      store.local.idNames['threads:4100000001'].u === 'fresh.clone' &&
      store.local.idNames['threads:4100000001'].d === 'Fresh Clone' &&
      store.local.idNames['threads:4100000002'].u === 'stale.clone',
      JSON.stringify(store.local.idNames || {}));
    check('a target with no display name is not given an empty one',
      store.local.idNames &&
      store.local.idNames['threads:4100000002'].d === null,
      JSON.stringify((store.local.idNames || {})['threads:4100000002']));

    // The gap this closed: `targets` is a ranked slice, so an id on the list
    // but outside that slice had no name anywhere and the history showed a
    // bare number for an account somebody had actually blocked.
    check('a listed id outside the ranked slice still learns its name',
      store.local.idNames &&
      store.local.idNames['threads:63082166531'] &&
      store.local.idNames['threads:63082166531'].u === 'unranked.clone' &&
      store.local.idNames['threads:63082166531'].d === 'Unranked Clone',
      JSON.stringify((store.local.idNames || {})['threads:63082166531']));

    // The list URL must be byte-identical for every install: a per-user query
    // string is the difference between an edge-cached 304 and a fresh transfer
    // per install per poll, and it would put the reader's timezone in
    // somebody's HTTP logs for nothing. PRIVACY.md promises the poll says
    // nothing about you, and this is the assertion behind that sentence.
    // The pointer walk that rides the refresh is held to the same standard:
    // its urls are compiled constants, so anything else in the log is a leak.
    {
      const pointerUrls = globalThis.CB_POINTER_URLS || [];
      const listCalls = calls.filter(c => c.url === FS_URL);
      check('the list URL describes nobody',
        listCalls.length === 1 &&
        calls.every(c => c.url === FS_URL || pointerUrls.includes(c.url)),
        JSON.stringify(calls.map(c => c.url)));
    }

    // The exact bug this was: names were read out of the array the worker
    // rebuilds for the QUEUE, which is only populated when list blocking is
    // on -- and which had dropped the name fields anyway.
    {
      store.local.idNames = {};
      await setSettings({ blockFromList: false });
      await send('sw:refresh-now');
      const learned = store.local.idNames || {};
      check('names are learned even with list blocking switched off',
        learned['threads:4100000001'] && learned['threads:4100000001'].u === 'fresh.clone',
        JSON.stringify(learned));
      check('and no cold targets are queued while it is off',
        !(store.local.blocklist.targets || []).length,
        JSON.stringify((store.local.blocklist.targets || []).length));
      await setSettings({ blockFromList: true });
    }

    check('published metadata is ranked locally, freshest and most active first',
      r.blocklist.targets.length === 2 &&
      r.blocklist.targets[0].id === '4100000001' &&
      typeof r.blocklist.targets[0].rank === 'number' &&
      r.blocklist.targets[0].rank > r.blocklist.targets[1].rank,
      JSON.stringify(r.blocklist.targets.map(t => [t.id, t.rank])));
    check('the why fields survive local ranking',
      r.blocklist.targets[0].why &&
      r.blocklist.targets[0].why.velocity7d === 3 &&
      typeof r.blocklist.targets[0].why.region === 'number',
      JSON.stringify(r.blocklist.targets[0].why));
    // Inverted deliberately. The list used to carry every reported-but-
    // unreviewed key so the chip could say "already reported" about somebody
    // else's report -- which published an unreviewed accusation to a document
    // anyone on the internet can read, filed by anyone, with no account.
    check('an unreviewed accusation is not cached from the list',
      !r.blocklist.pending || r.blocklist.pending.length === 0,
      JSON.stringify(r.blocklist.pending));
    check('docIdOverrides still hot-patch through the published list',
      (store.local.docIdOverrides || {}).useBlockMutation === '7123456789012345',
      JSON.stringify(store.local.docIdOverrides));
    // The map selects which GraphQL operation the page-world code calls
    // against Meta and with what doc_id, and it arrives from the network. It
    // was stored with no check at all; now only operation-shaped keys with
    // numeric doc_ids survive -- here, where the list is read, as well as
    // where it is published and where the page consumes it.
    check('and anything in the map that is not an operation with a numeric doc_id is dropped',
      !('probe' in (store.local.docIdOverrides || {})) &&
      !('bad key' in (store.local.docIdOverrides || {})) &&
      Object.keys(store.local.docIdOverrides || {}).length === 1,
      JSON.stringify(store.local.docIdOverrides));

    const st = await state();
    const queued = (st.queue.threads || []).map(e => (typeof e === 'string' ? e : e.id));
    check('locally-ranked targets are seeded into the cold queue',
      queued.includes('4100000001') && queued.includes('4100000002'),
      JSON.stringify(queued));

    // Status answers come from the cached document, no network at all.
    calls.length = 0;
    const stat1 = await send('sw:report-status',
      { platform: 'threads', profileId: '4100000001', force: true });
    check('an approved id answers blocked from the cached list, no fetch',
      stat1.ok && stat1.blocked === true && stat1.status === 'approved' && calls.length === 0,
      JSON.stringify(stat1));
    // A target this browser has never reported is simply unknown -- not
    // "pending", which would be repeating a stranger's accusation.
    const stat2 = await send('sw:report-status',
      { platform: 'threads', username: 'maybe.clone', force: true });
    check('somebody else’s report is not something we claim to know about',
      stat2.ok && stat2.blocked === false && stat2.status === null,
      JSON.stringify(stat2));

    // But our own submission still shows as pending afterwards, and keeps
    // showing -- that is the half of the chip worth having, and it needs no
    // public list to work.
    {
      store.local.reportedCache = { 'threads:@maybe.clone':
        { status: 'pending', count: 1, blocked: false, at: 1 } };   // long stale
      const mine = await send('sw:report-status',
        { platform: 'threads', username: 'maybe.clone', force: true });
      check('our own report still reads pending, however old the record',
        mine.ok && mine.status === 'pending', JSON.stringify(mine));
      delete store.local.reportedCache;
    }

    // Submitting a report is a POST to the API, which owns dedup.
    calls.length = 0;
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts: opts || {} });
      return { ok: true, status: 201, headers: { get: () => null },
               text: async () => '{"ok":true}', json: async () => ({ ok: true }) };
    };
    const sub = await send('sw:submit-report', {
      platform: 'threads', profileId: '9990001111', username: 'Fake.Person',
      displayName: 'x'.repeat(300), reason: 'clone', note: 'they copied me',
      viewerId: '2904880000'
    });
    const call = calls[0];
    const sent = call && JSON.parse(call.opts.body);
    check('the report is posted to the reports endpoint',
      sub.ok && call && /\/v1\/reports$/.test(call.url) &&
      call.opts.method === 'POST', call && call.url);
    // Dedup moved to the server, where it is a unique index on
    // (pseudonym, platform, target). Deriving a document id from the reporter
    // and probing for it was an existence oracle -- see SECURITY-REVIEW 2.3 --
    // and the client no longer knows how dedup is done, which is the point.
    check('the pseudonym is sent, and the URL carries no derived key',
      sent && /^acct_[0-9a-f]{24}$/.test(sent.pseudonym) &&
      !call.url.includes('documentId') && !call.url.includes(sent.pseudonym),
      call && call.url);
    check('the raw viewer id appears nowhere in the write',
      call && !call.opts.body.includes('2904880000'), 'checked body');
    // Clipped by the CLIENT to the server's caps. The server's schema rejects
    // an over-long field rather than trimming it, so sending it raw would cost
    // the whole report over an unusually long display name.
    check('fields are clipped to the caps the server enforces',
      sent && sent.targetName.length === 120 &&
      sent.targetUser === 'fake.person',
      sent && String(sent.targetName.length));

    // The server answers a repeat with 200 and says so, rather than making the
    // client infer it from a conflict status.
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null },
      text: async () => '{"ok":true,"duplicate":true}',
      json: async () => ({ ok: true, duplicate: true }) });
    const dup = await send('sw:submit-report', {
      platform: 'threads', profileId: '9990001111', viewerId: '2904880000'
    });
    check('a create conflict is reported as a duplicate, not an error',
      dup.ok && dup.duplicate === true, JSON.stringify(dup));

    // -- the pseudonym is keyed with a secret this install minted ---------
    //
    // It was an unkeyed SHA-256 of platform:accountId. Account ids are public
    // and enumerable, so (a) anyone holding the report store could recover
    // reporters by hashing candidates, and (b) because creates were open and
    // the document id was platform~target~pseudonym, a stranger could learn
    // whether a given account had reported a given target from the response
    // code of a create they had no business making. Keying the hash with a
    // per-install secret closes the first; server-side dedup closed the second
    // by removing the derived id altogether. Both still matter: the raw viewer
    // id must never reach a server, whoever runs it.
    const secret = store.local.reporterSecret;
    check('a reporter secret is minted on first use and kept locally',
      typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret),
      String(secret).slice(0, 12) + '…');
    const unkeyed = 'acct_' + require('crypto').createHash('sha256')
      .update('threads:2904880000').digest('hex').slice(0, 24);
    const keyed = sent.pseudonym;
    check('the pseudonym is not the unkeyed hash of the account id',
      keyed !== unkeyed && /^acct_[0-9a-f]{24}$/.test(keyed), keyed + ' vs ' + unkeyed);
    check('and never leaves the machine with the report',
      !call.opts.body.includes(secret) && !call.url.includes(secret), 'checked body and url');

    const again = [];
    global.fetch = async (url, opts) => {
      again.push({ url: String(url), opts });
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => '{}', json: async () => ({}) };
    };
    await send('sw:submit-report', { platform: 'threads', profileId: '9990002222', viewerId: '2904880000' });
    check('the same install and account get the same pseudonym on every report',
      again[0] && JSON.parse(again[0].opts.body).pseudonym === keyed,
      again[0] && JSON.parse(again[0].opts.body).pseudonym);

    // A reinstall (or cleared storage) is a fresh secret, and so a fresh
    // pseudonym -- the stated price of a pseudonym that is a function of
    // nothing public. The worker reads the secret from storage on every
    // report rather than remembering it, which is what makes this a test of
    // the worker and not of the mock.
    delete store.local.reporterSecret;
    again.length = 0;
    await send('sw:submit-report', { platform: 'threads', profileId: '9990003333', viewerId: '2904880000' });
    const minted = store.local.reporterSecret;
    const remade = again[0] && JSON.parse(again[0].opts.body).pseudonym;
    check('a cleared secret is minted again, and the pseudonym changes with it',
      /^[0-9a-f]{64}$/.test(String(minted)) && minted !== secret &&
      remade !== keyed && /^acct_[0-9a-f]{24}$/.test(String(remade)),
      String(remade));
    store.local.reporterSecret = secret;

    // -- the list and the API are two paths to one backend -----------------
    //
    // The list is a static file so that a poll costs a 304 and no database
    // work; reports go to the API because they are the one thing that needs a
    // server able to see who is asking. Both are the same origin now, and the
    // point of this test is that the busy path and the write path stay
    // separate: reading the list must never touch the API.
    await setSettings({
      listUrl: 'https://demo.example/blocklist.json',
      apiBase: 'https://demo.example/v1'
    });
    const splitCalls = [];
    global.fetch = async (url, opts) => {
      splitCalls.push(String(url));
      return { ok: true, status: 201, headers: { get: () => null },
               text: async () => '{"ok":true}', json: async () => ({ ok: true }) };
    };
    const splitSub = await send('sw:submit-report', {
      platform: 'threads', profileId: '9990005555', viewerId: '2904880000'
    });
    check('a report goes to the API and nowhere near the list file',
      splitSub.ok && splitCalls.length === 1 &&
      splitCalls[0] === 'https://demo.example/v1/reports',
      splitCalls[0]);

    delete global.fetch;
  }
  // -- 13c. reports that used to be destroyed --------------------------------
  //
  // On Threads a profile is a handle, never a numeric id: the id can only come
  // from an alias cache that a MAIN-world sweep fills opportunistically, so it
  // is missing whenever that sweep has not happened to see the account. Every
  // one of those reports used to be sent with an empty targetId, refused with
  // a 400, and dropped -- after the sheet had already said "Sent".
  {
    await reset({ platformBlockEnabled: false });
    await setSettings({ apiBase: 'https://demo.example/v1' });

    const bodies = [];
    global.fetch = async (url, opts) => {
      bodies.push(JSON.parse((opts || {}).body || '{}'));
      return { ok: true, status: 201, headers: { get: () => null },
               text: async () => '{"ok":true}', json: async () => ({ ok: true }) };
    };

    const noId = await send('sw:submit-report', {
      platform: 'threads', profileId: null, username: 'Some.Clone',
      reason: 'clone', viewerId: '2904880000'
    });
    check('a Threads report with no numeric id is filed against the handle',
      noId.ok && bodies[0] && bodies[0].targetId === '@some.clone',
      JSON.stringify(bodies[0] && bodies[0].targetId));
    check('and the handle is normalised, so one account is one target',
      bodies[0] && bodies[0].targetUser === 'some.clone',
      JSON.stringify(bodies[0] && bodies[0].targetUser));

    // The prefix is not decoration: the server decides which kind of target it
    // has by shape, so an all-digit handle must not be filed as a profile id.
    bodies.length = 0;
    await send('sw:submit-report', {
      platform: 'threads', profileId: null, username: '12345678',
      reason: 'clone', viewerId: '2904880000'
    });
    check('an all-digit handle is still filed as a handle, not as an id',
      bodies[0] && bodies[0].targetId === '@12345678',
      JSON.stringify(bodies[0] && bodies[0].targetId));

    // A numeric id, when there is one, is still what the report is filed
    // against -- the fallback must not have taken over the normal case.
    bodies.length = 0;
    await send('sw:submit-report', {
      platform: 'threads', profileId: '9990007777', username: 'has.an.id',
      reason: 'clone', viewerId: '2904880000'
    });
    check('a report that HAS an id is still filed against the id',
      bodies[0] && bodies[0].targetId === '9990007777',
      JSON.stringify(bodies[0] && bodies[0].targetId));

    // The chip on a profile reads reportedCache through reportKeyFor. The
    // cache used to be written under the id alone, so a handle-only report
    // stored itself as 'threads:' and the profile the person had just
    // reported went on saying nothing had happened.
    const cached = Object.keys(store.local.reportedCache || {});
    check('a handle-only report is cached where the status lookup will find it',
      cached.includes('threads:@some.clone') && !cached.includes('threads:'),
      JSON.stringify(cached));

    delete global.fetch;
  }

  // -- 13d. a refusal is kept, not binned ------------------------------------
  {
    await reset({ platformBlockEnabled: false });
    await setSettings({ apiBase: 'https://demo.example/v1' });

    // The exact failure the bug produced: the server refuses with a 400.
    global.fetch = async () => ({
      ok: false, status: 400, headers: { get: () => null },
      text: async () => '{"error":"bad_target"}',
      json: async () => ({ error: 'bad_target' })
    });

    const refused = await send('sw:submit-report', {
      platform: 'threads', profileId: null, username: 'refused.one',
      reason: 'clone', viewerId: '2904880000'
    });
    const box = store.local.reportOutbox || [];
    check('a refused report is kept rather than dropped on the floor',
      box.length === 1 && box[0].key === 'threads:@refused.one' &&
      box[0].why === 'refused:400',
      JSON.stringify(box.map(e => [e.key, e.why])));
    check('and the caller is told it is queued, not that it failed',
      refused.ok === true && refused.queued === true && refused.status === 'queued',
      JSON.stringify(refused));

    // The second, independent bug: every id-less target keyed itself
    // 'threads:' and the de-duplication threw away all but the first.
    await send('sw:submit-report', {
      platform: 'threads', profileId: null, username: 'refused.two',
      reason: 'clone', viewerId: '2904880000'
    });
    const two = store.local.reportOutbox || [];
    check('two different handle-only targets are two outbox entries, not one',
      two.length === 2 &&
      two.map(e => e.key).sort().join(',') ===
        'threads:@refused.one,threads:@refused.two',
      JSON.stringify(two.map(e => e.key)));

    // De-duplication still has to work; it just has to key on the right thing.
    await send('sw:submit-report', {
      platform: 'threads', profileId: null, username: 'refused.two',
      reason: 'clone', viewerId: '2904880000'
    });
    check('but the same target reported twice is still one entry',
      (store.local.reportOutbox || []).length === 2,
      String((store.local.reportOutbox || []).length));

    delete global.fetch;
  }

  // -- 13d-2. a refusal that will never become an acceptance -----------------
  //
  // The counterpart to 13d, and the line between them is the status code. A 400
  // may be transient from the client's side and must be kept. A 403 is not
  // "not yet", it is "not you": retrying earned the same answer six times over
  // about thirty-six hours, and then put the server's own English token on the
  // badge of somebody reading Vietnamese.
  {
    await reset({ platformBlockEnabled: false });
    await setSettings({ apiBase: 'https://demo.example/v1' });

    let calls = 0;
    global.fetch = async () => {
      calls++;
      return {
        ok: false, status: 403, headers: { get: () => null },
        text: async () => '{"error":"reporter_blocked"}',
        json: async () => ({ error: 'reporter_blocked' })
      };
    };

    const out = await send('sw:submit-report', {
      platform: 'threads', profileId: '4440001111', username: 'forbidden.one',
      reason: 'clone', viewerId: '2904880000'
    });
    check('a 403 is not queued for retry',
      (store.local.reportOutbox || []).length === 0,
      JSON.stringify((store.local.reportOutbox || []).map(e => e.why)));
    check('and the caller is told it failed rather than that it is queued',
      out.ok === false && out.status === 403 && !out.queued,
      JSON.stringify(out));

    const alerts = (await send('sw:alerts-get')).alerts || [];
    check('it is surfaced once, not silently dropped',
      alerts.length === 1 && alerts[0].key === 'threads:4440001111',
      JSON.stringify(alerts.map(a => a.key)));
    // The whole point: what reaches the badge is a sentence, not a protocol
    // token the server happened to choose.
    check('and what reaches the badge is a translated sentence, not a raw token',
      alerts[0] && alerts[0].detail !== 'reporter_blocked' &&
      /\S/.test(alerts[0].detail || ''),
      JSON.stringify(alerts[0] && alerts[0].detail));

    // Draining the outbox must not resurrect it either -- there is nothing to
    // drain, so nothing may be sent.
    const before = calls;
    await send('sw:flush-outbox').catch(() => null);
    check('flushing the outbox sends nothing, because nothing was kept',
      calls === before, String(calls - before));

    delete global.fetch;
  }

  // -- 13e. a report with nothing to file against ----------------------------
  {
    await reset({ platformBlockEnabled: false });
    await setSettings({ apiBase: 'https://demo.example/v1' });
    let called = 0;
    global.fetch = async () => {
      called++;
      return { ok: true, status: 201, headers: { get: () => null },
               text: async () => '{"ok":true}', json: async () => ({ ok: true }) };
    };

    const nothing = await send('sw:submit-report', {
      platform: 'threads', profileId: null, username: '',
      reason: 'clone', viewerId: '2904880000'
    });
    check('a report naming no account at all is refused without a request',
      !nothing.ok && called === 0,
      JSON.stringify(nothing) + ' calls=' + called);
    check('and it raises an alert rather than failing into a void',
      Object.keys(store.local.actionAlerts || {}).length === 1,
      JSON.stringify(store.local.actionAlerts || {}));

    delete global.fetch;
  }

  // -- 14b. the activity ledger ---------------------------------------------
  //
  // Every attempt is recorded with what was known about the target at the
  // time -- rank and why come from the queue entry and the published metadata,
  // both of which are gone from the queue the moment a block succeeds.
  {
    await reset({ maxColdBlocksPerHour: 50 });
    store.local.blocklist = { ids: [], usernames: [], pending: [],
      targets: [{ id: '7500000001', platform: 'facebook', rank: 4.2,
                  why: { trust: 1.5, recentDays: 0, velocity7d: 3, region: 0.8, lang: 0.8 } }],
      fetchedAt: Date.now(), source: 'x', count: 0 };
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: [{ id: '7500000001', rank: 4.2 }], warm: false });
    openGate();
    const c = await send('sw:queue-claim', { platform: 'facebook' });
    await send('sw:queue-result',
      { platform: 'facebook', target: c.target, ok: true, dryRun: false, warm: false });
    const log1 = store.local.blockLog || [];
    check('a successful block lands in the ledger with its rank and why',
      log1.length === 1 && log1[0].ok && log1[0].rank === 4.2 &&
      log1[0].why && log1[0].why.velocity7d === 3 && log1[0].warm === false,
      JSON.stringify(log1[0]));

    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7500000002'], warm: true });
    openGate();
    const c2 = await send('sw:queue-claim', { platform: 'facebook' });
    await send('sw:queue-result',
      { platform: 'facebook', target: c2.target, ok: false, dryRun: false, warm: true, detail: 'no mutation' });
    const log2 = store.local.blockLog || [];
    check('a failure is recorded with its detail, newest first',
      log2.length === 2 && !log2[0].ok && log2[0].detail === 'no mutation' && log2[0].warm === true,
      JSON.stringify(log2[0]));

    const st = await state();
    check('the ledger rides along in sw:get-state for the activity page',
      Array.isArray(st.blockLog) && st.blockLog.length === 2 &&
      st.cooldowns !== undefined && st.failures !== undefined,
      'blockLog=' + (st.blockLog || []).length);
  }

  // -- 15. the conditional poll ---------------------------------------------
  //
  // Every installation polls the list every ten minutes, so what an UNCHANGED
  // poll costs decides whether the interval is affordable at all. The list is
  // a static file with a strong ETag: the worker keeps it and sends
  // If-None-Match, and an unchanged list answers 304 with no body. The stored
  // copy must survive that untouched apart from its timestamp -- a 304 that
  // quietly emptied the list would unblock everybody at once.
  //
  // The conditional path lives on the NON-forced route, which only the alarm
  // reaches, so these fire the captured alarm listener.
  {
    const URL_ = 'https://demo.example/blocklist.json';
    const ALARM = { name: 'cb-refresh-blocklist' };
    const tick = () => new Promise(r => setTimeout(r, 120));
    const listBody = (ids) => ({
      v: 1, ids, usernames: [], docIdOverrides: {}, pending: [], targets: []
    });

    await reset({ maxColdBlocksPerHour: 50 });
    await setSettings({ listUrl: URL_ });

    let calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), headers: ((opts || {}).headers) || {} });
      return { ok: true, status: 200,
               headers: { get: (h) => (h.toLowerCase() === 'etag' ? '"v1"' : null) },
               text: async () => JSON.stringify(listBody(['4200000001'])),
               json: async () => listBody(['4200000001']) };
    };
    await send('sw:refresh-now');
    check('the first poll keeps the ETag the server sent',
      store.local.blocklist && store.local.blocklist.etag === '"v1"',
      JSON.stringify(store.local.blocklist && store.local.blocklist.etag));

    // An unchanged list: 304, no body, and the stored copy must not be harmed.
    calls = [];
    const wasAt = store.local.blocklist.fetchedAt;
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), headers: ((opts || {}).headers) || {} });
      return { ok: false, status: 304, headers: { get: () => null },
               text: async () => '', json: async () => ({}) };
    };
    await tick();
    await alarmHandler(ALARM);
    await tick();
    check('an unchanged poll sends If-None-Match',
      calls.length === 1 && calls[0].headers['if-none-match'] === '"v1"',
      JSON.stringify(calls[0] && calls[0].headers));
    check('and a 304 leaves the list intact, touching only the timestamp',
      store.local.blocklist.ids.length === 1 &&
      store.local.blocklist.ids[0] === '4200000001' &&
      store.local.blocklist.etag === '"v1"' &&
      store.local.blocklist.fetchedAt >= wasAt,
      JSON.stringify(store.local.blocklist.ids));

    // A changed list replaces it, and the new ETag is kept.
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'etag' ? '"v2"' : null) },
      text: async () => JSON.stringify(listBody(['4200000001', '4200000002'])),
      json: async () => listBody(['4200000001', '4200000002'])
    });
    await tick();
    await alarmHandler(ALARM);
    await tick();
    check('a changed list is taken, with its new ETag',
      store.local.blocklist.ids.length === 2 && store.local.blocklist.etag === '"v2"',
      JSON.stringify(store.local.blocklist.ids) + ' ' + store.local.blocklist.etag);

    delete global.fetch;
  }

  // -- 15b. the signed list, and the mirrors it makes safe ------------------
  //
  // The blocklist is the product's whole value, and a tool for reporting
  // state-aligned accounts should assume its domain gets blocked. So the list
  // can be read from mirrors the pointer names -- and the ONLY thing that
  // makes a mirror safe is that the list it serves carries a signature this
  // build can verify. These are the assertions behind that sentence: signed
  // and valid is accepted from anywhere; signed and invalid is refused from
  // anywhere; unsigned is accepted from the primary alone; and a mirror may
  // never roll the cache back.
  {
    const crypto = require('crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' })
      .subarray(-32).toString('base64url');
    const signed = (payload) => ({
      payload,
      sig: crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64url'),
      alg: 'ed25519'
    });
    const body = (o) => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify(o), json: async () => o
    });
    const down = async () => { throw new Error('ECONNREFUSED'); };
    const list = (ids, updatedAt) => ({
      v: 2, updatedAt, ids, usernames: [], docIdOverrides: {}, pending: [], targets: []
    });

    const PRIMARY = 'https://primary.example/blocklist.json';
    const MIRROR = 'https://mirror.example/blocklist.json';
    const T0 = '2026-08-22T10:00:00.000Z';
    const T1 = '2026-08-22T11:00:00.000Z';

    const pinned = globalThis.CB_POINTER_KEY;
    globalThis.CB_POINTER_KEY = pubRaw;
    await reset({ maxColdBlocksPerHour: 50 });
    await setSettings({ listUrl: PRIMARY });
    store.local.backendHosts = { hosts: ['primary.example'], listMirrors: [MIRROR], at: Date.now() };

    // (a) signed and valid from the primary
    let calls = [];
    global.fetch = async (url) => { calls.push(String(url)); return body(signed(list(['5000000001'], T0))); };
    let r = await send('sw:refresh-now');
    check('a signed list from the primary is unwrapped and accepted',
      r.ok && store.local.blocklist.ids.length === 1 &&
      store.local.blocklist.ids[0] === '5000000001' &&
      store.local.blocklist.verified === true &&
      store.local.blocklist.source === PRIMARY,
      JSON.stringify({ ok: r.ok, ids: store.local.blocklist.ids, verified: store.local.blocklist.verified }));

    // (b) tampered: the signature covers the payload, so one extra id breaks it
    const forged = signed(list(['5000000001'], T1));
    forged.payload.ids.push('6660000666');
    global.fetch = async () => body(forged);
    r = await send('sw:refresh-now');
    check('a tampered list is refused and the cache is untouched',
      !r.ok && store.local.blocklist.ids.length === 1 &&
      !store.local.blocklist.ids.includes('6660000666'),
      JSON.stringify({ ok: r.ok, error: r.error, ids: store.local.blocklist.ids }));

    // (c) primary down, mirror serves signed and newer
    calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url) === PRIMARY) return down();
      return body(signed(list(['5000000001', '5000000002'], T1)));
    };
    r = await send('sw:refresh-now');
    check('with the primary down, a signed list from a mirror is accepted',
      r.ok && store.local.blocklist.ids.length === 2 &&
      store.local.blocklist.source === MIRROR && store.local.blocklist.verified === true &&
      calls[0] === PRIMARY && calls[1] === MIRROR,
      JSON.stringify({ ok: r.ok, source: store.local.blocklist.source, calls }));

    // (d) primary down, mirror serves an UNSIGNED list
    global.fetch = async (url) => String(url) === PRIMARY ? down()
      : body(list(['5000000001', '5000000002', '9999999999'], '2026-08-22T12:00:00.000Z'));
    r = await send('sw:refresh-now');
    check('a mirror serving an unsigned list is refused, however fresh',
      !r.ok && store.local.blocklist.ids.length === 2 &&
      !store.local.blocklist.ids.includes('9999999999'),
      JSON.stringify({ ok: r.ok, error: r.error, ids: store.local.blocklist.ids }));

    // (e) primary down, mirror serves signed but OLDER than the cache
    global.fetch = async (url) => String(url) === PRIMARY ? down()
      : body(signed(list(['5000000001'], T0)));
    r = await send('sw:refresh-now');
    check('a mirror may never roll the cache back, even with a valid signature',
      r.ok && r.unchanged && r.stale === MIRROR &&
      store.local.blocklist.ids.length === 2,
      JSON.stringify({ ok: r.ok, unchanged: r.unchanged, stale: r.stale, ids: store.local.blocklist.ids.length }));

    // (f) the primary may roll back: a server restored from backup is legitimate
    global.fetch = async () => body(signed(list(['5000000001'], T0)));
    r = await send('sw:refresh-now');
    check('the primary is allowed to go backwards -- a restore from backup must work',
      r.ok && !r.unchanged && store.local.blocklist.ids.length === 1,
      JSON.stringify({ ok: r.ok, ids: store.local.blocklist.ids }));

    // (g) an unsigned list from the primary still works, for a self-hosted file
    global.fetch = async () => body(list(['5000000007'], T1));
    r = await send('sw:refresh-now');
    check('an unsigned list from the primary is still accepted -- self-hosting keeps working',
      r.ok && store.local.blocklist.ids[0] === '5000000007' &&
      store.local.blocklist.verified === false,
      JSON.stringify({ ok: r.ok, verified: store.local.blocklist.verified }));

    // (h) a build with no key pinned cannot verify, so it must not accept
    globalThis.CB_POINTER_KEY = '';
    global.fetch = async () => body(signed(list(['5000000008'], T1)));
    r = await send('sw:refresh-now');
    check('a build with no pinned key refuses a signed list rather than trusting it',
      !r.ok && store.local.blocklist.ids[0] === '5000000007',
      JSON.stringify({ ok: r.ok, error: r.error }));

    // (i) the ETag is only offered back to the host that issued it
    globalThis.CB_POINTER_KEY = pubRaw;
    store.local.blocklist.etag = '"from-primary"';
    store.local.blocklist.source = PRIMARY;
    const seenHeaders = [];
    global.fetch = async (url, opts) => {
      seenHeaders.push([String(url), ((opts || {}).headers || {})['if-none-match'] || null]);
      if (String(url) === PRIMARY) return down();
      return body(signed(list(['5000000009'], '2026-08-23T00:00:00.000Z')));
    };
    // The conditional path is the NON-forced one.
    await alarmHandler({ name: 'cb-refresh-blocklist' });
    await new Promise(r => setTimeout(r, 150));
    const toMirror = seenHeaders.find(h => h[0] === MIRROR);
    check('an ETag from the primary is never sent to a mirror',
      toMirror && toMirror[1] === null &&
      store.local.blocklist.source === MIRROR,
      JSON.stringify(seenHeaders));

    globalThis.CB_POINTER_KEY = pinned;
    delete store.local.backendHosts;
    delete global.fetch;
  }

  // -- 15c. failures the person asked for reach the toolbar ----------------
  //
  // The report sheet is optimistic now: it says "sent" and closes without
  // waiting. That is only honest if a failure still finds its way back, and
  // the badge is the only surface left once the sheet has gone. So these are
  // the assertions that make the optimism defensible rather than convenient.
  {
    await reset({ maxColdBlocksPerHour: 50, platformBlockEnabled: true });
    openGate();

    // A block nobody asked for -- the list-driven kind -- fails all the time
    // and retries; none of that is the reader's business.
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['6100000001'], warm: false });
    let c = await send('sw:queue-claim', { platform: 'threads' });
    await send('sw:queue-result', { platform: 'threads', target: c.target, ok: false, detail: 'no mutation' });
    let out = await send('sw:alerts-get');
    check('a list-driven failure does not raise an alert',
      out.ok && out.alerts.length === 0, JSON.stringify(out.alerts));

    // One they pressed a button for is different.
    await send('sw:enqueue-platform-block',
      { platform: 'threads', ids: ['6100000002'], warm: true, userInitiated: true });
    openGate();
    c = await send('sw:queue-claim', { platform: 'threads' });
    await send('sw:queue-result', { platform: 'threads', target: c.target, ok: false, detail: 'no mutation' });
    out = await send('sw:alerts-get');
    check('a failure they asked for does raise one',
      out.ok && out.alerts.length === 1 && out.alerts[0].key === 'threads:6100000002',
      JSON.stringify(out.alerts.map(a => a.key)));
    check('and it carries why, so the activity page can say',
      out.alerts[0].detail === 'no mutation', out.alerts[0].detail);

    // Retried and failed again: still one alert, not two.
    await send('sw:retry-target', { platform: 'threads', id: '6100000002' });
    openGate();
    c = await send('sw:queue-claim', { platform: 'threads' });
    await send('sw:queue-result', { platform: 'threads', target: c.target, ok: false, detail: 'again' });
    out = await send('sw:alerts-get');
    check('a retry that fails again does not count twice',
      out.alerts.length === 1 && out.alerts[0].tries === 2,
      JSON.stringify(out.alerts.map(a => a.key + ':' + a.tries)));

    // And a retry that works clears it, so a transient failure heals itself.
    await send('sw:retry-target', { platform: 'threads', id: '6100000002' });
    openGate();
    c = await send('sw:queue-claim', { platform: 'threads' });
    await send('sw:queue-result', { platform: 'threads', target: c.target, ok: true, dryRun: false });
    out = await send('sw:alerts-get');
    check('a later success takes the alert back down',
      out.alerts.length === 0, JSON.stringify(out.alerts));

    // notReady is "no tab could run it", which is waiting rather than failing.
    await send('sw:enqueue-platform-block',
      { platform: 'threads', ids: ['6100000003'], warm: true, userInitiated: true });
    openGate();
    c = await send('sw:queue-claim', { platform: 'threads' });
    await send('sw:queue-result',
      { platform: 'threads', target: c.target, ok: false, notReady: true, detail: 'not loaded' });
    out = await send('sw:alerts-get');
    check('not-ready is waiting, not failing, and raises nothing',
      out.alerts.length === 0, JSON.stringify(out.alerts));

    // Dismissing is what the activity page offers; they are a notification,
    // not a record -- the block history keeps every attempt either way.
    await send('sw:enqueue-platform-block',
      { platform: 'threads', ids: ['6100000004'], warm: true, userInitiated: true });
    openGate();
    c = await send('sw:queue-claim', { platform: 'threads' });
    await send('sw:queue-result', { platform: 'threads', target: c.target, ok: false, detail: 'x' });
    check('an alert is raised to be dismissed', (await send('sw:alerts-get')).alerts.length === 1);
    await send('sw:alerts-clear');
    check('dismissing clears them', (await send('sw:alerts-get')).alerts.length === 0);
  }

  // -- 16. passive and active ------------------------------------------------
  //
  // The mode is the only decision the options page asks anyone to make, and
  // the difference is invisible from inside the extension: passive looks
  // exactly like active with an empty list. So these drive a real refresh
  // whose payload carries ranked targets, and watch what reaches the queue.
  {
    const FS_URL = 'http://127.0.0.1:8080/blocklist.json';
    const today = new Date().toISOString().slice(0, 10);
    const published = {
      v: 1, updatedAt: new Date().toISOString(),
      ids: ['8100000001', '8100000002'], usernames: [], docIdOverrides: {}, pending: [],
      // Same trust era, different activity, so the ranking is deterministic
      // wherever this runs: neither target names a region or a language, so
      // locality is identical and only trust and velocity separate them.
      targets: [
        { platform: 'facebook', id: '8100000001', trust: 2, last: today,
          days: { [today]: 2 }, regions: {}, langs: {} },
        { platform: 'facebook', id: '8100000002', trust: 1, last: today,
          days: {}, regions: {}, langs: {} }
      ]
    };
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify(published), json: async () => published
    });
    const queuedIds = async () =>
      ((await state()).queue.facebook || []).map(e => (typeof e === 'string' ? e : e.id));

    // Passive: the list still arrives, but nobody is queued off the back of it.
    await reset({ mode: 'passive', listUrl: FS_URL, maxColdBlocksPerHour: 50 });
    const rp = await send('sw:refresh-now');
    check('passive mode still fetches and keeps the whole list',
      rp.ok && rp.blocklist.ids.length === 2,
      JSON.stringify(rp.blocklist && rp.blocklist.ids));
    const passiveQueue = await queuedIds();
    check('passive mode seeds none of the ranked targets',
      (rp.blocklist.targets || []).length === 0 && passiveQueue.length === 0,
      JSON.stringify(passiveQueue));

    // The profile in front of you is still blocked, at warm pacing: that is
    // the whole of what passive means, not "do nothing".
    const warmAdd = await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8100000001'], warm: true });
    openGate();
    const warmClaim = await send('sw:queue-claim', { platform: 'facebook' });
    check('passive mode still queues a profile that turned up on screen',
      warmAdd.added === 1 && warmClaim.target === '8100000001' && warmClaim.warm === true,
      `added=${warmAdd.added} target=${warmClaim.target} warm=${warmClaim.warm}`);
    check('and paces it as warm work, seconds rather than half a minute',
      warmClaim.nextDelayMs > 0 && warmClaim.nextDelayMs <= 12000, String(warmClaim.nextDelayMs));

    // Active: the identical payload, and now the ranked targets are the point.
    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50 });
    const ra = await send('sw:refresh-now');
    const seeded = await queuedIds();
    check('active mode seeds the same payload as cold work',
      ra.ok && seeded.length === 2 &&
      seeded.includes('8100000001') && seeded.includes('8100000002'),
      JSON.stringify(seeded));
    openGate();
    const coldClaim = await send('sw:queue-claim', { platform: 'facebook' });
    check('what it seeded is cold: best rank first, paced in the cold window',
      coldClaim.target === '8100000001' && coldClaim.warm === false &&
      coldClaim.nextDelayMs >= 4000 && coldClaim.nextDelayMs <= 10000,
      `${coldClaim.target} warm=${coldClaim.warm} delay=${coldClaim.nextDelayMs}`);

    // An install written before modes existed. Its stored settings carry
    // acceptServerTargets and no mode at all, which is why this writes sync
    // storage directly: going through set-settings would merge today's
    // defaults in and hide the very thing under test.
    store.local = {};
    store.sync = { settings: {
      listUrl: FS_URL, platformBlockEnabled: true, platformBlockDryRun: false,
      maxColdBlocksPerHour: 50, acceptServerTargets: false
    } };
    const rl = await send('sw:refresh-now');
    const legacyQueue = await queuedIds();
    check('an install that refused server targets before modes existed stays passive',
      rl.ok && (rl.blocklist.targets || []).length === 0 && legacyQueue.length === 0,
      JSON.stringify(legacyQueue));
    const legacyMode = (await state()).settings.mode;
    check('and it reports the mode it actually behaves as',
      legacyMode === 'passive', String(legacyMode));

    // The same vintage with the flag the other way round is an ordinary active
    // install: the fallback must not sweep every old install into passive.
    store.local = {};
    store.sync = { settings: {
      listUrl: FS_URL, platformBlockEnabled: true, maxColdBlocksPerHour: 50,
      acceptServerTargets: true
    } };
    const rl2 = await send('sw:refresh-now');
    check('an equally old install that accepted them is active',
      rl2.ok && (await queuedIds()).length === 2, JSON.stringify(await queuedIds()));

    // Pausing outranks the mode entirely.
    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50,
                  platformBlockEnabled: false });
    const rpaused = await send('sw:refresh-now');
    check('with blocking paused, even active mode queues nobody',
      rpaused.ok && (await queuedIds()).length === 0, JSON.stringify(await queuedIds()));
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8100000002'], warm: true });
    openGate();
    const pausedClaim = await send('sw:queue-claim', { platform: 'facebook' });
    check('and nothing already queued is handed out, warm or not',
      !pausedClaim.target, String(pausedClaim.target));

    delete global.fetch;
  }

  // -- 17. the toolbar badge -------------------------------------------------
  //
  // Cold targets are issued through the site's own code, so they only move
  // while a Facebook or Threads tab is open -- and nothing else in the product
  // says so: the queue just sits there looking healthy. The badge is the only
  // signal that reaches someone who is not looking at the extension at all,
  // so it has to be right about every condition it depends on.
  {
    // With the own-tab experiment on there is ALWAYS somewhere for cold work
    // to run -- the worker supplies the tab -- and the badge correctly says
    // nothing. That interaction is real and is covered in 2d-2f; what is under
    // test here is the badge's own reasoning about an absent tab, so this
    // block turns the experiment off and asks the question it means to ask.
    await reset({ mode: 'active', maxColdBlocksPerHour: 50, experimentalOwnTab: false });
    await send('sw:enqueue-platform-block', { platform: 'facebook', warm: false,
      ids: [{ id: '8300000001', rank: 3 }, { id: '8300000002', rank: 2 }] });

    // Picking a mode is what the options page writes, and writing settings is
    // what re-evaluates the badge.
    await setSettings({ mode: 'active' });
    check('cold work with nowhere to run puts the count on the badge',
      badge.text === '2' && badge.color === '#b7791f',
      `text=${JSON.stringify(badge.text)} color=${badge.color}`);

    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['8300000003'], warm: true });
    await setSettings({ mode: 'active' });
    check('warm entries are not counted: they only ever arrive while a tab is open',
      badge.text === '2', JSON.stringify(badge.text));

    openTabs = [{ id: 11, url: 'https://www.facebook.com/' }];
    await setSettings({ mode: 'active' });
    check('the badge clears once there is a tab for the work to run in',
      badge.text === '', JSON.stringify(badge.text));

    // A Threads tab counts too, and a tab on anything else does not.
    openTabs = [{ id: 12, url: 'https://www.threads.com/@someone' }];
    await setSettings({ mode: 'active' });
    check('a Threads tab is somewhere for the work to run as well',
      badge.text === '', JSON.stringify(badge.text));
    openTabs = [{ id: 13, url: 'https://example.com/' }];
    await setSettings({ mode: 'active' });
    check('an unrelated tab is not, and the warning comes back',
      badge.text === '2', JSON.stringify(badge.text));

    openTabs = [];
    await setSettings({ mode: 'passive' });
    check('passive mode is not waiting on a tab, so the badge clears',
      badge.text === '', JSON.stringify(badge.text));
    await setSettings({ mode: 'active', platformBlockEnabled: false });
    check('paused blocking is not waiting on a tab either',
      badge.text === '', JSON.stringify(badge.text));

    // A checkpoint owns the badge outright: it is the more urgent message and
    // the count would overwrite it.
    await reset({ mode: 'active', maxColdBlocksPerHour: 50 });
    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['8300000004'], warm: true });
    openGate();
    const cp = await send('sw:queue-claim', { platform: 'facebook' });
    await send('sw:queue-result', { platform: 'facebook', target: cp.target, ok: false,
      dryRun: false, checkpoint: true, detail: 'challenge' });
    check('a checkpoint marks the badge itself', badge.text === '!', JSON.stringify(badge.text));
    await send('sw:enqueue-platform-block', { platform: 'facebook', warm: false,
      ids: [{ id: '8300000005', rank: 1 }] });
    await setSettings({ mode: 'active' });
    check('and keeps it while halted, whatever else is queued',
      badge.text === '!', JSON.stringify(badge.text));
  }

  // -- 18. blockTags: which kinds of account get blocked ---------------------
  //
  // The setting rations BLOCKS, not the list: an unticked kind stays listed
  // and stays hidden. Both queueing paths have to honour it -- cold seeding
  // from the ranked slice, and the warm sweep the content script drives -- and
  // exactly one thing has to get past it, the button a person pressed.
  {
    const FS_URL = 'http://127.0.0.1:8080/blocklist.json';
    const today = new Date().toISOString().slice(0, 10);
    const published = {
      v: 1, updatedAt: new Date().toISOString(),
      ids: ['8500000001', '8500000002', '8500000003'],
      usernames: [], docIdOverrides: {}, pending: [],
      // The flat map covers ids with no target record behind them, which is
      // the only thing warm blocking has to go on.
      idTags: { '8500000001': 'clone', '8500000002': 'redbull', '8500000003': 'spam' },
      targets: [
        { platform: 'facebook', id: '8500000001', tag: 'clone', trust: 2, last: today,
          days: { [today]: 2 }, regions: {}, langs: {}, reporters: 2 },
        { platform: 'facebook', id: '8500000002', tag: 'redbull', trust: 1, last: today,
          days: {}, regions: {}, langs: {}, reporters: 1 }
      ]
    };
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify(published), json: async () => published
    });
    const queuedIds = async () =>
      ((await state()).queue.facebook || []).map(e => (typeof e === 'string' ? e : e.id));
    const ALL_BUT_REDBULL =
      ['clone', 'impersonation', 'scam', 'harassment', 'spam', 'other'];

    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50 });
    const rAll = await send('sw:refresh-now');
    check('with every kind ticked -- the shipped default -- all of them seed',
      rAll.ok && (await queuedIds()).length === 2, JSON.stringify(await queuedIds()));
    check('the published tag map is cached with the list',
      (rAll.blocklist.idTags || {})['8500000002'] === 'redbull',
      JSON.stringify(rAll.blocklist.idTags));
    check('and ranking does not strip a target of its tag',
      (rAll.blocklist.targets || []).every(t => t.tag),
      JSON.stringify((rAll.blocklist.targets || []).map(t => [t.id, t.tag])));

    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50,
                  blockTags: ALL_BUT_REDBULL });
    await send('sw:refresh-now');
    const seeded = await queuedIds();
    check('an unticked kind is left out of the cold queue',
      seeded.includes('8500000001') && !seeded.includes('8500000002'),
      JSON.stringify(seeded));

    // The content script forwards every listed id it sees. Scrolling past one
    // is not a decision about it, so the filter applies.
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000002'], warm: true });
    check('nor is it queued when the page sweep runs into it',
      !(await queuedIds()).includes('8500000002'), JSON.stringify(await queuedIds()));

    // Pressing Block now is. Dropping that click would leave a dead button and
    // nothing on screen to explain it.
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000002'], warm: true, userInitiated: true });
    check('but an explicit Block now goes through anyway',
      (await queuedIds()).includes('8500000002'), JSON.stringify(await queuedIds()));

    // An id the list published no tag for -- or a whole list published before
    // tags existed -- counts as 'other', which every install blocks until its
    // owner narrows the set.
    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50 });
    await send('sw:refresh-now');
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000009'], warm: true });
    check("an untagged id counts as 'other' and is still blocked",
      (await queuedIds()).includes('8500000009'), JSON.stringify(await queuedIds()));
    await setSettings({ blockTags: ['clone'] });
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000008'], warm: true });
    check("...and is refused once 'other' is unticked",
      !(await queuedIds()).includes('8500000008'), JSON.stringify(await queuedIds()));

    // Ticking nothing is a real answer -- "hide them, block nobody" -- and has
    // to be distinguishable from a settings object that has never met the key.
    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50,
                  blockTags: [] });
    await send('sw:refresh-now');
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000001'], warm: true });
    check('ticking no kinds at all blocks nobody unprompted',
      (await queuedIds()).length === 0, JSON.stringify(await queuedIds()));
    check('and the list itself is untouched: hiding is tag-blind',
      ((await state()).blocklist.ids || []).length === 3,
      JSON.stringify((await state()).blocklist.ids));

    delete global.fetch;
  }

  // -- 19. the two rankers ---------------------------------------------------
  //
  // The same ranking formula is written out twice: rankPublishedTargets() in
  // the service worker, and rankTargets() in shared/logic.js, which the
  // dashboard's preview uses. This suite used to run both over one fixture and
  // compare them, which is the only way drift would ever announce itself --
  // both would otherwise go on returning a plausible order while the
  // moderator's preview quietly stopped describing what any client does.
  //
  // logic.js is in the backend repository now and this one cannot see it, so
  // the comparison lives there instead: its check.js reads a checkout of this
  // repository when it has one, and skips loudly when it does not. The worker's
  // own ranking behaviour is still exercised below and in section 14.
  //
  // The dependency points one way on purpose. The backend is private and may
  // read this public repository; this repository must never need to read that
  // one.

  // -- 20. the two switches --------------------------------------------------
  //
  // blockSeen and blockFromList are not two halves of one dial. The radio they
  // replaced could only say "just what I see" or "both", so "work through the
  // list but leave what I scroll past alone" was unsayable -- and that is the
  // combination worth proving hardest, because nothing before this could
  // express it at all.
  //
  // Both sources are driven the way the extension drives them: a real refresh
  // whose payload carries ranked targets for the cold side, and a real enqueue
  // marked warm for the side that comes off the page in front of you.
  {
    const FS_URL = 'http://127.0.0.1:8080/blocklist.json';
    const today = new Date().toISOString().slice(0, 10);
    const published = {
      v: 1, updatedAt: new Date().toISOString(),
      ids: ['8200000001', '8200000002'], usernames: [], docIdOverrides: {}, pending: [],
      targets: [
        { platform: 'facebook', id: '8200000001', trust: 2, last: today,
          days: { [today]: 2 }, regions: {}, langs: {} },
        { platform: 'facebook', id: '8200000002', trust: 1, last: today,
          days: {}, regions: {}, langs: {} }
      ]
    };
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify(published), json: async () => published
    });
    const queuedIds = async () =>
      ((await state()).queue.facebook || []).map(e => (typeof e === 'string' ? e : e.id));

    // A profile on the list that this browser has never met until it scrolls
    // past, so what these prove is the switch rather than the seeding.
    const ON_SCREEN = '8200000003';

    /**
     * Run both sources past one settings object and report what each of them
     * managed to queue.
     *
     * Kept apart, because the whole question is whether one can be on while
     * the other is off: a single count would pass just as happily if the
     * wrong source had filled it.
     */
    async function bothSources(settings) {
      await reset(Object.assign({ listUrl: FS_URL, maxColdBlocksPerHour: 50 }, settings));
      const r = await send('sw:refresh-now');
      const fromList = await queuedIds();
      await send('sw:enqueue-platform-block',
        { platform: 'facebook', ids: [ON_SCREEN], warm: true });
      const after = await queuedIds();
      return { ok: r.ok, listKept: (r.blocklist && r.blocklist.ids) || [],
               fromList, seen: after.filter(id => !fromList.includes(id)) };
    }

    // The combination the radio could not say: work the list, leave what
    // scrolls past alone.
    const listOnly = await bothSources({ blockSeen: false, blockFromList: true });
    check('blockSeen off, blockFromList on: the ranked list still seeds cold work',
      listOnly.fromList.length === 2 &&
      listOnly.fromList.includes('8200000001') && listOnly.fromList.includes('8200000002'),
      JSON.stringify(listOnly.fromList));
    check('and a profile that turns up on screen is not queued',
      listOnly.seen.length === 0, JSON.stringify(listOnly.seen));
    // Seeded is not the same as workable: the cold side has to survive the
    // claim too, or "the list keeps running" would be a claim about storage.
    openGate();
    const listOnlyClaim = await send('sw:queue-claim', { platform: 'facebook' });
    check('and the cold work it seeded is handed out, paced in the cold window',
      listOnlyClaim.target === '8200000001' && listOnlyClaim.warm === false &&
      listOnlyClaim.nextDelayMs >= 4000 && listOnlyClaim.nextDelayMs <= 10000,
      `${listOnlyClaim.target} warm=${listOnlyClaim.warm} delay=${listOnlyClaim.nextDelayMs}`);

    // The converse: what is in front of you, and nothing else.
    const seenOnly = await bothSources({ blockSeen: true, blockFromList: false });
    check('blockSeen on, blockFromList off: the list still arrives in full',
      seenOnly.ok && seenOnly.listKept.length === 2, JSON.stringify(seenOnly.listKept));
    check('but none of its ranked targets are queued',
      seenOnly.fromList.length === 0, JSON.stringify(seenOnly.fromList));
    check('and a profile that turns up on screen still is',
      seenOnly.seen.includes(ON_SCREEN), JSON.stringify(seenOnly.seen));

    // Both off is a real setting -- the extension still hides, still reports,
    // still keeps the list -- and it has to be quiet from both directions.
    const neither = await bothSources({ blockSeen: false, blockFromList: false });
    check('both switches off: neither source queues anybody',
      neither.fromList.length === 0 && neither.seen.length === 0,
      `fromList=${JSON.stringify(neither.fromList)} seen=${JSON.stringify(neither.seen)}`);

    // Pressing a button is a decision, not a sweep. The popup's Block now and
    // the report sheet's block-too tick box both send userInitiated, and it
    // has to outrank the standing preference: a control that silently did
    // nothing would be worse than no control at all.
    const byHand = await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8200000004'], warm: true, userInitiated: true });
    check('but a block the user asked for by hand still goes through',
      byHand.added === 1 && (await queuedIds()).includes('8200000004'),
      JSON.stringify(await queuedIds()));

    // The ordinary shipped state, where the two do not interfere.
    const both = await bothSources({ blockSeen: true, blockFromList: true });
    check('both switches on: the list and the page each queue their own',
      both.fromList.length === 2 && both.seen.includes(ON_SCREEN),
      `fromList=${JSON.stringify(both.fromList)} seen=${JSON.stringify(both.seen)}`);

    /**
     * An install written before the pair existed.
     *
     * Its settings go straight into sync storage: going through set-settings
     * would merge today's defaults in and hide the very thing under test,
     * which is what the worker makes of a settings object that has neither
     * blockSeen nor blockFromList in it.
     */
    async function legacyInstall(stored) {
      store.local = {};
      store.sync = { settings: Object.assign({
        listUrl: FS_URL, platformBlockEnabled: true, platformBlockDryRun: false,
        maxColdBlocksPerHour: 50
      }, stored) };
      const r = await send('sw:refresh-now');
      const fromList = await queuedIds();
      await send('sw:enqueue-platform-block',
        { platform: 'facebook', ids: [ON_SCREEN], warm: true });
      const after = await queuedIds();
      return { ok: r.ok, targets: (r.blocklist && r.blocklist.targets) || [], fromList,
               seen: after.filter(id => !fromList.includes(id)),
               settings: (await state()).settings };
    }

    const wasPassive = await legacyInstall({ mode: 'passive' });
    check('an install carrying mode passive still refuses cold work end to end',
      wasPassive.ok && wasPassive.targets.length === 0 && wasPassive.fromList.length === 0,
      JSON.stringify(wasPassive.fromList));
    check('and still blocks what it sees, which is all passive ever meant',
      wasPassive.seen.includes(ON_SCREEN), JSON.stringify(wasPassive.seen));
    check('and it reads back as the pair it behaves as',
      wasPassive.settings.blockSeen === true && wasPassive.settings.blockFromList === false,
      `seen=${wasPassive.settings.blockSeen} fromList=${wasPassive.settings.blockFromList}`);

    // Older still: the flag that predates modes entirely. Somebody who turned
    // server targets off must not get them back by upgrading twice.
    const refusedTargets = await legacyInstall({ acceptServerTargets: false });
    check('an install carrying acceptServerTargets false refuses it the same way',
      refusedTargets.ok && refusedTargets.targets.length === 0 &&
      refusedTargets.fromList.length === 0, JSON.stringify(refusedTargets.fromList));
    check('and it too keeps blocking what turns up on screen',
      refusedTargets.seen.includes(ON_SCREEN), JSON.stringify(refusedTargets.seen));

    delete global.fetch;
  }

  // -- 21. one pacing gate for the whole browser -----------------------------
  //
  // The gate is what stops five open tabs producing five times the rate the
  // caps were chosen for. Section 5 proves it holds between tabs on one site;
  // the question here is what it does across the two sites, because a gate
  // kept per platform would let a Facebook tab and a Threads tab block in the
  // same second and quietly double the rate again. Facebook and Threads are
  // one Meta account, and the account is the thing that gets checkpointed --
  // so one gate covers the browser, not one per site.
  {
    await reset();
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['9100000001'], warm: true });
    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['9100000002'], warm: true });

    openGate();
    const onThreads = await send('sw:queue-claim', { platform: 'threads' });
    const onFacebook = await send('sw:queue-claim', { platform: 'facebook' });
    check('a block in flight on Threads holds a Facebook tab back too',
      onThreads.target === '9100000001' && !onFacebook.target && onFacebook.retryInMs > 0,
      `threads=${onThreads.target} facebook=${onFacebook.target} retry=${onFacebook.retryInMs}`);

    await send('sw:queue-result',
      { platform: 'threads', target: onThreads.target, ok: true, dryRun: true, warm: true });
    const stillHeld = await send('sw:queue-claim', { platform: 'facebook' });
    const s21 = (await state()).settings;
    check('and the pause after that block lands is shared across both sites',
      !stillHeld.target && stillHeld.retryInMs > 0 &&
      stillHeld.retryInMs <= (s21.warmMaxDelayMs | 0) + 500,
      `retryInMs=${stillHeld.retryInMs} warmMax=${s21.warmMaxDelayMs}`);

    openGate();
    const servedNext = await send('sw:queue-claim', { platform: 'facebook' });
    check('once the pause has run the other site is served, not starved',
      servedNext.target === '9100000002', String(servedNext.target));
  }

  // -- 22. a tab that dies mid-block must not wedge the queue ----------------
  //
  // The gate is shut by the claim and reopened by the result, so a tab that is
  // closed, crashed or navigated away between the two never reports anything.
  // Nothing would notice: there is no error and no failed target, just a
  // browser that stopped blocking. The claim bounds the shut gate by the lease
  // for exactly this reason, and a bound is only worth having if it is tested.
  {
    // The worker's lease window. Hardcoded because it is a module-local const
    // in the service worker: if it moves, this should fail loudly rather than
    // quietly stop testing anything.
    const LEASE_MS = 90 * 1000;

    await reset();
    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['9200000001'], warm: true });
    openGate();
    const claimed = await send('sw:queue-claim', { platform: 'facebook' });

    // The tab is gone. No result is ever reported for this target.
    const wedged = await send('sw:queue-claim', { platform: 'facebook' });
    const s22 = (await state()).settings;
    check('with a block in flight the gate is shut for the lease, not for the delay',
      claimed.target === '9200000001' && !wedged.target &&
      wedged.retryInMs > (s22.warmMaxDelayMs | 0) && wedged.retryInMs <= LEASE_MS,
      `retryInMs=${wedged.retryInMs} warmMax=${s22.warmMaxDelayMs} lease=${LEASE_MS}`);

    rewind(LEASE_MS + 1000);
    const recovered = await send('sw:queue-claim', { platform: 'facebook' });
    check('and once the lease has run out the target is claimable again',
      recovered.target === '9200000001',
      `target=${recovered.target} retry=${recovered.retryInMs}`);
    check('with nothing lost from the queue while it was held',
      ((await state()).queue.facebook || []).length === 1,
      JSON.stringify((await state()).queue.facebook));
  }

  finish();
})().catch((e) => { console.error('harness error:', e); process.exitCode = 1; });

function finish() {
  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
  }
  process.exitCode = failed.length ? 1 : 0;
}
