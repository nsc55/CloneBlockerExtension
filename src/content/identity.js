/**
 * Per-tab verdict cache + identity resolution (ISOLATED world).
 *
 * The central difficulty: your server hands us profile IDs, but what the page
 * actually renders is very often only a vanity username (facebook.com/someone,
 * threads.com/@someone) with no numeric id anywhere in the DOM.
 *
 * Rather than making a network request per unknown username, we exploit the
 * fact that the page has already fetched the mapping: Meta's Relay store holds
 * records keyed by numeric id that carry the username alongside. The MAIN-world
 * script sweeps that store and feeds us id<->username pairs, which we cache in
 * chrome.storage so the mapping survives navigation and later page loads.
 *
 * The list itself does not live here any more. It used to arrive whole -- every
 * id and every username, in two Sets -- which was fine at ten thousand entries
 * and is not fine at millions: one copy per open tab, rebuilt on every refresh.
 * The service worker keeps the list in IndexedDB now, and this file keeps only
 * the VERDICTS this tab has asked for: a bounded map from id or username to
 * "listed" or "not listed", stamped with the generation of the list it was
 * answered against. Questions are batched and asked once; a generation change
 * empties the map and everything on screen is asked again.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const bridge = globalThis.CB_BRIDGE;

  const ALIAS_KEY = 'aliasMap';       // chrome.storage.local: { username(lower): id }
  const ALIAS_MAX = 20000;            // keep the cache from growing without bound

  // Verdicts this tab has been given, keyed 'i:<id>' or 'u:<username(lower)>'.
  // The value is { hit, gen }: `hit` is the worker's row for a listed profile
  // ({t, u, d, p} for an id, {t, p} for a username) and null for one it did
  // not find; `gen` is the list generation the answer was given under, and an
  // entry from an older generation is treated as never having been asked.
  // Bounded by insertion order -- Map keeps it -- so trimming is "drop from
  // the front", the same bound the alias maps have proved affordable.
  const verdicts = new Map();
  const VERDICT_MAX = 4000;
  // Questions are coalesced: everything asked within this window goes to the
  // worker as one message, capped at the worker's own per-request limit.
  const LOOKUP_DELAY_MS = 50;
  const LOOKUP_MAX = 500;
  let generation = 0;                 // 0 until the first list status arrives
  let listCounts = { ids: 0, usernames: 0 };
  let pendingBatch = null;            // the batch not yet sent; see requestKeys()
  // Keys asked and not yet answered, each mapped to the promise of the batch
  // carrying it, so a second question about the same profile waits on the
  // first rather than asking again.
  const asked = new Map();

  const aliasToId = new Map();        // username(lower) -> numeric id
  const idToAlias = new Map();        // numeric id -> username
  let aliasDirty = false;

  function norm(u) {
    return String(u || '').trim().toLowerCase().replace(/^@/, '');
  }
  function isNumericId(v) {
    return typeof v === 'string' ? /^\d{4,}$/.test(v) : false;
  }

  /**
   * What the worker knows about the list: its generation and its size.
   *
   * Fed from sw:get-blocklist at boot and from every sw:blocklist-updated
   * broadcast. The generation is the only part that matters for correctness:
   * a verdict is only true of the list it was answered against, so a changed
   * generation empties the cache and the caller rescans. The counts are for
   * the popup and the diagnostics, which used to read the size of the Sets.
   */
  function setListStatus(status) {
    if (!status) return;
    const c = status.counts;
    if (c && typeof c === 'object') {
      listCounts = { ids: Number(c.ids) || 0, usernames: Number(c.usernames) || 0 };
    }
    const gen = Number(status.generation) || 0;
    if (gen !== generation) {
      verdicts.clear();
      generation = gen;
    }
  }

  async function loadAliases() {
    try {
      const got = await chrome.storage.local.get(ALIAS_KEY);
      const map = got && got[ALIAS_KEY];
      if (map && typeof map === 'object') {
        for (const k of Object.keys(map)) {
          const id = String(map[k]);
          if (!isNumericId(id)) continue;
          aliasToId.set(k, id);
          idToAlias.set(id, k);
        }
      }
    } catch (e) { /* first run, or storage unavailable */ }
  }

  let saveTimer = null;
  function scheduleAliasSave() {
    if (!aliasDirty || saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (!aliasDirty) return;
      aliasDirty = false;
      try {
        // Trim oldest-inserted first if we have grown too large. Map preserves
        // insertion order, so this is just "drop from the front".
        let entries = Array.from(aliasToId.entries());
        if (entries.length > ALIAS_MAX) entries = entries.slice(entries.length - ALIAS_MAX);
        await chrome.storage.local.set({ [ALIAS_KEY]: Object.fromEntries(entries) });
      } catch (e) { /* storage may be full or context gone */ }
    }, 4000);
  }

  /** Record an id<->username pair discovered from the page. */
  function learn(id, username) {
    if (!isNumericId(String(id || ''))) return false;
    const u = norm(username);
    if (!u) return false;
    const sid = String(id);
    if (aliasToId.get(u) === sid) return false;
    aliasToId.set(u, sid);
    idToAlias.set(sid, u);
    aliasDirty = true;
    // Bound memory on a long-lived tab that sweeps many profiles. Map preserves
    // insertion order, so the oldest entries are at the front.
    if (aliasToId.size > ALIAS_MAX) {
      const excess = aliasToId.size - ALIAS_MAX;
      let n = 0;
      for (const k of aliasToId.keys()) {
        if (n++ >= excess) break;
        const gone = aliasToId.get(k);
        aliasToId.delete(k);
        if (idToAlias.get(gone) === k) idToAlias.delete(gone);
      }
    }
    scheduleAliasSave();
    return true;
  }

  /**
   * Learn a sweep's worth of pairs, and say how many of them matter.
   *
   * A pair that bridges a blocklist entry to something on the page can flip
   * an already-cached "not blocked" verdict, so the caller needs to know to
   * invalidate rather than just re-scan. Which pairs those are is a question
   * for the worker now: every NEW pair of the sweep goes into one batch --
   * capped, because a sweep can be large and the worker takes 500 at a time
   * -- and the ones that come back listed are the relevant ones.
   */
  async function learnMany(users) {
    let learned = 0;
    const fresh = [];
    for (const u of users || []) {
      if (!u || !u.id || !u.username) continue;
      if (!learn(u.id, u.username)) continue;
      learned++;
      if (fresh.length < LOOKUP_MAX) fresh.push({ id: String(u.id), username: u.username });
    }
    let relevant = 0;
    if (fresh.length) {
      await lookupAny(fresh);
      for (const pair of fresh) if (matchCached(pair)) relevant++;
    }
    return { learned, relevant };
  }

  // -- verdicts -------------------------------------------------------------

  /** The cached answer for one key: the worker's row for a listed profile,
   *  null for a cached miss, undefined when this tab has not been told -- or
   *  was told about an older list. */
  function verdictOf(key) {
    const v = verdicts.get(key);
    if (!v || v.gen !== generation) return undefined;
    return v.hit;
  }

  function remember(key, hit) {
    // Re-inserted rather than updated in place, so a key answered again moves
    // to the back and the front of the map stays the oldest answers.
    verdicts.delete(key);
    verdicts.set(key, { hit: hit || null, gen: generation });
  }

  function trimVerdicts() {
    if (verdicts.size <= VERDICT_MAX) return;
    const excess = verdicts.size - VERDICT_MAX;
    let n = 0;
    for (const k of verdicts.keys()) {
      if (n++ >= excess) break;
      verdicts.delete(k);
    }
  }

  /**
   * The keys that decide whether an identity is listed, most direct first:
   * its own id, its own username, and -- when only one half is known -- the
   * other half through the learned alias map, because the list may name a
   * profile by id while the page only shows the username, or vice versa.
   * Each entry carries the `by` a hit on that key reports, the same words the
   * whole-list matcher used to answer with.
   *
   * Accepts a partial identity -- {id} or {username} or both. An id that is
   * not numeric is no id: the list only ever holds numeric ones.
   */
  function keysFor(identity) {
    if (!identity) return [];
    const id = identity.id && isNumericId(String(identity.id)) ? String(identity.id) : null;
    const uname = identity.username ? norm(identity.username) : null;
    const out = [];
    if (id) out.push({ key: 'i:' + id, by: 'id', id, username: uname || idToAlias.get(id) || null });
    if (uname) out.push({ key: 'u:' + uname, by: 'username', id: id || aliasToId.get(uname) || null, username: uname });
    if (uname && !id) {
      const mapped = aliasToId.get(uname);
      if (mapped) out.push({ key: 'i:' + mapped, by: 'alias->id', id: mapped, username: uname });
    }
    if (id && !uname) {
      const mapped = idToAlias.get(id);
      if (mapped) out.push({ key: 'u:' + mapped, by: 'id->alias', id, username: mapped });
    }
    return out;
  }

  /**
   * Decide whether an identity refers to a blocked profile, from what this
   * tab already knows. Three answers, and callers must tell them apart:
   *
   *   an object   -- listed, and why it matched ({by, id, username}, plus the
   *                  row's tag and published name where the worker gave them);
   *   null        -- every key is a cached miss under the current list;
   *   undefined   -- at least one key has not been answered yet. Nothing may
   *                  be concluded from that, least of all "not blocked": ask
   *                  with lookup() and judge when it returns.
   */
  function matchCached(identity) {
    let unknown = false;
    for (const k of keysFor(identity)) {
      const v = verdictOf(k.key);
      if (v === undefined) { unknown = true; continue; }
      if (v) return { by: k.by, id: k.id, username: k.username, t: v.t, u: v.u, d: v.d };
    }
    return unknown ? undefined : null;
  }

  /** Any of several candidate identities matching is enough to hide a post;
   *  any of them unanswered is enough to hold the judgement. */
  function matchAnyCached(identities) {
    let unknown = false;
    for (const ident of identities || []) {
      const m = matchCached(ident);
      if (m) return m;
      if (m === undefined) unknown = true;
    }
    return unknown ? undefined : null;
  }

  function newBatch() {
    const b = { ids: new Set(), usernames: new Set(), sent: false, timer: null, resolve: null, done: null };
    b.done = new Promise((resolve) => { b.resolve = resolve; });
    b.timer = setTimeout(() => flushBatch(b), LOOKUP_DELAY_MS);
    return b;
  }

  /**
   * Queue keys for the worker and resolve once every batch carrying one of
   * them has been answered. A batch is sent when the window closes or when
   * either list reaches the worker's cap, whichever comes first, so a caller
   * with more than a cap's worth simply spans two batches.
   */
  function requestKeys(ids, unames) {
    const waits = new Set();
    const add = (key, kind, value) => {
      const prior = asked.get(key);
      if (prior) { waits.add(prior); return; }
      if (!pendingBatch) pendingBatch = newBatch();
      const b = pendingBatch;
      b[kind].add(value);
      asked.set(key, b.done);
      waits.add(b.done);
      if (b[kind].size >= LOOKUP_MAX) flushBatch(b);
    };
    for (const id of ids) add('i:' + id, 'ids', id);
    for (const u of unames) add('u:' + u, 'usernames', u);
    return Promise.all(waits);
  }

  async function flushBatch(b) {
    if (b.sent) return;
    b.sent = true;
    if (pendingBatch === b) pendingBatch = null;
    clearTimeout(b.timer);
    const ids = Array.from(b.ids);
    const usernames = Array.from(b.usernames);
    try {
      const reply = await bridge.sw(P.SW.BLOCKLIST_LOOKUP, {
        platform: bridge.state.platform, ids, usernames
      });
      // The reply names only the hits; everything asked and not named is a
      // miss, which is what keeps it small on a feed where almost every
      // author is clean. An answer about a different list than the one this
      // tab is tracking is not written down: sw:blocklist-updated is on its
      // way with the new generation, the cache is about to be emptied, and
      // the caller rescans. Before the first status arrives (generation 0)
      // any answer is taken.
      if (reply && reply.ok && (generation === 0 || Number(reply.generation) === generation)) {
        const hitIds = (reply.ids && typeof reply.ids === 'object') ? reply.ids : {};
        const hitNames = (reply.usernames && typeof reply.usernames === 'object') ? reply.usernames : {};
        // hasOwnProperty, not a bare index: a username can spell
        // 'constructor', and a plain object answers that with a function.
        const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null;
        const row = (v) => (v ? (typeof v === 'object' ? v : {}) : null);
        for (const id of ids) remember('i:' + id, row(own(hitIds, id)));
        for (const u of usernames) remember('u:' + u, row(own(hitNames, u)));
        trimVerdicts();
      }
    } catch (e) { /* the worker is gone or timed out; the keys stay unknown */ }
    for (const id of ids) asked.delete('i:' + id);
    for (const u of usernames) asked.delete('u:' + u);
    b.resolve();
  }

  /**
   * Ask the worker about whatever these identities need that this tab does
   * not have a verdict for, then answer like matchAnyCached would.
   *
   * The keys are expanded through the alias map exactly as matchCached reads
   * them, deduplicated against the cache and against questions already in
   * flight, and sent as one message. Nothing about the answer reaches the
   * network: the worker reads its own store. Resolves undefined when the
   * question could not be answered -- the list changed underneath, or the
   * worker did not reply -- so the caller can leave a node undecided rather
   * than caching a miss it was never given.
   */
  async function lookupAny(identities) {
    const ids = new Set();
    const unames = new Set();
    for (const ident of identities || []) {
      for (const k of keysFor(ident)) {
        if (verdictOf(k.key) !== undefined) continue;
        if (k.key.startsWith('i:')) ids.add(k.key.slice(2));
        else unames.add(k.key.slice(2));
      }
    }
    if (ids.size || unames.size) await requestKeys(ids, unames);
    return matchAnyCached(identities);
  }

  /** One identity, same contract as lookupAny. */
  function lookup(identity) { return lookupAny([identity]); }

  /**
   * Listed profiles this tab has actually seen and has a numeric id for --
   * the only ones a real platform block can target, and the only ones a tab
   * offers the queue. Positive verdicts under the current list: direct id
   * hits, and username hits the alias map can put an id to. Bounded by the
   * cache, so never more than VERDICT_MAX.
   */
  function blockedIdsSeen() {
    const out = new Set();
    for (const [key, v] of verdicts) {
      if (!v.hit || v.gen !== generation) continue;
      if (key.startsWith('i:')) { out.add(key.slice(2)); continue; }
      const mapped = aliasToId.get(key.slice(2));
      if (mapped) out.add(mapped);
    }
    return Array.from(out);
  }

  /** Look up the numeric id we have learned for a username, and the reverse.
   *  Used by the report UI so a report carries an id where one is known -- ids
   *  survive a rename, usernames do not. */
  function idForUsername(u) { return aliasToId.get(norm(u)) || null; }
  function usernameForId(id) { return idToAlias.get(String(id)) || null; }

  globalThis.CB_IDENTITY = {
    setListStatus, loadAliases, learn, learnMany,
    matchCached, matchAnyCached, lookup, lookupAny, blockedIdsSeen,
    idForUsername, usernameForId,
    norm, isNumericId,
    // blockedIds / blockedUsernames are the list's counts now, not this tab's:
    // the names are kept because the popup, the options diagnostics and the
    // session inspector print them.
    stats: () => ({
      blockedIds: listCounts.ids,
      blockedUsernames: listCounts.usernames,
      aliasesKnown: aliasToId.size,
      verdictsCached: verdicts.size,
      pending: pendingBatch ? pendingBatch.ids.size + pendingBatch.usernames.size : 0,
      generation
    })
  };
})();
