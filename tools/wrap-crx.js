#!/usr/bin/env node
/**
 * Put the signed CRX inside a zip, because a bare .crx cannot be handed to
 * anybody over the web any more.
 *
 * WHY THIS EXISTS. Chrome stopped accepting CRX files that arrive as
 * downloads: navigating to one, or clicking a link to one, is refused with
 * "can only be added from the Chrome Web Store" and in most builds the
 * download itself is flagged before that. The file is still perfectly valid —
 * the install path that works is to have it already on disk and drag it onto
 * chrome://extensions with developer mode on — so what is broken is the
 * DELIVERY, not the artefact. A zip is delivered without argument by every
 * browser and every corporate proxy, and unzipping it puts the .crx on disk,
 * which is exactly the state the working install path starts from.
 *
 * So: clone-blocker-<version>.crx.zip, containing that one file and nothing
 * else. No README beside it, deliberately — the release notes are where the
 * instructions belong, and a zip whose contents vary is a zip somebody has to
 * read before they can use it.
 *
 * DETERMINISTIC, like tools/pack.js and for the same reason: the release
 * publishes SHA256SUMS.txt, and a checksum over bytes that change on every
 * build tells you nothing except that the build ran. Entry timestamps are
 * fixed rather than real.
 *
 * STORED, not deflated. The payload is a CRX, which is a signature header in
 * front of a zip that tools/pack.js already compressed at level 9. Deflating
 * it again buys nothing measurable and costs the reader a second decompress.
 * That makes the writer here much smaller than pack.js's, which is why this
 * does not try to share it: the general one handles a tree of compressible
 * files, and this one handles a single incompressible blob.
 *
 * Usage:
 *     node tools/wrap-crx.js [--crx <in.crx>] [--out <out.crx.zip>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function fail(msg) {
  console.error('wrap-crx: ' + msg);
  process.exit(1);
}

// -- arguments --------------------------------------------------------------

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const name = args[i];
  if (!name.startsWith('--')) fail(`unexpected argument ${name}`);
  opt[name.slice(2)] = args[++i];
}

const version = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const crxPath = opt.crx || path.join(ROOT, 'dist', `clone-blocker-${version}.crx`);
const outPath = opt.out || crxPath + '.zip';

if (!fs.existsSync(crxPath)) {
  fail(`${path.relative(ROOT, crxPath).split(path.sep).join('/')} does not exist — ` +
    'run "npm run pack" and then "npm run crx -- --key <key.pem>" first.');
}

const crx = fs.readFileSync(crxPath);

// Refuse to wrap something that is not a CRX at all. The whole point of this
// file is that somebody downloads it expecting to install an extension, and a
// zip containing the wrong bytes fails at the far end of a long chain, on a
// machine nobody here can see.
if (crx.length < 16 || crx.subarray(0, 4).toString('latin1') !== 'Cr24') {
  fail(`${path.relative(ROOT, crxPath).split(path.sep).join('/')} does not start with ` +
    'the CRX magic "Cr24" — refusing to wrap a file that is not a CRX.');
}
const crxVersion = crx.readUInt32LE(4);
if (crxVersion !== 3) fail(`unexpected CRX format version ${crxVersion}, wanted 3`);

// -- zip container (single entry, stored) -----------------------------------

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

// The same fixed DOS timestamp pack.js uses: 2020-01-01 00:00:00.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function buildZip(name, data) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);            // version needed
  lh.writeUInt16LE(0x0800, 6);        // flags: the name is UTF-8
  lh.writeUInt16LE(0, 8);             // method 0: stored
  lh.writeUInt16LE(DOS_TIME, 10);
  lh.writeUInt16LE(DOS_DATE, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);            // version made by
  ch.writeUInt16LE(20, 6);            // version needed
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(0, 10);            // stored
  ch.writeUInt16LE(DOS_TIME, 12);
  ch.writeUInt16LE(DOS_DATE, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(data.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);            // extra
  ch.writeUInt16LE(0, 32);            // comment
  ch.writeUInt16LE(0, 34);            // disk
  ch.writeUInt16LE(0, 36);            // internal attrs
  ch.writeUInt32LE(0o644 << 16, 38);  // external attrs: regular file, rw-r--r--
  ch.writeUInt32LE(0, 42);            // offset of the one local header
  const offset = lh.length + nameBuf.length + data.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(ch.length + nameBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([lh, nameBuf, data, ch, nameBuf, end]);
}

const entryName = path.basename(crxPath);
const zip = buildZip(entryName, crx);

// -- read it back -----------------------------------------------------------
//
// Parsed out of the archive rather than trusted from the variables that wrote
// it. What has to be true is that a reader who unzips this gets the CRX back
// byte for byte; asserting it against the buffer we just built would only
// prove that concat works.
{
  const nameLen = zip.readUInt16LE(26);
  const start = 30 + nameLen;
  const back = zip.subarray(start, start + zip.readUInt32LE(22));
  if (!back.equals(crx)) fail('the wrapped CRX does not read back identical — refusing to write');
  if (zip.subarray(30, 30 + nameLen).toString('utf8') !== entryName) {
    fail('the entry name does not read back — refusing to write');
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, zip);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
console.log('wrote ' + rel(outPath));
console.log('  1 file, ' + entryName + ', ' + crx.length + ' bytes stored');
console.log('  ' + zip.length + ' bytes total');
console.log('  sha256 ' + crypto.createHash('sha256').update(zip).digest('hex'));
console.log('\nUnzip, then drag the .crx onto chrome://extensions with developer mode on.');
