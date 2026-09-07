/**
 * Unit tests for the chunked-list walk (src/background/list-sync.js) and for
 * the fixture the other harnesses build trees with (tools/lib/v3-fixture.js).
 *
 * Two things are proved here that the browser test cannot. First, that the
 * fixture is the server's builder byte for byte: the vectors below were
 * taken from CloneBlockerBackend/server/src/lib/publish-v3.js running over
 * the same rows, so a port that drifted -- a different sort, a different
 * gzip header -- would give the same rows different names, and every "only
 * what changed" assertion in queue-test.js would be measuring the wrong
 * thing. Second, that every refusal the walk makes is made: a root over a
 * cap, a table filed under the wrong slot, a chunk with a bad row, a gzip
 * bomb, an object whose bytes do not hash to their name. Then the walk itself
 * runs through the real list-store.js over the harness's memory backend
 * (tools/lib/memory-list-store.js) and a fetch stub, so that what is fetched
 * from where -- the privacy promise and the incremental download -- is
 * asserted from the request log rather than inferred.
 *
 *   node tools/list-sync-test.js
 *
 * CB_LIST_SYNC points it at a modified copy of list-sync.js (its envelope.js
 * and list-store.js are resolved beside it), the way CB_SW does for
 * queue-test.js.
 */
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const V3 = require('./lib/v3-fixture.js');
const Mem = require('./lib/memory-list-store.js');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
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
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sameSet = (a, b) => {
  const A = new Set(a), B = new Set(b);
  return A.size === B.size && [...A].every(x => B.has(x));
};

// protocol.js publishes CB_LIST_URL, CB_V3_MIRRORS and CB_TAGS onto
// globalThis; the walk reads them at call time, exactly as the worker does.
require('../src/common/protocol.js');

// ---------------------------------------------------------------------------
// 1. the fixture is the server's builder, byte for byte
// ---------------------------------------------------------------------------
//
// Every constant here was printed by publish-v3.js itself (buildArtifacts over
// the rows below, updatedAt 2026-09-06T10:00:00.000Z, no previous state).
{
  const rows = [
    { i: '10000000000000001', u: 'user_1', d: 'Name 1', t: 'clone' },
    { i: '10000000000000000', u: 'User_0', d: 'Name 0', t: 'scam' },
    { u: 'handle_a', t: 'spam' },
    { i: '10000000000000002', t: 'other' }
  ];
  check('canonicalLine writes i, u, d, t in that order and omits what is absent',
    rows.map(V3.canonicalLine).join('|') ===
      '{"i":"10000000000000001","u":"user_1","d":"Name 1","t":"clone"}|' +
      '{"i":"10000000000000000","u":"User_0","d":"Name 0","t":"scam"}|' +
      '{"u":"handle_a","t":"spam"}|' +
      '{"i":"10000000000000002","t":"other"}');
  const h = [
    ['threads:10000000000000001', 1351637917, 5],
    ['threads:10000000000000000', 2975804720, 11],
    ['threads:@handle_a', 1342510575, 5],
    ['threads:10000000000000002', 2311648101, 8]
  ];
  check('h32Of is the first four bytes of sha256, big-endian, and bucketOf its high k bits',
    h.every(([key, h32, b]) => V3.h32Of(key) === h32 && V3.bucketOf(h32, 4) === b && V3.bucketOf(h32, 0) === 0),
    JSON.stringify(h.map(([key]) => [V3.h32Of(key), V3.bucketOf(V3.h32Of(key), 4)])));
  check('keyOf is platform:id for an id row and platform:@handle for a handle row',
    V3.keyOf('threads', rows[0]) === 'threads:10000000000000001' &&
    V3.keyOf('facebook', rows[2]) === 'facebook:@handle_a');

  const gz = V3.gzipDeterministic('{"i":"10000000000000000","u":"User_0","d":"Name 0","t":"scam"}\n');
  check('gzipDeterministic pins MTIME to zero and OS to Unix, level 9',
    gz.toString('hex') === '1f8b0800000000000203ab56ca54b252323440034a3a4aa54a564aa1c5a945f1204e8a92' +
      '95925f626eaa028853a264a5549c9c98ab54cb0500c026a1973f000000' &&
    V3.sha256hex(gz) === '58e279ddb50dae98e22e5bbe58bbe3c997a963f4a0197157f0d5c3755e1e2825',
    gz.toString('hex'));

  check('kFor is max(4, ceil(log2(rows/512)), previous k) and gFor is max(0, k-8)',
    [V3.kFor(0), V3.kFor(512), V3.kFor(513), V3.kFor(20000), V3.kFor(300, 6)].join() === '4,4,4,6,6' &&
    [V3.gFor(4), V3.gFor(9), V3.gFor(12)].join() === '0,1,4');

  // Two ids in one bucket, an id without a username, a handle and a cased
  // handle: the chunk text is the sort's output, and its name the gzip's.
  const vec = [
    { i: '10000000000000001', u: 'user_1', d: 'Name 1', t: 'clone' },
    { i: '10000000000000020', u: 'zed', t: 'scam' },
    { i: '10000000000000014', d: 'Only Name', t: 'other' },
    { u: 'handle_a', t: 'spam' },
    { u: 'Handle_B', t: 'redbull' }
  ];
  check('compareRows puts id rows first, then byte-wise by key',
    vec.slice().sort(V3.compareRows).map(r => r.i || r.u).join() ===
      '10000000000000001,10000000000000014,10000000000000020,Handle_B,handle_a');
  const tree = V3.build({
    platforms: { threads: vec, facebook: [] },
    extras: { targets: [], targetsAvailable: 3, manual: { ids: [], usernames: [] } },
    rankWeights: { halfLifeDays: 7, velocityWeight: 1, localityFloor: 0.25, localityLangFactor: 0.8, uniqueReporterBoost: 0 },
    docIdOverrides: {}
  }, { updatedAt: '2026-09-06T10:00:00.000Z' });
  check('build writes the root payload the server writes, field for field',
    JSON.stringify(tree.payload) ===
      '{"v":3,"updatedAt":"2026-09-06T10:00:00.000Z","hash":"sha256-hi32","maxChunkRows":8192,' +
      '"maxChunkBytes":262144,"platforms":{"facebook":{"k":4,"g":0,"total":0,"groups":' +
      '["e44db05db1cb9bd2a0c89d5d256b0d196cc07e24ca0ca03ad2bade29df623aa6"]},"threads":{"k":4,' +
      '"g":0,"total":5,"groups":["3700dd43cbaa1637d7540f18a20694a12cffb96062b990fddce21fc49c0a4f03"]}},' +
      '"extras":"5dc13cc23c9a7521457bfd0229c0c897357fac3a0c9da16b6457ace62f02e352","rankWeights":' +
      '{"halfLifeDays":7,"velocityWeight":1,"localityFloor":0.25,"localityLangFactor":0.8,' +
      '"uniqueReporterBoost":0},"docIdOverrides":{}}',
    JSON.stringify(tree.payload));
  const sizes = Array.from(tree.objects, ([n, b]) => n + ':' + b.length).sort().join(' ');
  check('and names every object as the server does, at the server\'s sizes',
    sizes === [
      '195c9c1172cef8e34f0e710996e587f25d46351ae61ff0373aaca8ebeeeb5a7b.ndjson.gz:120',
      '3700dd43cbaa1637d7540f18a20694a12cffb96062b990fddce21fc49c0a4f03.json:280',
      '55d2a2f26fd017c585d49e2c957414764ee52747d9c76c3819b70a06cd8e123d.ndjson.gz:51',
      '5dc13cc23c9a7521457bfd0229c0c897357fac3a0c9da16b6457ace62f02e352.json:76',
      'e44db05db1cb9bd2a0c89d5d256b0d196cc07e24ca0ca03ad2bade29df623aa6.json:142'
    ].join(' '), sizes);
  const wide = V3.build({
    platforms: { threads: vec },
    extras: { targets: [], targetsAvailable: 0, manual: { ids: [], usernames: [] } },
    rankWeights: {}, docIdOverrides: {}
  }, { updatedAt: '2026-09-06T10:00:00.000Z', k: { threads: 9 } });
  check('a k floor of 9 gives two groups named as the server names them',
    JSON.stringify(wide.payload.platforms) ===
      '{"threads":{"k":9,"g":1,"total":5,"groups":["5a4037944792e9538d62d080ed85f416f3e27d81c04e88e6b09d96e45e28a88a",' +
      '"b4a9f5411ea7bebc20faebdc04653c8b7ebd3311ccbf48bd4aaf034e935920aa"]}}' &&
    wide.payload.extras === '7e93df1679ffb9d6e78fbcf59290187ba1f0129373e4b9322ffd7dcc6316ad6e',
    JSON.stringify(wide.payload.platforms));

  // The chain check, on the fixture's own output and after one byte moves.
  const KEY = V3.keygen();
  const signed = V3.build({ platforms: { threads: vec, facebook: [] } },
    { updatedAt: '2026-09-06T10:00:00.000Z', sign: KEY.privateKeyPem });
  const chain = V3.verifyChain(signed, { publicKey: KEY.publicKeyRaw });
  check('verifyChain walks root -> tables -> chunks -> extras on the fixture\'s own output',
    chain.ok && chain.rows === 5, JSON.stringify(chain));
  const refuses = (t, opts, want) => {
    const r = V3.verifyChain(t, opts);
    return !r.ok && (!want || want.test(String(r.error)));
  };
  const p = signed.payload;
  const table = JSON.parse(signed.objects.get(p.platforms.threads.groups[0] + '.json').toString('utf8'));
  const chunkName = table.chunks.find(Boolean)[0];
  check('and refuses a tampered chunk, table and extras, and a wrong key',
    refuses(V3.tamper(signed, chunkName), { publicKey: KEY.publicKeyRaw }, /chunk bytes/) &&
    refuses(V3.tamper(signed, p.platforms.threads.groups[0]), { publicKey: KEY.publicKeyRaw }, /group bytes/) &&
    refuses(V3.tamper(signed, p.extras + '.json'), { publicKey: KEY.publicKeyRaw }) &&
    refuses(signed, { publicKey: V3.keygen().publicKeyRaw }, /signature/));
  check('an unsigned tree is a bare payload, accepted only when the caller allows it',
    tree.root === tree.payload &&
    V3.verifyChain(tree, { allowUnsigned: true }).rows === 5 &&
    refuses(tree, {}, /unsigned/));
  check('tamper keeps the name and changes the bytes',
    V3.tamper(signed, chunkName).objects.get(chunkName + '.ndjson.gz').length ===
      signed.objects.get(chunkName + '.ndjson.gz').length &&
    !V3.tamper(signed, chunkName).objects.get(chunkName + '.ndjson.gz').equals(signed.objects.get(chunkName + '.ndjson.gz')));
  const urls = signed.byUrl('https://m.example/blocklist/v3/');
  check('byUrl lays the tree out under a base the way a mirror serves it',
    urls.has('https://m.example/blocklist/v3/manifest.json') &&
    urls.has('https://m.example/blocklist/v3/objects/' + chunkName + '.ndjson.gz') &&
    urls.size === signed.objects.size + 1);
}

// ---------------------------------------------------------------------------
// the walk's collaborators, stood in for
// ---------------------------------------------------------------------------

// The list store the walk writes: the real list-store.js, resolving to the
// harness's Map-backed backend through CB_LIST_STORE_FACTORY. Reinstalled
// fresh where a section wants an empty one; the helpers read whichever is
// current.
let mem = Mem.install();
const rowsNow = () => mem.dump().rows;          // key -> row
const chunksNow = () => mem.dump().chunks;      // key -> entry
const groupsNow = () => mem.dump().groups;      // key -> table
const chunkKeys = () => Object.keys(chunksNow());
const hasRow = (key) => !!rowsNow()[key];
const rowsByChunk = (prefix) => Object.values(rowsNow()).filter(r => r.chunk.startsWith(prefix));

/**
 * A fetch stub serving trees under bases, logging every request.
 *
 *   routes: [{ base, tree, down?, status?: {name: code}, throwOnce?: [name] }]
 */
function serve(routes, log) {
  const thrown = new Set();
  const answer = (entry, code, bytes) => {
    entry.result = code;
    const body = bytes || Buffer.alloc(0);
    return {
      ok: code >= 200 && code < 300, status: code,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(body.length) : null) },
      text: async () => body.toString('utf8'),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    };
  };
  return async (url, opts) => {
    const u = String(url);
    const entry = { url: u, method: ((opts || {}).method || 'GET'),
                    headers: ((opts || {}).headers) || {}, cache: (opts || {}).cache, result: null };
    log.push(entry);
    for (const r of routes) {
      if (!u.startsWith(r.base)) continue;
      if (r.down) { entry.result = 'threw'; throw new Error('ECONNREFUSED'); }
      const rel = u.slice(r.base.length);
      const name = rel.startsWith('objects/') ? rel.slice('objects/'.length) : rel;
      if (r.throwOnce && r.throwOnce.includes(name) && !thrown.has(r.base + name)) {
        thrown.add(r.base + name);
        entry.result = 'threw';
        throw new Error('ECONNRESET');
      }
      if (r.status && r.status[name]) return answer(entry, r.status[name]);
      if (rel === 'manifest.json') return answer(entry, 200, Buffer.from(JSON.stringify(r.tree.root), 'utf8'));
      if (rel.startsWith('objects/') && r.tree.objects.has(name)) return answer(entry, 200, Buffer.from(r.tree.objects.get(name)));
      return answer(entry, 404);
    }
    return answer(entry, 404);
  };
}
const objectGets = (log, base) => log.filter(e => e.url.startsWith(base + 'objects/')).map(e => e.url.slice(base.length + 'objects/'.length));
const rootGets = (log, base) => log.filter(e => e.url === base + 'manifest.json').length;
/** Every object name a tree's root reaches. */
function objectsOf(tree) {
  const p = tree.payload;
  const tables = [], chunks = [];
  for (const part of Object.values(p.platforms)) {
    for (const g of part.groups) {
      tables.push(g + '.json');
      const table = JSON.parse(Buffer.from(tree.objects.get(g + '.json')).toString('utf8'));
      for (const c of table.chunks) if (c) chunks.push(c[0] + '.ndjson.gz');
    }
  }
  return { tables, chunks, extras: p.extras + '.json', all: tables.concat(chunks, [p.extras + '.json']) };
}
/**
 * The privacy promise, as a predicate over the request log: a root under a
 * base, or an object under a base named by its content hash, and nothing
 * else -- and never a header that says anything about this browser.
 */
function fixedRequest(entry, bases) {
  const h = entry.headers || {};
  for (const k of Object.keys(h)) if (!/^accept$/i.test(k)) return false;
  if (entry.method !== 'GET') return false;
  return bases.some(b => entry.url === b + 'manifest.json' ||
    new RegExp('^' + b.replace(/[.+?^${}()|[\]\\]/g, '\\$&') + 'objects/[0-9a-f]{64}\\.(json|ndjson\\.gz)$').test(entry.url));
}

// The rows the walk sections publish: an id row with a name, one without (a
// Facebook row may carry no username), a cased username, two handle rows,
// and the same digits on both platforms.
const ROWS = {
  threads: [
    { i: '5300000001', u: 'fresh.clone', d: 'Fresh Clone', t: 'clone' },
    { i: '5300000002', u: 'stale.clone', t: 'clone' },
    { i: '5300000003', u: 'Mixed.Case.Id', d: 'Cased', t: 'redbull' },
    { i: '5300000004', t: 'spam' },
    { u: 'Handle.One', t: 'clone' },
    { u: 'handle.two', t: 'other' }
  ],
  facebook: [
    { i: '5400000001', u: 'fb.clone', d: 'FB Clone', t: 'scam' },
    { i: '5400000002', t: 'clone' },
    { i: '5300000001', u: 'same.digits', t: 'clone' }
  ]
};
const EXTRAS = { targets: [{ id: '5300000001', platform: 'threads', trust: 2, last: '2026-09-01', days: {} }],
                 targetsAvailable: 9, manual: { ids: ['5500000099'], usernames: ['Manual.Handle'] } };
const COUNTS = { ids: 8, usernames: 3, manualIds: 1, manualUsernames: 1,
                 byPlatform: { threads: { ids: 4, usernames: 2 }, facebook: { ids: 3, usernames: 0 } } };
const countsMatch = (c, want) => {
  const w = want || COUNTS;
  return !!c && c.ids === w.ids && c.usernames === w.usernames &&
    c.manualIds === w.manualIds && c.manualUsernames === w.manualUsernames &&
    !!c.byPlatform && ['threads', 'facebook'].every(p => !!c.byPlatform[p] &&
      c.byPlatform[p].ids === w.byPlatform[p].ids && c.byPlatform[p].usernames === w.byPlatform[p].usernames);
};
const KEY = V3.keygen();
function treeAt(updatedAt, patch) {
  const p = patch || {};
  return V3.build({
    platforms: Object.assign({}, ROWS, p.platforms || {}),
    extras: Object.assign({}, EXTRAS, p.extras || {}),
    rankWeights: { halfLifeDays: 7, velocityWeight: 1 },
    docIdOverrides: { useBlockMutation: '7123456789012345' }
  }, { updatedAt, k: p.k || {}, sign: p.unsigned ? null : KEY.privateKeyPem });
}
const B1 = 'https://mirror-one.example/blocklist/v3/';
const B2 = 'https://mirror-two.example/blocklist/v3/';
const T = (key, ...subs) => key + (subs.length ? ':' + subs.join(',') : '');

(async () => {
  const file = process.env.CB_LIST_SYNC || path.join(__dirname, '..', 'src', 'background', 'list-sync.js');
  let LS, ListStore;
  try {
    LS = await import(pathToFileURL(file).href);
    ListStore = await import(pathToFileURL(path.join(path.dirname(file), 'list-store.js')).href);
  } catch (e) {
    check('list-sync.js imports (envelope.js and list-store.js beside it)', false, e.message);
    finish();
    return;
  }
  check('list-sync.js imports and exports the walk', typeof LS.syncV3 === 'function' &&
    typeof LS.validateRoot === 'function' && typeof LS.importLegacy === 'function');
  globalThis.CB_POINTER_KEY = KEY.publicKeyRaw;

  // ---- 2. validateRoot -----------------------------------------------------
  {
    const good = treeAt('2026-09-06T10:00:00.000Z').payload;
    const v = LS.validateRoot(good);
    check('a server root validates and keeps both platforms',
      !!v && v.platforms.threads.k === 4 && v.platforms.facebook.total === 3 && v.extras === good.extras &&
      v.rankWeights.halfLifeDays === 7 && v.docIdOverrides.useBlockMutation === '7123456789012345');
    const mut = (fn) => { const r = clone(good); fn(r); return LS.validateRoot(r); };
    const cases = [
      ['k 17', (r) => { r.platforms.threads.k = 17; }],
      ['g > k', (r) => { r.platforms.threads.g = 5; }],
      ['groups.length !== 1<<g', (r) => { r.platforms.threads.groups.push(r.platforms.threads.groups[0]); }],
      ['non-hex sha', (r) => { r.platforms.threads.groups[0] = 'Z' + r.platforms.threads.groups[0].slice(1); }],
      ['maxChunkRows 8193', (r) => { r.maxChunkRows = 8193; }],
      ['maxChunkBytes over cap', (r) => { r.maxChunkBytes = 256 * 1024 + 1; }],
      ['total over cap', (r) => { r.platforms.facebook.total = 4000001; }],
      ['v "3" string', (r) => { r.v = '3'; }],
      ['wrong hash', (r) => { r.hash = 'sha256-lo32'; }],
      ['unparseable updatedAt', (r) => { r.updatedAt = 'yesterday'; }],
      ['extras not hex', (r) => { r.extras = 'abc'; }],
      ['rankWeights an array', (r) => { r.rankWeights = [1]; }],
      ['a platform that is not an object', (r) => { r.platforms.threads = 'x'; }],
      ['k a float', (r) => { r.platforms.threads.k = 4.5; }]
    ];
    const failed = cases.filter(([, fn]) => mut(fn) !== null).map(([n]) => n);
    check('validateRoot rejects every cap and shape violation', !failed.length, failed.join(', '));
    check('and ignores a platform this build does not know',
      !!mut((r) => { r.platforms.instagram = { k: 99 }; }) &&
      !mut((r) => { r.platforms.instagram = { k: 99 }; }).platforms.instagram);
    check('a root with no extras validates with extras null',
      mut((r) => { delete r.extras; }).extras === null);
  }

  // ---- 3. parseGroupTable --------------------------------------------------
  {
    const tree = treeAt('2026-09-06T10:00:00.000Z');
    const p = tree.payload;
    const name = p.platforms.threads.groups[0] + '.json';
    const bytes = tree.objects.get(name);
    const want = { platform: 'threads', k: 4, g: 0, j: 0, maxChunkRows: 8192, maxChunkBytes: 262144 };
    const t = LS.parseGroupTable(bytes, want);
    check('a server table parses to its chunk entries',
      !!t && t.chunks.length === 16 && t.chunks.filter(Boolean).every(e => e.length === 3));
    const text = Buffer.from(bytes).toString('utf8');
    const edited = (fn) => {
      const doc = JSON.parse(text); fn(doc);
      return LS.parseGroupTable(Buffer.from(JSON.stringify(doc), 'utf8'), want);
    };
    const cases = [
      ['platform mismatch', (d) => { d.platform = 'facebook'; }],
      ['k mismatch', (d) => { d.k = 5; }],
      ['g mismatch', (d) => { d.g = 1; }],
      ['group mismatch', (d) => { d.group = 1; }],
      ['wrong chunks length', (d) => { d.chunks.push(null); }],
      ['rows 0', (d) => { d.chunks.find(Boolean)[1] = 0; }],
      ['rows over the root\'s maxChunkRows', (d) => { d.chunks.find(Boolean)[1] = 8193; }],
      ['bytes over cap', (d) => { d.chunks.find(Boolean)[2] = 262145; }],
      ['duplicate chunk names', (d) => { const e = d.chunks.find(Boolean); d.chunks[d.chunks.indexOf(null)] = e.slice(); }],
      ['a two-element entry', (d) => { const e = d.chunks.find(Boolean); e.pop(); }],
      ['a non-hex chunk name', (d) => { d.chunks.find(Boolean)[0] = 'g'.repeat(64); }],
      ['v 2', (d) => { d.v = 2; }]
    ];
    const failed = cases.filter(([, fn]) => edited(fn) !== null).map(([n]) => n);
    check('parseGroupTable rejects every mismatch and malformed entry', !failed.length, failed.join(', '));
    check('and refuses bytes that are not JSON, or not an object',
      LS.parseGroupTable(Buffer.from('nope'), want) === null &&
      LS.parseGroupTable(Buffer.from('[1]'), want) === null);
  }

  // ---- 4. parseChunkLines and inflateChunk ---------------------------------
  {
    const tree = treeAt('2026-09-06T10:00:00.000Z');
    const table = JSON.parse(Buffer.from(tree.objects.get(tree.payload.platforms.facebook.groups[0] + '.json')).toString('utf8'));
    const idx = table.chunks.findIndex(e => e && e[1] >= 1);
    const [sha, rows] = table.chunks[idx];
    const gz = tree.objects.get(sha + '.ndjson.gz');
    const inflated = await LS.inflateChunk(gz, 4 * 1024 * 1024);
    check('inflateChunk inflates a real chunk to its text',
      !!inflated.text && inflated.text === zlib.gunzipSync(gz).toString('utf8'), JSON.stringify(inflated));
    const parsed = LS.parseChunkLines(inflated.text, { platform: 'facebook', k: 4, bucket: idx, rows });
    check('parseChunkLines turns it into keyed store rows tagged with their bucket',
      !!parsed && parsed.rows.length === rows && parsed.idRows + parsed.handleRows === rows &&
      parsed.rows.every(r => r.chunk === 'facebook:4:' + idx && r.platform === 'facebook' &&
        r.key === 'facebook:' + (r.kind === 'id' ? r.id : '@' + r.uname)));

    const P = (lines, opts) => LS.parseChunkLines(lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
      Object.assign({ platform: 'threads', k: 4, bucket: 0, rows: lines.length }, opts || {}));
    const fb = P([{ i: '5400000002', t: 'clone' }], { platform: 'facebook' });
    check('a facebook id row without a username is accepted, and carries no uname',
      !!fb && fb.idRows === 1 && fb.rows[0].uname === undefined && fb.rows[0].u === undefined);
    const named = P([{ i: '5300000003', u: 'Mixed.Case.Id', d: 'x'.repeat(200), t: 'redbull' }, { u: 'Handle.One', t: 'clone' }]);
    check('a username is kept as published and folded into uname; a display name is clipped to 120',
      !!named && named.rows[0].u === 'Mixed.Case.Id' && named.rows[0].uname === 'mixed.case.id' &&
      named.rows[0].d.length === 120 && named.rows[1].key === 'threads:@handle.one' && named.rows[1].u === 'Handle.One');
    const cases = [
      ['line count mismatch', () => P([{ i: '5300000001', t: 'clone' }], { rows: 2 })],
      ['no trailing newline', () => LS.parseChunkLines('{"i":"5300000001","t":"clone"}', { platform: 'threads', k: 4, bucket: 0, rows: 1 })],
      ['a non-object line', () => P(['[1]'])],
      ['a string line', () => P(['"x"'])],
      ['not JSON', () => P(['{nope'])],
      ['an id of 3 digits', () => P([{ i: '530', t: 'clone' }])],
      ['an id of 25 digits', () => P([{ i: '5'.repeat(25), t: 'clone' }])],
      ['a numeric id', () => P([{ i: 5300000001, t: 'clone' }])],
      ['a handle over 64 chars', () => P([{ u: 'h'.repeat(65), t: 'clone' }])],
      ['an empty handle', () => P([{ u: '', t: 'clone' }])],
      ['a handle of only @', () => P([{ u: '@', t: 'clone' }])],
      ['a duplicate id', () => P([{ i: '5300000001', t: 'clone' }, { i: '5300000001', t: 'spam' }])],
      ['a duplicate case-folded username', () => P([{ u: 'Dup.Handle', t: 'clone' }, { u: 'dup.handle', t: 'spam' }])],
      ['a row without t', () => P([{ i: '5300000001' }])],
      ['a username over 80 on an id row', () => P([{ i: '5300000001', u: 'u'.repeat(81), t: 'clone' }])]
    ];
    const failed = cases.filter(([, fn]) => fn() !== null).map(([n]) => n);
    check('parseChunkLines rejects every malformed chunk', !failed.length, failed.join(', '));
    check('an unknown tag is stored as published (tagOf maps it at read time)',
      P([{ i: '5300000001', t: 'future-tag' }]).rows[0].t === 'future-tag');
    check('an id row and a handle row may share a username in one chunk (only keys are unique)',
      P([{ i: '5300000001', u: 'shared', t: 'clone' }, { u: 'shared', t: 'spam' }]) !== null);

    // A gzip bomb: five megabytes of zeros compress to a few kilobytes.
    const bomb = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024), { level: 9 });
    const b = await LS.inflateChunk(bomb, 4 * 1024 * 1024);
    check('inflateChunk aborts a gzip bomb at the 4 MiB cap',
      b.error === 'tooLarge' && bomb.length < 16 * 1024, JSON.stringify(b) + ' from ' + bomb.length + ' bytes');
    const small = await LS.inflateChunk(zlib.gzipSync(Buffer.alloc(1024)), 4 * 1024 * 1024);
    check('and lets a small one through', !!small.text && small.text.length === 1024);
    const corrupt = await LS.inflateChunk(Buffer.from('not gzip at all'), 4 * 1024 * 1024);
    check('and reports bytes that are not gzip as corrupt', corrupt.error === 'corrupt', JSON.stringify(corrupt));
  }

  // ---- 5. fetchObject: hash before parse, retry once, next mirror ----------
  {
    const tree = treeAt('2026-09-06T10:00:00.000Z');
    const names = objectsOf(tree);
    const chunk = names.chunks[0];
    const bad = V3.tamper(tree, chunk.slice(0, 64));
    let log = [];
    const onBad = [];
    let r = await LS.fetchObject([B1, B2], chunk, {
      cap: 262144, exactBytes: tree.objects.get(chunk).length,
      onBad: async (name, base, why) => { onBad.push([name, base, why]); },
      fetchFn: serve([{ base: B1, tree: bad }, { base: B2, tree }], log)
    });
    check('bytes that do not hash to their name are refused and the next mirror asked',
      !r.error && r.base === B2 && Buffer.from(r.bytes).equals(tree.objects.get(chunk)) &&
      onBad.length === 1 && onBad[0][1] === B1 && onBad[0][2] === 'hash' &&
      objectGets(log, B1).length === 1 && objectGets(log, B2).length === 1,
      JSON.stringify({ error: r.error, onBad, gets: [objectGets(log, B1), objectGets(log, B2)] }));

    log = [];
    r = await LS.fetchObject([B1, B2], chunk, { cap: 262144,
      fetchFn: serve([{ base: B1, tree, throwOnce: [chunk] }, { base: B2, tree }], log) });
    check('a transport error earns one immediate retry on the same mirror',
      !r.error && r.base === B1 && objectGets(log, B1).length === 2 && objectGets(log, B2).length === 0,
      JSON.stringify(log.map(e => [e.url.slice(-20), e.result])));

    log = [];
    r = await LS.fetchObject([B1, B2], chunk, { cap: 262144,
      fetchFn: serve([{ base: B1, tree, status: { [chunk]: 404 } }, { base: B2, tree }], log) });
    check('a 404 is a mirror failure: no retry, next mirror',
      !r.error && r.base === B2 && objectGets(log, B1).length === 1 && objectGets(log, B2).length === 1);

    log = [];
    r = await LS.fetchObject([B1, B2], chunk, { cap: 10, fetchFn: serve([{ base: B1, tree }, { base: B2, tree }], log) });
    check('an object over the cap is refused by Content-Length on every mirror: tooLarge',
      r.error === 'tooLarge', JSON.stringify(r));

    log = [];
    const bads = [];
    r = await LS.fetchObject([B1, B2], chunk, { cap: 262144, exactBytes: tree.objects.get(chunk).length + 1,
      onBad: async (n, b, why) => { bads.push(why); },
      fetchFn: serve([{ base: B1, tree }, { base: B2, tree }], log) });
    check('a chunk whose byte count is not the signed one is a bad object everywhere',
      r.error === 'badObject' && bads.join() === 'bytes,bytes', JSON.stringify({ r, bads }));

    log = [];
    r = await LS.fetchObject([B1, B2], chunk, { cap: 262144,
      parse: async () => ({ error: 'badObject' }),
      fetchFn: serve([{ base: B1, tree }, { base: B2, tree }], log) });
    check('bytes that hash right but fail strict parse are bad objects, tried on every mirror',
      r.error === 'badObject' && objectGets(log, B1).length === 1 && objectGets(log, B2).length === 1);

    log = [];
    r = await LS.fetchObject([B1, B2], chunk, { cap: 262144,
      fetchFn: serve([{ base: B1, down: true }, { base: B2, down: true }], log) });
    check('every mirror down is a transport failure', r.error === 'fetch' && log.length === 4, JSON.stringify(r));

    log = [];
    r = await LS.fetchObject([B1], chunk, { cap: 262144, fetchFn: serve([{ base: B1, tree }], log) });
    check('an object request carries no headers and may use the HTTP cache',
      Object.keys(log[0].headers).length === 0 && log[0].cache === 'default' && log[0].method === 'GET',
      JSON.stringify(log[0]));
  }

  // ---- 6. which bases ------------------------------------------------------
  {
    const DEF = globalThis.CB_LIST_URL;
    check('isV3ListUrl recognises a root by its shape',
      LS.isV3ListUrl('https://me.example/blocklist/v3/manifest.json') &&
      LS.isV3ListUrl('http://127.0.0.1:8123/blocklist/v3/manifest.json') &&
      !LS.isV3ListUrl('https://me.example/blocklist.json') && !LS.isV3ListUrl(''));
    const had = globalThis.CB_V3_MIRRORS;
    globalThis.CB_V3_MIRRORS = [B1, B2];
    const ptr = { v3Mirrors: [B2, 'https://ptr.example/blocklist/v3/', 'http://insecure.example/blocklist/v3/', 'https://x.example/blocklist.json'] };
    check('the shipped default walks the pointer\'s bases then the compiled ones, deduped and shape-checked',
      LS.v3Candidates({ listUrl: DEF }, ptr).join() === [B2, 'https://ptr.example/blocklist/v3/', B1].join() &&
      LS.selfHostedBase({ listUrl: DEF }) === null,
      LS.v3Candidates({ listUrl: DEF }, ptr).join());
    check('a self-hosted root goes first, and is the only base allowed to be plain http',
      LS.v3Candidates({ listUrl: 'http://127.0.0.1:8123/blocklist/v3/manifest.json' }, ptr)[0] === 'http://127.0.0.1:8123/blocklist/v3/' &&
      LS.selfHostedBase({ listUrl: 'http://127.0.0.1:8123/blocklist/v3/manifest.json' }) === 'http://127.0.0.1:8123/blocklist/v3/' &&
      LS.v3Candidates({ listUrl: 'http://127.0.0.1:8123/blocklist/v3/manifest.json' }, ptr).length === 4);
    check('any other listUrl means no v3 phase at all',
      LS.v3Candidates({ listUrl: 'https://me.example/blocklist.json' }, ptr).length === 0 &&
      LS.v3Candidates({ listUrl: '' }, ptr).length === 0);
    globalThis.CB_V3_MIRRORS = had;
  }

  // ---- 7. the walk ---------------------------------------------------------
  const DEF = globalThis.CB_LIST_URL;
  const hadMirrors = globalThis.CB_V3_MIRRORS;
  globalThis.CB_V3_MIRRORS = [B1, B2];
  const stats = {};
  const bump = async (n) => { stats[n] = (stats[n] || 0) + 1; };
  const settings = { listUrl: DEF };
  const walk = (routes, log, extra) => LS.syncV3(Object.assign({
    settings, force: false, pointerRec: null, store: ListStore, bump, T, fetchFn: serve(routes, log)
  }, extra || {}));
  const T0 = '2026-09-06T10:00:00.000Z', T1 = '2026-09-06T10:05:00.000Z', T2 = '2026-09-06T10:10:00.000Z';
  const T3 = '2026-09-06T10:15:00.000Z', T4 = '2026-09-06T10:20:00.000Z', T5 = '2026-09-06T10:25:00.000Z';

  {
    const tree = treeAt(T0);
    const names = objectsOf(tree);
    const log = [];
    const r = await walk([{ base: B1, tree }, { base: B2, tree }], log);
    check('a cold walk installs every chunk the root names and commits the root last',
      !!r && r.ok && !r.unchanged && r.root.format === 'v3' && r.root.updatedAt === T0 &&
      r.root.generation === 1 && r.source === B1 && r.verified === true,
      JSON.stringify(r && { ok: r.ok, error: r.error, kind: r.kind, unchanged: r.unchanged }));
    check('the counts add up, manual entries in ids and usernames but not per platform',
      r && countsMatch(r.counts) && r.counts.chunksTotal === chunkKeys().length &&
      JSON.stringify(await ListStore.getMeta('counts')) === JSON.stringify(r.counts),
      JSON.stringify(r && r.counts));
    check('and the row store holds every key: platform-scoped rows and the manual \'*\' rows',
      hasRow('threads:5300000001') && hasRow('facebook:5300000001') &&
      hasRow('threads:@handle.one') && rowsNow()['threads:@handle.one'].u === 'Handle.One' &&
      hasRow('*:5500000099') && hasRow('*:@manual.handle') &&
      rowsNow()['*:@manual.handle'].chunk === 'manual' && rowsNow()['facebook:5400000002'].uname === undefined,
      Object.keys(rowsNow()).join());
    check('exactly the root\'s objects were fetched, each once, all from the root winner',
      sameSet(objectGets(log, B1), names.all) && objectGets(log, B1).length === names.all.length &&
      objectGets(log, B2).length === 0 && rootGets(log, B1) === 1 && rootGets(log, B2) === 0,
      JSON.stringify([objectGets(log, B1).length, names.all.length, objectGets(log, B2)]));
    check('every request was a fixed URL with no header but accept, describing nobody',
      log.every(e => fixedRequest(e, [B1, B2])) &&
      log.filter(e => e.url.endsWith('manifest.json')).every(e => e.cache === 'no-cache' && e.headers.accept === 'application/json'),
      JSON.stringify(log.map(e => [e.url, e.headers])));
    check('the extras record holds the sha-verified object whole',
      r && r.extras.sha === tree.payload.extras && r.extras.targets.length === 1 &&
      r.extras.targetsAvailable === 9 && r.extras.manual.usernames[0] === 'manual.handle');
    const rec = LS.buildRecord({ root: r.root, extras: r.extras, counts: r.counts }, [{ id: '5300000001' }], 9, { changed: r.changed });
    check('buildRecord is the slim record: counts, generation, the slice, never the rows',
      rec.count === 11 && rec.generation === 1 && rec.format === 'v3' && rec.chunks.changed === r.changed.chunks &&
      rec.chunks.total === chunkKeys().length && rec.extrasSha === tree.payload.extras && rec.targets.length === 1 &&
      rec.ids === undefined && rec.usernames === undefined && rec.idTags === undefined && rec.verified === true &&
      rec.source === B1 && rec.updatedAt === T0, JSON.stringify(rec));

    // The same root again: recognised by updatedAt and the extras it names.
    const log2 = [];
    const r2 = await walk([{ base: B1, tree }, { base: B2, tree }], log2);
    check('an unchanged root on a scheduled poll is one GET and no walk',
      r2 && r2.ok && r2.unchanged && r2.source === B1 && log2.length === 1 && r2.root.generation === 1,
      JSON.stringify({ r2: r2 && { ok: r2.ok, unchanged: r2.unchanged }, gets: log2.length }));
    const log3 = [];
    const r3 = await walk([{ base: B1, tree }, { base: B2, tree }], log3, { force: true });
    check('a forced refresh walks but fetches nothing content-addressed that already matches',
      r3 && r3.ok && !r3.unchanged && r3.root.generation === 1 && r3.changed.chunks === 0 &&
      log3.length === 1 && countsMatch(r3.counts),
      JSON.stringify({ r3: r3 && { ok: r3.ok, gen: r3.root.generation, changed: r3.changed }, gets: log3.length }));
  }

  // One row's tag changes: one chunk, one table, nothing else.
  {
    const before = treeAt(T0);
    const rows = clone(ROWS);
    rows.threads[3].t = 'clone';                       // 5300000004: spam -> clone
    const tree = treeAt(T1, { platforms: rows });
    const wasChunks = clone(chunksNow());
    const log = [];
    const r = await walk([{ base: B1, tree }, { base: B2, tree }], log);
    const gets = objectGets(log, B1);
    const changedTables = objectsOf(tree).tables.filter(t => !objectsOf(before).tables.includes(t));
    const changedChunks = objectsOf(tree).chunks.filter(c => !objectsOf(before).chunks.includes(c));
    check('a change to one row fetches exactly its table and its chunk',
      r && r.ok && changedTables.length === 1 && changedChunks.length === 1 &&
      sameSet(gets, changedTables.concat(changedChunks)) && gets.length === 2 && objectGets(log, B2).length === 0,
      JSON.stringify({ gets, changedTables, changedChunks }));
    const kept = Object.keys(wasChunks).filter(k => chunksNow()[k] && chunksNow()[k].sha === wasChunks[k].sha);
    check('the row is replaced in place, the generation moves, and the other buckets are untouched',
      rowsNow()['threads:5300000004'].t === 'clone' && r.root.generation === 2 && r.changed.chunks === 1 &&
      kept.length === Object.keys(wasChunks).length - 1 && countsMatch(r.counts),
      JSON.stringify({ gen: r.root.generation, changed: r.changed, kept: kept.length, was: Object.keys(wasChunks).length }));
    check('the extras were not re-fetched: same sha, same record',
      !gets.includes(tree.payload.extras + '.json') && r.extras.sha === tree.payload.extras);

    // The previous, older root from a mirror: a replay or a stale copy.
    const log2 = [];
    const r2 = await walk([{ base: B1, tree: before }, { base: B2, tree }], log2);
    check('a verified root older than the one held is stale: the cache wins, the mirror is counted',
      r2 && r2.ok && r2.unchanged && r2.stale === B1 && stats.staleMirrors === 1 &&
      rowsNow()['threads:5300000004'].t === 'clone' && (await ListStore.getMeta('root')).updatedAt === T1 &&
      log2.length === 1, JSON.stringify({ r2: r2 && { ok: r2.ok, unchanged: r2.unchanged, stale: r2.stale }, stats }));
  }

  // A mirror serving corrupt bytes for one chunk: refused, fetched elsewhere.
  {
    const rows = clone(ROWS);
    rows.facebook.push({ i: '5400000003', u: 'newcomer', t: 'clone' });
    const tree = treeAt(T2, { platforms: rows });
    const before = objectsOf(treeAt(T1, { platforms: (() => { const r = clone(ROWS); r.threads[3].t = 'clone'; return r; })() }));
    const newChunk = objectsOf(tree).chunks.find(c => !before.chunks.includes(c));
    const bad = V3.tamper(tree, newChunk.slice(0, 64));
    const wasBad = stats.badObjects || 0;
    const log = [];
    const r = await walk([{ base: B1, tree: bad }, { base: B2, tree }], log);
    check('a chunk whose bytes do not hash to their name is refused and taken from the next mirror',
      r && r.ok && objectGets(log, B1).includes(newChunk) && objectGets(log, B2).join() === newChunk &&
      hasRow('facebook:5400000003') && stats.badObjects === wasBad + 1 && r.root.generation === 3,
      JSON.stringify({ r: r && { ok: r.ok, error: r.error }, b1: objectGets(log, B1), b2: objectGets(log, B2), stats }));
    check('the tampered mirror was not asked for the same object twice',
      objectGets(log, B1).filter(n => n === newChunk).length === 1);
    check('the counts follow', countsMatch(r.counts, { ids: 9, usernames: 3, manualIds: 1, manualUsernames: 1,
      byPlatform: { threads: { ids: 4, usernames: 2 }, facebook: { ids: 4, usernames: 0 } } }), JSON.stringify(r.counts));

    // Every mirror bad for it: the walk fails, and nothing committed moves.
    const rows2 = clone(rows);
    rows2.facebook.push({ i: '5400000004', t: 'spam' });
    const tree2 = treeAt(T3, { platforms: rows2 });
    const newChunk2 = objectsOf(tree2).chunks.find(c => !objectsOf(tree).chunks.includes(c));
    const bad2 = V3.tamper(tree2, newChunk2.slice(0, 64));
    const rootBefore = await ListStore.getMeta('root');
    const log2 = [];
    const r2 = await walk([{ base: B1, tree: bad2 }, { base: B2, tree: bad2 }], log2);
    check('when every mirror serves a bad object the walk fails as sw_badObject and the committed root stands',
      r2 && r2.ok === false && r2.kind === 'badObject' && r2.error === 'sw_badObject' &&
      JSON.stringify(await ListStore.getMeta('root')) === JSON.stringify(rootBefore) &&
      !hasRow('facebook:5400000004') && stats.fetchErrors === 1,
      JSON.stringify({ r2, stats }));
    // The good table it did verify is kept: the next walk plans from it.
    const log3 = [];
    const r3 = await walk([{ base: B1, tree: tree2 }, { base: B2, tree: tree2 }], log3);
    check('the next walk resumes: the verified table is reused and only the missing chunk is fetched',
      r3 && r3.ok && objectGets(log3, B1).join() === newChunk2 && hasRow('facebook:5400000004') &&
      r3.root.updatedAt === T3, JSON.stringify({ r3: r3 && { ok: r3.ok, error: r3.error }, gets: objectGets(log3, B1) }));
  }

  // The winner down: root and objects from the next base.
  {
    const rows = clone(ROWS);
    rows.facebook.push({ i: '5400000003', u: 'newcomer', t: 'clone' }, { i: '5400000004', t: 'spam' });
    rows.threads[3].t = 'clone';
    rows.threads.push({ u: 'late.handle', t: 'scam' });
    const tree = treeAt(T4, { platforms: rows });
    const log = [];
    const r = await walk([{ base: B1, down: true }, { base: B2, tree }], log);
    check('with the first base down, the root and its objects come from the second',
      r && r.ok && r.source === B2 && rootGets(log, B2) === 1 && objectGets(log, B2).length > 0 &&
      objectGets(log, B1).length === 0 && hasRow('threads:@late.handle'),
      JSON.stringify({ r: r && { ok: r.ok, source: r.source }, b1: log.filter(e => e.url.startsWith(B1)).length }));
    check('a signed root from a mirror is accepted and verified',
      r && r.verified === true && (await ListStore.getMeta('root')).source === B2);
  }

  // An unsigned root is refused from a compiled base and accepted from a self-hosted one.
  {
    const tree = treeAt(T5, { unsigned: true });
    const log = [];
    const r = await walk([{ base: B1, tree }, { base: B2, tree }], log);
    check('an unsigned root from a public base is not a list: the walk yields to the legacy loop',
      r === null && (await ListStore.getMeta('root')).updatedAt === T4, JSON.stringify(r));
    const SELF = 'https://me.example/blocklist/v3/';
    const log2 = [];
    const r2 = await walk([{ base: SELF, tree }, { base: B1, tree: treeAt(T4) }], log2,
      { settings: { listUrl: SELF + 'manifest.json' } });
    check('the same root from a self-hosted base is accepted, unsigned, and asked first',
      r2 && r2.ok && r2.source === SELF && r2.verified === false && log2[0].url === SELF + 'manifest.json' &&
      objectGets(log2, B1).length === 0, JSON.stringify(r2 && { ok: r2.ok, error: r2.error, source: r2.source }));
    const older = treeAt(T0);
    const log3 = [];
    const r3 = await walk([{ base: SELF, tree: older }], log3, { settings: { listUrl: SELF + 'manifest.json' } });
    check('and a self-hosted base may roll the list back',
      r3 && r3.ok && !r3.unchanged && r3.root.updatedAt === T0 && countsMatch(r3.counts),
      JSON.stringify(r3 && { ok: r3.ok, unchanged: r3.unchanged, updatedAt: r3.root && r3.root.updatedAt }));
    const log4 = [];
    const forged = clone(treeAt(T5).root);
    forged.payload.platforms.threads.total = 0;
    const r4 = await walk([{ base: B1, tree: { root: forged, objects: treeAt(T5).objects } }, { base: B2, tree: treeAt(T5) }], log4);
    check('a signed root that fails to verify is refused everywhere, counted, and the next base tried',
      r4 && r4.ok && r4.source === B2 && stats.badSignatures === 1, JSON.stringify({ r4: r4 && r4.source, stats }));
  }

  // k grows: every bucket at the new level is new, the old level is swept.
  {
    const tree = treeAt('2026-09-06T10:27:00.000Z', { k: { threads: 6 } });
    const wasFacebook = chunkKeys().filter(k => k.startsWith('facebook:'));
    const log = [];
    const r = await walk([{ base: B1, tree }, { base: B2, tree }], log);
    const keys = chunkKeys();
    check('a k change installs every bucket at the new level and sweeps the old one',
      r && r.ok && keys.some(k => k.startsWith('threads:6:')) && !keys.some(k => k.startsWith('threads:4:')) &&
      rowsByChunk('threads:4:').length === 0 && countsMatch(r.counts) &&
      r.counts.byPlatform.threads.ids === 4 && hasRow('threads:5300000001'),
      JSON.stringify({ r: r && { ok: r.ok, error: r.error, unchanged: r.unchanged }, keys }));
    check('and leaves the other platform alone: same entries, nothing fetched for it',
      sameSet(keys.filter(k => k.startsWith('facebook:')), wasFacebook) &&
      !objectGets(log, B1).includes(tree.payload.platforms.facebook.groups[0] + '.json'));
    const threadsTable = tree.payload.platforms.threads.groups[0] + '.json';
    const table = JSON.parse(Buffer.from(tree.objects.get(threadsTable)).toString('utf8'));
    check('a stored table is reused: only the new table and its chunks were asked for',
      sameSet(objectGets(log, B1), [threadsTable].concat(table.chunks.filter(Boolean).map(c => c[0] + '.ndjson.gz'))) &&
      objectGets(log, B1).length === 1 + table.chunks.filter(Boolean).length,
      JSON.stringify(objectGets(log, B1)));
  }

  // A platform the root stops naming loses its rows.
  {
    const tree = V3.build({ platforms: { threads: ROWS.threads }, extras: EXTRAS },
      { updatedAt: '2026-09-06T10:30:00.000Z', k: { threads: 6 }, sign: KEY.privateKeyPem });
    const log = [];
    const r = await walk([{ base: B1, tree }, { base: B2, tree }], log);
    check('a platform the root no longer names is swept',
      r && r.ok && !chunkKeys().some(k => k.startsWith('facebook:')) &&
      !hasRow('facebook:5400000001') && r.counts.byPlatform.facebook.ids === 0 && r.counts.ids === 5,
      JSON.stringify(r && r.counts));
  }

  // Extras that cannot be fetched: membership commits, the slice waits, only the extras are retried.
  {
    const tree = treeAt('2026-09-06T10:35:00.000Z', { k: { threads: 6 }, extras: { manual: { ids: ['5500000100'], usernames: [] } } });
    const extrasName = tree.payload.extras + '.json';
    const log = [];
    const r = await walk([{ base: B1, tree, status: { [extrasName]: 404 } }, { base: B2, tree, status: { [extrasName]: 404 } }], log);
    const rootMeta = await ListStore.getMeta('root');
    check('an extras fetch failure keeps the previous extras and still commits the root',
      r && r.ok && rootMeta.updatedAt === tree.payload.updatedAt && rootMeta.extras === tree.payload.extras &&
      r.extras.sha !== tree.payload.extras && hasRow('*:5500000099') && !hasRow('*:5500000100') &&
      hasRow('facebook:5400000001'),
      JSON.stringify({ r: r && { ok: r.ok, error: r.error, extras: r.extras && r.extras.sha }, root: rootMeta.extras }));
    const log2 = [];
    const r2 = await walk([{ base: B1, tree }, { base: B2, tree }], log2);
    check('the next poll of the same root retries only the extras, then the manual rows follow',
      r2 && r2.ok && !r2.unchanged && objectGets(log2, B1).join() === extrasName && r2.extras.sha === tree.payload.extras &&
      hasRow('*:5500000100') && !hasRow('*:5500000099') && !hasRow('*:@manual.handle') &&
      r2.counts.manualIds === 1 && r2.counts.manualUsernames === 0,
      JSON.stringify({ gets: objectGets(log2, B1), r2: r2 && { ok: r2.ok, unchanged: r2.unchanged } }));
    const log3 = [];
    const r3 = await walk([{ base: B1, tree }, { base: B2, tree }], log3);
    check('and after that the root is unchanged again', r3 && r3.ok && r3.unchanged && log3.length === 1);
  }

  // ---- 8. planPlatform on its own ------------------------------------------
  {
    mem = Mem.install();
    const tree = treeAt(T0);
    const root = LS.validateRoot(tree.payload);
    const log = [];
    const plan = await LS.planPlatform(root, 'threads', ListStore, { bases: [B1], fetchFn: serve([{ base: B1, tree }], log) });
    const table = JSON.parse(Buffer.from(tree.objects.get(root.platforms.threads.groups[0] + '.json')).toString('utf8'));
    check('planPlatform on an empty store lists every non-null bucket, in order, and stores the table',
      !plan.error && plan.work.length === table.chunks.filter(Boolean).length &&
      plan.work.every((w, i) => i === 0 || w.bucket > plan.work[i - 1].bucket) &&
      plan.work.every(w => w.key === 'threads:4:' + w.bucket && w.sha === table.chunks[w.bucket][0]) &&
      !!groupsNow()['threads:0'] && objectGets(log, B1).length === 1,
      JSON.stringify(plan));
    for (const w of plan.work) {
      await ListStore.commitBucket({ chunkKey: w.key, rows: [],
        entry: { sha: w.sha, rows: w.rows, bytes: w.bytes, idRows: 0, handleRows: 0, at: 1 } });
    }
    const log2 = [];
    const plan2 = await LS.planPlatform(root, 'threads', ListStore, { bases: [B1], fetchFn: serve([{ base: B1, tree }], log2) });
    check('and once every bucket is committed the plan is empty with no fetch',
      !plan2.error && plan2.work.length === 0 && log2.length === 0);
    await ListStore.commitBucket({ chunkKey: 'threads:4:15', rows: [],
      entry: { sha: 'f'.repeat(64), rows: 1, bytes: 1, idRows: 1, handleRows: 0, at: 1 } });
    const plan3 = await LS.planPlatform(root, 'threads', ListStore, { bases: [B1], fetchFn: serve([{ base: B1, tree }], []) });
    check('a committed bucket the root does not name is planned as a deletion',
      !plan3.error && plan3.work.length === (table.chunks[15] ? 2 : 1) && plan3.work.some(w => w.bucket === 15 && w.sha === null),
      JSON.stringify(plan3.work));
    const lying = clone(root);
    lying.platforms.threads.total = 99;
    const plan4 = await LS.planPlatform(lying, 'threads', ListStore, { bases: [B1], fetchFn: serve([{ base: B1, tree }], []) });
    check('a root whose total the tables do not add up to is refused', plan4.error === 'badObject', JSON.stringify(plan4));
  }

  // ---- 9. the legacy whole-file list in the same store ---------------------
  {
    mem = Mem.install();
    const payload = {
      v: 2, updatedAt: '2026-09-05T00:00:00.000Z',
      ids: ['6100000001', '6100000002'], usernames: ['Legacy.Handle'],
      idTags: { '6100000001': 'redbull', '6100000002': 'not-a-tag' },
      idNames: { threads: { '6100000001': { u: '@Leg.User', d: 'Legacy Person' } } },
      targets: [{ id: '6100000001', platform: 'threads', trust: 1 }], targetsAvailable: 1
    };
    const norm = { ids: payload.ids.slice(), usernames: ['legacy.handle'], docIdOverrides: { x: '123456' } };
    const r = await LS.importLegacy(norm, payload, { store: ListStore, source: 'https://me.example/blocklist.json', verified: false, etag: 'W/"1"' });
    const rows = rowsNow();
    check('a legacy import puts every row under a \'*\' key, tagged legacy, with names and tags from the payload',
      Object.keys(rows).length === 3 && rows['*:6100000001'].t === 'redbull' && rows['*:6100000002'].t === 'other' &&
      rows['*:6100000001'].u === 'Leg.User' && rows['*:6100000001'].uname === 'leg.user' &&
      rows['*:6100000001'].d === 'Legacy Person' && rows['*:@legacy.handle'].kind === 'handle' &&
      Object.values(rows).every(x => x.chunk === 'legacy' && x.platform === '*'),
      JSON.stringify(Object.values(rows)));
    check('and writes the three meta documents: a legacy root, the counts, the targets',
      r.root.format === 'legacy' && r.root.generation === 1 && r.root.updatedAt === payload.updatedAt &&
      r.root.docIdOverrides.x === '123456' && r.counts.ids === 2 && r.counts.usernames === 1 && r.counts.manualIds === 0 &&
      r.counts.legacyIds === 2 && r.extras.sha === null && r.extras.targets.length === 1 && r.extras.targetsAvailable === 1 &&
      (await ListStore.getMeta('root')).source === 'https://me.example/blocklist.json',
      JSON.stringify(r));
    const rec = LS.buildRecord({ root: r.root, extras: r.extras, counts: r.counts }, [], 1, {});
    check('its slim record counts ids and usernames',
      rec.count === 3 && rec.format === 'legacy' && rec.chunks.total === 0 && rec.extrasSha === null && rec.etag === 'W/"1"');

    // A chunked root after a legacy list: the source switch replaces it wholesale.
    const tree = treeAt(T0);
    const log = [];
    const r2 = await LS.syncV3({ settings, force: false, pointerRec: null, store: ListStore, bump, T,
      fetchFn: serve([{ base: B1, tree }], log) });
    check('a chunked root after a legacy list drops the legacy rows and moves the generation on',
      r2 && r2.ok && !hasRow('*:6100000001') && !hasRow('*:@legacy.handle') &&
      hasRow('threads:5300000001') && r2.root.generation === 2 && countsMatch(r2.counts),
      JSON.stringify(r2 && { ok: r2.ok, gen: r2.root && r2.root.generation, rows: Object.keys(rowsNow()) }));
    // And a legacy list after a chunked one clears everything the walk built.
    await LS.importLegacy(norm, payload, { store: ListStore, source: 'x', verified: false, etag: null });
    check('a legacy list after a chunked one clears every store first',
      Object.keys(groupsNow()).length === 0 && chunkKeys().length === 0 && !hasRow('threads:5300000001') &&
      Object.keys(rowsNow()).length === 3 && (await ListStore.getMeta('root')).generation === 3);
  }

  globalThis.CB_V3_MIRRORS = hadMirrors;
  finish();
})().catch((e) => { console.error('harness error:', e); process.exitCode = 1; });
