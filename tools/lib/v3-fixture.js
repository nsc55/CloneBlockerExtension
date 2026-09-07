/**
 * The chunked blocklist (v3), built in process.
 *
 * A port of the pure half of CloneBlockerBackend/server/src/lib/publish-v3.js
 * -- the row hash, the bucket rule, the canonical line, the sort and the
 * fixed gzip header -- so a harness can build a tree BYTE-IDENTICAL to what
 * the server publishes without running the server: the same rows give the
 * same object names, which is what the walk's "only what changed" is measured
 * against. tools/list-sync-test.js pins this port to vectors taken from the
 * server's own build, so a change to publish-v3.js that this file does not
 * follow fails a test rather than an assertion about the wrong bytes.
 *
 * Shared by tools/queue-test.js (served through a fetch stub), tools/e2e-test.js
 * (served over node:http to real Chrome) and tools/run-real-block.js. Zero
 * dependencies, like everything under tools/.
 *
 *   const V3 = require('./lib/v3-fixture.js');
 *   const tree = V3.build({ platforms: { threads: rows }, extras }, { updatedAt, sign });
 *   tree.root        the signed envelope, or the bare payload when unsigned
 *   tree.payload     the root payload
 *   tree.objects     Map<name, Buffer>: '<sha256>.json' tables and extras,
 *                    '<sha256>.ndjson.gz' chunks
 *   tree.byUrl(base) Map<url, Buffer> of everything a client may ask a base for
 */
'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert');

// The format's constants, copied from publish-v3.js. K_MIN and ROWS_PER_CHUNK
// are the server's choices rather than the format's: the root carries k, so
// a client never depends on them, but a fixture that picked differently would
// not reproduce the server's names.
const V = 3;
const HASH = 'sha256-hi32';
const MAX_CHUNK_ROWS = 8192;
const MAX_CHUNK_BYTES = 256 * 1024;
const ROWS_PER_CHUNK = 512;
const K_MIN = 4;
const GROUP_BITS = 8;

// ------------------------------------------------------------ pure pieces --

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** First four bytes of SHA-256 of the row key, as an unsigned 32-bit integer. */
function h32Of(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest().readUInt32BE(0);
}

function keyOf(platform, row) {
  return row.i !== undefined ? `${platform}:${row.i}` : `${platform}:@${row.u}`;
}

/** High bits, not modulo: bucket b at level k splits in place into 2b, 2b+1. */
function bucketOf(h32, k) {
  return k === 0 ? 0 : (h32 >>> (32 - k));
}

function groupOf(h32, g) {
  return g === 0 ? 0 : (h32 >>> (32 - g));
}

/** k never decreases: a client that learned k=8 must not be asked to merge. */
function kFor(rowCount, kPrevious) {
  const needed = rowCount <= ROWS_PER_CHUNK ? 0 : Math.ceil(Math.log2(rowCount / ROWS_PER_CHUNK));
  return Math.max(K_MIN, needed, kPrevious || 0);
}

function gFor(k) {
  return Math.max(0, k - GROUP_BITS);
}

/** Fixed key order so an unchanged row is an unchanged line. */
function canonicalLine(row) {
  const out = {};
  if (row.i !== undefined) out.i = row.i;
  if (row.u !== undefined) out.u = row.u;
  if (row.d !== undefined) out.d = row.d;
  out.t = row.t;
  return JSON.stringify(out);
}

function compareRows(a, b) {
  const aId = a.i !== undefined, bId = b.i !== undefined;
  if (aId !== bId) return aId ? -1 : 1;           // id rows before handle rows
  const ka = aId ? a.i : a.u, kb = bId ? b.i : b.u;
  return ka < kb ? -1 : ka > kb ? 1 : 0;           // byte-wise string order
}

/**
 * gzip with a fixed header. Node's zlib writes the platform's OS byte and a
 * zero mtime; the OS byte differs between the Linux container and a Windows
 * checkout, which would give the same text two names. Pin both.
 */
function gzipDeterministic(text) {
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  gz[4] = 0; gz[5] = 0; gz[6] = 0; gz[7] = 0;     // MTIME
  gz[9] = 3;                                       // OS = Unix
  return gz;
}

// ---------------------------------------------------------------- signing --
//
// The same envelope as the server's lib/sign.js: {payload, sig, alg} with an
// Ed25519 signature over JSON.stringify(payload). Ported rather than required
// because this repository does not have the server's code, and a harness that
// signs with a key it minted proves the worker verifies with the code path
// production takes.

function keygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyRaw: publicKey.export({ type: 'spki', format: 'der' })
      .subarray(-32).toString('base64url')
  };
}

function sign(payload, pem) {
  return {
    payload,
    sig: crypto.sign(null, Buffer.from(JSON.stringify(payload)), pem).toString('base64url'),
    alg: 'ed25519'
  };
}

function publicKeyRaw(pem) {
  return crypto.createPublicKey(pem)
    .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
}

function isEnvelope(doc) {
  return !!(doc && typeof doc === 'object' && doc.payload && doc.sig && doc.alg);
}

function verify(envelope, pubRaw) {
  if (!envelope || !envelope.payload || !envelope.sig || envelope.alg !== 'ed25519') return false;
  let pub;
  try {
    pub = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),   // SPKI prefix for Ed25519
        Buffer.from(String(pubRaw), 'base64url')
      ]),
      format: 'der', type: 'spki'
    });
  } catch (e) { return false; }
  try {
    return crypto.verify(null, Buffer.from(JSON.stringify(envelope.payload)), pub,
      Buffer.from(String(envelope.sig), 'base64url'));
  } catch (e) { return false; }
}

// ------------------------------------------------------------- the builder --

/** A tree: the root, its payload, the objects, and every URL a base answers. */
function treeOf(root, payload, objects) {
  return {
    root,
    payload,
    objects,
    byUrl(base) {
      const out = new Map();
      out.set(base + 'manifest.json', Buffer.from(JSON.stringify(root), 'utf8'));
      for (const [name, buf] of objects) out.set(base + 'objects/' + name, buf);
      return out;
    }
  };
}

/**
 * Build every object and the root from rows. The port of buildArtifacts(),
 * with the server's state folded into the options.
 *
 *   input.platforms   { threads: [row, ...], facebook: [row, ...] } -- a row is
 *                     {i, u?, d?, t} for an id or {u, t} for a handle, exactly
 *                     the server's row shape (shared/logic.js buildRows)
 *   input.extras      { targets, targetsAvailable, manual: {ids, usernames} }
 *   input.rankWeights, input.docIdOverrides   copied into the root as given
 *   opts.updatedAt    the root's only freshness value, so a sequence of trees
 *                     is stamped explicitly rather than with the clock
 *   opts.k            per-platform k floor, the server's "previous k"
 *   opts.g            per-platform g, to build a many-group tree from few rows
 *                     (the server derives g from k and never needs this)
 *   opts.sign         a function payload -> envelope, a private-key PEM, or
 *                     nothing for an unsigned root
 */
function build(input, opts) {
  const o = opts || {};
  const kFloor = o.k || {};
  const gFixed = o.g || {};
  const objects = new Map();          // name -> Buffer
  const put = (name, buf) => { objects.set(name, buf); return name; };
  const platforms = {};

  for (const platform of Object.keys(input.platforms).sort()) {
    const rows = input.platforms[platform] || [];
    const k = kFor(rows.length, kFloor[platform]);
    const g = gFixed[platform] !== undefined ? gFixed[platform] : gFor(k);
    const buckets = new Map();
    for (const row of rows) {
      const h = h32Of(keyOf(platform, row));
      const b = bucketOf(h, k);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(row);
    }
    const perBucket = new Map();      // bucket -> [sha, rows, bytes]
    let total = 0;
    for (const [b, list] of buckets) {
      list.sort(compareRows);
      if (list.length > MAX_CHUNK_ROWS) {
        throw new Error(`v3 chunk ${platform}/${b} has ${list.length} rows; raise k`);
      }
      const text = list.map(canonicalLine).join('\n') + '\n';
      const gz = gzipDeterministic(text);
      if (gz.length > MAX_CHUNK_BYTES) {
        throw new Error(`v3 chunk ${platform}/${b} is ${gz.length} bytes; raise k`);
      }
      const name = sha256hex(gz) + '.ndjson.gz';
      put(name, gz);
      perBucket.set(b, [name.slice(0, 64), list.length, gz.length]);
      total += list.length;
    }
    const groups = [];
    const perGroup = 1 << (k - g);
    for (let j = 0; j < (1 << g); j++) {
      const chunks = [];
      for (let idx = 0; idx < perGroup; idx++) {
        const b = (j << (k - g)) + idx;
        chunks.push(perBucket.has(b) ? perBucket.get(b) : null);
      }
      const table = JSON.stringify({ v: V, platform, k, g, group: j, chunks });
      const buf = Buffer.from(table, 'utf8');
      groups.push(put(sha256hex(buf) + '.json', buf).slice(0, 64));
    }
    platforms[platform] = { k, g, total, groups };
  }

  const ex = input.extras || { targets: [], targetsAvailable: 0, manual: { ids: [], usernames: [] } };
  const extrasBuf = Buffer.from(JSON.stringify({
    v: V,
    targets: ex.targets,
    targetsAvailable: ex.targetsAvailable,
    manual: ex.manual
  }), 'utf8');
  const extras = put(sha256hex(extrasBuf) + '.json', extrasBuf).slice(0, 64);

  const payload = {
    v: V,
    updatedAt: o.updatedAt || new Date().toISOString(),
    hash: HASH,
    maxChunkRows: MAX_CHUNK_ROWS,
    maxChunkBytes: MAX_CHUNK_BYTES,
    platforms,
    extras,
    rankWeights: input.rankWeights,
    docIdOverrides: input.docIdOverrides
  };
  let root = payload;
  if (typeof o.sign === 'function') root = o.sign(payload);
  else if (o.sign) root = sign(payload, o.sign);
  return treeOf(root, payload, objects);
}

/**
 * Walk root -> groups -> chunks -> extras from bytes, the way a client must.
 * The port of the server's own test (server/test/publish-v3.test.js
 * verifyChain), against a tree in memory -- {root, objects} -- instead of a
 * directory, so it verifies a built tree and one read back off the wire
 * alike. Answers {ok: true, rows} or {ok: false, error} naming the first
 * broken link, so a harness can print what broke instead of catching.
 *
 *   opts.publicKey      what a signed root must verify against (the raw
 *                       base64url key; publicKeyRaw is accepted too)
 *   opts.allowUnsigned  accept a bare payload (a self-hosted root may be one)
 */
function verifyChain(tree, opts) {
  try {
    return { ok: true, rows: checkChain(tree, opts || {}) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function checkChain(tree, o) {
  const readObj = (name) => {
    const buf = tree.objects.get(name);
    assert.ok(buf, `object ${name} is in the tree`);
    return Buffer.from(buf);
  };
  const pubRaw = o.publicKey || o.publicKeyRaw;
  let p;
  if (isEnvelope(tree.root)) {
    assert.ok(pubRaw, 'a signed root needs a public key to verify against');
    assert.ok(verify(tree.root, pubRaw), 'root signature must verify');
    assert.ok(JSON.stringify(tree.root).startsWith('{"payload":'), 'payload must be the first key');
    p = tree.root.payload;
  } else {
    assert.ok(o.allowUnsigned, 'root is unsigned');
    p = tree.root;
  }
  assert.equal(p.v, 3);
  assert.equal(p.hash, HASH);
  let rows = 0;
  for (const [platform, part] of Object.entries(p.platforms)) {
    assert.equal(part.groups.length, 1 << part.g);
    let seen = 0;
    part.groups.forEach((gname, j) => {
      const gbuf = readObj(gname + '.json');
      assert.equal(sha256hex(gbuf), gname, 'group bytes must hash to their name');
      const g = JSON.parse(gbuf.toString('utf8'));
      assert.deepEqual([g.v, g.platform, g.k, g.g, g.group], [3, platform, part.k, part.g, j]);
      assert.equal(g.chunks.length, 1 << (part.k - part.g));
      g.chunks.forEach((entry, idx) => {
        if (entry === null) return;
        const [cname, count, bytes] = entry;
        const cbuf = readObj(cname + '.ndjson.gz');
        assert.equal(sha256hex(cbuf), cname, 'chunk bytes must hash to their name');
        assert.equal(cbuf.length, bytes);
        const lines = zlib.gunzipSync(cbuf).toString('utf8').split('\n');
        assert.equal(lines.pop(), '', 'chunk text ends with one newline');
        assert.equal(lines.length, count);
        const bucket = (j << (part.k - part.g)) + idx;
        for (const line of lines) {
          const row = JSON.parse(line);
          const h = h32Of(keyOf(platform, row));
          assert.equal(bucketOf(h, part.k), bucket, 'every row lives in its own bucket');
        }
        seen += count;
      });
    });
    assert.equal(seen, part.total);
    rows += seen;
  }
  const ebuf = readObj(p.extras + '.json');
  assert.equal(sha256hex(ebuf), p.extras);
  return rows;
}

/**
 * The same tree with one object's bytes changed and its name kept: what a
 * mirror that corrupted, truncated or rewrote an object looks like. `name`
 * is the 64-hex prefix or the full object name. The root is untouched, so the
 * signature still verifies and the refusal under test is the hash check.
 */
function tamper(tree, name) {
  const full = tree.objects.has(name) ? name
    : Array.from(tree.objects.keys()).find(n => n.startsWith(name));
  assert.ok(full, `no object ${name} in the tree`);
  const objects = new Map(tree.objects);
  const buf = Buffer.from(objects.get(full));
  buf[buf.length - 1] ^= 0x01;
  objects.set(full, buf);
  return treeOf(tree.root, tree.payload, objects);
}

module.exports = {
  V, HASH, MAX_CHUNK_ROWS, MAX_CHUNK_BYTES, ROWS_PER_CHUNK, K_MIN, GROUP_BITS,
  sha256hex, h32Of, keyOf, bucketOf, groupOf, kFor, gFor, canonicalLine, compareRows,
  gzipDeterministic,
  keygen, sign, verify, isEnvelope, publicKeyRaw,
  build, verifyChain, tamper
};
