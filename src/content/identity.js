/**
 * Blocklist index + identity resolution (ISOLATED world).
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
 */
(function () {
  'use strict';

  const ALIAS_KEY = 'aliasMap';       // chrome.storage.local: { username(lower): id }
  const ALIAS_MAX = 20000;            // keep the cache from growing without bound

  const idSet = new Set();            // blocked numeric ids (strings)
  const nameSet = new Set();          // blocked usernames (lowercased)
  const aliasToId = new Map();        // username(lower) -> numeric id
  const idToAlias = new Map();        // numeric id -> username
  let aliasDirty = false;

  function norm(u) {
    return String(u || '').trim().toLowerCase().replace(/^@/, '');
  }
  function isNumericId(v) {
    return typeof v === 'string' ? /^\d{4,}$/.test(v) : false;
  }

  /** Load the blocklist the service worker fetched from your server. */
  function setBlocklist(list) {
    idSet.clear();
    nameSet.clear();
    if (!list) return;
    for (const raw of list.ids || []) {
      const v = String(raw).trim();
      if (isNumericId(v)) idSet.add(v);
      else if (v) nameSet.add(norm(v));   // tolerate usernames in the ids array
    }
    for (const raw of list.usernames || []) {
      const v = norm(raw);
      if (v) nameSet.add(v);
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

  function learnMany(users) {
    let learned = 0;
    let relevant = 0;
    for (const u of users || []) {
      if (!u || !u.id || !u.username) continue;
      if (!learn(u.id, u.username)) continue;
      learned++;
      // A pair that bridges a blocklist entry to something on the page can
      // flip an already-cached "not blocked" verdict, so the caller needs to
      // know to invalidate rather than just re-scan.
      if (idSet.has(String(u.id)) || nameSet.has(norm(u.username))) relevant++;
    }
    return { learned, relevant };
  }

  /**
   * Decide whether an identity refers to a blocked profile.
   * Accepts a partial identity -- {id} or {username} or both.
   * Returns null when not blocked, otherwise why it matched.
   */
  function match(identity) {
    if (!identity) return null;
    const id = identity.id ? String(identity.id) : null;
    const uname = identity.username ? norm(identity.username) : null;

    if (id && idSet.has(id)) return { by: 'id', id, username: uname || idToAlias.get(id) || null };
    if (uname && nameSet.has(uname)) return { by: 'username', id: id || aliasToId.get(uname) || null, username: uname };

    // Cross-reference through the learned alias map: the list may name a
    // profile by id while the page only shows the username, or vice versa.
    if (uname && !id) {
      const mapped = aliasToId.get(uname);
      if (mapped && idSet.has(mapped)) return { by: 'alias->id', id: mapped, username: uname };
    }
    if (id && !uname) {
      const mapped = idToAlias.get(id);
      if (mapped && nameSet.has(mapped)) return { by: 'id->alias', id, username: mapped };
    }
    return null;
  }

  /** Any of several candidate identities matching is enough to hide a post. */
  function matchAny(identities) {
    for (const ident of identities || []) {
      const m = match(ident);
      if (m) return m;
    }
    return null;
  }

  /** Blocked profiles we have a numeric id for -- the only ones a real
   *  platform block can target. */
  function blockableIds() {
    const out = new Set(idSet);
    for (const uname of nameSet) {
      const mapped = aliasToId.get(uname);
      if (mapped) out.add(mapped);
    }
    return Array.from(out);
  }

  /** Blocklist entries we could not resolve to a numeric id yet. */
  function unresolvedUsernames() {
    return Array.from(nameSet).filter(u => !aliasToId.has(u));
  }

  /** Look up the numeric id we have learned for a username, and the reverse.
   *  Used by the report UI so a report carries an id where one is known -- ids
   *  survive a rename, usernames do not. */
  function idForUsername(u) { return aliasToId.get(norm(u)) || null; }
  function usernameForId(id) { return idToAlias.get(String(id)) || null; }

  globalThis.CB_IDENTITY = {
    setBlocklist, loadAliases, learn, learnMany,
    match, matchAny, blockableIds, unresolvedUsernames,
    idForUsername, usernameForId,
    norm, isNumericId,
    stats: () => ({
      blockedIds: idSet.size,
      blockedUsernames: nameSet.size,
      aliasesKnown: aliasToId.size
    })
  };
})();
