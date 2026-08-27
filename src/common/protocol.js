/**
 * Shared constants for the MAIN <-> ISOLATED world bridge and the
 * ISOLATED <-> service-worker message channel.
 *
 * Loaded as a plain (non-module) content script, so it publishes onto the
 * isolated world's global object. The MAIN-world script keeps its own copy of
 * the wire strings, because the two worlds cannot share JS objects at all --
 * only structured-cloneable messages via window.postMessage.
 */
(function () {
  'use strict';

  const PROTOCOL = {
    // window.postMessage envelope marker. Every bridge frame carries this.
    MARK: '__cloneblocker_bridge__',

    // Handshake. MAIN announces readiness; ISOLATED replies with a session
    // nonce that both sides then require on every subsequent frame.
    MAIN_READY: 'main:ready',
    HELLO: 'iso:hello',
    HELLO_ACK: 'main:hello-ack',

    // ISOLATED -> MAIN
    RESOLVE_IDS: 'iso:resolve-ids',        // ask MAIN to identify authors of DOM nodes
    PLATFORM_BLOCK: 'iso:platform-block',  // ask MAIN to run a real block mutation
    PROBE_CAPABILITY: 'iso:probe',         // ask MAIN what block strategies are available
    DUMP_MODULES: 'iso:dump-modules',      // debug: list registered modules matching a pattern
    SET_CONFIG: 'iso:set-config',

    // MAIN -> ISOLATED
    IDENTITY: 'main:identity',             // author id/username discovered for a node
    STORE_SNAPSHOT: 'main:store-snapshot', // batch of user records from the Relay store
    BLOCK_RESULT: 'main:block-result',
    CAPABILITY: 'main:capability',
    MODULES: 'main:modules',
    VIEWER: 'main:viewer',                 // logged-in user id

    // ISOLATED/popup/options <-> service worker (chrome.runtime.sendMessage)
    SW: {
      GET_STATE: 'sw:get-state',
      GET_BLOCKLIST: 'sw:get-blocklist',
      REFRESH_NOW: 'sw:refresh-now',
      GET_SETTINGS: 'sw:get-settings',
      SET_SETTINGS: 'sw:set-settings',
      REPORT_STATS: 'sw:report-stats',
      ENQUEUE_PLATFORM_BLOCK: 'sw:enqueue-platform-block',
      QUEUE_CLAIM: 'sw:queue-claim',       // content script asks for next queued target
      QUEUE_RESULT: 'sw:queue-result',
      // The site's block operation, remembered. Meta loads it only when its own
      // block dialog renders, so a page that saw it tells the worker the doc_id
      // and every later page load can block without it.
      REMEMBER_DOC_IDS: 'sw:remember-doc-ids',
      // Try a waiting target again now: clear whatever it is waiting out --
      // a dry-run cooldown, a failure backoff -- and wake a tab for it.
      // Reports that could not be sent yet. See the outbox in the worker.
      FLUSH_REPORTS: 'sw:flush-reports',
      // Things the person asked for that did not happen. Read by the activity
      // page, cleared when they have been looked at.
      ALERTS_GET: 'sw:alerts-get',
      ALERTS_CLEAR: 'sw:alerts-clear',
      RETRY_TARGET: 'sw:retry-target',
      RETRY_ALL: 'sw:retry-all',

      // Clone reporting. Users submit; an admin reviews and decides.
      SUBMIT_REPORT: 'sw:submit-report',
      REPORT_STATUS: 'sw:report-status',
      BLOCKLIST_UPDATED: 'sw:blocklist-updated', // SW -> tabs broadcast
      // SW -> tabs: somebody pressed a button and is watching. The worker
      // loops sleep between claims on timers chosen for unattended
      // sweeping; this cuts the current sleep short so an explicit block
      // happens now rather than at the end of it.
      WAKE_WORKER: 'sw:wake-worker',
      LOG: 'sw:log'
    }
  };

  /**
   * The one tag vocabulary, shared with shared/logic.js and the server.
   *
   * A reporter's `reason` is a vote and a target's `tag` is the verdict, but
   * they are the same words -- which is what lets a verdict be derived from
   * the votes at all.
   *
   * Order is load-bearing three times over, so it is a decision rather than a
   * tidy-up: it is the order every list of them is shown in, the FIRST entry
   * is what the report sheet offers before anyone touches it, and ties between
   * equally popular reasons break towards whatever comes first.
   *
   * 'redbull' leads because it is what this deployment is mostly used to
   * report; putting the common case first is the difference between a reporter
   * confirming a pre-filled answer and hunting through a list every time. New
   * tags go before 'other', which stays the bucket of last resort.
   */
  const TAGS = ['redbull', 'clone', 'impersonation', 'scam', 'harassment', 'spam', 'other'];

  /**
   * The label for each tag. One dictionary rather than one per page, because
   * three copies of "Scam or fraud" is three chances for the report sheet, the
   * options page and the activity chips to end up naming the same thing
   * differently -- and a user who ticks a box has to be able to recognise it
   * in the sheet they filled in. Now that there are two languages, it is also
   * three chances to translate one of them and forget the others.
   */
  const TAG_LABELS_EN = {
    clone: 'Clone / fake account',
    impersonation: 'Impersonating someone',
    scam: 'Scam or fraud',
    harassment: 'Harassment',
    spam: 'Spam',
    redbull: 'Redbull',
    other: 'Something else'
  };

  /**
   * Resolved through CB_T, so one vocabulary serves both languages -- with the
   * English above as the fallback rather than the key.
   *
   * CB_T answers with the key when a message is missing, which is what you want
   * for a control that would otherwise render blank. It is not what you want
   * here: this file is also loaded by the Node harnesses and by anything that
   * imports the protocol without an extension around it, and a report sheet
   * offering "tag_redbull" as a reason would be worse than one offering plain
   * English. So a key echoed straight back is read as "no translation
   * available" and the English wins.
   */
  function tagLabel(tag) {
    const key = 'tag_' + tag;
    const t = globalThis.CB_T;
    const label = t ? t(key) : key;
    return label === key ? (TAG_LABELS_EN[tag] || tag) : label;
  }

  /**
   * Resolved on READ, not once at load.
   *
   * This used to be a plain object built in a loop right here, which froze
   * every label in whatever language was in force the instant protocol.js
   * parsed -- before the language override had been fetched from storage. The
   * result was a report sheet whose headings and buttons were Vietnamese and
   * whose reason list was English: the one part of that dialog somebody has to
   * read carefully, in the wrong language. A getter per tag costs nothing and
   * cannot go stale.
   */
  const TAG_LABELS = {};
  for (const tag of TAGS) {
    Object.defineProperty(TAG_LABELS, tag, {
      enumerable: true,
      get: () => tagLabel(tag)
    });
  }

  // Storage keys (chrome.storage.local unless noted).
  const KEYS = {
    SETTINGS: 'settings',          // sync
    BLOCKLIST: 'blocklist',        // local: { ids, usernames, etag, fetchedAt, source }
    QUEUE: 'platformQueue',        // local: pending real-block targets
    DONE: 'platformDone',          // local: ids already platform-blocked
    STATS: 'stats',                // local
    LEARNED: 'learnedTemplates',   // local: captured request templates per platform
    REPORTED: 'reportedCache'      // local: { key: {status,count,blocked,at} }
  };

  // The blocklist lives at one address, baked in. It used to be a text field,
  // which made the first thing a new user saw a question they had no way to
  // answer. Overridable through storage (the harnesses do exactly that) but
  // no UI writes it any more.
  // The list is a static file, and that is a deliberate economy.
  //
  // Every install polls it every ten minutes and the content changes rarely.
  // Served as a static file with an ETag, an unchanged poll costs a few
  // hundred bytes and no database read at all -- and usually no origin request
  // either, because Cloudflare answers it from the edge. Against a database
  // endpoint the same poll was one billed read per install, from something
  // anybody could hammer, so read cost became a function of user count and of
  // whoever felt like generating traffic.
  //
  // Both of these now point at our own server. The list is still a static file
  // with an ETag -- that part of the Firebase design was right and is kept --
  // but it is written by the backend and served by nginx behind Cloudflare
  // rather than by Hosting, and reports go to a REST API that can see who is
  // asking and how often. Firestore rules could not, which is why none of this
  // is Firestore any more. See docs/BACKEND-PLAN.md.
  const BACKEND = 'https://cloneblocker.tree55.com';

  // The block-surviving copies, named up here because they are the DEFAULTS
  // now, not just the fallbacks. The origin is the freshest source and the
  // pointer's own home, but it is also the address an ISP blocks first, so a
  // default that points there is a default that does not work for the people
  // this is built for. The relay is an AWS Lambda that forwards reports to the
  // origin; the mirrors are GitHub-backed copies the server pushes every few
  // minutes. All are on shared infrastructure a national block cannot take
  // down without large collateral, and every artifact they serve is signed.
  const RELAY = 'https://h0w1lwun39.execute-api.ap-southeast-1.amazonaws.com';
  const MIRROR_RAW = 'https://raw.githubusercontent.com/nsc55/cloneblocker-mirror/published';
  const MIRROR_JSDELIVR = 'https://cdn.jsdelivr.net/gh/nsc55/cloneblocker-mirror@published';

  // The list defaults to the GitHub mirror and reports default to the relay:
  // the shipped configuration works from inside the block, and a user who can
  // reach the origin loses nothing but a few minutes of list freshness. The
  // origin stays a fallback for both (see LIST_MIRRORS and the pointer).
  const LIST_URL = MIRROR_RAW + '/blocklist.json';
  const API_BASE = RELAY + '/v1';

  // Where to look when the backend cannot be reached at its usual address.
  //
  // A Chrome extension takes days to clear review, so a hardcoded address is a
  // single point of failure: a migration, a takedown, or a national ISP
  // deciding it does not care for this one bricks every installation until a
  // new version ships. The pointer is a small signed document that says where
  // to go instead, and the extension can read it without an update.
  //
  // It is SIGNED and the hostnames are PINNED, because whoever controls this
  // controls every installation -- which is a concentrated risk the Firebase
  // design did not have, and the thing most worth getting right here.
  // Read in order, first answer wins. More than one host on purpose: if the
  // pointer is only reachable at the address that has just been blocked, it
  // cannot do the one job it exists for -- which is exactly what happened in
  // August 2026, when this array had one entry and Vietnamese ISPs blocked it.
  //
  // The origin is read first here on purpose: it is signed like every mirror,
  // and it is where a pointer naming a FRESH relay or mirror would come from,
  // so a build whose compiled hosts have all been blocked can still be handed
  // a new one. A blocked install simply fails this first entry and reads the
  // pointer from the relay, which is the second.
  const POINTER_URLS = [
    BACKEND + '/backend.json',
    RELAY + '/backend.json',
    MIRROR_RAW + '/backend.json',
    MIRROR_JSDELIVR + '/backend.json'
  ];

  // The list fallbacks, after the compiled primary (LIST_URL, the GitHub
  // mirror) and after any mirrors a signed pointer named. All four public
  // copies are listed; refreshBlocklist drops whichever one equals the
  // primary, so this stays correct whatever listUrl a self-hoster sets. The
  // origin is last: freshest, but the one an ISP blocks, so it is where a
  // blocked install ends up only if every shared copy has failed.
  const LIST_MIRRORS = [
    MIRROR_RAW + '/blocklist.json',
    MIRROR_JSDELIVR + '/blocklist.json',
    RELAY + '/blocklist.json',
    BACKEND + '/blocklist.json'
  ];

  // The hostnames this build will talk to, whatever a signed pointer says.
  //
  // This is the control that survives the signing key leaking. A stolen key
  // can produce a valid pointer; it cannot add a host to this array, because
  // this array ships inside the extension and changing it needs a store
  // review. So the worst a compromised key achieves is choosing among hosts
  // the build already trusted.
  const POINTER_HOSTS = [
    'cloneblocker.tree55.com',
    'h0w1lwun39.execute-api.ap-southeast-1.amazonaws.com'
  ];

  // Ed25519 public key, raw 32 bytes, base64url. Generated once with
  // `node server/src/lib/pointer.js --keygen`; the private half lives in the
  // server's environment and has never been in this repository.
  //
  // An empty key means NO pointer is accepted rather than any pointer being
  // accepted -- see readPointer(). Failing closed matters more here than
  // anywhere else in the extension.
  const POINTER_KEY = 'fYcRAV8CRof15IAinUoDOZuBbqqDtDXDPl3lwSLoMhk';

  const DEFAULT_SETTINGS = {
    listUrl: LIST_URL,
    listAuthHeader: '',      // optional "Authorization: ..." value
    // Ten minutes, not an hour. The list is a static file on a CDN and the
    // poll is conditional, so an unchanged list answers 304 and costs a few
    // hundred bytes and no database read at all -- which is what makes a
    // shorter interval affordable. What it buys is the gap between a moderator
    // approving a clone and every installation acting on it.
    refreshMinutes: 10,

    // Reporting. apiBase is derived from listUrl when left blank, so the common
    // case needs no extra configuration.
    apiBase: API_BASE,
    /**
     * Which language the extension's own pages speak.
     *
     * Vietnamese, not 'auto'. This shipped as 'auto' -- whatever the browser
     * is set to, which is what chrome.i18n does on its own -- and 'auto' is
     * the right default for an extension whose users are anybody. This one's
     * users are Vietnamese people reporting accounts that impersonate
     * Vietnamese public figures, and a great many of them run an
     * English-language Chrome because that is what came with the machine.
     * Following the browser served those people English, which is the wrong
     * language for every one of them.
     *
     * Chrome offers no per-extension language control, so 'auto' left them no
     * way out short of changing the whole browser and restarting it. That is
     * the reason the override exists at all; making it the default is the
     * same argument taken one step further.
     *
     * Anyone this is wrong for changes it once, in options, and is remembered
     * -- including back to 'auto'. Existing installs are untouched: a stored
     * setting wins over this, so this only decides what a NEW install starts
     * with.
     *
     * One thing neither this nor the override can reach: the extension's name
     * and description in chrome://extensions and the Web Store come from the
     * manifest, which Chrome resolves before any of our code runs. That is
     * what default_locale in manifest.json is for, and it is 'vi' for the
     * same reason this is.
     */
    // i18n.js owns this value -- see DEFAULT_LANG there for why it cannot
    // live only here. The literal is a fallback for the Node harnesses, which
    // read this file with no extension around it.
    uiLanguage: globalThis.CB_DEFAULT_LANG || 'vi',   // 'auto' | 'en' | 'vi'

    reportUiEnabled: true,   // the in-page report affordance on profiles
    // Reporting and blocking are usually the same intent: the person filing
    // the report wants this account gone from their feed now, not once a
    // moderator has read it. So the sheet offers both at once and ticks it by
    // default. It is a remembered preference rather than a fresh default each
    // time -- someone who unticks it means it.
    reportAlsoBlocks: true,
    // One-click blocking. Off by default, because a confirmation is the right
    // default for an irreversible-looking action against a named person. When
    // on, the in-page block button acts at once -- report and block, the same
    // as pressing Submit with "also block" ticked -- and shows an inline
    // animation on the button and the post rather than opening the sheet. The
    // sheet's optimism is what makes this safe to skip: a report that cannot
    // send is kept and retried, and a failed block reaches the toolbar badge.
    quickBlock: false,
    reportHoverDelayMs: 350,
    reporterId: '',          // set on first use; identifies repeat reports
    submitToken: '',         // only if the server was started with --submit-token

    /**
     * What the extension is allowed to block. Two independent switches, not
     * two halves of one dial.
     *
     *   blockSeen     -- profiles that turn up on the page while you browse.
     *                    They were on your screen anyway, which is the pattern
     *                    the platform finds unremarkable, so these go quickly.
     *   blockFromList -- the ranked list itself: accounts that are active near
     *                    you but that you may never scroll past. Never on your
     *                    screen, which is the pattern that draws a checkpoint,
     *                    so these are paced slowly under a tighter ceiling.
     *
     * These used to be one `mode` with values 'passive' and 'active', which
     * said they were alternatives. They never were -- the old 'active' meant
     * BOTH -- and the radio buttons made "work the list but leave what I scroll
     * past alone" unsayable. Two tick boxes say what is actually true.
     */
    blockSeen: true,
    blockFromList: true,

    /**
     * Which kinds of account this install is willing to spend a block on.
     *
     * An array matched by inclusion rather than a map of flags, so a tag added
     * in a later release is NOT blocked by an existing install until its owner
     * ticks it. A new category must never start acting on its own.
     *
     * Hiding ignores this entirely: everything approved is hidden regardless.
     * Hiding is free and reversible, so rationing it by kind would buy nothing
     * and only make the list look incomplete.
     */
    blockTags: TAGS.slice(),

    // DOM suppression: hide a listed profile's content without touching your
    // account. Off by default -- real blocks are the product; this is for
    // people who also want the whole list gone from view immediately,
    // including profiles they will never scroll past.
    hideEnabled: false,
    hideMode: 'collapse',    // 'collapse' | 'placeholder' | 'blur'
    hideComments: true,
    hideFeedPosts: true,

    // The master switch behind the modes. On by default: the pacing, the
    // ceilings and the randomised delays are the safety mechanism now, and
    // they ship at cautious values. Surfaced as "Pause blocking" rather than
    // as a mode. (Test harnesses force this off -- a test run must never
    // block anyone for real.)
    platformBlockEnabled: true,
    platformBlockDryRun: false,

    // Raw request fallbacks (hand-built GraphQL, Instagram REST). OFF by
    // default and deliberately so: hand-crafted requests carrying CSRF tokens
    // to Meta endpoints were observed forcing the signed-in session to log
    // out, while driving the site's own Relay code never did. Without this,
    // only the platform's own code path is used.
    allowRawNetworkFallback: false,

    /**
     * EXPERIMENT: let the extension open its own tab to work the queue.
     *
     * Blocking needs the site's own code, and the site's own code needs a
     * page -- so with no Facebook or Threads tab open, a queued target sits
     * there however long the person is away. The alternative, sending the
     * block from the worker with scraped tokens, is a hand-built request, and
     * those were observed invalidating the signed-in session. So instead of
     * faking a page, the extension KEEPS one: a pinned tab, opened when there
     * is work and nobody is browsing, which then stays. It closed itself on an
     * empty queue at first, and that was worse than it sounds -- a tab
     * appearing and vanishing in the strip several times an hour. Pinned and
     * still is the shape somebody can live with.
     *
     * Absent from stored settings means "follow the build" -- see
     * getSettings(): on in an unpacked development build, off in a published
     * one. Ticking or unticking the box in options makes the choice explicit
     * and the build stops deciding.
     */
    experimentalOwnTab: false,
    maxBlocksPerHour: 100,
    maxBlocksPerDay: 1000,
    // Cold targets -- ones the server nominated that this browser has never
    // seen -- get a ceiling of their own. A run of blocks against strangers is
    // the pattern that draws a checkpoint; blocking someone whose profile is on
    // the screen in front of you is not.
    maxColdBlocksPerHour: 100,
    minDelayMs: 4000,        // between cold blocks
    maxDelayMs: 10000,
    warmMinDelayMs: 4000,    // between blocks of profiles that were on screen
    warmMaxDelayMs: 10000,

    // How many ranked targets to take at a time. Whether to take any at all
    // is `mode`; this is only the batch size.
    targetBudget: 100,
    // Sent with the blocklist request so the server can rank by where a clone
    // is actually operating. Coarse by construction: a time zone and a language
    // tag, both of which the browser already tells every site you visit.
    shareRegion: true,

    debug: false
  };

  /**
   * Which mode is in force, tolerating settings written before modes existed.
   *
   * `acceptServerTargets: false` was the old way to say "only block what I
   * see", so an install carrying it lands in passive rather than silently
   * gaining a behaviour its owner had turned off.
   */
  function blockModes(settings) {
    const s = settings || {};
    // Explicit pair wins.
    if (typeof s.blockSeen === 'boolean' || typeof s.blockFromList === 'boolean') {
      return { seen: s.blockSeen !== false, fromList: s.blockFromList !== false };
    }
    // Then the single mode that replaced acceptServerTargets, then
    // acceptServerTargets itself. An install that had turned the ranked list
    // off must not gain it back by upgrading; the whole point of reading the
    // old keys is that nobody's settings change under them.
    if (s.mode === 'passive') return { seen: true, fromList: false };
    if (s.mode === 'active') return { seen: true, fromList: true };
    return { seen: true, fromList: s.acceptServerTargets !== false };
  }

  /** Kept so a caller that only wants the old vocabulary still reads right. */
  function modeOf(settings) {
    return blockModes(settings).fromList ? 'active' : 'passive';
  }

  globalThis.CB_POINTER_URLS = POINTER_URLS;
  globalThis.CB_POINTER_HOSTS = POINTER_HOSTS;
  globalThis.CB_LIST_MIRRORS = LIST_MIRRORS;
  globalThis.CB_POINTER_KEY = POINTER_KEY;
  globalThis.CB_BACKEND = BACKEND;
  globalThis.CB_LIST_URL = LIST_URL;
  globalThis.CB_API_BASE = API_BASE;
  globalThis.CB_MODE_OF = modeOf;
  globalThis.CB_BLOCK_MODES = blockModes;
  globalThis.CB_TAGS = TAGS;
  globalThis.CB_TAG_LABELS = TAG_LABELS;
  globalThis.CB_PROTOCOL = PROTOCOL;
  /**
   * Is this an unpacked (development) build?
   *
   * Chrome adds `update_url` to the manifest of an extension installed from
   * the Web Store and leaves it out of one loaded unpacked, and reading the
   * manifest costs no permission -- unlike chrome.management, which would put
   * a permission on the store listing to answer one boolean. A build that
   * cannot tell answers "no", so an experiment is never on by accident in
   * somebody's browser.
   */
  function isDevBuild() {
    try {
      const m = chrome.runtime.getManifest();
      return !(m && m.update_url);
    } catch (e) { return false; }
  }

  globalThis.CB_KEYS = KEYS;
  // Whether a captured GraphQL operation name is the block MUTATION, rather
  // than anything with "block" in it. The isolated world's copy of the test
  // the MAIN world applies (src/main/inject.js, isBlockMutationName): the two
  // worlds cannot share code, and both have to refuse the same requests --
  // Facebook's RTWebCallBlockSettingHooksQuery, a read of a Messenger setting
  // fired on every page load, was captured as the block template and broke
  // every Facebook block on the installs that held it.
  globalThis.CB_IS_BLOCK_MUTATION_NAME = (name) => {
    const n = String(name || '');
    return !!n && !/unblock/i.test(n) && /block/i.test(n) && /mutation/i.test(n);
  };
  globalThis.CB_IS_DEV_BUILD = isDevBuild;
  globalThis.CB_DEFAULT_SETTINGS = DEFAULT_SETTINGS;
})();
