/**
 * The list store: every listed row, in IndexedDB.
 *
 * The blocklist used to be two arrays in chrome.storage.local that every
 * content script copied into Sets of its own. That stops at a few thousand
 * rows: the record has a quota, every tab holds a full copy, and a refresh
 * rewrites the lot. The rows live here now -- one database in the service
 * worker's origin, which the extension pages share -- and a page asks for
 * exactly the authors on its screen, by key.
 *
 * This module is the ONLY code that names the stores and indexes. Everything
 * else -- the walk in list-sync.js, the worker's lookup handler, the harness's
 * memory store -- speaks the interface exported below and never a store name.
 *
 * Stores (database CB_LIST_DB, version CB_LIST_DB_VERSION, both published by
 * protocol.js so the worker, the pages and the harnesses agree):
 *
 *   meta    keyPath 'k'   'root' is the last FULLY committed root, written
 *                         only at the end of a walk, so anti-rollback and the
 *                         unchanged short-circuit compare against a complete
 *                         list and never against chrome.storage. 'extras' is
 *                         the sha-verified extras object, kept whole (there is
 *                         no 10 MB quota here) so a forced refresh re-ranks
 *                         with no fetch. 'counts' is recomputed at commit.
 *   groups  keyPath 'key' `${platform}:${j}` -> {sha, k, g, chunks}. The
 *                         VERIFIED table, not just its name: an unchanged
 *                         group plans from disk without a fetch, and a walk
 *                         that resumes after the worker died plans stored
 *                         tables against the chunks store. A sha alone would
 *                         let a half-committed group pass for a finished one.
 *   chunks  keyPath 'key' `${platform}:${k}:${bucket}` -> {sha, rows, bytes,
 *                         idRows, handleRows, at}, one entry per COMMITTED
 *                         bucket. k is in the key so a k change never collides
 *                         with the old layout, and the old k's leftovers are
 *                         one range sweep.
 *   rows    keyPath 'key' `${platform}:${id}` for an id, `${platform}:@${u}`
 *                         for a handle, '*' as the platform for manual and
 *                         legacy rows -- the same key the server hashes. Two
 *                         indexes: byUname (non-unique: an id row and a handle
 *                         row may share a name, and so may both platforms),
 *                         byChunk (non-unique: a replaced bucket's rows are
 *                         one index range).
 *
 * No staging store and no progress record. A bucket commits in ONE
 * transaction -- delete its old rows, put the new ones, put its chunk entry --
 * so the chunks store IS the progress: a worker killed anywhere leaves the
 * previous bucket contents answering lookups, and the next walk finds the
 * bucket still missing and does it again.
 *
 * THE BACKEND SEAM. Node has no IndexedDB, so the harnesses install a
 * Map-backed implementation of the same narrow interface (tools/lib/
 * memory-list-store.js) through globalThis.CB_LIST_STORE_FACTORY before they
 * import the worker -- the pattern CB_MIGRATE_CONFIG in service-worker.js
 * set. Every export resolves the backend on each call, so a test can swap it
 * between cases, and the IndexedDB backend is touched only inside a call and
 * never at import, which is what lets this module load in Node at all. The
 * backend interface is the storage primitives (the `idb` object below); the
 * semantics every caller relies on -- id filtering, name normalisation, the
 * '*' fallback, which row wins a name, the counts document -- live once, in
 * the exported functions, and run against either backend.
 */

const META = 'meta';
const GROUPS = 'groups';
const CHUNKS = 'chunks';
const ROWS = 'rows';
const BY_UNAME = 'byUname';
const BY_CHUNK = 'byChunk';

/**
 * How many keys one lookup may ask about, per kind. Over-cap requests are
 * truncated rather than refused: a page that lists more authors than this
 * gets the first LOOKUP_MAX answered and asks again for the rest.
 */
export const LOOKUP_MAX = 500;

/**
 * Rows per transaction when a whole tag or key prefix is rewritten. Bounds
 * memory to one batch of keys, rather than one transaction per row or every
 * key at once.
 */
export const ROW_BATCH = 5000;

/** A platform id. The same shape service-worker.js filters with. */
export const ID_RE = /^\d{4,24}$/;

/** The longest display name a row keeps. */
const NAME_MAX = 120;

/**
 * Past every string that starts with a prefix. IndexedDB compares strings by
 * UTF-16 code unit and U+FFFF is the largest, so [prefix, prefix + PAST] is
 * exactly the strings with that prefix.
 */
const PAST = '\uffff';

/** A username as it is keyed and indexed: trimmed, lowercase, no leading @. */
export function normUname(u) {
  return String(u || '').trim().toLowerCase().replace(/^@/, '');
}

export const idKey = (platform, id) => `${platform}:${id}`;
export const handleKey = (platform, uname) => `${platform}:@${uname}`;
export const chunkKey = (platform, k, bucket) => `${platform}:${k}:${bucket}`;
export const groupKey = (platform, j) => `${platform}:${j}`;

/**
 * One stored row from one published (or legacy) entry.
 *
 * Returns null for a shape that is not a row at all -- no id and no usable
 * handle -- so a caller can count what it dropped rather than store a record
 * nothing can find. `t` is stored as published: tagOf() maps an unknown tag to
 * 'other' when it is READ, and storing the mapped value would hide a tag this
 * build does not know yet from the build that will. `uname` goes on both kinds
 * so names and username membership use one index; `d` is cut to NAME_MAX.
 */
export function makeRow({ platform, chunk, id, u, d, t }) {
  const p = String(platform || '');
  const c = String(chunk || '');
  if (!p || !c) return null;
  const uname = normUname(u);
  const tag = String(t || 'other');
  const hasU = u !== undefined && u !== null && String(u) !== '';
  if (id !== undefined && id !== null && String(id) !== '') {
    const i = String(id);
    if (!ID_RE.test(i)) return null;
    const row = { key: idKey(p, i), platform: p, kind: 'id', chunk: c, id: i, t: tag };
    if (hasU) row.u = String(u);
    if (uname) row.uname = uname;
    if (d) row.d = String(d).slice(0, NAME_MAX);
    return row;
  }
  if (!uname) return null;
  const row = { key: handleKey(p, uname), platform: p, kind: 'handle', chunk: c, u: String(u), uname, t: tag };
  if (d) row.d = String(d).slice(0, NAME_MAX);
  return row;
}

// -- the IndexedDB backend ----------------------------------------------------

function settled(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('list-store: transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('list-store: transaction failed'));
  });
}

/**
 * One transaction, start to finish.
 *
 * `body` issues its requests SYNCHRONOUSLY and collects their results in the
 * callbacks, returning the object they fill in (or a function that reads it
 * once the transaction is complete). Nothing here awaits between requests: an
 * IndexedDB transaction auto-commits when no request is pending, and the
 * cheapest way never to fall foul of that is to hand it every request at
 * once. A thrown body aborts the transaction, so nothing half-done lands.
 */
async function transact(db, names, access, body) {
  const tx = db.transaction(names, access);
  const finished = settled(tx);
  let out;
  try {
    out = body(tx);
  } catch (e) {
    try { tx.abort(); } catch (_) { /* already over */ }
    await finished.catch(() => {});
    throw e;
  }
  await finished;
  return typeof out === 'function' ? out() : out;
}

function createSchema(db) {
  // Version 1. A later version adds its migration here, keyed on the request
  // event's oldVersion; there is nothing to migrate from yet.
  if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'k' });
  if (!db.objectStoreNames.contains(GROUPS)) db.createObjectStore(GROUPS, { keyPath: 'key' });
  if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: 'key' });
  if (!db.objectStoreNames.contains(ROWS)) {
    const rows = db.createObjectStore(ROWS, { keyPath: 'key' });
    rows.createIndex(BY_UNAME, 'uname', { unique: false });
    rows.createIndex(BY_CHUNK, 'chunk', { unique: false });
  }
}

// The open connection, memoised per worker lifetime. Reset when the database
// closes under us -- a versionchange from another context, or a destroy() --
// so the next call opens afresh rather than failing on a dead handle.
let opening = null;

function openDb() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const name = globalThis.CB_LIST_DB;
    const version = globalThis.CB_LIST_DB_VERSION;
    if (!name || !version) {
      reject(new Error('list-store: protocol.js has not published CB_LIST_DB'));
      return;
    }
    if (typeof indexedDB === 'undefined') {
      reject(new Error('list-store: IndexedDB is not available here'));
      return;
    }
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = () => createSchema(r.result);
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); opening = null; };
      db.onclose = () => { opening = null; };
      resolve(db);
    };
    r.onerror = () => reject(r.error || new Error('list-store: open failed'));
  });
  opening.catch(() => { opening = null; });
  return opening;
}

const range = (prefix) => IDBKeyRange.bound(prefix, prefix + PAST);

/**
 * The storage primitives. This object IS the backend interface: a factory
 * installed on globalThis.CB_LIST_STORE_FACTORY must return an object with
 * these methods and these shapes, and nothing else in the module knows which
 * one it is talking to.
 */
const idb = {
  open() { return openDb().then(() => undefined); },

  async getMeta(k) {
    const db = await openDb();
    return transact(db, [META], 'readonly', (tx) => {
      const r = tx.objectStore(META).get(k);
      return () => r.result || null;
    });
  },

  async putMeta(doc) {
    const db = await openDb();
    await transact(db, [META], 'readwrite', (tx) => { tx.objectStore(META).put(doc); });
  },

  async getGroup(key) {
    const db = await openDb();
    return transact(db, [GROUPS], 'readonly', (tx) => {
      const r = tx.objectStore(GROUPS).get(key);
      return () => r.result || null;
    });
  },

  async putGroup(key, table) {
    const db = await openDb();
    await transact(db, [GROUPS], 'readwrite', (tx) => {
      tx.objectStore(GROUPS).put(Object.assign({}, table, { key }));
    });
  },

  async getChunk(key) {
    const db = await openDb();
    return transact(db, [CHUNKS], 'readonly', (tx) => {
      const r = tx.objectStore(CHUNKS).get(key);
      return () => r.result || null;
    });
  },

  async putChunk(key, entry) {
    const db = await openDb();
    await transact(db, [CHUNKS], 'readwrite', (tx) => {
      tx.objectStore(CHUNKS).put(Object.assign({}, entry, { key }));
    });
  },

  /** Every chunk entry whose key starts with `prefix`, in key order. */
  async listChunks(prefix) {
    const db = await openDb();
    return transact(db, [CHUNKS], 'readonly', (tx) => {
      const r = tx.objectStore(CHUNKS).getAll(range(prefix));
      return () => r.result || [];
    });
  },

  /**
   * One bucket, landed whole: the rows the chunk key held before go, the new
   * rows and the chunk entry arrive, all in one transaction. A row whose key
   * already exists under another chunk is simply overwritten, which is how a
   * row moves between layouts when k changes.
   */
  async commitBucket({ chunkKey: ck, entry, rows }) {
    const db = await openDb();
    return transact(db, [ROWS, CHUNKS], 'readwrite', (tx) => {
      const rs = tx.objectStore(ROWS);
      const out = { removed: 0, added: rows.length };
      const old = rs.index(BY_CHUNK).getAllKeys(IDBKeyRange.only(ck));
      old.onsuccess = () => {
        out.removed = old.result.length;
        for (const key of old.result) rs.delete(key);
        for (const row of rows) rs.put(row);
        tx.objectStore(CHUNKS).put(Object.assign({}, entry, { key: ck }));
      };
      return out;
    });
  },

  /** A bucket the plan says is empty now: its rows and its entry, together. */
  async dropChunk(ck) {
    const db = await openDb();
    return transact(db, [ROWS, CHUNKS], 'readwrite', (tx) => {
      const rs = tx.objectStore(ROWS);
      const out = { removed: 0 };
      const old = rs.index(BY_CHUNK).getAllKeys(IDBKeyRange.only(ck));
      old.onsuccess = () => {
        out.removed = old.result.length;
        for (const key of old.result) rs.delete(key);
        tx.objectStore(CHUNKS).delete(ck);
      };
      return out;
    });
  },

  /**
   * Everything under a chunk-key prefix: rows first, `batch` keys per
   * transaction through the byChunk index, then the chunk entries. Either
   * order is safe to interrupt -- an entry without rows and rows without an
   * entry are both found again by the same prefix next time -- and rows first
   * means a lookup never sees an entry claiming rows that are already gone.
   */
  async sweepPrefix(prefix, batch) {
    const db = await openDb();
    const out = { rows: 0, chunks: 0 };
    if (!(batch > 0)) batch = ROW_BATCH;
    for (;;) {
      const n = await transact(db, [ROWS], 'readwrite', (tx) => {
        const rs = tx.objectStore(ROWS);
        const box = { n: 0 };
        const r = rs.index(BY_CHUNK).getAllKeys(range(prefix), batch);
        r.onsuccess = () => {
          box.n = r.result.length;
          for (const key of r.result) rs.delete(key);
        };
        return () => box.n;
      });
      out.rows += n;
      if (n < batch) break;
    }
    out.chunks = await transact(db, [CHUNKS], 'readwrite', (tx) => {
      const cs = tx.objectStore(CHUNKS);
      const box = { n: 0 };
      const r = cs.getAllKeys(range(prefix));
      r.onsuccess = () => {
        box.n = r.result.length;
        for (const key of r.result) cs.delete(key);
      };
      return () => box.n;
    });
    return out;
  },

  /**
   * Replace every row tagged `tag` (its chunk value) with `rows`. Old rows go
   * `batch` at a time; the last batch of deletes and the first batch of puts
   * share a transaction, so a small set -- the manual list -- lands whole.
   * A large one (a legacy import) lands in batches, and its caller writes the
   * root last so a kill mid-way is a walk that simply runs again.
   */
  async replaceTagged(tag, rows, batch) {
    const db = await openDb();
    const out = { removed: 0, added: rows.length };
    if (!(batch > 0)) batch = ROW_BATCH;
    for (;;) {
      const n = await transact(db, [ROWS], 'readwrite', (tx) => {
        const rs = tx.objectStore(ROWS);
        const box = { n: 0 };
        const r = rs.index(BY_CHUNK).getAllKeys(IDBKeyRange.only(tag), batch);
        r.onsuccess = () => {
          box.n = r.result.length;
          for (const key of r.result) rs.delete(key);
          if (box.n < batch) for (const row of rows.slice(0, batch)) rs.put(row);
        };
        return () => box.n;
      });
      out.removed += n;
      if (n < batch) break;
    }
    for (let i = batch; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch);
      await transact(db, [ROWS], 'readwrite', (tx) => {
        const rs = tx.objectStore(ROWS);
        for (const row of slice) rs.put(row);
      });
    }
    return out;
  },

  /**
   * The one read every lookup is built from: the rows under `keys`, the rows
   * indexed under each of `unames`, and the committed generation, from ONE
   * readonly transaction. Misses are simply absent. Never the network.
   */
  async fetch({ keys, unames }) {
    const db = await openDb();
    return transact(db, [ROWS, META], 'readonly', (tx) => {
      const rs = tx.objectStore(ROWS);
      const byName = rs.index(BY_UNAME);
      const out = { generation: 0, rows: {}, names: {} };
      const root = tx.objectStore(META).get('root');
      root.onsuccess = () => {
        out.generation = (root.result && root.result.generation) || 0;
      };
      for (const key of keys) {
        const r = rs.get(key);
        r.onsuccess = () => { if (r.result) out.rows[key] = r.result; };
      }
      for (const u of unames) {
        const r = byName.getAll(u);
        r.onsuccess = () => { if (r.result.length) out.names[u] = r.result; };
      }
      return out;
    });
  },

  /**
   * How many id rows and handle rows carry each tag. Keys only: the kind is
   * in the key (':@' marks a handle), so a legacy import of any size is
   * counted without loading a value.
   */
  async countTagged(tags) {
    const db = await openDb();
    return transact(db, [ROWS], 'readonly', (tx) => {
      const byChunk = tx.objectStore(ROWS).index(BY_CHUNK);
      const out = {};
      for (const tag of tags) {
        const acc = { ids: 0, usernames: 0 };
        out[tag] = acc;
        const r = byChunk.getAllKeys(IDBKeyRange.only(tag));
        r.onsuccess = () => {
          for (const key of r.result) {
            if (key.indexOf(':@') >= 0) acc.usernames++; else acc.ids++;
          }
        };
      }
      return out;
    });
  },

  /** Every store emptied, in one transaction. A legacy import starts here. */
  async clear() {
    const db = await openDb();
    await transact(db, [META, GROUPS, CHUNKS, ROWS], 'readwrite', (tx) => {
      for (const name of [META, GROUPS, CHUNKS, ROWS]) tx.objectStore(name).clear();
    });
  },

  /** Close the memoised connection; the next call reopens. */
  async close() {
    if (!opening) return;
    const p = opening;
    opening = null;
    try { (await p).close(); } catch (_) { /* never opened */ }
  },

  /**
   * Delete the database. Our own connection is closed first; one held open by
   * a page gets versionchange and closes itself, after which the delete goes
   * through -- `blocked` resolves rather than waits, because a page that
   * ignores versionchange would otherwise hold this promise forever.
   */
  async destroy() {
    await idb.close();
    const name = globalThis.CB_LIST_DB;
    if (!name || typeof indexedDB === 'undefined') return;
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => resolve();
      r.onblocked = () => resolve();
      r.onerror = () => reject(r.error || new Error('list-store: delete failed'));
    });
  }
};

// The seam. Resolved on every call, never cached: a harness installs its
// factory before importing the worker and may swap it between cases.
const backend = () => (globalThis.CB_LIST_STORE_FACTORY ? globalThis.CB_LIST_STORE_FACTORY() : idb);

// -- the interface everything else uses ----------------------------------------

function mustBeKey(v, what) {
  if (typeof v !== 'string' || !v) throw new TypeError(`list-store: ${what} must be a non-empty string`);
  return v;
}

function mustBeRows(rows, chunk) {
  if (!Array.isArray(rows)) throw new TypeError('list-store: rows must be an array');
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !row.key) {
      throw new TypeError('list-store: every row needs a key');
    }
    if (row.chunk !== chunk) {
      throw new TypeError(`list-store: row ${row.key} is tagged ${row.chunk}, not ${chunk}`);
    }
  }
  return rows;
}

/** Ids worth asking about: the id shape, deduplicated, at most LOOKUP_MAX. */
function cleanIds(ids) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(ids) ? ids : []) {
    const id = String(v || '').trim();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= LOOKUP_MAX) break;
  }
  return out;
}

/** Names worth asking about: normalised, non-empty, deduplicated, capped. */
function cleanNames(usernames) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(usernames) ? usernames : []) {
    const u = normUname(v);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= LOOKUP_MAX) break;
  }
  return out;
}

/** What an id hit tells a page: the tag, the row's platform, a name if any. */
function idHit(row) {
  const hit = { t: row.t, p: row.platform };
  if (row.u !== undefined) hit.u = row.u;
  if (row.d !== undefined) hit.d = row.d;
  return hit;
}

/**
 * Which of the rows indexed under a name answers for it.
 *
 * Username membership keeps the legacy semantics: a HANDLE row is a hit, an
 * id row that happens to carry the same name is not, unless the caller asks
 * for id-row names too. A row for the asked platform beats a '*' row, and a
 * handle row beats an id row, so the answer is the most specific listing.
 */
function pickName(rows, platform, idRowUsernames) {
  let best = null, bestScore = Infinity;
  for (const row of rows) {
    const onPlatform = row.platform === platform;
    if (!onPlatform && row.platform !== '*') continue;
    const isHandle = row.kind === 'handle';
    if (!isHandle && !idRowUsernames) continue;
    const score = (onPlatform ? 0 : 2) + (isHandle ? 0 : 1);
    if (score < bestScore) { best = row; bestScore = score; }
  }
  return best;
}

export function open() { return backend().open(); }
export function getMeta(k) { return backend().getMeta(mustBeKey(k, 'meta key')); }
export function putMeta(doc) {
  if (!doc || typeof doc.k !== 'string' || !doc.k) throw new TypeError('list-store: a meta document needs k');
  return backend().putMeta(doc);
}
export function getGroup(key) { return backend().getGroup(mustBeKey(key, 'group key')); }
export function putGroup(key, table) {
  if (!table || typeof table !== 'object') throw new TypeError('list-store: a group table must be an object');
  return backend().putGroup(mustBeKey(key, 'group key'), table);
}
export function getChunk(key) { return backend().getChunk(mustBeKey(key, 'chunk key')); }
export function putChunk(key, entry) {
  if (!entry || typeof entry !== 'object') throw new TypeError('list-store: a chunk entry must be an object');
  return backend().putChunk(mustBeKey(key, 'chunk key'), entry);
}
export function listChunks(prefix) { return backend().listChunks(mustBeKey(prefix, 'prefix')); }

/**
 * Land one bucket: `rows` (every one tagged `chunkKey`) replace whatever the
 * chunk key held, and `entry` ({sha, rows, bytes, idRows, handleRows, at})
 * records it, in one transaction. Returns {removed, added}.
 */
export function commitBucket({ chunkKey: ck, entry, rows }) {
  mustBeKey(ck, 'chunk key');
  if (!entry || typeof entry.sha !== 'string') throw new TypeError('list-store: a chunk entry needs sha');
  return backend().commitBucket({ chunkKey: ck, entry, rows: mustBeRows(rows, ck) });
}

/** Remove one bucket's rows and its entry together. Returns {removed}. */
export function dropChunk(ck) { return backend().dropChunk(mustBeKey(ck, 'chunk key')); }

/**
 * Remove every row and chunk entry whose chunk key starts with `prefix` --
 * `${platform}:${kOld}:` after a k change, `${platform}:` for a platform the
 * root no longer names, 'legacy' after a source switch. Batched; returns
 * {rows, chunks}.
 */
export function sweepPrefix(prefix, batch = ROW_BATCH) {
  return backend().sweepPrefix(mustBeKey(prefix, 'prefix'), batch);
}

/**
 * Replace the rows tagged `tag` ('manual', 'legacy') with `rows`, every one
 * of which must carry that tag. Returns {removed, added}.
 */
export function replaceTagged(tag, rows, batch = ROW_BATCH) {
  return backend().replaceTagged(mustBeKey(tag, 'tag'), mustBeRows(rows, tag), batch);
}

/**
 * Membership for a page's worth of authors, in the sw:blocklist-lookup reply
 * shape: {generation, ids: {id: {t, u?, d?, p}}, usernames: {uname: {t, p}}}.
 *
 * POSITIVES ONLY: a key absent from the reply is a miss, which keeps replies
 * tiny on a feed where almost every author is clean. An id is looked up
 * under the asked platform and then under '*' (manual and legacy rows); a
 * name is answered by the byUname index filtered to those two platforms and,
 * by default, to handle rows -- see pickName. Inputs are filtered, normalised,
 * deduplicated and capped here, so a caller may hand over what it scraped.
 */
export async function lookup({ platform, ids, usernames, idRowUsernames = false }) {
  const p = mustBeKey(platform, 'platform');
  const wantIds = cleanIds(ids);
  const wantNames = cleanNames(usernames);
  const keys = [];
  for (const id of wantIds) {
    keys.push(idKey(p, id));
    if (p !== '*') keys.push(idKey('*', id));
  }
  const got = await backend().fetch({ keys, unames: wantNames });
  const out = { generation: got.generation || 0, ids: {}, usernames: {} };
  for (const id of wantIds) {
    const row = got.rows[idKey(p, id)] || got.rows[idKey('*', id)];
    if (row) out.ids[id] = idHit(row);
  }
  for (const u of wantNames) {
    const best = pickName(got.names[u] || [], p, idRowUsernames);
    if (best) out.usernames[u] = { t: best.t, p: best.platform };
  }
  return out;
}

/** The stored rows under exactly these keys, as {key: row}; misses absent. */
export async function getRows(keys) {
  const want = (Array.isArray(keys) ? keys : []).filter(k => typeof k === 'string' && k);
  if (!want.length) return {};
  return (await backend().fetch({ keys: want, unames: [] })).rows;
}

/**
 * Which of these ids are listed for the platform, with the '*' fallback --
 * what pruning the queue against the list needs. Returns a Set of ids.
 */
export async function hasIds(platform, ids) {
  const p = mustBeKey(platform, 'platform');
  const present = new Set();
  // Not capped like a lookup -- a queue is as long as it is -- but read in
  // LOOKUP_MAX-sized slices, so a long one is a few reads rather than one
  // transaction holding every key at once.
  const all = (Array.isArray(ids) ? ids : []).map(v => String(v || '').trim()).filter(v => ID_RE.test(v));
  const unique = [...new Set(all)];
  for (let i = 0; i < unique.length; i += LOOKUP_MAX) {
    const slice = unique.slice(i, i + LOOKUP_MAX);
    const keys = [];
    for (const id of slice) {
      keys.push(idKey(p, id));
      if (p !== '*') keys.push(idKey('*', id));
    }
    const got = await backend().fetch({ keys, unames: [] });
    for (const id of slice) {
      if (got.rows[idKey(p, id)] || got.rows[idKey('*', id)]) present.add(id);
    }
  }
  return present;
}

/**
 * The 'counts' document, recomputed from the chunks store at the current k
 * of each platform ({threads: k, facebook: k}) plus the manual and legacy
 * tallies, written to meta and returned. `ids` and `usernames` include the
 * manual and legacy rows: they are what the popup's list line prints.
 */
export async function recomputeCounts(platformsK) {
  const b = backend();
  const byPlatform = {};
  let ids = 0, usernames = 0, chunksTotal = 0, bytes = 0;
  for (const p of Object.keys(platformsK || {})) {
    const k = platformsK[p];
    const entries = Number.isInteger(k) && k >= 0 ? await b.listChunks(`${p}:${k}:`) : [];
    const acc = { ids: 0, usernames: 0, chunks: entries.length, bytes: 0 };
    for (const e of entries) {
      acc.ids += e.idRows || 0;
      acc.usernames += e.handleRows || 0;
      acc.bytes += e.bytes || 0;
    }
    byPlatform[p] = acc;
    ids += acc.ids;
    usernames += acc.usernames;
    chunksTotal += acc.chunks;
    bytes += acc.bytes;
  }
  const tagged = await b.countTagged(['manual', 'legacy']);
  const manual = tagged.manual || { ids: 0, usernames: 0 };
  const legacy = tagged.legacy || { ids: 0, usernames: 0 };
  const doc = {
    k: 'counts',
    ids: ids + manual.ids + legacy.ids,
    usernames: usernames + manual.usernames + legacy.usernames,
    manualIds: manual.ids,
    manualUsernames: manual.usernames,
    legacyIds: legacy.ids,
    legacyUsernames: legacy.usernames,
    byPlatform,
    chunksTotal,
    bytes
  };
  await b.putMeta(doc);
  return doc;
}

export function clear() { return backend().clear(); }
export function close() { return backend().close ? backend().close() : Promise.resolve(); }
export function destroy() { return backend().destroy(); }
