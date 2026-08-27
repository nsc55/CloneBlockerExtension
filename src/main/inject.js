/**
 * MAIN-world content script.
 *
 * Runs in the page's own JavaScript realm at document_start, BEFORE Meta's
 * bootstrap code executes. That timing is what makes the module-registry hook
 * below possible.
 *
 * Why MAIN world at all (three things the ISOLATED world cannot do):
 *   1. window.require / __d  -- Meta's internal module registry lives on the
 *      page's window. The isolated world has a different window object.
 *   2. React fiber expandos  -- page scripts set __reactFiber$xxx on DOM nodes.
 *      Each world gets its own JS wrapper for a DOM node, so expandos set by
 *      the page are invisible to the isolated world.
 *   3. The live Relay environment + store, which is where author IDs, usernames
 *      and current block state actually live.
 *
 * What this file must NOT do: touch chrome.* (unavailable in MAIN world) or
 * fetch our own server (the page's CSP connect-src would block it). Both happen
 * on the other side of the bridge.
 *
 * SAFETY: this script never blocks anyone on its own. It acts only on an
 * explicit PLATFORM_BLOCK request from the isolated world, which the service
 * worker rate-limits and which is disabled by default.
 */
(function () {
  'use strict';

  const MARK = '__cloneblocker_bridge__';
  const MSG = {
    MAIN_READY: 'main:ready',
    HELLO: 'iso:hello',
    HELLO_ACK: 'main:hello-ack',
    RESOLVE_IDS: 'iso:resolve-ids',
    PLATFORM_BLOCK: 'iso:platform-block',
    PROBE_CAPABILITY: 'iso:probe',
    DUMP_MODULES: 'iso:dump-modules',
    SET_CONFIG: 'iso:set-config',
    IDENTITY: 'main:identity',
    STORE_SNAPSHOT: 'main:store-snapshot',
    BLOCK_RESULT: 'main:block-result',
    CAPABILITY: 'main:capability',
    MODULES: 'main:modules',
    VIEWER: 'main:viewer'
  };

  const IS_THREADS = /(^|\.)threads\.(net|com)$/.test(location.hostname);
  const PLATFORM = IS_THREADS ? 'threads' : 'facebook';

  // Nonces of every isolated-world peer that has completed a handshake.
  //
  // A single nonce assumed exactly one peer. In practice a page can carry more
  // than one content-script instance -- an extension reload while the tab is
  // open, or a re-registration -- and then the last handshake silently won:
  // every request from the other peer failed the nonce check and was dropped
  // with no reply, which the caller could only observe as an unexplained
  // timeout.
  const peerNonces = new Set();
  let debug = false;
  const log = (...a) => { if (debug) console.debug('[CloneBlocker/main]', ...a); };

  // ==========================================================================
  // 1. Module registry hook.
  //
  // Meta's bundles register modules by calling __d(name, deps, factory, ...).
  // We install a property trap so that the moment their bootstrap assigns
  // window.__d, we wrap it in a Proxy. A Proxy (rather than a plain wrapper
  // function) matters: their runtime attaches properties to __d, and a Proxy
  // forwards all property access to the real function untouched.
  //
  // We only record names here. Module factories are never executed -- require()
  // is called lazily, and only for the few modules we actually need.
  // ==========================================================================
  // Shared across instances of this script.
  //
  // A page can end up with more than one copy of the content script (extension
  // reload with the tab open, re-registration). Each copy re-trapping window.__d
  // meant the later one replaced the earlier one's setter and BOTH ended up
  // recording nothing -- which is why the index kept reading as 0 modules while
  // require() still worked. Install once, then share.
  // Non-enumerable, so a page script walking window's own keys does not find
  // it. Not hiding -- a script that patches fetch and XHR (below) is
  // detectable by anyone who looks for that, and this extension changes the
  // page visibly besides -- but nothing here should be cheaper to enumerate
  // than it needs to be, given who might want to know who has this installed.
  const SHARED = '__TQ_MODULE_INDEX__';
  if (!window[SHARED]) {
    Object.defineProperty(window, SHARED, {
      value: { modules: new Set(), graphql: new Set(), installed: false },
      enumerable: false, configurable: true, writable: true
    });
  }
  const shared = window[SHARED];
  const moduleIndex = shared.modules;
  const graphqlModules = shared.graphql;
  let realD = null;

  function recordModule(name) {
    if (typeof name !== 'string') return;
    moduleIndex.add(name);
    if (name.endsWith('.graphql')) graphqlModules.add(name);
    // The site has just loaded its block mutation -- which happens when the
    // person opens its own block dialog, and at no other time. Read the doc_id
    // out of it while it is here: one natural encounter is then enough for this
    // browser to block from any tab afterwards, with the module long gone.
    if (/blockmutation/i.test(name) && !/unblock/i.test(name)) scheduleDocIdReport();
  }

  // Debounced, because module registration arrives in bursts, and delayed,
  // because a module that has just been DEFINED is not yet executable -- its
  // own dependencies may still be registering.
  let docIdReportTimer = null;
  let lastDocIdReport = '';
  function scheduleDocIdReport() {
    if (docIdReportTimer) return;
    docIdReportTimer = setTimeout(() => {
      docIdReportTimer = null;
      try {
        const found = {};
        for (const c of docIdCandidates()) if (c.source === 'module') found[c.name] = c.docId;
        const sig = JSON.stringify(found);
        if (sig === '{}' || sig === lastDocIdReport) return;
        lastDocIdReport = sig;
        post(MSG.CAPABILITY, { docIds: found });
      } catch (e) { /* observation must never break the page */ }
    }, 1500);
  }

  let proxyCache = null, proxyTarget = null;
  function makeProxy(target) {
    return new Proxy(target, {
      apply(t, thisArg, args) {
        try { recordModule(args[0]); } catch (e) { /* never break the page */ }
        return Reflect.apply(t, thisArg, args);
      }
    });
  }
  function makeProxyCached(target) {
    if (proxyTarget === target && proxyCache) return proxyCache;
    proxyTarget = target;
    proxyCache = makeProxy(target);
    return proxyCache;
  }

  function installModuleHook() {
    // Another copy of this script already owns the trap and is filling the
    // shared index; re-trapping would only clobber it.
    if (shared.installed) return;
    shared.installed = true;
    const existing = Object.getOwnPropertyDescriptor(window, '__d');
    if (existing && typeof existing.value === 'function') {
      // Late injection: wrap what is already there.
      realD = existing.value;
      try {
        Object.defineProperty(window, '__d', {
          configurable: true, writable: true, value: makeProxy(realD)
        });
      } catch (e) { log('late wrap failed', e); }
      return;
    }
    try {
      Object.defineProperty(window, '__d', {
        configurable: true,
        get() { return realD ? makeProxyCached(realD) : undefined; },
        set(v) { realD = v; }
      });
    } catch (e) {
      console.warn('[CloneBlocker] could not hook __d:', e);
    }
  }

  installModuleHook();

  // ==========================================================================
  // 2. Safe access to Meta's internal modules.
  // ==========================================================================
  function req(name) {
    try {
      if (typeof window.require !== 'function') return null;
      const m = window.require(name);
      return m && m.__esModule && m.default !== undefined ? m.default : m;
    } catch (e) { return null; }
  }

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** Live tokens. Every one has a regex fallback against the HTML, because the
   *  module names get renamed from time to time. */
  function getTokens() {
    // These tokens are only ever emitted inside inline <script> blocks, so scan
    // those rather than the whole document.
    //
    // documentElement.innerHTML serialises every node on the page. On a feed
    // scrolled to a thousand-odd posts that is tens of megabytes of string
    // materialisation, and it grows without bound as the user scrolls -- long
    // enough to stall the synchronous capability probe past the bridge's
    // timeout, which surfaced as an unexplained "MAIN world timed out". Script
    // text is a small, roughly constant slice of the same data.
    let cachedHtml = null;
    const html = () => {
      if (cachedHtml !== null) return cachedHtml;
      let acc = '';
      try {
        const scripts = document.querySelectorAll('script:not([src])');
        for (let i = 0; i < scripts.length; i++) {
          const t = scripts[i].textContent;
          if (!t) continue;
          acc += t;
          if (acc.length > 8e6) break;   // hard ceiling; tokens appear early
        }
      } catch (e) { /* fall through to empty */ }
      cachedHtml = acc;
      return cachedHtml;
    };
    const rx = (re) => { const m = html().match(re); return m ? m[1] : null; };

    const dtsgMod = req('DTSGInitialData') || req('DTSG_ASYNC') || {};
    const lsdMod = req('LSD') || {};
    const cu = req('CurrentUserInitialData') || {};

    const fb_dtsg =
      dtsgMod.token ||
      (req('DTSGInitData') || {}).token ||
      rx(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
      rx(/\["DTSGInitData",\[\],\{"token":"([^"]+)"/) ||
      rx(/name="fb_dtsg"\s+value="([^"]+)"/) ||
      null;

    const lsd = lsdMod.token || rx(/"LSD",\[\],\{"token":"([^"]+)"/) || null;

    // Who is signed in, resolved per platform.
    //
    // Threads runs on Instagram's identity, not Facebook's: there is no c_user
    // cookie, and CurrentUserInitialData -- a Facebook module -- is present but
    // reports USER_ID "0". The authoritative value is the ds_user_id cookie.
    // Reading only the Facebook signals made a signed-in Threads session look
    // signed out, which silently emptied actor_id/av on every request built
    // from it.
    let viewerId = null;
    if (IS_THREADS) {
      viewerId = cookie('ds_user_id') ||
                 rx(/"ds_user_id":"(\d+)"/) ||
                 rx(/"viewerId":"(\d+)"/) ||
                 null;
    }
    if (!viewerId) {
      viewerId = cu.USER_ID || cu.ACCOUNT_ID || null;
      if (!viewerId || viewerId === '0') {
        viewerId = cookie('c_user') || cookie('ds_user_id') || rx(/"USER_ID":"(\d+)"/) || null;
      }
    }
    if (viewerId === '0' || viewerId === '') viewerId = null;

    return {
      fb_dtsg,
      lsd,
      viewerId,
      csrf: cookie('csrftoken'),
      appId: (req('SiteData') || {}).app_id ||
             (IS_THREADS ? '238260118697367' : null) ||
             rx(/"X-IG-App-ID"\s*:\s*"(\d+)"/),
      // These two are only nice-to-have, so they must never be the reason the
      // page gets serialised. Fall back to the known-good constant first and
      // scan only if the module actually had nothing.
      asbd: (req('SiteData') || {}).asbd_id || '359341',
      rev: (req('SiteData') || {}).client_revision || null
    };
  }

  /** The active Relay environment. Facebook uses the Comet one; Threads runs a
   *  separate "Barcelona" environment (Threads' internal codename). Both
   *  modules exist on both sites, so we pick whichever store actually has
   *  records in it. */
  let cachedEnv = null;

  function getRelayEnvironment() {
    // Picking the environment means enumerating every record in up to three
    // stores. That is fine once, but this runs on a 15-second sweep and on
    // every identity probe, so the choice is cached. Which environment is
    // active never changes for the life of a document; only its contents do,
    // and the caller re-reads those.
    if (cachedEnv && cachedEnv.env) {
      let count = cachedEnv.count;
      try { count = cachedEnv.env.getStore().getSource().getRecordIDs().length; } catch (e) { /* keep last */ }
      cachedEnv.count = count;
      return cachedEnv;
    }
    const candidates = IS_THREADS
      ? ['BarcelonaRelayEnvironment', 'CometRelayEnvironment', 'RelayFBCometEnvironment']
      : ['CometRelayEnvironment', 'RelayFBCometEnvironment', 'BarcelonaRelayEnvironment'];
    let best = null, bestCount = -1;
    for (const name of candidates) {
      const env = req(name);
      if (!env || typeof env.getStore !== 'function') continue;
      let count = 0;
      try { count = env.getStore().getSource().getRecordIDs().length; } catch (e) { count = 0; }
      if (count > bestCount) { best = { name, env, count }; bestCount = count; }
    }
    // Only settle on a choice once a store has actually been populated --
    // early in page load every candidate is legitimately empty.
    if (best && best.count > 0) cachedEnv = best;
    return best;
  }

  // ==========================================================================
  // 3. Identity resolution.
  //
  // Turning a rendered post into "which profile ID wrote this" is the hard part
  // of the whole extension. Three independent sources, best first.
  // ==========================================================================

  /** (a) Relay store sweep: authoritative id <-> username pairs, plus current
   *  block state, for everything currently rendered. */
  function sweepRelayStore() {
    const found = [];
    const envInfo = getRelayEnvironment();
    if (!envInfo) return found;
    let source;
    try { source = envInfo.env.getStore().getSource(); } catch (e) { return found; }
    let ids;
    try { ids = source.getRecordIDs(); } catch (e) { return found; }

    for (const key of ids) {
      let r;
      try { r = source.get(key); } catch (e) { continue; }
      if (!r || typeof r !== 'object') continue;
      const tn = r.__typename;
      if (!tn || !/User|Actor|Profile/i.test(tn)) continue;

      const id = r.id || r.pk || r.pk_id ||
                 (typeof key === 'string' && key.includes(':') ? key.split(':').pop() : null);
      if (!id || !/^\d+$/.test(String(id))) continue;

      const username = r.username || r.short_name || r.url_username || null;
      let blocking = null;
      try {
        const fs = r.friendship_status;
        if (fs && typeof fs === 'object' && '__ref' in fs) {
          const sub = source.get(fs.__ref);
          if (sub && typeof sub.blocking === 'boolean') blocking = sub.blocking;
        } else if (fs && typeof fs.blocking === 'boolean') {
          blocking = fs.blocking;
        }
      } catch (e) { /* optional */ }

      found.push({ id: String(id), username, name: r.name || null, blocking });
    }
    return found;
  }

  /** (b) React fiber walk: for a specific DOM node, find the author id that
   *  Comet/Barcelona attached to the React props of that subtree. */
  const FIBER_KEY_RE = /^__reactFiber\$|^__reactInternalInstance\$/;
  const PROPS_KEY_RE = /^__reactProps\$/;

  function fiberFromNode(node) {
    for (const k in node) {
      if (FIBER_KEY_RE.test(k)) return node[k];
    }
    return null;
  }

  const ID_BEARING_KEYS = ['actor', 'owner', 'author', 'user', 'profile', 'from',
                           'actors', 'story', 'node', 'post', 'media', 'comment',
                           'feedback', 'thread_item'];

  /** Bounded BFS through a props object graph looking for a user-shaped record.
   *  Hard bounds matter: these graphs are cyclic and very large. */
  function harvestIdsFromProps(root, budget) {
    const out = [];
    if (!root || typeof root !== 'object') return out;
    const seen = new Set();
    const queue = [[root, 0]];
    let visits = 0;
    const MAX_VISITS = budget || 900;
    const MAX_DEPTH = 9;

    while (queue.length && visits < MAX_VISITS) {
      const [obj, depth] = queue.shift();
      if (!obj || typeof obj !== 'object' || depth > MAX_DEPTH) continue;
      if (seen.has(obj)) continue;
      seen.add(obj);
      visits++;

      const tn = obj.__typename;
      const rawId = obj.id != null ? obj.id
                  : obj.pk != null ? obj.pk
                  : obj.userID != null ? obj.userID
                  : obj.user_id != null ? obj.user_id
                  : obj.profile_id;
      const uname = obj.username || obj.short_name || obj.url_username;

      if (rawId != null && /^\d{5,}$/.test(String(rawId))) {
        const looksUser = (tn && /User|Actor|Profile|Page/i.test(tn)) || !!uname;
        if (looksUser) out.push({ id: String(rawId), username: uname || null, typename: tn || null });
      } else if (typeof rawId === 'string') {
        // Comet often carries the opaque form base64("User:12345") instead.
        const decoded = decodeNodeId(rawId);
        if (decoded && /User|Actor|Profile|Page/i.test(decoded.typename)) {
          out.push({ id: decoded.id, username: uname || null, typename: decoded.typename });
        }
      }

      if (Array.isArray(obj)) {
        for (let i = 0; i < Math.min(obj.length, 25); i++) queue.push([obj[i], depth + 1]);
        continue;
      }
      for (const key of Object.keys(obj)) {
        if (key === 'stateNode' || key === 'return' ||
            key.startsWith('_owner') || key.startsWith('_store')) continue;
        const v = obj[key];
        if (!v || typeof v !== 'object') continue;
        // Prioritise keys that historically carry the author.
        if (ID_BEARING_KEYS.includes(key)) queue.unshift([v, depth + 1]);
        else queue.push([v, depth + 1]);
      }
    }
    return out;
  }

  /**
   * A Facebook comment's author, resolved from the Relay store by comment id.
   *
   * Facebook comments never carry the author's numeric id in their markup: the
   * link is a vanity URL (facebook.com/some.name) or a bare profile.php, the
   * fibers render from store refs rather than inline props, and the store's
   * User record for a comment author has a name but no username to key on. So
   * identifyNode/identityFromHrefs both come back empty, and a block against a
   * comment author had nothing to aim at.
   *
   * The store does hold it, exactly. The `comment_id` in the comment's own href
   * (base64 of "comment:<feedback>_<pk>") is the store's KEY for the Comment
   * record, whose author.__ref is the author's numeric id. Confirmed live: every
   * comment resolved by a direct key hit, name and id agreeing. A scan by the
   * decoded comment pk is kept as a fallback for any key-format drift.
   */
  function resolveCommentAuthor(commentId) {
    const cid = String(commentId || '');
    if (!cid) return null;
    const envInfo = getRelayEnvironment();
    if (!envInfo || !envInfo.env) return null;
    let src;
    try { src = envInfo.env.getStore().getSource(); } catch (e) { return null; }

    let rec = null;
    try { rec = src.get(cid); } catch (e) { /* not a key here */ }
    if (!rec || rec.__typename !== 'Comment') {
      let decoded = '';
      try { decoded = atob(cid); } catch (e) { /* not base64 */ }
      const pk = (decoded.match(/_(\d+)$/) || [])[1];
      let idsList;
      try { idsList = src.getRecordIDs(); } catch (e) { idsList = []; }
      for (const key of idsList) {
        let r;
        try { r = src.get(key); } catch (e) { continue; }
        if (!r || r.__typename !== 'Comment') continue;
        if (key === cid) { rec = r; break; }
        if (pk) {
          let kd = '';
          try { kd = atob(key); } catch (e) { /* ignore */ }
          if (kd.endsWith('_' + pk)) { rec = r; break; }
        }
      }
    }
    if (!rec || rec.__typename !== 'Comment') return null;

    const ref = rec.author && (rec.author.__ref || rec.author.id);
    if (ref == null) return null;
    let author = null;
    if (typeof ref === 'string') { try { author = src.get(ref); } catch (e) { /* ignore */ } }
    // author.__ref is itself the numeric id in current Comet; fall back to the
    // digits inside whatever the ref is.
    let id = (author && author.id) || (String(ref).match(/(\d{5,})/) || [])[1] || null;
    if (id == null || !/^\d{5,}$/.test(String(id))) return null;
    const username = (author && (author.username || author.short_name || author.url_username)) || null;
    return { id: String(id), username, name: (author && author.name) || null };
  }

  function identifyNode(node) {
    if (!node || node.nodeType !== 1) return [];
    const results = [];

    for (const k in node) {
      if (PROPS_KEY_RE.test(k)) {
        results.push(...harvestIdsFromProps(node[k], 400));
        break;
      }
    }
    // Walk a few fiber ancestors -- the author usually lives on a wrapper.
    let fiber = fiberFromNode(node);
    let hops = 0;
    while (fiber && hops < 14) {
      if (fiber.memoizedProps) results.push(...harvestIdsFromProps(fiber.memoizedProps, 500));
      if (results.length) break;
      fiber = fiber.return;
      hops++;
    }
    const seen = new Set();
    return results.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }

  const FB_RESERVED = /^(profile\.php|photo|photo\.php|watch|groups|pages|events|marketplace|reel|reels|stories|share|permalink|posts|videos|hashtag|search|messages|notifications|friends|settings|privacy|help|policies|login|reg|home|gaming|weather|fundraisers|saved|memories|bookmarks|ads|business|legal|terms|about|careers|people|places|games|live|media|story\.php|browse|allactivity|pages_feed|pg)$/i;

  /** (c) href parsing -- last resort, and the only source that works for plain
   *  server-rendered markup with no React attached. */
  function identityFromHrefs(node) {
    const out = [];
    let anchors = (node.matches && node.matches('a[href]'))
      ? [node]
      : Array.from(node.querySelectorAll ? node.querySelectorAll('a[href]') : []);

    // Same narrowing as the isolated-world pass: we want whoever WROTE this,
    // not everyone linked from inside it. Without this a blocked profile
    // leaving a comment would take the whole surrounding post down.
    if (anchors.length > 1) {
      const own = anchors.filter((a) => {
        if (!a.closest) return true;
        const holder = a.closest('div[role="article"], [aria-label^="Comment by"]');
        return !holder || holder === node;
      });
      const byline = own.filter(a => a.closest && a.closest('h1, h2, h3, h4, strong'));
      anchors = byline.length ? byline : own.slice(0, 3);
    }

    for (const a of anchors.slice(0, 40)) {
      const href = a.getAttribute('href') || '';
      let m;
      if ((m = href.match(/profile\.php\?id=(\d+)/))) {
        out.push({ id: m[1], username: null });
      } else if ((m = href.match(/^https?:\/\/[^/]*threads\.(?:net|com)\/@([A-Za-z0-9._]+)/)) ||
                 (m = href.match(/^\/@([A-Za-z0-9._]+)/))) {
        out.push({ id: null, username: m[1] });
      } else if ((m = href.match(/^https?:\/\/[^/]*facebook\.com\/([A-Za-z0-9.\-]+)(?:[/?#]|$)/)) ||
                 (m = href.match(/^\/([A-Za-z0-9.\-]+)(?:[/?#]|$)/))) {
        if (!FB_RESERVED.test(m[1])) out.push({ id: null, username: m[1] });
      }
    }
    const seen = new Set();
    return out.filter(r => {
      const k = r.id || '@' + r.username;
      return seen.has(k) ? false : (seen.add(k), true);
    });
  }

  // ==========================================================================
  // 4. Request observation ("capture mode").
  //
  // Meta rotates GraphQL doc_ids constantly and gates operations behind ~30
  // __relay_internal__pv__*relayprovider variables, so any hardcoded request
  // goes stale quickly. Instead we watch real traffic: when the user blocks
  // someone through the normal UI once, we capture that exact request and can
  // replay its shape later against a different target id.
  // ==========================================================================
  const captured = [];
  // Depth counter around our OWN block attempts. The network observer is a
  // global fetch/XHR hook, so without it the extension records its own
  // requests -- including ones that just failed with a 404 -- and stores them
  // as the "learned" template, overwriting a good one captured from the real UI.
  let selfRequestDepth = 0;
  function asSelfRequest(fn) {
    selfRequestDepth++;
    // Released on the next macrotask: the hook runs synchronously when fetch is
    // called, so the counter only has to survive the call itself.
    try { return fn(); } finally { setTimeout(() => { selfRequestDepth--; }, 0); }
  }
  // Templates seen before the bridge handshake. Posting one then would carry a
  // null nonce and be dropped by the isolated world, silently losing exactly
  // the request capture mode exists to collect.
  const pendingCaptures = [];
  const BLOCKY = /block/i;

  function headersToObject(h) {
    const o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach((v, k) => { o[k] = v; }); return o; }
      if (Array.isArray(h)) { for (const pair of h) o[pair[0]] = pair[1]; return o; }
      Object.assign(o, h);
    } catch (e) { /* ignore */ }
    return o;
  }

  function noteRequest(url, method, body, headers) {
    try {
      if (selfRequestDepth > 0) return;   // never learn from ourselves
      if (!/graphql|\/api\/v1\/(friendships|users)/i.test(url || '')) return;
      let params = null;
      if (typeof body === 'string') {
        try { params = new URLSearchParams(body); } catch (e) { /* not urlencoded */ }
      } else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        params = body;
      } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        params = new URLSearchParams();
        for (const pair of body.entries()) params.append(pair[0], String(pair[1]));
      }

      const friendly = params ? params.get('fb_api_req_friendly_name') : null;
      const rootField = headers && (headers['x-root-field-name'] || headers['X-Root-Field-Name']);
      // A persisted-query request names its operation, and the name is the
      // whole test: it has to be a block MUTATION. Matching the word "block"
      // anywhere -- name, URL, root field, even the variables -- is how
      // RTWebCallBlockSettingHooksQuery, a read of Messenger's call-blocking
      // setting that Facebook fires on every page load, was recorded as the
      // learned block template (see isBlockMutationName). A request with no
      // operation name is a REST call, and there the path has to say block.
      const isBlockish = friendly
        ? isBlockMutationName(friendly)
        : ((BLOCKY.test(url) || BLOCKY.test(rootField || '')) &&
           !/unblock/i.test(String(url) + String(rootField || '')));
      if (!isBlockish) return;

      // Guess which id in the variables was the target, so a replay knows what
      // to swap.
      let capturedTargetId = null;
      if (params) {
        const v = params.get('variables') || '';
        const ids = v.match(/\d{5,}/g) || [];
        const viewer = getTokens().viewerId;
        capturedTargetId = ids.find(x => x !== viewer) || null;
      }

      const template = {
        platform: PLATFORM,
        url: new URL(url, location.origin).href,
        method: method || 'POST',
        friendlyName: friendly,
        docId: params ? params.get('doc_id') : null,
        variables: params ? params.get('variables') : null,
        rootField: rootField || null,
        capturedTargetId,
        // Keep every field so a replay reproduces the request faithfully.
        fields: params ? Object.fromEntries(params.entries()) : null,
        headers: headers || null
      };
      captured.push(template);
      log('captured block-shaped request', template.friendlyName || template.url);
      if (!peerNonces.size) pendingCaptures.push(template);
      else post(MSG.CAPABILITY, { capturedTemplate: template });
    } catch (e) { /* observation must never break the page */ }
  }

  function installNetworkObserver() {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url);
          const method = (init && init.method) || (input && input.method) || 'GET';
          const body = (init && init.body !== undefined) ? init.body : (input && input.body);
          const hdrs = headersToObject((init && init.headers) || (input && input.headers));
          if (String(method).toUpperCase() === 'POST') noteRequest(url, method, body, hdrs);
        } catch (e) { /* ignore */ }
        return origFetch.apply(this, arguments);
      };
    }

    // Meta's older networking layer still uses XHR on some surfaces, so hooking
    // only fetch would miss requests.
    const OrigXHR = window.XMLHttpRequest;
    if (typeof OrigXHR === 'function' && OrigXHR.prototype) {
      const openOrig = OrigXHR.prototype.open;
      const sendOrig = OrigXHR.prototype.send;
      const setHeaderOrig = OrigXHR.prototype.setRequestHeader;
      OrigXHR.prototype.open = function (method, url) {
        try {
          Object.defineProperty(this, '__tq', {
            value: { method: method, url: url, headers: {} },
            enumerable: false, configurable: true, writable: true
          });
        } catch (e) { /* ignore */ }
        return openOrig.apply(this, arguments);
      };
      OrigXHR.prototype.setRequestHeader = function (k, v) {
        try { if (this.__tq) this.__tq.headers[String(k).toLowerCase()] = v; } catch (e) { /* ignore */ }
        return setHeaderOrig.apply(this, arguments);
      };
      OrigXHR.prototype.send = function (body) {
        try {
          const i = this.__tq;
          if (i && String(i.method).toUpperCase() === 'POST') noteRequest(i.url, i.method, body, i.headers);
        } catch (e) { /* ignore */ }
        return sendOrig.apply(this, arguments);
      };
    }
  }
  installNetworkObserver();

  // ==========================================================================
  // 5. Block strategies, best-first.
  // ==========================================================================

  /** Find candidate block-mutation modules in the live registry. */
  function findBlockMutationModules() {
    const cands = [];

    // Ask for the operations we know by name.
    //
    // Prefer the registry: require() on a module Meta has not defined is not
    // free -- it routes through their ErrorUtils and emits a "Requiring unknown
    // module" report inside their own telemetry. Doing that for every candidate
    // name on every capability probe is both noisy and needlessly conspicuous,
    // so only ask for names the page has actually registered.
    //
    // The blind path is kept for the case where the index is empty (our __d
    // trap never got installed), because that is exactly when we would
    // otherwise find nothing at all -- but it is the exception, not the rule.
    const indexUsable = moduleIndex.size > 0;
    for (const k of (KNOWN_BLOCK_OPS[PLATFORM] || [])) {
      for (const suffix of ['.graphql', '.threads.graphql', '_facebookRelayOperation']) {
        const name = k.name + suffix;
        if (cands.indexOf(name) !== -1) continue;
        if (indexUsable && !moduleIndex.has(name)) continue;
        const mod = req(name);
        const r = mod && (mod.default || mod);
        if (r && r.kind === 'Request' && r.params) cands.push(name);
      }
    }

    for (const name of graphqlModules) {
      if (!/block/i.test(name)) continue;
      if (!/mutation/i.test(name)) continue;
      if (cands.indexOf(name) === -1) cands.push(name);
    }
    const known = (KNOWN_BLOCK_OPS[PLATFORM] || []).map(k => k.name);
    const score = (n) => {
      let s = 0;
      // An exact match against an operation we already know the shape of is
      // worth more than every heuristic combined.
      const knownIdx = known.findIndex(k => n.indexOf(k) !== -1);
      if (knownIdx >= 0) s += 100 - knownIdx;
      if (/unblock/i.test(n)) s -= 50;
      if (/user|profile|account|person/i.test(n)) s += 10;
      if (/^use/.test(n)) s += 2;
      if (IS_THREADS && /barcelona|^useTH|^TH/i.test(n)) s += 8;
      if (!IS_THREADS && /comet|fb/i.test(n)) s += 8;
      if (/\.threads\.graphql$/.test(n)) s += IS_THREADS ? 3 : -3;
      return s;
    };
    return cands
      .sort((a, b) => score(b) - score(a))
      .map((name) => {
        let params = null;
        try {
          const mod = req(name);
          const r = mod && (mod.default || mod);
          if (r && r.params) params = { id: r.params.id, name: r.params.name, kind: r.params.operationKind };
        } catch (e) { /* ignore */ }
        return { name, params };
      })
      .filter(c => !c.params || c.params.kind === 'mutation');
  }

  function jazoest(dtsg) {
    // Meta's trivial checksum over the dtsg bytes; the server rejects a mismatch.
    let sum = 0;
    for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
    return '2' + sum;
  }

  /**
   * Known operation names for "block a user", newest-known-good first.
   *
   * These are only *hints* -- used to rank discovered modules and to name a
   * hand-built request. The doc_id that goes with them is NEVER hardcoded: Meta
   * rotates persisted-query ids roughly monthly, so it is always read from the
   * live module at call time, or supplied by your server via docIdOverrides.
   */
  const KNOWN_BLOCK_OPS = {
    facebook: [
      // Profile "..." -> Block. Variables shape verified against current
      // third-party implementations of this same mutation.
      {
        name: 'ProfileCometActionBlockUserMutation',
        vars: (target, viewer) => ({
          collectionID: null,
          hasCollectionAndSectionID: false,
          input: {
            blocksource: 'PROFILE',
            should_apply_to_later_created_profiles: false,
            user_id: Number(target),
            actor_id: String(viewer || ''),
            client_mutation_id: String(Math.floor(performance.now()) % 100000)
          },
          scale: 3,
          sectionID: null,
          isPrivacyCheckupContext: false
        })
      },
      // Settings -> Blocking. Same endpoint takes an explicit action verb.
      {
        name: 'BlockingSettingsBlockMutation',
        vars: (target, viewer) => ({
          input: {
            block_action: 'BLOCK',
            setting: 'USER',
            target_id: String(target),
            actor_id: String(viewer || ''),
            client_mutation_id: '1'
          },
          profile_picture_size: 36
        })
      },
      {
        name: 'useGroupsCometBlockUserMutation',
        vars: (target, viewer) => ({
          input: { blockee_id: String(target), actor_id: String(viewer || ''), client_mutation_id: '1' }
        })
      }
    ],
    threads: [
      // Observed directly from threads.com on 2026-08-20 by watching a real
      // block leave the browser. Note how little it resembles the Facebook
      // shape: the variables are flat rather than wrapped in `input`, there is
      // no actor_id at all, and the operation is prefixed useTH, not Barcelona.
      // Every one of those guesses was wrong before this was captured.
      {
        name: 'useTHUserBlockMutation',
        vars: (target) => ({
          user_id: String(target),
          container_module: 'ig_text_feed_profile',
          media_id: null,
          ranking_info_token: null,
          barcelona_source_quote_post_id: null,
          barcelona_source_reply_id: null,
          is_messaging_nua: null,
          consistent_thread_fbid: null
        })
      },
      {
        name: 'BarcelonaBlockUserMutation',
        vars: (target, viewer) => ({
          input: { user_id: String(target), actor_id: String(viewer || ''), client_mutation_id: '1' }
        })
      }
    ]
  };

  /**
   * Is this operation name the block mutation, as opposed to something that
   * merely has "block" in it?
   *
   * The distinction is the whole bug behind 1.0.4's "no data in GraphQL
   * response" on Facebook. Facebook fires plenty of QUERIES whose name
   * contains the word -- RTWebCallBlockSettingHooksQuery, a read of the
   * Messenger call-blocking setting, goes out on every page load -- and the
   * capture path matched on the word alone. One of those became the learned
   * template, its doc_id was promoted into the ladder, and on any ordinary
   * Facebook tab it was the ONLY candidate: every block attempt executed a
   * settings query and failed on its answer ({viewer:{call_blocked_until}}).
   *
   * So a name is believed only if it is one of the operations known to be a
   * block, or is spelled as one: "block" and "mutation" both present and
   * "unblock" absent. Every known block operation on both platforms satisfies
   * the spelling rule too.
   */
  function isBlockMutationName(name) {
    const n = String(name || '');
    if (!n || /unblock/i.test(n)) return false;
    if ((KNOWN_BLOCK_OPS[PLATFORM] || []).some(k => n.indexOf(k.name) !== -1)) return true;
    return /block/i.test(n) && /mutation/i.test(n);
  }

  /** A captured template is only ever USED if it carries a persisted-query id
   *  under a name that passes the test above. Anything else is kept out of
   *  the ladder and out of the doc_id candidates entirely. */
  function usableTemplate(t) {
    return !!(t && t.docId && isBlockMutationName(t.friendlyName));
  }

  /** Candidate variable shapes for a Relay commitMutation, best-first.
   *  We try the shape whose known operation name matches the module, then the
   *  other known shapes, then generic fallbacks. Relay rejects a wrong shape
   *  with a "missing_required_variable"-style error, which we detect and retry
   *  rather than treating as a hard failure. */
  function buildVariableShapes(targetId, moduleName) {
    const viewerId = getTokens().viewerId;
    const known = KNOWN_BLOCK_OPS[PLATFORM] || [];
    const shapes = [];

    const matching = known.filter(k => moduleName && moduleName.indexOf(k.name) !== -1);
    const rest = known.filter(k => shapes.indexOf(k) === -1 && matching.indexOf(k) === -1);
    for (const k of matching.concat(rest)) {
      try { shapes.push(k.vars(targetId, viewerId)); } catch (e) { /* ignore */ }
    }

    // Generic fallbacks for operations we have never seen before.
    shapes.push(
      { input: { blockee_id: String(targetId), actor_id: viewerId, client_mutation_id: '1' } },
      { input: { blocked_user_id: String(targetId), actor_id: viewerId, client_mutation_id: '1' } },
      { input: { user_id: String(targetId), actor_id: viewerId, client_mutation_id: '1' } },
      { userID: String(targetId) },
      { user_id: String(targetId) },
      { target_user_id: String(targetId) }
    );
    return shapes;
  }

  /** Meta encodes GraphQL node ids as base64("<TypeName>:<numericID>").
   *  Recovering the numeric id from one is often the only way to key a
   *  vanity-URL profile. */
  function decodeNodeId(v) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/=]{8,}$/.test(v)) return null;
    let decoded;
    try { decoded = atob(v); } catch (e) { return null; }
    const m = decoded.match(/^([A-Za-z]+):(\d{5,})$/);
    return m ? { typename: m[1], id: m[2] } : null;
  }

  function stripForbidden(h) {
    // The browser refuses to let us set these; leaving them in throws.
    const FORBIDDEN = /^(host|content-length|origin|referer|cookie|connection|user-agent|sec-|accept-encoding|proxy-|:)/i;
    const out = {};
    for (const k of Object.keys(h || {})) if (!FORBIDDEN.test(k)) out[k] = h[k];
    return out;
  }

  // Fields that identify US, never the person being blocked. Overwriting one
  // of these with the target id produces a malformed request that either fails
  // or expresses the wrong relationship.
  const VIEWER_KEYS = /^(actor_id|actorID|av|__user|viewer_id|viewerID|session_id|client_mutation_id|_uid|_uuid)$/i;
  // Fields that plausibly denote the block target.
  const TARGET_KEYS = /^(blockee_id|blockeeID|blocked_user_id|target_id|target_user_id|user_id|userID|profile_id|profileID|pk)$/i;

  function replaceIdDeep(obj, oldId, newId) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string' || typeof v === 'number') {
        const sv = String(v);
        if (oldId) {
          // We know exactly which id was the target, so match on the value and
          // leave everything else alone.
          if (sv === oldId) obj[k] = newId;
        } else if (TARGET_KEYS.test(k) && !VIEWER_KEYS.test(k) && /^\d{5,}$/.test(sv)) {
          // No captured target to match against -- fall back to key names, but
          // only ones that clearly mean "the other person".
          obj[k] = typeof v === 'number' ? Number(newId) : newId;
        }
      } else if (v && typeof v === 'object') {
        replaceIdDeep(v, oldId, newId);
      }
    }
  }

  /**
   * Decide whether a block request actually succeeded.
   *
   * This FAILS CLOSED: success has to be positively proven by the response
   * body, not merely inferred from a 2xx status. That distinction is not
   * academic -- a signed-out request to the Instagram friendships endpoint
   * answers 200 with a login payload, and treating that as success made the
   * extension report a block that never happened, consume rate-limit budget for
   * it, and retire the target permanently so it would never be retried.
   *
   * @param expect 'rest' | 'graphql' -- what a success looks like for this path.
   */
  function interpretResponse(status, text, strategy, expect) {
    const body = String(text || '');
    // Meta prefixes some JSON with an anti-hijacking token.
    const clean = body.replace(/^\s*for\s*\(;;\);/, '').trim();
    const head = clean.slice(0, 600);

    let json = null;
    // Parse the WHOLE body: parsing a truncated head always throws, which used
    // to push large valid responses into the "not JSON" path.
    try { json = JSON.parse(clean); } catch (e) { /* not JSON, or a stream */ }

    const fail = (detail, extra) =>
      Object.assign({ ok: false, strategy, status, detail }, extra || {});

    if (status === 429 || /rate.?limit|too many requests|please wait a few minutes/i.test(clean)) {
      return fail('rate limited', { rateLimited: true });
    }
    if (/checkpoint_required|challenge_required/i.test(clean)) {
      return fail('account checkpoint/challenge -- stop automation and resolve it in the UI',
                  { checkpoint: true });
    }
    if (/login_required|not_authenticated|please log in|log in to continue/i.test(clean) ||
        status === 401 || status === 403) {
      return fail('not signed in (the session was rejected)', { loggedOut: true });
    }
    // An HTML body from an API endpoint means we were served a page -- almost
    // always the login wall -- not an API answer.
    if (/^\s*(<!doctype|<html)/i.test(clean)) {
      return fail('server returned an HTML page, not an API response (likely signed out)',
                  { loggedOut: true });
    }
    // One response, or several. Facebook's Relay network layer hands its
    // subscriber an ARRAY of payloads -- [{data, extensions}] -- confirmed on
    // a live page, where a plain query came back as exactly that. Reading
    // only `json.data` meant every Facebook answer arriving this way, the
    // successful ones included, was judged "no data in GraphQL response": the
    // relay-network tier could not report a success on Facebook at all.
    const payloads = Array.isArray(json) ? json : (json ? [json] : []);
    const errored = payloads.find(p => p && p.errors && p.errors.length);
    if (errored) {
      return fail(errored.errors.map(e => e.message || e.summary).join('; '));
    }

    if (expect === 'rest') {
      // Instagram's REST endpoints answer {"status":"ok"} on success.
      if (json && json.status === 'ok') return { ok: true, strategy, status, detail: 'status=ok' };
      if (json && json.status) return fail('status=' + json.status + ' ' + (json.message || ''));
      return fail('unrecognised REST response: ' + head);
    }

    if (expect === 'graphql') {
      // Relay answers with a data object; an empty or absent one is not
      // success. Any payload in the set carrying one counts -- a deferred
      // response puts the data in its first chunk and bookkeeping in the rest.
      const withData = payloads.find(p => p && p.data && typeof p.data === 'object' &&
                                          !Array.isArray(p.data) && Object.keys(p.data).length);
      if (withData) return { ok: true, strategy, status, detail: 'data returned' };
      return fail('no data in GraphQL response: ' + head);
    }

    return fail('unverified response: ' + head);
  }

  /** Strategy A -- drive Relay itself.
   *
   *  By far the most robust path: Relay fills in doc_id, every
   *  __relay_internal__pv__* provider variable, fb_dtsg, lsd and all the
   *  __dyn/__csr bookkeeping, and it updates the local store so the UI reflects
   *  the block immediately. A hand-built request gets none of that. */
  function blockViaRelay(targetId, moduleName, dryRun) {
    const RelayModern = req('RelayModern');
    const envInfo = getRelayEnvironment();
    if (!RelayModern || typeof RelayModern.commitMutation !== 'function') {
      return Promise.reject(new Error('RelayModern.commitMutation unavailable'));
    }
    if (!envInfo) return Promise.reject(new Error('no Relay environment'));

    const mod = req(moduleName);
    const mutation = mod && (mod.default || mod);
    if (!mutation || mutation.kind !== 'Request') {
      return Promise.reject(new Error('module ' + moduleName + ' is not a Relay Request'));
    }

    const variableShapes = buildVariableShapes(targetId, moduleName);

    if (dryRun) {
      return Promise.resolve({
        ok: true, dryRun: true, strategy: 'relay',
        module: moduleName,
        docId: mutation.params && mutation.params.id,
        operation: mutation.params && mutation.params.name,
        wouldSend: variableShapes[0]
      });
    }

    // Each rejected shape is a real mutation request against the account. Three
    // candidate modules times every shape would be a burst of dozens of writes
    // for one target -- exactly what rate limiting and automation detection
    // look for. Cap how many shapes a live run is allowed to try.
    const maxShapes = dryRun ? variableShapes.length : 3;

    return new Promise((resolve, reject) => {
      let idx = 0;
      const attempt = () => {
        if (idx >= Math.min(maxShapes, variableShapes.length)) {
          reject(new Error('no variable shape accepted after ' + idx + ' attempt(s)'));
          return;
        }
        const variables = variableShapes[idx++];
        let settled = false;

        // commitMutation is not guaranteed to call back. If Relay's network
        // layer rejects in a way that reaches neither onCompleted nor onError,
        // the promise would never settle and the caller would sit there until
        // its own timeout, reporting nothing useful. Bound each attempt.
        const guard = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('commitMutation did not call back within 20s (' + moduleName + ')'));
        }, 20000);
        const done = (fn) => (...args) => {
          clearTimeout(guard);
          fn(...args);
        };
        try {
          RelayModern.commitMutation(envInfo.env, {
            mutation,
            variables,
            onCompleted: done((response, errors) => {
              if (settled) return; settled = true;
              if (errors && errors.length) {
                if (/missing_required_variable|Variable/i.test(JSON.stringify(errors))) { attempt(); return; }
                reject(new Error(errors.map(e => e.message).join('; ')));
                return;
              }
              resolve({ ok: true, strategy: 'relay', module: moduleName,
                        operation: mutation.params && mutation.params.name,
                        response: safeClone(response) });
            }),
            onError: done((err) => {
              if (settled) return; settled = true;
              if (/missing_required_variable|Variable/i.test(String(err && err.message))) { attempt(); return; }
              reject(err instanceof Error ? err : new Error(String(err)));
            })
          });
        } catch (e) {
          clearTimeout(guard);
          if (settled) return; settled = true;
          if (idx < variableShapes.length) { settled = false; attempt(); } else reject(e);
        }
      };
      attempt();
    });
  }

  /** postMessage requires structured-cloneable data; Relay responses can carry
   *  exotic values, so round-trip through JSON and give up gracefully. */
  function safeClone(v) {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
  }

  /** An operation name and a persisted-query id, or nothing. Applied to every
   *  map that arrives from outside this file, here as well as where the list
   *  is published and where the worker stores it. */
  function sanitizeDocIds(map) {
    const out = {};
    if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
    for (const k of Object.keys(map)) {
      const v = String(map[k]);
      if (/^[A-Za-z0-9_]{1,120}$/.test(k) && /^[0-9]{6,24}$/.test(v)) out[k] = v;
    }
    return out;
  }

  /**
   * Every doc_id this page could block with, best first.
   *
   *   module    — read out of an operation node the page has actually loaded.
   *               Verified this page load; nothing beats it.
   *   learned   — remembered by this browser from a page load where the module
   *               WAS there, or from a block that actually succeeded. It has
   *               worked here before, which a value shipped to everyone has
   *               not, so it goes first of the two.
   *   supplied  — published with the blocklist. The owner's lever: when Meta
   *               rotates an id, one publish fixes every install that has
   *               never seen the module, and bootstraps a fresh one.
   *   captured  — watched leaving this browser in a real block request.
   */
  function docIdCandidates() {
    const out = [], seen = new Set();
    const add = (name, id, source) => {
      if (!name || !id) return;
      const key = name + ':' + id;
      if (seen.has(key)) return;
      if (!/^[A-Za-z0-9_]{1,120}$/.test(name) || !/^[0-9]{6,24}$/.test(String(id))) return;
      seen.add(key);
      out.push({ name, docId: String(id), source });
    };
    for (const c of findBlockMutationModules()) {
      if (c.params && c.params.id) add(c.params.name, c.params.id, 'module');
    }
    const known = KNOWN_BLOCK_OPS[PLATFORM] || [];
    for (const k of known) add(k.name, learnedDocIds[k.name], 'learned');
    for (const k of known) add(k.name, docIdOverrides[k.name], 'supplied');
    // Only a template that names the block mutation gets its doc_id in here.
    // A captured request that merely mentioned "block" used to be promoted
    // regardless, and on a tab with no module, nothing learned and nothing
    // published it was the whole ladder -- see isBlockMutationName.
    if (usableTemplate(learnedTemplate)) {
      const friendly = String(learnedTemplate.friendlyName || '');
      const match = known.find(k => friendly.indexOf(k.name) !== -1);
      add(match ? match.name : friendly, learnedTemplate.docId, 'captured');
    }
    return out;
  }

  /** The site's own network layer, if this page has one. */
  function relayNetwork() {
    const envInfo = getRelayEnvironment();
    if (!envInfo || !envInfo.env) return null;
    const net = typeof envInfo.env.getNetwork === 'function' ? envInfo.env.getNetwork() : null;
    return (net && typeof net.execute === 'function') ? net : null;
  }

  /**
   * Strategy A2 -- the site's own Relay NETWORK layer, driven with request
   * parameters we build.
   *
   * Meta ships the block mutation lazily, and it is genuinely unreachable by
   * name until the site renders its own block dialog: `Bootloader.loadModules`,
   * `requireLazy` and `JSResource` were each tried against a live signed-in
   * page and each returned nothing, because the loader needs a resource map
   * that only ships with the component. Strategy A therefore cannot run on a
   * tab where nobody has opened that dialog -- which is nearly every tab, and
   * is why the ladder used to end here telling the user to go and open a menu.
   *
   * The network layer needs no module. Its execute() takes plain
   * RequestParameters -- {id, name, operationKind} -- where the id is the
   * persisted-query doc_id. Given one from a source we trust, this hands the
   * site's own networking a request that IT composes: its endpoint, its
   * fb_dtsg and lsd, its headers, its bookkeeping. Confirmed against a live
   * page by executing a real query with parameters built from nothing but a
   * doc_id and getting data back.
   *
   * What Strategy A has and this does not: the provider variables Relay reads
   * off the operation node, and the store write that redraws the UI. The
   * Threads block mutation declares no provider variables (its captured
   * variable set is flat), and a block is server-side either way -- the UI
   * catches up on its next fetch.
   *
   * This is NOT the hand-built fallback below. That one composes the request
   * itself and guesses at headers, and was observed invalidating the session;
   * this asks the site's own code to compose it. That is why it is on by
   * default and the hand-built one is not.
   */
  function blockViaRelayNetwork(targetId, cand, dryRun) {
    const net = relayNetwork();
    if (!net) return Promise.reject(new Error('no Relay network layer on this page'));

    const shapes = buildVariableShapes(targetId, cand.name);
    const params = {
      id: String(cand.docId),
      name: cand.name,
      operationKind: 'mutation',
      text: null,
      metadata: {},
      cacheID: cand.name
    };

    if (dryRun) {
      return Promise.resolve({
        ok: true, dryRun: true, strategy: 'relay-network',
        module: null, docId: params.id, operation: cand.name,
        docIdSource: cand.source, wouldSend: shapes[0]
      });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const guard = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('the Relay network layer did not answer within 20s (' + cand.name + ')'));
      }, 20000);
      const once = (fn) => (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        fn(v);
      };
      const ok = once(resolve), no = once(reject);
      try {
        const obs = net.execute(params, shapes[0], { force: true });
        if (!obs || typeof obs.subscribe !== 'function') {
          no(new Error('execute() returned ' + typeof obs + ', not an observable'));
          return;
        }
        obs.subscribe({
          // Read fail-closed, exactly like every other strategy: a payload
          // carrying errors, a login wall, or an empty data object is a
          // failure however healthy the transport looked. Resolving rather
          // than rejecting keeps the rateLimited / checkpoint / loggedOut
          // flags, which the ladder above acts on.
          next: (payload) => {
            const verdict = interpretResponse(200, JSON.stringify(payload), 'relay-network', 'graphql');
            ok(Object.assign(verdict, {
              docId: params.id, operation: cand.name, docIdSource: cand.source,
              response: verdict.ok ? safeClone(payload) : undefined
            }));
          },
          // A server-side refusal arrives by ERRORING the observable, not by
          // delivering a payload with errors in it -- confirmed against a live
          // page, where an impossible target came back as "GraphQL operation
          // responded with error 4630001". So the same fail-closed reading has
          // to happen on this branch too, or a rate limit or a checkpoint
          // would read as a plain failure and the ladder would carry on into
          // exactly the wrong thing.
          error: (e) => {
            const msg = String((e && e.message) || e);
            const verdict = interpretResponse(200,
              JSON.stringify({ errors: [{ message: msg }] }), 'relay-network', 'graphql');
            ok(Object.assign(verdict, {
              docId: params.id, operation: cand.name, docIdSource: cand.source,
              // A doc_id Meta has rotated away from is worth forgetting rather
              // than retrying on every future target.
              docIdRejected: /doc_?id|persisted[_ ]query|unknown operation|no such operation/i.test(msg)
            }));
          },
          complete: () => no(new Error('the Relay network layer completed without answering'))
        });
      } catch (e) {
        no(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Strategy B -- replay a captured request with the target id swapped. */
  async function blockViaLearnedTemplate(targetId, template, dryRun) {
    if (!template || !template.fields) throw new Error('no learned template');
    const tokens = getTokens();
    const fields = Object.assign({}, template.fields);

    // Refresh the volatile bits; a stale token means a silent failure.
    if (fields.fb_dtsg && tokens.fb_dtsg) fields.fb_dtsg = tokens.fb_dtsg;
    if (fields.lsd && tokens.lsd) fields.lsd = tokens.lsd;
    if (fields.jazoest && tokens.fb_dtsg) fields.jazoest = jazoest(tokens.fb_dtsg);
    if (fields.av && tokens.viewerId) fields.av = tokens.viewerId;
    if (fields.__user && tokens.viewerId) fields.__user = tokens.viewerId;

    // Swap the target id inside the variables blob, preserving its structure.
    if (fields.variables) {
      let vars = null;
      try { vars = JSON.parse(fields.variables); } catch (e) { vars = null; }
      if (vars) {
        replaceIdDeep(vars, template.capturedTargetId || null, String(targetId));
        fields.variables = JSON.stringify(vars);
      }
    }

    const body = new URLSearchParams(fields).toString();
    const headers = Object.assign(
      { 'content-type': 'application/x-www-form-urlencoded' },
      stripForbidden(template.headers || {})
    );
    if (tokens.lsd) headers['x-fb-lsd'] = tokens.lsd;

    if (dryRun) {
      return { ok: true, dryRun: true, strategy: 'learned-template',
               url: template.url, friendlyName: template.friendlyName,
               docId: fields.doc_id, variables: fields.variables };
    }
    const res = await asSelfRequest(() => fetch(template.url, {
      method: 'POST', credentials: 'include', headers, body
    }));
    const text = await res.text();
    return interpretResponse(res.status, text, 'learned-template', 'graphql');
  }

  /** Strategy C -- Threads/Instagram-style REST endpoint.
   *
   *  Threads runs on Instagram's infrastructure and inherits the friendships
   *  API. The unsigned, cookie-authenticated web variants take a plain numeric
   *  pk and need no doc_id at all, which makes this the most durable path when
   *  it is available. Two path forms are in use; try both. */
  async function blockViaFriendshipsRest(targetId, dryRun) {
    if (!IS_THREADS) throw new Error('REST friendships path is Threads-only');
    const tokens = getTokens();
    const paths = [
      '/api/v1/friendships/block/' + encodeURIComponent(targetId) + '/',
      '/web/friendships/' + encodeURIComponent(targetId) + '/block/'
    ];
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'x-ig-app-id': tokens.appId || '238260118697367',
      'x-asbd-id': tokens.asbd || '359341',
      'x-requested-with': 'XMLHttpRequest'
    };
    if (tokens.csrf) headers['x-csrftoken'] = tokens.csrf;
    if (tokens.lsd) headers['x-fb-lsd'] = tokens.lsd;

    if (dryRun) {
      return { ok: true, dryRun: true, strategy: 'friendships-rest',
               urls: paths.map(p => location.origin + p) };
    }

    const body = new URLSearchParams();
    body.set('user_id', String(targetId));
    body.set('container_module', 'profile');

    let last = null;
    for (const p of paths) {
      let res;
      try {
        res = await asSelfRequest(() => fetch(location.origin + p, {
          method: 'POST', credentials: 'include', headers, body: body.toString()
        }));
      } catch (e) { last = { ok: false, strategy: 'friendships-rest', detail: String(e && e.message) }; continue; }
      // A 404 means this path form is not the one this surface uses; try the next.
      if (res.status === 404) { last = { ok: false, strategy: 'friendships-rest', status: 404, detail: 'path not found: ' + p }; continue; }
      const text = await res.text();
      const r = interpretResponse(res.status, text, 'friendships-rest', 'rest');
      r.path = p;
      if (r.ok || r.rateLimited || r.checkpoint) return r;
      last = r;
    }
    return last || { ok: false, strategy: 'friendships-rest', detail: 'no friendships path responded' };
  }

  /** Strategy D -- hand-built GraphQL POST.
   *
   *  The doc_id comes from the live module registry, or from docIdOverrides
   *  pushed by your server (which lets you hot-patch a rotation without
   *  shipping a new extension version). Never hardcoded.
   *
   *  This is the least reliable path, because Relay normally supplies ~30
   *  __relay_internal__pv__*relayprovider variables that we cannot reconstruct;
   *  operations that require them fail with missing_required_variable_value.
   *  Kept as a floor under the better strategies. */
  // Two sources of doc_ids, kept apart on purpose (see docIdCandidates).
  let docIdOverrides = {};      // published with the blocklist, by the owner
  let learnedDocIds = {};       // seen working in THIS browser, remembered
  let allowRawNetworkFallback = false;
  let reqCounter = 0;

  async function blockViaHandBuilt(targetId, candidate, dryRun) {
    const tokens = getTokens();

    // Prefer an operation whose variable shape we actually know.
    const known = KNOWN_BLOCK_OPS[PLATFORM] || [];
    let opName = candidate && candidate.params && candidate.params.name;
    let docId = candidate && candidate.params && candidate.params.id;

    let shaper = known.find(k => opName && opName.indexOf(k.name) !== -1);
    if (!shaper) {
      // No live module matched; fall back to a known op whose doc_id our server
      // supplied.
      for (const k of known) {
        if (docIdOverrides[k.name]) { shaper = k; opName = k.name; docId = docIdOverrides[k.name]; break; }
      }
    } else if (docIdOverrides[shaper.name]) {
      docId = docIdOverrides[shaper.name];
    }
    if (!docId) throw new Error('no doc_id available (none discovered, none supplied by server)');

    const variables = JSON.stringify(
      shaper ? shaper.vars(targetId, tokens.viewerId)
             : { input: { blockee_id: String(targetId), actor_id: tokens.viewerId, client_mutation_id: '1' } }
    );

    // Threads uses two GraphQL endpoints and they are not interchangeable:
    // reads (feed pagination and the like) go to /graphql/query, but mutations
    // go to /api/graphql. Sending a mutation to the read endpoint was one of
    // the reasons the hand-built path could never have worked here.
    const endpoint = IS_THREADS ? '/api/graphql' : '/api/graphql/';
    const fields = {
      av: tokens.viewerId || '0',
      __user: tokens.viewerId || '0',
      __a: '1',
      __req: (++reqCounter).toString(36),
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: opName || '',
      variables,
      server_timestamps: 'true',
      doc_id: String(docId)
    };
    if (tokens.rev) fields.__rev = tokens.rev;
    if (tokens.fb_dtsg) { fields.fb_dtsg = tokens.fb_dtsg; fields.jazoest = jazoest(tokens.fb_dtsg); }
    if (tokens.lsd) fields.lsd = tokens.lsd;

    if (dryRun) return { ok: true, dryRun: true, strategy: 'hand-built', endpoint, opName, docId, variables };

    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': fields.fb_api_req_friendly_name
    };
    if (tokens.lsd) headers['x-fb-lsd'] = tokens.lsd;
    if (IS_THREADS && tokens.appId) headers['x-ig-app-id'] = tokens.appId;

    const res = await asSelfRequest(() => fetch(endpoint, {
      method: 'POST', credentials: 'include', headers,
      body: new URLSearchParams(fields).toString()
    }));
    const text = await res.text();
    const r = interpretResponse(res.status, text, 'hand-built', 'graphql');
    r.opName = opName;
    return r;
  }

  // ==========================================================================
  // 6. Bridge to the isolated world.
  // ==========================================================================
  function post(type, payload, nonce) {
    // Reply to the peer that asked. Broadcasts (no nonce given) go to every
    // known peer, so a second content-script instance is not left blind.
    const targets = nonce !== undefined ? [nonce]
                  : (peerNonces.size ? Array.from(peerNonces) : [null]);
    const send = (p) => {
      for (const target of targets) {
        window.postMessage(
          { [MARK]: true, dir: 'main->iso', nonce: target, type, payload: p },
          location.origin
        );
      }
    };
    try {
      send(payload);
      return;
    } catch (e) {
      // postMessage throws on anything structured-clone cannot copy. Swallowing
      // that meant the caller's ticket was simply never answered, which is
      // indistinguishable from a hang -- it showed up as "MAIN world timed
      // out" while the real fault was a payload carrying a function or a live
      // Relay object. Degrade instead of going silent.
      try {
        send(JSON.parse(JSON.stringify(payload)));
        return;
      } catch (e2) { /* fall through */ }
      try {
        send({
          ticket: payload && payload.ticket,
          ok: false,
          error: 'response payload was not cloneable: ' + String((e && e.message) || e).slice(0, 200)
        });
      } catch (e3) {
        console.warn('[CloneBlocker] could not post a reply at all', e3);
      }
    }
  }

  /** Reply to one specific peer. */
  function postTo(nonce, type, payload) { post(type, payload, nonce); }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  let learnedTemplate = null;

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[MARK] !== true || d.dir !== 'iso->main') return;

    // Handshake first; everything after must carry the agreed nonce.
    if (d.type === MSG.HELLO) {
      const peer = d.payload && d.payload.nonce;
      if (peer) peerNonces.add(peer);
      debug = !!(d.payload && d.payload.debug);
      post(MSG.HELLO_ACK, { platform: PLATFORM }, peer);
      post(MSG.VIEWER, { viewerId: getTokens().viewerId, platform: PLATFORM }, peer);
      // Anything captured before the bridge existed can be delivered now.
      while (pendingCaptures.length) {
        post(MSG.CAPABILITY, { capturedTemplate: pendingCaptures.shift() }, peer);
      }
      return;
    }
    if (!d.nonce || !peerNonces.has(d.nonce)) return;

    try {
      switch (d.type) {
        case MSG.SET_CONFIG: {
          const p = d.payload || {};
          if (typeof p.debug === 'boolean') debug = p.debug;
          // A template that does not name the block mutation is refused at
          // the door as well as everywhere it would be used: the stored one
          // on an upgraded install is exactly the junk this guards against.
          if ('learnedTemplate' in p) {
            learnedTemplate = usableTemplate(p.learnedTemplate) ? p.learnedTemplate : null;
          }
          // Server-pushed doc_id overrides let you hot-patch a Meta rotation
          // without shipping a new extension build. Validated here as well as
          // where the list is published and where the worker stores it: a
          // key names an operation, a value is a numeric doc_id, and nothing
          // else is allowed to reach the code that builds a request from it.
          if (p.docIdOverrides) docIdOverrides = sanitizeDocIds(p.docIdOverrides);
          // What this browser has seen work before, replayed back to the page
          // after a reload -- the memory that makes the block operation
          // available on a tab that never opened the site's block dialog.
          if (p.learnedDocIds) learnedDocIds = sanitizeDocIds(p.learnedDocIds);
          if (typeof p.allowRawNetworkFallback === 'boolean') {
            allowRawNetworkFallback = p.allowRawNetworkFallback;
          }
          break;
        }

        case MSG.PROBE_CAPABILITY: {
          const tokens = getTokens();
          const envInfo = getRelayEnvironment();
          const mutations = findBlockMutationModules();
          postTo(d.nonce, MSG.CAPABILITY, {
            // Echoed so a caller using request() can await a live answer
            // instead of relying on whatever snapshot was taken last.
            ticket: d.payload && d.payload.ticket,
            platform: PLATFORM,
            viewerId: tokens.viewerId,
            hasRequire: typeof window.require === 'function',
            hasRelay: !!envInfo,
            relayEnv: envInfo ? envInfo.name : null,
            relayRecords: envInfo ? envInfo.count : 0,
            hasCommitMutation: typeof (req('RelayModern') || {}).commitMutation === 'function',
            hasDtsg: !!tokens.fb_dtsg,
            hasLsd: !!tokens.lsd,
            moduleCount: moduleIndex.size,
            graphqlModuleCount: graphqlModules.size,
            blockMutationCandidates: mutations.slice(0, 12),
            // Every doc_id this page could block with and where each came
            // from. The module-sourced ones are what the isolated world asks
            // the worker to remember; the rest say why blocking will or will
            // not work on a tab with no block dialog ever opened.
            blockDocIds: docIdCandidates(),
            hasLearnedTemplate: !!learnedTemplate,
            capturedCount: captured.length
          });
          break;
        }

        case MSG.DUMP_MODULES: {
          // Debug affordance: which modules has the page actually registered?
          // Meta renames these often enough that a name-based search can come
          // up empty while the capability is genuinely present, and there is no
          // way to tell those two cases apart without looking at the list.
          const p2 = d.payload || {};
          let re;
          try { re = new RegExp(p2.pattern || 'block', 'i'); } catch (e) { re = /block/i; }
          const names = [];
          for (const n of moduleIndex) {
            if (re.test(n)) names.push(n);
            if (names.length >= 300) break;
          }
          // Resolve params for any that look like Relay operations.
          const resolved = [];
          for (const n of names) {
            if (!n.endsWith('.graphql')) continue;
            try {
              const mod = req(n);
              const r = mod && (mod.default || mod);
              if (r && r.params) {
                resolved.push({ name: n, id: r.params.id, op: r.params.name, kind: r.params.operationKind });
              }
            } catch (e) { /* ignore */ }
            if (resolved.length >= 60) break;
          }
          postTo(d.nonce, MSG.MODULES, {
            ticket: p2.ticket,
            total: moduleIndex.size,
            matched: names.length,
            names: names.slice(0, 120),
            resolved
          });
          break;
        }

        case MSG.RESOLVE_IDS: {
          // Bulk: sweep the Relay store for every rendered user.
          const store = sweepRelayStore();
          if (store.length) postTo(d.nonce, MSG.STORE_SNAPSHOT, { users: store, platform: PLATFORM });

          // Per-node: identify authors for the nodes the DOM layer asked about.
          const reqs = (d.payload && d.payload.nodes) || [];
          const answers = [];
          for (const r of reqs) {
            const node = document.querySelector('[data-cb-probe="' + cssEscape(r.probe) + '"]');
            if (!node) { answers.push({ probe: r.probe, identities: [] }); continue; }
            let ids = identifyNode(node);
            if (!ids.length) ids = identityFromHrefs(node);
            answers.push({ probe: r.probe, identities: ids });
          }
          // Per-comment: the only reliable source for a Facebook comment
          // author's numeric id is the Relay store, keyed by the comment id the
          // DOM layer read off the permalink. Answered alongside the node probes.
          for (const cid of ((d.payload && d.payload.commentIds) || [])) {
            const who = resolveCommentAuthor(cid);
            answers.push({ commentId: cid, identities: who ? [who] : [] });
          }
          // The ticket must be echoed back: the isolated world correlates
          // request/response by it, and a missing ticket means the caller's
          // promise hangs until its timeout instead of resolving.
          postTo(d.nonce, MSG.IDENTITY, { ticket: d.payload && d.payload.ticket, answers, platform: PLATFORM });
          break;
        }

        case MSG.PLATFORM_BLOCK: {
          const p = d.payload || {};
          const targetId = String(p.targetId || '');
          const dryRun = p.dryRun !== false;
          const ticket = p.ticket;
          if (!/^\d+$/.test(targetId)) {
            postTo(d.nonce, MSG.BLOCK_RESULT, { ticket, ok: false, detail: 'target id must be numeric' });
            break;
          }

          const attempts = [];
          let result = null;
          let lastFailure = null;

          // Build the ladder.
          //
          // The first tier drives the site's OWN code: Relay's commitMutation
          // with the site's own operation node. Relay then supplies the current
          // doc_id, every generated provider variable, the CSRF tokens and all
          // the __dyn/__csr bookkeeping, and it updates the local store so the
          // UI reflects the change. Nothing we hand-assemble can match that.
          //
          // The raw tiers below are gated behind allowRawNetworkFallback and
          // off by default. Hand-built requests bearing CSRF tokens were
          // observed causing Meta to invalidate the signed-in session, and the
          // Instagram REST paths answer 404 on threads.com anyway -- so they
          // are a liability, not a safety net, unless deliberately enabled.
          const candidates = findBlockMutationModules();
          const ladder = [];
          for (const c of candidates.slice(0, 3)) {
            ladder.push({ name: 'relay:' + c.name, run: () => blockViaRelay(targetId, c.name, dryRun) });
          }

          // The site's own network layer, driven with a doc_id we already
          // hold. This is the tier that lets a tab where nobody has opened a
          // block dialog block anything at all -- the module the tier above
          // needs is not loadable by name (see blockViaRelayNetwork). Capped:
          // every doc_id that turns out to be stale costs a real request.
          for (const cand of docIdCandidates().slice(0, 3)) {
            ladder.push({
              name: 'relay-net:' + cand.name + '/' + cand.source,
              run: () => blockViaRelayNetwork(targetId, cand, dryRun)
            });
          }

          // Replaying a request the site itself made is far safer than
          // synthesising one, so it sits above the hand-built tier -- but it is
          // still a raw request, and only worth trying if it captured a real
          // persisted-query operation.
          if (usableTemplate(learnedTemplate) && allowRawNetworkFallback) {
            ladder.push({ name: 'learned', run: () => blockViaLearnedTemplate(targetId, learnedTemplate, dryRun) });
          }
          if (allowRawNetworkFallback) {
            ladder.push({ name: 'handbuilt', run: () => blockViaHandBuilt(targetId, candidates[0] || null, dryRun) });
          }
          // The Instagram REST friendships paths are deliberately NOT in the
          // ladder. On threads.com both answer 404, and posting a hand-made
          // CSRF-bearing request to them coincided with the signed-in session
          // being invalidated -- twice. A fallback that cannot succeed and can
          // log the user out is not worth keeping in the default path.

          if (!ladder.length) {
            // Nothing was tried, so nothing about the TARGET failed: the page
            // simply has not loaded the operation yet. Flagged as such so the
            // worker does not count it toward abandoning the target -- five of
            // these in a row used to drop a perfectly good target from the
            // queue because the tab happened to be sitting on the feed.
            // Reachable only on a browser that has never once had the site's
            // block operation in front of it AND whose list carries no doc_id:
            // no module here, nothing remembered, nothing published, no
            // capture. Both cures are stated because both are real -- the
            // owner publishes a doc_id and every install is fixed at once, or
            // this browser sees the operation once and remembers it forever.
            postTo(d.nonce, MSG.BLOCK_RESULT, {
              ticket, targetId, dryRun, ok: false, attempts: [], notReady: true,
              detail: 'no way to reach the site\'s block operation yet: it is not loaded on this ' +
                      'page (the site only loads it when its own block dialog opens), no doc_id ' +
                      'is published with the list, and this browser has not seen one before. ' +
                      'Publishing a doc_id fixes every install; opening any profile\'s "..." ' +
                      'menu, choosing Block and then Cancel teaches this one -- it blocks nobody, ' +
                      'the dialog asks first.'
            });
            break;
          }

          for (const step of ladder) {
            let r = null;
            try {
              r = await step.run();
            } catch (e) {
              attempts.push({ strategy: step.name, ok: false, err: String((e && e.message) || e) });
              continue;
            }
            // A strategy that returns {ok:false} has FAILED. Treating a
            // returned-but-failed result as "done" was silently skipping every
            // remaining strategy -- e.g. a learned template gone stale after a
            // doc_id rotation would return HTTP 400 and the REST and hand-built
            // paths that might have worked were never tried.
            attempts.push({ strategy: step.name, ok: !!(r && r.ok), detail: (r && r.detail) || '' });
            if (r && r.ok) { result = r; break; }
            lastFailure = r || lastFailure;
            // Stop the ladder on conditions where continuing makes things worse
            // rather than better: more requests during a rate limit or an
            // account challenge is exactly the wrong response.
            if (r && (r.rateLimited || r.checkpoint)) { result = r; break; }
          }

          const reported = result || lastFailure;
          postTo(d.nonce, MSG.BLOCK_RESULT, {
            ticket,
            targetId,
            // Echo back what was asked for. Deriving this from the result would
            // misreport a dry run as a real block if the result failed to clone.
            dryRun,
            ok: !!(result && result.ok),
            result: safeClone(reported),
            attempts,
            detail: reported
              ? (reported.detail || '')
              : 'no strategy available -- turn on capture mode and block one profile manually to teach it'
          });
          break;
        }
      }
    } catch (e) {
      // A throw in here used to vanish into this catch, and the isolated world
      // would just sit on its ticket until it timed out -- reporting "timeout"
      // for what was really a bug on this side. Send the error back so the
      // failure names itself.
      const msg = String((e && e.stack) || (e && e.message) || e).slice(0, 500);
      log('handler error', e);
      const ticket = d.payload && d.payload.ticket;
      if (ticket) {
        const replyType = d.type === MSG.PLATFORM_BLOCK ? MSG.BLOCK_RESULT
                        : d.type === MSG.DUMP_MODULES ? MSG.MODULES
                        : d.type === MSG.RESOLVE_IDS ? MSG.IDENTITY
                        : MSG.CAPABILITY;
        postTo(d.nonce, replyType, { ticket, ok: false, error: msg, detail: 'MAIN world error: ' + msg });
      }
    }
  });

  // Announce readiness. The isolated world may load first or second, so it also
  // sends HELLO on its own schedule; whichever arrives second completes it.
  post(MSG.MAIN_READY, { platform: PLATFORM, href: location.href });
  document.addEventListener('DOMContentLoaded', () => post(MSG.MAIN_READY, { platform: PLATFORM }));
})();
