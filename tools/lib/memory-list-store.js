/**
 * A Map-backed list store for the Node harnesses.
 *
 * src/background/list-store.js keeps the blocklist rows in IndexedDB, which
 * Node does not have, and the harnesses drive the real service worker, which
 * reads the list through that module. So this is the same narrow backend
 * interface -- the `idb` object in list-store.js, method for method, shape
 * for shape -- over four Maps, installed before the worker is imported:
 *
 *   const memStore = require('./lib/memory-list-store');
 *   const list = memStore.install();       // globalThis.CB_LIST_STORE_FACTORY
 *   await import(swPath);
 *   list.seed([{ platform: 'threads', id: '1234567890', u: 'someone', t: 'clone' }]);
 *
 * Only the primitives live here. Everything a caller relies on -- id
 * filtering, name normalisation, the '*' fallback, which row wins a name, the
 * counts document -- is in list-store.js and runs unchanged against this, so
 * a queue test exercises the worker's real list semantics; only the storage
 * underneath is a fake. The real IndexedDB path is proven by e2e-test.js in
 * Chrome. Zero dependencies, like every other tool here.
 *
 * Two things this does that IndexedDB would: values are cloned on the way in
 * and out, so a caller mutating what it got back cannot corrupt the store;
 * and the derived indexes (byUname, byChunk) are maintained on every write,
 * so a lookup here goes through the same two paths a real one does.
 */
'use strict';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const startsWith = (s, prefix) => typeof s === 'string' && s.startsWith(prefix);

// The two shapes list-store.js's makeRow builds, repeated here (it is an ES
// module and this is CommonJS) so a test can seed rows by what they are
// rather than by hand-built keys. Kept identical on purpose.
const ID_RE = /^\d{4,24}$/;
const normUname = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

function rowOf(spec) {
  if (spec && typeof spec.key === 'string' && spec.key) return clone(spec);
  const p = String(spec.platform || '*');
  const chunk = String(spec.chunk || 'manual');
  const uname = normUname(spec.u);
  const t = String(spec.t || 'other');
  if (spec.id !== undefined && spec.id !== null && String(spec.id) !== '') {
    const id = String(spec.id);
    if (!ID_RE.test(id)) throw new Error('memory-list-store: not an id: ' + id);
    const row = { key: `${p}:${id}`, platform: p, kind: 'id', chunk, id, t };
    if (spec.u !== undefined && spec.u !== null && String(spec.u) !== '') row.u = String(spec.u);
    if (uname) row.uname = uname;
    if (spec.d) row.d = String(spec.d).slice(0, 120);
    return row;
  }
  if (!uname) throw new Error('memory-list-store: a row needs an id or a username');
  const row = { key: `${p}:@${uname}`, platform: p, kind: 'handle', chunk, u: String(spec.u), uname, t };
  if (spec.d) row.d = String(spec.d).slice(0, 120);
  return row;
}

function createMemoryListStore() {
  const meta = new Map();     // k -> doc
  const groups = new Map();   // key -> table
  const chunks = new Map();   // key -> entry
  const rows = new Map();     // key -> row
  const byUname = new Map();  // uname -> Set(key)
  const byChunk = new Map();  // chunk -> Set(key)

  const index = (map, k, key) => {
    if (k === undefined || k === null) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(key);
  };
  const unindex = (map, k, key) => {
    const set = map.get(k);
    if (!set) return;
    set.delete(key);
    if (!set.size) map.delete(k);
  };
  const deleteRow = (key) => {
    const old = rows.get(key);
    if (!old) return false;
    unindex(byUname, old.uname, key);
    unindex(byChunk, old.chunk, key);
    rows.delete(key);
    return true;
  };
  const putRow = (row) => {
    deleteRow(row.key);
    const stored = clone(row);
    rows.set(stored.key, stored);
    index(byUname, stored.uname, stored.key);
    index(byChunk, stored.chunk, stored.key);
  };
  const keysTagged = (chunk) => [...(byChunk.get(chunk) || [])];
  const keysUnder = (prefix) => {
    const out = [];
    for (const [chunk, set] of byChunk) if (startsWith(chunk, prefix)) out.push(...set);
    return out;
  };

  const store = {
    async open() {},

    async getMeta(k) { return clone(meta.get(k)) || null; },
    async putMeta(doc) { meta.set(doc.k, clone(doc)); },

    async getGroup(key) { return clone(groups.get(key)) || null; },
    async putGroup(key, table) { groups.set(key, clone(Object.assign({}, table, { key }))); },

    async getChunk(key) { return clone(chunks.get(key)) || null; },
    async putChunk(key, entry) { chunks.set(key, clone(Object.assign({}, entry, { key }))); },

    async listChunks(prefix) {
      return [...chunks.keys()].filter(k => startsWith(k, prefix)).sort()
        .map(k => clone(chunks.get(k)));
    },

    async commitBucket({ chunkKey, entry, rows: fresh }) {
      const old = keysTagged(chunkKey);
      for (const key of old) deleteRow(key);
      for (const row of fresh) putRow(row);
      chunks.set(chunkKey, clone(Object.assign({}, entry, { key: chunkKey })));
      return { removed: old.length, added: fresh.length };
    },

    async dropChunk(chunkKey) {
      const old = keysTagged(chunkKey);
      for (const key of old) deleteRow(key);
      chunks.delete(chunkKey);
      return { removed: old.length };
    },

    async sweepPrefix(prefix) {
      const gone = keysUnder(prefix);
      for (const key of gone) deleteRow(key);
      const entries = [...chunks.keys()].filter(k => startsWith(k, prefix));
      for (const key of entries) chunks.delete(key);
      return { rows: gone.length, chunks: entries.length };
    },

    async replaceTagged(tag, fresh) {
      const old = keysTagged(tag);
      for (const key of old) deleteRow(key);
      for (const row of fresh) putRow(row);
      return { removed: old.length, added: fresh.length };
    },

    async fetch({ keys, unames }) {
      const root = meta.get('root');
      const out = { generation: (root && root.generation) || 0, rows: {}, names: {} };
      for (const key of keys) {
        const row = rows.get(key);
        if (row) out.rows[key] = clone(row);
      }
      for (const u of unames) {
        const set = byUname.get(u);
        if (set && set.size) out.names[u] = [...set].map(k => clone(rows.get(k)));
      }
      return out;
    },

    async countTagged(tags) {
      const out = {};
      for (const tag of tags) {
        const acc = { ids: 0, usernames: 0 };
        out[tag] = acc;
        for (const key of keysTagged(tag)) {
          if (key.indexOf(':@') >= 0) acc.usernames++; else acc.ids++;
        }
      }
      return out;
    },

    async clear() {
      meta.clear(); groups.clear(); chunks.clear();
      rows.clear(); byUname.clear(); byChunk.clear();
    },

    async close() {},
    async destroy() { await store.clear(); },

    // ---- for the tests ----------------------------------------------------

    /**
     * REPLACE the rows wholesale -- a list put in place without a fetch, the
     * way the queue tests stand a list up between cases. Every row goes,
     * then `specs` arrive, each {platform, id | u, d?, t?, chunk?} or a
     * fully built row; `platform` defaults to '*' and `chunk` to 'manual',
     * the shape of a hand-listed account. The other three stores are left
     * as they are unless an option names them: `root` and `counts` seed
     * those meta documents (generation lives in root), `extras` the extras
     * document, and `chunks` an array of [key, entry] pairs for tests that
     * plan a walk.
     */
    async seed(specs, opts) {
      rows.clear(); byUname.clear(); byChunk.clear();
      for (const spec of specs || []) putRow(rowOf(spec));
      const o = opts || {};
      if (o.root) meta.set('root', clone(Object.assign({ k: 'root' }, o.root)));
      if (o.counts) meta.set('counts', clone(Object.assign({ k: 'counts' }, o.counts)));
      if (o.extras) meta.set('extras', clone(Object.assign({ k: 'extras' }, o.extras)));
      for (const [key, entry] of o.chunks || []) {
        chunks.set(key, clone(Object.assign({}, entry, { key })));
      }
      return store;
    },

    /** Everything, as plain objects, for assertions. */
    dump() {
      const obj = (map) => {
        const out = {};
        for (const [k, v] of map) out[k] = clone(v);
        return out;
      };
      return { meta: obj(meta), groups: obj(groups), chunks: obj(chunks), rows: obj(rows) };
    },

    /** How many rows are held, for the assertions that count. */
    size() { return rows.size; }
  };
  return store;
}

/**
 * Make `store` (a fresh one by default) the backend list-store.js resolves,
 * and return it. Call before importing the worker; the factory is consulted
 * on every call, so a test may install another store between cases.
 */
function install(store) {
  const s = store || createMemoryListStore();
  globalThis.CB_LIST_STORE_FACTORY = () => s;
  return s;
}

module.exports = { createMemoryListStore, install, rowOf };
