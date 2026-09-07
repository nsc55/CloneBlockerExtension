/**
 * The chunked blocklist (v3): the walk that keeps the list store equal to a
 * signed root.
 *
 * The whole-file list stopped scaling at about 1,700 targets, so the server
 * also publishes the same listing as a small signed ROOT naming
 * content-addressed OBJECTS (CloneBlockerBackend/server/src/lib/publish-v3.js
 * is the format's source of truth; docs/BACKEND.md describes it):
 *
 *   <base>manifest.json                 the signed root: per platform the
 *                                       bucket bits k, the group bits g, the
 *                                       row total and the group tables
 *   <base>objects/<sha256>.json         a group table (which chunk holds each
 *                                       bucket) or the extras object
 *   <base>objects/<sha256>.ndjson.gz    a chunk: one row per line, gzipped
 *
 * A row's bucket is the high k bits of the first four bytes of
 * sha256('<platform>:<id>') or sha256('<platform>:@<handle>'); an object's
 * name is the SHA-256 of its exact bytes. So the root is the only thing that
 * needs a signature, every object is bound to it by its hash, and a client
 * that remembers which chunk it holds for each bucket downloads only the
 * buckets whose names changed. This module is that client: it plans from the
 * root against what the store already holds, fetches what is missing,
 * verifies every byte before believing it, and commits ONE BUCKET AT A TIME
 * into IndexedDB (list-store.js). Every step is idempotent, so a service
 * worker killed anywhere in the walk simply re-enters on the next alarm and
 * continues: progress is the chunks store itself, and the root is written
 * last, only once everything it names is in place.
 *
 * PRIVACY INVARIANT. The set of objects fetched is a pure function of
 * (the committed chunks store, the new root): no lookup, no page and no
 * profile ever causes a fetch, and nothing about this browser reaches a
 * mirror -- no Authorization, no If-None-Match, no query string. A content
 * hash names bytes everybody downloads and describes nobody. The fixed-url
 * assertions in tools/queue-test.js encode this; keep them true.
 *
 * Memory stays bounded whatever the list's size: one compressed object, one
 * inflated chunk, one plan array of 2^k entries and one bucket's rows are the
 * most in flight at once -- never every row.
 *
 * The store is list-store.js's exported interface -- getMeta/putMeta,
 * getGroup/putGroup, listChunks, commitBucket, dropChunk, sweepPrefix,
 * replaceTagged, recomputeCounts, clear -- passed in as `store` by the worker
 * (and defaulted to the module here), so the harnesses drive this walk
 * against the Map-backed twin they install through CB_LIST_STORE_FACTORY.
 */

import { isEnvelope, verifyEnvelope, sha256Hex } from './envelope.js';
import * as ListStore from './list-store.js';
import { makeRow, chunkKey, groupKey, normUname, ID_RE } from './list-store.js';

const V = 3;
const HASH = 'sha256-hi32';
const PLATFORMS = ['threads', 'facebook'];

// This build's own ceilings, sized for millions of rows rather than for the
// server's current output (8192 rows and 256 KiB per chunk today). The root
// carries the server's maxChunkRows / maxChunkBytes and they must fit under
// these; k <= 16 keeps a plan array under 65,536 entries and a group table
// under 64 KiB.
export const MAX_CHUNK_ROWS = 8192;
export const MAX_CHUNK_GZ_BYTES = 256 * 1024;
export const MAX_INFLATED = 4 * 1024 * 1024;
export const MAX_GROUP_BYTES = 64 * 1024;
export const MAX_EXTRAS_BYTES = 4 * 1024 * 1024;
export const MAX_K = 16;
export const MAX_G = 8;
export const MAX_ROWS_PER_PLATFORM = 4000000;
// The extras object carries the ranked targets' metadata; the tail slices
// the first 200 and rememberNames() takes at most this many per platform.
export const MAX_EXTRAS_TARGETS = 2000;
// An extension-API call resets the MV3 idle timer. A long cold sync makes
// one this often, and the resume logic covers the case where that does not
// suffice.
const HEARTBEAT_MS = 20 * 1000;

const HEX64 = /^[0-9a-f]{64}$/;
// A self-hosted chunked list is recognised by its URL shape alone: the root
// of a v3 tree is always <base>manifest.json with <base> ending in
// /blocklist/v3/, and no other list URL ends that way.
const V3_ROOT_RE = /\/blocklist\/v3\/manifest\.json$/i;
// What a base named by a pointer or compiled into the build must look like --
// the mirror of the server's pointer.js V3_BASE, so a whole-file address can
// never be taken for a base.
const V3_BASE_RE = /^https:\/\/.+\/blocklist\/v3\/$/i;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const decodeUtf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

// Read at call time rather than at import: protocol.js publishes these onto
// globalThis when the worker evaluates it, and a harness may swap them.
const listUrlDefault = () => globalThis.CB_LIST_URL || '';
const compiledBases = () => globalThis.CB_V3_MIRRORS || [];
const tagOf = (value) => ((globalThis.CB_TAGS || []).includes(value) ? value : 'other');

// ---------------------------------------------------------------------------
// which bases, and in what order
// ---------------------------------------------------------------------------

/** Is this list URL the root of a chunked tree? */
export function isV3ListUrl(url) {
  return V3_ROOT_RE.test(String(url || ''));
}

/**
 * The base of a self-hosted chunked list, or null.
 *
 * The shipped default is never self-hosted, whatever its shape: it is a public
 * file, so it gets no exemption. Any other listUrl ending in
 * /blocklist/v3/manifest.json is a tree the reader themselves pointed at, and
 * that base is granted the two things a self-hosted primary always was -- an
 * unsigned root, and a rollback.
 */
export function selfHostedBase(settings) {
  const listUrl = String((settings && settings.listUrl) || '');
  if (!listUrl || listUrl === listUrlDefault() || !isV3ListUrl(listUrl)) return null;
  return listUrl.slice(0, listUrl.length - 'manifest.json'.length);
}

/**
 * The bases to try, in order: the self-hosted one first when there is one,
 * then whatever a signed pointer named, then the compiled copies; deduped.
 * Empty means the v3 phase is not attempted at all -- the primary is some
 * other address, and that is the legacy whole-file loop's business.
 */
export function v3Candidates(settings, pointerRec) {
  const listUrl = String((settings && settings.listUrl) || '');
  const self = selfHostedBase(settings);
  if (!self && listUrl !== listUrlDefault()) return [];
  const named = (pointerRec && Array.isArray(pointerRec.v3Mirrors)) ? pointerRec.v3Mirrors : [];
  const out = [];
  const seen = new Set();
  const take = (base) => {
    if (!base || seen.has(base)) return;
    seen.add(base);
    out.push(base);
  };
  take(self);
  for (const b of named.concat(compiledBases())) {
    const base = String(b || '').trim();
    if (V3_BASE_RE.test(base)) take(base);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the root
// ---------------------------------------------------------------------------

/**
 * A root payload, checked field by field against this build's ceilings, or
 * null for anything that is not one. Returns a fresh object holding only what
 * the walk reads, so nothing downstream has to re-check a shape.
 *
 * Unknown platforms are skipped rather than refused: a root that adds one is
 * still a valid list of the two this build knows. A known platform that is
 * malformed refuses the whole root, because a plan built from it would be
 * wrong about every bucket.
 */
export function validateRoot(payload) {
  if (!isPlainObject(payload)) return null;
  if (payload.v !== V || payload.hash !== HASH) return null;
  if (typeof payload.updatedAt !== 'string' || !Number.isFinite(Date.parse(payload.updatedAt))) return null;
  if (!isIntIn(payload.maxChunkRows, 1, MAX_CHUNK_ROWS)) return null;
  if (!isIntIn(payload.maxChunkBytes, 1, MAX_CHUNK_GZ_BYTES)) return null;
  if (!isPlainObject(payload.platforms)) return null;
  const platforms = {};
  for (const p of PLATFORMS) {
    if (!Object.prototype.hasOwnProperty.call(payload.platforms, p)) continue;
    const part = payload.platforms[p];
    if (!isPlainObject(part)) return null;
    if (!isIntIn(part.k, 0, MAX_K) || !isIntIn(part.g, 0, MAX_G) || part.g > part.k) return null;
    if (!isIntIn(part.total, 0, MAX_ROWS_PER_PLATFORM)) return null;
    if (!Array.isArray(part.groups) || part.groups.length !== (1 << part.g)) return null;
    if (!part.groups.every(s => typeof s === 'string' && HEX64.test(s))) return null;
    platforms[p] = { k: part.k, g: part.g, total: part.total, groups: part.groups.slice() };
  }
  let extras = null;
  if (payload.extras != null) {
    if (typeof payload.extras !== 'string' || !HEX64.test(payload.extras)) return null;
    extras = payload.extras;
  }
  for (const key of ['rankWeights', 'docIdOverrides']) {
    if (payload[key] != null && !isPlainObject(payload[key])) return null;
  }
  return {
    v: V,
    updatedAt: payload.updatedAt,
    hash: HASH,
    maxChunkRows: payload.maxChunkRows,
    maxChunkBytes: payload.maxChunkBytes,
    platforms,
    extras,
    rankWeights: payload.rankWeights || null,
    docIdOverrides: payload.docIdOverrides || null
  };
}

/**
 * GET one base's root.
 *
 * Plain headers only. If-None-Match is not CORS-safelisted, so it would turn
 * the poll into a preflighted request that neither raw.githubusercontent nor
 * jsDelivr answers (raw 403s OPTIONS outright, jsDelivr omits allow-headers;
 * verified 2026-08-27 and again 2026-09-06), and an Authorization header is
 * a credential this build has no business showing a mirror. Nothing is gated
 * on Content-Type either: raw serves JSON as text/plain.
 *
 * Signed and verifying is accepted from anywhere; signed and failing is
 * refused from anywhere, because a thing that claims a signature and cannot
 * back it is an attack rather than a list; unsigned is accepted from the
 * self-hosted base only.
 *
 * Resolves to {payload, verified, etag} or to {error, ...}, where error is
 * one of 'fetch' (threw; detail), 'http' (status), 'notList', 'unsigned' and
 * 'badSignature' -- the caller turns those into stats and messages.
 */
export async function fetchRoot(base, opts) {
  const o = opts || {};
  const fetchFn = o.fetchFn || ((u, init) => globalThis.fetch(u, init));
  let r;
  try {
    r = await fetchFn(base + 'manifest.json', {
      method: 'GET', headers: { accept: 'application/json' }, cache: 'no-cache'
    });
  } catch (e) {
    return { error: 'fetch', detail: (e && e.message) || String(e) };
  }
  if (!r.ok) return { error: 'http', status: r.status };
  let doc;
  try { doc = JSON.parse(await r.text()); }
  catch (e) { return { error: 'notList' }; }

  let inner = doc, verified = false;
  if (isEnvelope(doc)) {
    inner = await verifyEnvelope(doc);
    if (!inner) return { error: 'badSignature' };
    verified = true;
  } else if (!o.selfHosted) {
    return { error: 'unsigned' };
  }
  const payload = validateRoot(inner);
  if (!payload) return { error: 'notList' };
  const etag = (r.headers && typeof r.headers.get === 'function') ? (r.headers.get('etag') || null) : null;
  return { payload, verified, etag };
}

// ---------------------------------------------------------------------------
// objects
// ---------------------------------------------------------------------------

/**
 * GET one content-addressed object from the first base that serves it
 * correctly.
 *
 * Objects are immutable and served with a year of max-age, so the browser's
 * HTTP cache may answer (cache:'default'); no custom headers, for the reasons
 * fetchRoot gives. The bytes are hashed and compared with the name BEFORE
 * they are parsed or inflated, and only bytes that hashed right ever reach
 * `opts.parse`. Content-Length is only an early abort past the cap, never a
 * check: the .json objects arrive transport-encoded on three of the four
 * bases and the browser decodes them (verified live), so the header does not
 * describe the bytes handed over.
 *
 * Per base: a transport error (fetch threw) earns one immediate retry on the
 * same base; an HTTP status -- a 404 included, it is a mirror failure and
 * never "nothing to install" -- or a size failure moves on; bytes that do not
 * hash to the name, or that `parse` rejects, count against stats.badObjects
 * (opts.onBad) and move on, never retried on the same base. Exhausting every
 * base fails: {error} with 'tooLarge' when any cap tripped, 'badObject' when
 * every base that answered served a bad object, otherwise the last transport
 * or HTTP failure.
 *
 *   opts.cap         the most bytes accepted
 *   opts.exactBytes  the signed byte count a chunk must match exactly
 *   opts.parse       async bytes -> {value} | {error: 'badObject'|'tooLarge'}
 *   opts.onBad       async (name, base, why) -- a bad object was served
 *   opts.fetchFn     the harnesses' stand-in for fetch
 */
export async function fetchObject(bases, name, opts) {
  const o = opts || {};
  const fetchFn = o.fetchFn || ((u, init) => globalThis.fetch(u, init));
  const cap = o.cap > 0 ? o.cap : MAX_INFLATED;
  const want = name.slice(0, 64);
  let answered = 0, bad = 0, large = 0, last = null;
  const reject = async (base, why) => {
    bad++;
    last = { kind: 'badObject' };
    if (o.onBad) await o.onBad(name, base, why);
  };
  for (const base of bases) {
    const url = base + 'objects/' + name;
    let r = null;
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      try { r = await fetchFn(url, { method: 'GET', cache: 'default' }); }
      catch (e) { last = { kind: 'fetch', detail: (e && e.message) || String(e) }; }
    }
    if (!r) continue;
    if (!r.ok) { last = { kind: 'http', status: r.status }; continue; }
    answered++;
    const declared = Number(r.headers && typeof r.headers.get === 'function'
      ? r.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > cap) {
      try { if (r.body && r.body.cancel) r.body.cancel().catch(() => {}); } catch (e) { /* already consumed */ }
      large++;
      last = { kind: 'tooLarge' };
      continue;
    }
    let bytes;
    try { bytes = new Uint8Array(await r.arrayBuffer()); }
    catch (e) { last = { kind: 'fetch', detail: (e && e.message) || String(e) }; continue; }
    if (bytes.byteLength > cap) { large++; last = { kind: 'tooLarge' }; continue; }
    if (o.exactBytes != null && bytes.byteLength !== o.exactBytes) { await reject(base, 'bytes'); continue; }
    if ((await sha256Hex(bytes)) !== want) { await reject(base, 'hash'); continue; }
    if (!o.parse) return { bytes, base };
    const parsed = await o.parse(bytes);
    if (!parsed || parsed.error) {
      const why = (parsed && parsed.error) || 'badObject';
      if (why === 'tooLarge') { large++; last = { kind: 'tooLarge' }; }
      else await reject(base, 'parse');
      continue;
    }
    return { bytes, base, value: parsed.value };
  }
  const kind = large ? 'tooLarge'
    : (bad && bad === answered) ? 'badObject'
      : (last ? last.kind : 'fetch');
  return { error: kind, detail: last && last.detail, status: last && last.status };
}

/**
 * A group table's bytes, strictly parsed against what the root says it is.
 *
 * Every field is compared with the root's, not merely typed: a table is
 * reached through a signed name, but the name says nothing about which
 * platform, level or group the bytes describe, and a table filed under the
 * wrong slot would plan the wrong buckets. A chunk named for two buckets is
 * refused too; one name is one range of the hash space.
 *
 *   want: {platform, k, g, j, maxChunkRows, maxChunkBytes}
 */
export function parseGroupTable(bytes, want) {
  let table;
  try { table = JSON.parse(decodeUtf8(bytes)); }
  catch (e) { return null; }
  if (!isPlainObject(table)) return null;
  if (table.v !== V || table.platform !== want.platform || table.k !== want.k ||
      table.g !== want.g || table.group !== want.j) return null;
  const per = 1 << (want.k - want.g);
  if (!Array.isArray(table.chunks) || table.chunks.length !== per) return null;
  const maxRows = want.maxChunkRows > 0 ? want.maxChunkRows : MAX_CHUNK_ROWS;
  const maxBytes = want.maxChunkBytes > 0 ? want.maxChunkBytes : MAX_CHUNK_GZ_BYTES;
  const seen = new Set();
  const chunks = [];
  for (const entry of table.chunks) {
    if (entry === null) { chunks.push(null); continue; }
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [sha, rows, bytesDeclared] = entry;
    if (typeof sha !== 'string' || !HEX64.test(sha)) return null;
    if (!isIntIn(rows, 1, maxRows) || !isIntIn(bytesDeclared, 1, maxBytes)) return null;
    if (seen.has(sha)) return null;
    seen.add(sha);
    chunks.push([sha, rows, bytesDeclared]);
  }
  return { v: V, platform: want.platform, k: want.k, g: want.g, group: want.j, chunks };
}

/**
 * gunzip a chunk under a hard ceiling on the INFLATED size.
 *
 * The compressed size is signed and checked before this runs; the inflated
 * size is not, and a gzip bomb is a few kilobytes that inflate without end.
 * DecompressionStream yields as it goes, so a counting stage in the pipe
 * aborts the moment the running total passes the cap -- the bytes past it
 * are never allocated. Resolves to {text} or {error: 'tooLarge'|'corrupt'}.
 */
export async function inflateChunk(bytes, cap) {
  const limit = cap > 0 ? cap : MAX_INFLATED;
  let total = 0, overflow = false;
  const counting = new TransformStream({
    transform(piece, controller) {
      total += piece.byteLength;
      if (total > limit) {
        overflow = true;
        controller.error(new Error('inflated past ' + limit + ' bytes'));
        return;
      }
      controller.enqueue(piece);
    }
  });
  try {
    const stream = new Response(bytes).body
      .pipeThrough(new DecompressionStream('gzip'))
      .pipeThrough(counting);
    const out = await new Response(stream).arrayBuffer();
    return { text: decodeUtf8(out) };
  } catch (e) {
    return { error: overflow ? 'tooLarge' : 'corrupt' };
  }
}

/**
 * A chunk's text, strictly parsed into store rows.
 *
 * One JSON object per line and a trailing newline is the server's format;
 * the line count must equal the signed row count. An id row is
 * {i, u?, d?, t} with i of 4-24 digits -- u is NOT required, a Facebook row
 * may carry none (shared/logic.js buildRows) -- and a handle row is {u, t}.
 * `t` is stored as published: tagOf() maps anything unknown to 'other' when
 * it is read, so a tag from a later release survives a round trip through
 * this build. Two rows with the same id, or two handle rows with the same
 * case-folded username, cannot both be keyed, so either refuses the chunk.
 * (An id row's username is a name, not a key: the server only keeps them
 * unique on Threads, and two Facebook rows may legitimately share one.)
 * The rows themselves come from list-store.js makeRow, so what the walk
 * writes is exactly what the lookup reads.
 *
 *   want: {platform, k, bucket, rows}
 *   -> {rows: [...store rows], idRows, handleRows} | null
 */
export function parseChunkLines(text, want) {
  if (typeof text !== 'string' || !text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== want.rows) return null;
  const p = want.platform;
  const chunk = chunkKey(p, want.k, want.bucket);
  const ids = new Set(), handles = new Set();
  const rows = [];
  let idRows = 0, handleRows = 0;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); }
    catch (e) { return null; }
    if (!isPlainObject(r) || typeof r.t !== 'string') return null;
    let row;
    if (r.i !== undefined) {
      if (typeof r.i !== 'string' || !ID_RE.test(r.i)) return null;
      if (r.u !== undefined && (typeof r.u !== 'string' || r.u.length > 80)) return null;
      if (r.d !== undefined && typeof r.d !== 'string') return null;
      if (ids.has(r.i)) return null;
      ids.add(r.i);
      row = makeRow({ platform: p, chunk, id: r.i, u: r.u, d: r.d, t: r.t });
      idRows++;
    } else {
      if (typeof r.u !== 'string' || !r.u || r.u.length > 64) return null;
      const uname = normUname(r.u);
      if (!uname || handles.has(uname)) return null;
      handles.add(uname);
      row = makeRow({ platform: p, chunk, u: r.u, t: r.t });
      handleRows++;
    }
    if (!row) return null;
    rows.push(row);
  }
  return { rows, idRows, handleRows };
}

/**
 * The extras object: the ranked targets' metadata, how many targets there
 * are in all, and the manual entries answered for every platform. Optional
 * for membership -- a broken one leaves the previous slice in place.
 */
export function parseExtras(bytes) {
  let doc;
  try { doc = JSON.parse(decodeUtf8(bytes)); }
  catch (e) { return null; }
  if (!isPlainObject(doc) || doc.v !== V) return null;
  if (doc.targets != null && !Array.isArray(doc.targets)) return null;
  if (doc.manual != null && !isPlainObject(doc.manual)) return null;
  const m = doc.manual || {};
  if (m.ids != null && !Array.isArray(m.ids)) return null;
  if (m.usernames != null && !Array.isArray(m.usernames)) return null;
  const ids = [], usernames = [];
  for (const v of (m.ids || [])) {
    const id = String(v == null ? '' : v).trim();
    if (ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  for (const v of (m.usernames || [])) {
    const u = normUname(v);
    if (u && u.length <= 80 && !usernames.includes(u)) usernames.push(u);
  }
  return {
    targets: (doc.targets || []).filter(isPlainObject).slice(0, MAX_EXTRAS_TARGETS),
    targetsAvailable: Math.max(0, Number(doc.targetsAvailable) || 0),
    manual: { ids, usernames }
  };
}

/** The store rows for the manual entries: '*' keys, answered for every platform. */
function manualRows(manual) {
  const rows = [];
  for (const id of (manual && manual.ids) || []) {
    const row = makeRow({ platform: '*', chunk: 'manual', id, t: 'other' });
    if (row) rows.push(row);
  }
  for (const u of (manual && manual.usernames) || []) {
    const row = makeRow({ platform: '*', chunk: 'manual', u, t: 'other' });
    if (row) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

/**
 * What one platform needs, from the root and what the store holds.
 *
 * A group whose stored table carries the root's sha is planned from disk
 * without a fetch; the others are fetched, parsed against the root and
 * stored at once -- which is safe, because the plan compares tables with the
 * CHUNKS store rather than with nothing, so a stored table never makes a
 * half-committed group look finished. A bucket is up to date when the
 * committed entry at the root's k names the planned chunk (both absent
 * counts too); everything else is the work list, in bucket order. A k change
 * needs no special case: every bucket at the new k is absent and so is
 * replaced, and the old level's rows keep answering lookups until the sweep.
 *
 *   ctx: {bases, fetchFn?, onBad?}
 *   -> {k, g, total, work: [{bucket, key, sha|null, rows, bytes}]} | {error}
 */
export async function planPlatform(root, platform, store, ctx) {
  const c = ctx || {};
  const part = root.platforms[platform];
  const { k, g } = part;
  const planned = new Array(1 << k).fill(null);
  const named = new Set();
  let total = 0;
  for (let j = 0; j < part.groups.length; j++) {
    const sha = part.groups[j];
    const key = groupKey(platform, j);
    let table = await store.getGroup(key);
    if (!table || table.sha !== sha || table.k !== k || table.g !== g || !Array.isArray(table.chunks)) {
      const got = await fetchObject(c.bases, sha + '.json', {
        cap: MAX_GROUP_BYTES, onBad: c.onBad, fetchFn: c.fetchFn,
        parse: (bytes) => {
          const t = parseGroupTable(bytes, {
            platform, k, g, j, maxChunkRows: root.maxChunkRows, maxChunkBytes: root.maxChunkBytes
          });
          return t ? { value: t } : { error: 'badObject' };
        }
      });
      if (got.error) return { error: got.error, detail: got.detail, status: got.status };
      table = { sha, k, g, chunks: got.value.chunks };
      await store.putGroup(key, table);
    }
    const per = 1 << (k - g);
    for (let idx = 0; idx < per; idx++) {
      const entry = table.chunks[idx];
      if (!entry) continue;
      const [csha, rows, bytes] = entry;
      // One name is one hash range: a chunk named for two buckets is a table
      // the signed root should never have reached.
      if (named.has(csha)) return { error: 'badObject' };
      named.add(csha);
      planned[(j << (k - g)) + idx] = { sha: csha, rows, bytes };
      total += rows;
      if (total > MAX_ROWS_PER_PLATFORM) return { error: 'tooLarge' };
    }
  }
  if (total !== part.total) return { error: 'badObject' };

  const have = new Map();
  for (const entry of await store.listChunks(`${platform}:${k}:`)) have.set(entry.key, entry);
  const work = [];
  for (let b = 0; b < planned.length; b++) {
    const key = chunkKey(platform, k, b);
    const cur = have.get(key) || null;
    const want = planned[b];
    if (!want && !cur) continue;
    if (want && cur && cur.sha === want.sha) continue;
    work.push({ bucket: b, key, sha: want ? want.sha : null, rows: want ? want.rows : 0, bytes: want ? want.bytes : 0 });
  }
  return { k, g, total, work };
}

/**
 * Drop every committed bucket of a platform at a level other than kNew --
 * the leftovers of an old k, or everything when the root no longer names
 * the platform (kNew null). One prefix sweep per old level, rows before
 * entries and batched inside the store, so a kill mid-sweep leaves nothing a
 * lookup could misread and the next walk sweeps the rest again. Returns how
 * many entries went.
 */
async function sweepPlatform(store, platform, kNew) {
  if (kNew === null) return (await store.sweepPrefix(`${platform}:`)).chunks | 0;
  const levels = new Set();
  for (const entry of await store.listChunks(`${platform}:`)) {
    const level = String(entry.key).split(':')[1];
    if (Number(level) !== kNew) levels.add(level);
  }
  let swept = 0;
  for (const level of levels) swept += (await store.sweepPrefix(`${platform}:${level}:`)).chunks | 0;
  return swept;
}

/** The idle-timer reset, at most once per HEARTBEAT_MS of walking. */
function heartbeat() {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < HEARTBEAT_MS) return;
    last = Date.now();
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ listSyncHeartbeat: last });
      }
    } catch (e) { /* no extension API around: the harnesses */ }
  };
}

/** The per-platform k the counts are recomputed at; null for a platform the root does not name. */
function levelsOf(root) {
  const out = {};
  for (const p of PLATFORMS) out[p] = root.platforms[p] ? root.platforms[p].k : null;
  return out;
}

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

/**
 * Bring the store up to the newest verifying root, or learn that it already
 * is. Runs inside refreshBlocklist() behind its per-worker memo, so two
 * walks never overlap; the tail (ranking, pruning, seeding, the broadcast)
 * stays with the caller and runs on every ok result, which is what a forced
 * refresh means.
 *
 *   opts: {settings, force, pointerRec, prevRoot?, store?, bump?, T?, fetchFn?}
 *
 * Resolves to
 *   null                                       no base served a verifying
 *                                              root, or v3 is not attempted
 *                                              for this listUrl -- the caller
 *                                              falls through to the legacy loop
 *   {ok:true, unchanged:true, stale: base}     a verified root older than the
 *                                              one held: a stale mirror or a
 *                                              replay; the cache wins
 *   {ok:true, unchanged:true, source}          same root, same extras, not
 *                                              forced
 *   {ok:false, error, kind}                    the walk failed; committed
 *                                              state is untouched and the
 *                                              next poll continues from it
 *   {ok:true, root, extras, counts, changed:{chunks, bytes}, source, verified, etag}
 *                                              the store is complete under
 *                                              `root` (the committed meta)
 */
export async function syncV3(opts) {
  const o = opts || {};
  const store = o.store || ListStore;
  const settings = o.settings || {};
  const T = o.T || globalThis.CB_T || ((k) => k);
  const bump = o.bump || (async () => {});
  const fetchFn = o.fetchFn;
  const candidates = v3Candidates(settings, o.pointerRec);
  if (!candidates.length) return null;
  const self = selfHostedBase(settings);

  const prevRoot = o.prevRoot !== undefined ? o.prevRoot : await store.getMeta('root');
  const prevExtras = await store.getMeta('extras');

  // 1. The root. The first base whose root verifies is the root winner and
  // is asked first for the objects it names; the rest follow in declared
  // order. No age check on a root: only the pointer has one, and a stale
  // list beats none.
  let root = null, winner = null, verified = false, etag = null;
  for (const base of candidates) {
    const got = await fetchRoot(base, { selfHosted: base === self, fetchFn });
    if (got.error) {
      if (got.error === 'badSignature') await bump('badSignatures');
      continue;
    }
    const selfHosted = base === self;
    // A mirror may never roll the cache back. Only a self-hosted base is
    // exempt: a server the reader runs, restored from backup, is a
    // legitimate rollback. The shipped default is a public file an attacker
    // could pin to an old signed copy, so it gets the guard like any mirror.
    if (!selfHosted && prevRoot && prevRoot.updatedAt &&
        Date.parse(got.payload.updatedAt) < Date.parse(prevRoot.updatedAt)) {
      await bump('staleMirrors');
      return { ok: true, unchanged: true, stale: base, root: prevRoot };
    }
    // The same root, and the extras it names already held: nothing to walk.
    // A missing or older extras record is what makes the next poll retry
    // only that fetch, since the plan below costs no request for an
    // unchanged tree.
    if (!o.force && prevRoot && prevRoot.format === 'v3' &&
        got.payload.updatedAt === prevRoot.updatedAt &&
        prevExtras && (prevExtras.sha || null) === got.payload.extras) {
      return { ok: true, unchanged: true, source: base, root: prevRoot };
    }
    root = got.payload; winner = base; verified = got.verified; etag = got.etag;
    break;
  }
  if (!root) return null;

  const bases = [winner].concat(candidates.filter(b => b !== winner));
  const onBad = async () => { await bump('badObjects'); };
  const beat = heartbeat();
  const changed = { chunks: 0, bytes: 0 };
  let touched = false;
  const fail = async (kind, detail, status) => {
    await bump('fetchErrors');
    const error = kind === 'badObject' ? T('sw_badObject')
      : kind === 'tooLarge' ? T('sw_listTooLarge')
        : kind === 'http' ? T('sw_httpStatus', status)
          : T('sw_fetchFailed', detail || 'unreachable');
    return { ok: false, error, kind };
  };

  for (const platform of PLATFORMS) {
    if (!root.platforms[platform]) continue;
    // 3. Plan: which buckets at the root's k differ from what is committed.
    const plan = await planPlatform(root, platform, store, { bases, fetchFn, onBad });
    if (plan.error) return fail(plan.error, plan.detail, plan.status);
    const { k } = plan;
    // 4. Install each replaced bucket directly, one transaction each. A
    // planned-null bucket with a stale entry loses its rows and entry the
    // same way; a kill between buckets leaves the previous contents of the
    // rest in place, and the next plan finds exactly them.
    for (const item of plan.work) {
      if (!item.sha) {
        await store.dropChunk(item.key);
        changed.chunks++;
        touched = true;
        await beat();
        continue;
      }
      const got = await fetchObject(bases, item.sha + '.ndjson.gz', {
        cap: Math.min(item.bytes, MAX_CHUNK_GZ_BYTES), exactBytes: item.bytes, onBad, fetchFn,
        parse: async (bytes) => {
          const inflated = await inflateChunk(bytes, MAX_INFLATED);
          if (inflated.error) return { error: inflated.error === 'tooLarge' ? 'tooLarge' : 'badObject' };
          const parsed = parseChunkLines(inflated.text, { platform, k, bucket: item.bucket, rows: item.rows });
          return parsed ? { value: parsed } : { error: 'badObject' };
        }
      });
      if (got.error) return fail(got.error, got.detail, got.status);
      await store.commitBucket({
        chunkKey: item.key,
        rows: got.value.rows,
        entry: { sha: item.sha, rows: item.rows, bytes: item.bytes,
                 idRows: got.value.idRows, handleRows: got.value.handleRows, at: Date.now() }
      });
      changed.chunks++;
      changed.bytes += item.bytes;
      touched = true;
      await beat();
    }
    // 5. Sweep the old level once every bucket of the new one is in.
    const swept = await sweepPlatform(store, platform, k);
    if (swept) { changed.chunks += swept; touched = true; }
  }
  for (const platform of PLATFORMS) {
    if (root.platforms[platform]) continue;
    const swept = await sweepPlatform(store, platform, null);
    if (swept) { changed.chunks += swept; touched = true; }
  }
  // A source switch replaces the list wholesale: whole-file rows from a
  // legacy primary do not survive a chunked root.
  if (prevRoot && prevRoot.format === 'legacy') {
    await store.replaceTagged('legacy', []);
    touched = true;
  }

  // 6. Extras. A failure here keeps the previous record -- the targets slice
  // goes stale, membership does not -- and because meta.extras.sha will not
  // equal the committed root's extras, the next poll retries only this.
  let extras = prevExtras && prevExtras.sha !== undefined ? prevExtras : null;
  if ((extras ? extras.sha : undefined) !== root.extras) {
    if (!root.extras) {
      await store.replaceTagged('manual', []);
      extras = { k: 'extras', sha: null, targets: [], targetsAvailable: 0, manual: { ids: [], usernames: [] } };
      await store.putMeta(extras);
      touched = true;
    } else {
      const got = await fetchObject(bases, root.extras + '.json', {
        cap: MAX_EXTRAS_BYTES, onBad, fetchFn,
        parse: (bytes) => {
          const e = parseExtras(bytes);
          return e ? { value: e } : { error: 'badObject' };
        }
      });
      if (got.error) {
        await bump('fetchErrors');
      } else {
        await store.replaceTagged('manual', manualRows(got.value.manual));
        extras = { k: 'extras', sha: root.extras, targets: got.value.targets,
                   targetsAvailable: got.value.targetsAvailable, manual: got.value.manual };
        await store.putMeta(extras);
        touched = true;
      }
    }
  }

  // 7. Commit. The counts are recomputed from the chunks store and written,
  // then the root, last: from here the list is complete under it, and the
  // next poll's unchanged and anti-rollback checks compare against it. The
  // generation moves when anything a tab could have cached did -- and once
  // when a list first appears, whatever it holds.
  const counts = await store.recomputeCounts(levelsOf(root));
  const generation = prevRoot ? ((prevRoot.generation | 0) + (touched ? 1 : 0)) : 1;
  const metaRoot = {
    k: 'root',
    format: 'v3',
    v: V,
    updatedAt: root.updatedAt,
    hash: root.hash,
    maxChunkRows: root.maxChunkRows,
    maxChunkBytes: root.maxChunkBytes,
    platforms: root.platforms,
    extras: root.extras,
    rankWeights: root.rankWeights,
    docIdOverrides: root.docIdOverrides,
    source: winner,
    verified,
    etag,
    fetchedAt: Date.now(),
    generation
  };
  await store.putMeta(metaRoot);
  return { ok: true, root: metaRoot, extras, counts, changed, source: winner, verified, etag };
}

// ---------------------------------------------------------------------------
// the legacy whole-file list, imported into the same store
// ---------------------------------------------------------------------------

/**
 * Put a normalised whole-file list into the store, wholesale.
 *
 * A legacy source is the whole list, so every store is cleared first and the
 * rows go in under '*' keys -- answered for every platform, as the flat id
 * and username arrays always were -- tagged 'legacy' so a later chunked root
 * can drop exactly them. Names come from the published idNames map, tags
 * from idTags; both are optional in the legacy shapes. The rows land in
 * batches (replaceTagged) and the root is written last, so a kill mid-way is
 * an import that simply runs again.
 *
 *   norm     normalizeBlocklist(payload): {ids, usernames, docIdOverrides}
 *   payload  the list as fetched (after the envelope, when there was one)
 *   opts     {store?, source, verified, etag}
 *   -> {root, extras, counts}  the three meta documents as written
 */
export async function importLegacy(norm, payload, opts) {
  const o = opts || {};
  const store = o.store || ListStore;
  const doc = isPlainObject(payload) ? payload : {};
  const prevRoot = await store.getMeta('root');
  await store.clear();

  const idTags = isPlainObject(doc.idTags) ? doc.idTags : {};
  const idNames = isPlainObject(doc.idNames) ? doc.idNames : {};
  const nameOf = (id) => {
    for (const plat of Object.keys(idNames)) {
      const m = idNames[plat];
      const e = m && typeof m === 'object' ? m[id] : null;
      if (!e) continue;
      const raw = typeof e === 'string' ? { u: e } : e;
      if (raw.u || raw.d) return raw;
    }
    return null;
  };
  const rows = [];
  for (const id of norm.ids || []) {
    const name = nameOf(id) || {};
    const row = makeRow({
      platform: '*', chunk: 'legacy', id,
      u: name.u ? String(name.u).replace(/^@/, '').slice(0, 80) : undefined,
      d: name.d, t: tagOf(idTags[id])
    });
    if (row) rows.push(row);
  }
  for (const u of norm.usernames || []) {
    const row = makeRow({ platform: '*', chunk: 'legacy', u: normUname(u), t: 'other' });
    if (row) rows.push(row);
  }
  await store.replaceTagged('legacy', rows);

  const counts = await store.recomputeCounts({ threads: null, facebook: null });
  const extras = {
    k: 'extras',
    sha: null,
    targets: Array.isArray(doc.targets) ? doc.targets.filter(isPlainObject).slice(0, MAX_EXTRAS_TARGETS) : [],
    targetsAvailable: Math.max(0, Number(doc.targetsAvailable) || 0),
    manual: null
  };
  const root = {
    k: 'root',
    format: 'legacy',
    v: doc.v != null ? doc.v : null,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
    hash: null,
    platforms: {},
    extras: null,
    rankWeights: isPlainObject(doc.rankWeights) ? doc.rankWeights : null,
    docIdOverrides: norm.docIdOverrides || null,
    source: o.source || null,
    verified: !!o.verified,
    etag: o.etag || null,
    fetchedAt: Date.now(),
    generation: (prevRoot ? (prevRoot.generation | 0) : 0) + 1
  };
  await store.putMeta(extras);
  await store.putMeta(root);
  return { root, extras, counts };
}

// ---------------------------------------------------------------------------
// the slim record
// ---------------------------------------------------------------------------

/**
 * The chrome.storage.local KEYS.BLOCKLIST record: what the popup, the
 * activity page and the tabs read. Counts, the generation and the ranked
 * slice -- never the rows, which are asked for by key.
 *
 *   meta   {root, extras, counts} as the store holds them
 *   extra  {changed: {chunks, bytes}, fetchedAt?} from this walk
 */
export function buildRecord(meta, targets, targetsAvailable, extra) {
  const m = meta || {};
  const root = m.root || {};
  const counts = m.counts || {};
  const ex = extra || {};
  const ids = counts.ids | 0, usernames = counts.usernames | 0;
  return {
    format: root.format || 'v3',
    updatedAt: root.updatedAt || null,
    hash: root.hash || null,
    generation: root.generation | 0,
    counts: {
      ids, usernames,
      manualIds: counts.manualIds | 0,
      manualUsernames: counts.manualUsernames | 0,
      byPlatform: counts.byPlatform || {}
    },
    count: ids + usernames,
    chunks: {
      total: counts.chunksTotal | 0,
      changed: (ex.changed && ex.changed.chunks) | 0,
      bytes: counts.bytes | 0
    },
    targets: Array.isArray(targets) ? targets : [],
    targetsAvailable: Number(targetsAvailable) || 0,
    extrasSha: (m.extras && m.extras.sha) || null,
    etag: root.etag || null,
    fetchedAt: ex.fetchedAt || root.fetchedAt || null,
    source: root.source || null,
    verified: !!root.verified
  };
}
