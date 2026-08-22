/**
 * Builds the upload artefact for the Chrome Web Store.
 *
 *   node tools/pack.js [--skip-check] [--out DIR]
 *
 * The store takes a ZIP of the unpacked extension, not a CRX. A CRX is the
 * self-hosting format: it carries a signature made with a key you generate,
 * and the id it produces is derived from that key. The store issues its own
 * key and its own id, so uploading a CRX is rejected -- and generating one
 * here would only create a private key somebody then has to keep safe for no
 * benefit. If you ever want one for sideloading, Chrome makes it from this
 * same directory with --pack-extension.
 *
 * What goes in is an allowlist, not the tree minus exclusions: manifest.json,
 * src/, icons/, _locales/. That is everything the extension loads and nothing
 * else. An exclusion list is the wrong way round for this job -- it ships
 * whatever nobody thought to name, and the things nobody thinks to name are
 * exactly the .env files and the keys.
 *
 * The zip is deterministic: entries sorted, timestamps fixed, so the same tree
 * produces a byte-identical file and the printed hash means something.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT_DIR = path.resolve(ROOT, argOf('out', 'dist'));
const SKIP_CHECK = args.includes('--skip-check');

// Everything the manifest can cause Chrome to load, and nothing else.
const INCLUDE = ['manifest.json', 'src', 'icons', '_locales'];

let failed = 0;
const ok = (msg, detail) => console.log('ok    ' + msg + (detail ? '  — ' + detail : ''));
const bad = (msg, detail) => { failed++; console.log('FAIL  ' + msg + (detail ? '  — ' + detail : '')); };
const report = (cond, msg, detail) => (cond ? ok(msg, detail) : bad(msg, detail));

// ---------------------------------------------------------------------------
// zip container
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// A fixed, valid DOS timestamp: 2020-01-01 00:00:00. Zip stores mtimes, and
// real ones would make two builds of an identical tree differ.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/** @param {{name: string, data: Buffer}[]} files */
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = zlib.deflateRawSync(f.data, { level: 9 });
    // Stored beats deflated on data that does not compress; a zip entry may
    // legally use either, and paying eight bytes to make a file bigger is
    // silly.
    const stored = deflated.length >= f.data.length;
    const body = stored ? f.data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(f.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // flags: names are UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);            // extra
    ch.writeUInt16LE(0, 32);            // comment
    ch.writeUInt16LE(0, 34);            // disk
    ch.writeUInt16LE(0, 36);            // internal attrs
    ch.writeUInt32LE(0o644 << 16, 38);  // external attrs: regular file, rw-r--r--
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += lh.length + name.length + body.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, dir, end]);
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

function walk(rel, acc) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isFile()) { acc.push(rel.split(path.sep).join('/')); return acc; }
  for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue;
    walk(path.join(rel, e.name), acc);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

console.log('packing for the Chrome Web Store\n');

if (!SKIP_CHECK) {
  // Fail closed. Everything check.js enforces -- locale parity, no untranslated
  // markup, every referenced asset present -- is something that ships to real
  // users if the zip is built around it.
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'check.js')], { stdio: 'pipe' });
    ok('tools/check.js passes');
  } catch (e) {
    bad('tools/check.js passes', 'run `npm run check` to see what broke');
    console.log(String(e.stdout || '').split('\n').filter(l => /^FAIL/.test(l)).join('\n'));
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

// ---- the manifest itself ---------------------------------------------------
report(manifest.manifest_version === 3, 'manifest_version is 3', String(manifest.manifest_version));
report(/^\d{1,5}(\.\d{1,5}){0,3}$/.test(version) &&
  version.split('.').every(n => Number(n) <= 65535),
  'version is a store-legal dotted integer', version);
report(!('key' in manifest), 'no `key` field',
  'key' in manifest ? 'a packed key would fight the id the store assigns' : '');
report(!('update_url' in manifest), 'no `update_url`',
  'update_url' in manifest ? 'store items must not carry one' : '');

// ---- name and description, in every language the store will serve ----------
{
  const locales = fs.readdirSync(path.join(ROOT, '_locales'));
  report(locales.includes(manifest.default_locale),
    'default_locale has a dictionary', manifest.default_locale);

  for (const loc of locales) {
    const dict = JSON.parse(fs.readFileSync(
      path.join(ROOT, '_locales', loc, 'messages.json'), 'utf8'));
    // The store reads name and description straight off the manifest, so a
    // __MSG__ that does not resolve ships an empty listing in that language.
    for (const key of ['appName', 'appDesc']) {
      report(dict[key] && dict[key].message,
        `_locales/${loc} defines ${key}`, dict[key] ? '' : 'missing');
    }
    const name = (dict.appName || {}).message || '';
    const desc = (dict.appDesc || {}).message || '';
    report(name.length > 0 && name.length <= 45,
      `${loc} name within 45`, `${name.length} — ${name}`);
    report(desc.length > 0 && desc.length <= 132,
      `${loc} description within 132`, String(desc.length));
  }
}

// ---- collect, then check the manifest's references against what we collected
const files = [];
for (const inc of INCLUDE) {
  if (!fs.existsSync(path.join(ROOT, inc))) { bad('missing ' + inc); continue; }
  walk(inc, files);
}
files.sort();
const present = new Set(files);

{
  // Every path the manifest names, from wherever it names it.
  const refs = new Set();
  const add = (p) => { if (typeof p === 'string' && !/^(https?:)?\/\//.test(p)) refs.add(p); };
  for (const v of Object.values(manifest.icons || {})) add(v);
  for (const v of Object.values((manifest.action || {}).default_icon || {})) add(v);
  add((manifest.action || {}).default_popup);
  add(manifest.options_page);
  add((manifest.background || {}).service_worker);
  for (const cs of manifest.content_scripts || []) {
    for (const j of cs.js || []) add(j);
    for (const c of cs.css || []) add(c);
  }
  // web_accessible_resources may be globs, so those are matched rather than
  // looked up.
  const globs = [];
  for (const w of manifest.web_accessible_resources || []) {
    for (const r of w.resources || []) globs.push(r);
  }

  const missing = [...refs].filter(r => !present.has(r));
  report(missing.length === 0,
    `every path the manifest names is in the zip (${refs.size})`, missing.join(', '));

  for (const g of globs) {
    const re = new RegExp('^' + g.split('*').map(s =>
      s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const hit = files.some(f => re.test(f));
    report(hit, `web_accessible_resources matches something: ${g}`);
  }
}

// ---- nothing that should never leave this machine --------------------------
{
  // The real secrets, read from the files that hold them, rather than a
  // guess at what a secret looks like. A pattern list catches the shapes you
  // thought of; this catches the actual string that is actually in .env.
  const secrets = [];
  for (const f of ['.env', '.env.local']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*[A-Za-z0-9_]+\s*=\s*(.+?)\s*$/);
      if (m) {
        const v = m[1].replace(/^["']|["']$/g, '');
        if (v.length >= 12) secrets.push(v);
      }
    }
  }

  // Shapes as well, for anything that never went through .env.
  const SHAPES = [
    [/github_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
    [/ghp_[A-Za-z0-9]{30,}/, 'a GitHub token'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/\b127\.0\.0\.1\b|\blocalhost\b/, 'a local address'],
    [/\bdemo-clone\b/, 'the emulator project id']
  ];

  const offenders = [];
  for (const rel of files) {
    if (/\.(png|jpg|jpeg|gif|webp|woff2?|ttf)$/i.test(rel)) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const s of secrets) if (text.includes(s)) offenders.push(rel + ': a value from .env');
    for (const [re, what] of SHAPES) if (re.test(text)) offenders.push(rel + ': ' + what);
  }
  report(offenders.length === 0,
    'nothing secret or local-only in the shipped files', offenders.join(' | '));

  report(!present.has('.env') && !files.some(f => /\.pem$|\.key$|\.env/.test(f)),
    'no key or env file swept in');
}

// ---- the list it will actually talk to -------------------------------------
{
  const proto = fs.readFileSync(path.join(ROOT, 'src', 'common', 'protocol.js'), 'utf8');
  const m = proto.match(/const LIST_URL\s*=\s*\n?\s*'([^']+)'/);
  report(!!m && /^https:\/\//.test(m[1]), 'the built-in list URL is https', m ? m[1] : 'not found');
  report(!!m && !/localhost|127\.0\.0\.1|demo-/.test(m[1]),
    'and points at production', m ? m[1] : '');
}

if (failed) {
  console.log(`\n${failed} problem(s). Nothing written.`);
  process.exit(1);
}

// ---- write -----------------------------------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true });
const zip = buildZip(files.map(name => ({ name, data: fs.readFileSync(path.join(ROOT, name)) })));
const outFile = path.join(OUT_DIR, `clone-blocker-${version}.zip`);
fs.writeFileSync(outFile, zip);

console.log('\ncontents');
let raw = 0;
for (const f of files) {
  const n = fs.statSync(path.join(ROOT, f)).size;
  raw += n;
  console.log('  ' + String(n).padStart(8) + '  ' + f);
}
console.log('  ' + String(raw).padStart(8) + '  (uncompressed total)');

console.log('\nwrote ' + path.relative(ROOT, outFile).split(path.sep).join('/'));
console.log('  ' + files.length + ' files, ' + zip.length + ' bytes');
console.log('  sha256 ' + crypto.createHash('sha256').update(zip).digest('hex'));
console.log('\nUpload this .zip at https://chrome.google.com/webstore/devconsole');
