#!/usr/bin/env node
/**
 * The self-hosting build: wrap the zip tools/pack.js made into a signed CRX3.
 *
 * The store takes the zip; the CRX exists for everyone outside the store —
 * sideloading, enterprise policy, a Linux install. A CRX is the same archive
 * with a signature in front, and THE KEY IS THE IDENTITY: Chrome derives the
 * extension id from the public key, so signing with a different key ships a
 * different extension. Generate the key once and keep it forever:
 *
 *     node tools/make-crx.js --new-key crx-key.pem
 *
 * writes a fresh 2048-bit RSA key (refusing to overwrite one) and then signs
 * with it. Never commit the key — .gitignore refuses *.pem for exactly this —
 * and never regenerate it casually: losing it orphans every installed copy,
 * and anyone holding it can publish updates as this extension.
 *
 * Zero dependencies, like every other tool here. CRX3 is a small, stable
 * format — "Cr24", version 3, a protobuf header carrying the RSA proof and
 * the signed crx_id, then the zip bytes untouched — and node's crypto does
 * all the real work. The zip is embedded byte-for-byte, so the CRX provably
 * contains exactly what the store upload contains, and the signature is
 * verified back with the public key before anything is written to disk.
 *
 * Usage:
 *     node tools/make-crx.js --key <private.pem> [--zip <in.zip>] [--out <out.crx>]
 *     node tools/make-crx.js --new-key <private.pem>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function fail(msg) {
  console.error('make-crx: ' + msg);
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

const keyPath = opt['new-key'] || opt.key;
if (!keyPath) {
  fail('a signing key is required.\n' +
    '  first time:  node tools/make-crx.js --new-key crx-key.pem\n' +
    '  after that:  node tools/make-crx.js --key crx-key.pem\n' +
    'The extension id is derived from this key. Keep it; never commit it.');
}

if (opt['new-key']) {
  if (fs.existsSync(keyPath)) {
    fail(`${keyPath} already exists — refusing to overwrite a signing key.\n` +
      'If you meant to sign with it: --key ' + keyPath);
  }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 });
  console.log(`new signing key written to ${keyPath} — back it up, never commit it`);
}

const keyPem = fs.readFileSync(keyPath, 'utf8');

const version = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const zipPath = opt.zip || path.join(ROOT, 'dist', `clone-blocker-${version}.zip`);
const outPath = opt.out || zipPath.replace(/\.zip$/, '.crx');
if (!fs.existsSync(zipPath)) {
  fail(`${path.relative(ROOT, zipPath)} does not exist — run "npm run pack" first.`);
}
const zip = fs.readFileSync(zipPath);

// -- tiny protobuf writers --------------------------------------------------
//
// Two messages, three fields, all length-delimited (wire type 2) — a protobuf
// library would be the only dependency in the repository.

function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
function field(number, bytes) {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

// -- the CRX3 header --------------------------------------------------------

const publicKey = crypto.createPublicKey(keyPem);
const spki = publicKey.export({ type: 'spki', format: 'der' });

// The id is the first half of the key's SPKI hash, spelled in Chrome's
// a-p alphabet (a nibble each), which is how it appears on chrome://extensions.
const idBytes = crypto.createHash('sha256').update(spki).digest().subarray(0, 16);
const id = [...idBytes]
  .map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
  .join('');

// SignedData { bytes crx_id = 1; }
const signedHeaderData = field(1, idBytes);

// What the signature covers: a fixed context string (its trailing NUL
// included), the little-endian length of SignedData, SignedData itself, and
// the whole archive.
const context = Buffer.from('CRX3 SignedData\0', 'latin1');
const shdLen = Buffer.alloc(4);
shdLen.writeUInt32LE(signedHeaderData.length, 0);

const signer = crypto.createSign('sha256');
signer.update(context); signer.update(shdLen);
signer.update(signedHeaderData); signer.update(zip);
const signature = signer.sign(keyPem);

// Believe the signature only after verifying it the way Chrome will.
const verifier = crypto.createVerify('sha256');
verifier.update(context); verifier.update(shdLen);
verifier.update(signedHeaderData); verifier.update(zip);
if (!verifier.verify(publicKey, signature)) fail('self-verification failed');

// CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
//                 bytes signed_header_data = 10000; }
// AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
const proof = Buffer.concat([field(1, spki), field(2, signature)]);
const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);

const magic = Buffer.from('Cr24', 'latin1');
const nums = Buffer.alloc(8);
nums.writeUInt32LE(3, 0);             // CRX format version
nums.writeUInt32LE(header.length, 4);

const crx = Buffer.concat([magic, nums, header, zip]);
fs.writeFileSync(outPath, crx);

const sha = crypto.createHash('sha256').update(crx).digest('hex');
console.log(`wrote ${path.relative(ROOT, outPath)}`);
console.log(`  ${crx.length} bytes over a ${zip.length}-byte zip`);
console.log(`  extension id ${id}`);
console.log(`  sha256 ${sha}`);
