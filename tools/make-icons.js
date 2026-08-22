/**
 * Generates the extension's PNG icons with no dependencies.
 *
 * Node can already do everything needed: zlib for the IDAT stream and
 * Buffer/CRC for the chunk framing. Drawing is done by evaluating a signed
 * distance field per pixel, which gives clean antialiased edges without a
 * canvas library and stays sharp at 16px where a downscaled bitmap turns to
 * mush.
 *
 * The mark is a red cow wearing a livestock ear tag.
 *
 * "Bo do" -- red cow -- is what Vietnamese readers call the paid commenters
 * who swarm a post to shout down whoever is speaking. The joke is that they
 * are a herd: the same opinion, in the same words, from a hundred accounts
 * that all look alike. Which is also what this extension is for, so one mark
 * carries both halves of it. The ear tag finishes the thought -- numbered,
 * interchangeable, and saying what it was issued to say.
 *
 * It went through a slashed cow and a prohibition ring first. The slash ran
 * diagonally through the muzzle, so the face lost half of itself exactly
 * where pixels got scarce; the ring read as "blocked" beautifully at 16px and
 * shrank the cow to an unrecognisable smudge, which is the one thing the mark
 * cannot afford to lose. The tag says the same thing without spending any of
 * the face, and being the only asymmetric element, it is also what makes the
 * silhouette identifiable small. "Blocker" is in the name; the icon's job is
 * to be recognised in a toolbar.
 *
 * The joke is aimed at the herd and nothing else. A flag or a star with a
 * line through it would be a different joke -- one about a country rather
 * than about astroturfing -- and a worse one.
 *
 *   node tools/make-icons.js
 *
 * Writes icons/icon{16,32,48,128}.png for the manifest, plus
 * store/icon128.png -- the same mark inset to 96px inside a 128px transparent
 * frame, which is what the Chrome Web Store asks for its listing icon.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// -- PNG container ---------------------------------------------------------

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Each scanline is prefixed with a filter byte (0 = None).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// -- distance fields -------------------------------------------------------

/** Signed distance to a rounded rectangle, centred at (cx, cy). */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a circle. */
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/** Signed distance to a thick line segment, used for the slash. */
function sdSegment(px, py, ax, ay, bx, by, thick) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - thick;
}

/**
 * Signed distance to an ellipse, near enough. The exact solution needs a
 * quartic; scaling the point into circle space and scaling the distance back
 * by the smaller radius is off by a fraction of a pixel on the flanks, which
 * at 128px is invisible and at 16px is smaller than a pixel.
 */
function sdEllipse(px, py, cx, cy, rx, ry) {
  return (Math.hypot((px - cx) / rx, (py - cy) / ry) - 1) * Math.min(rx, ry);
}

// -- palette ---------------------------------------------------------------
//
// The cow has to be red -- that is the whole name -- so the field cannot be.
// Deep indigo holds up against both a light and a dark toolbar, which rules
// out anything mid-tone, and it throws the red forward instead of competing
// with it. Cream for the horns and muzzle: red on indigo alone is a shape
// without a face, and the light parts are what make it read as a cow rather
// than a blob at 16px.
const BADGE  = [30, 36, 64];
const COW    = [230, 57, 63];
const CREAM  = [255, 219, 208];
const STRIKE = [244, 246, 252];
const TAG    = [255, 199, 46];

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * @param {number} size    output edge in pixels
 * @param {number} inset   artwork scale inside the frame (1 = full bleed)
 */
function render(size, inset) {
  const S = size;
  const buf = Buffer.alloc(S * S * 4);
  const SS = 4;             // 4x4 supersampling; cheap at these sizes
  const k = inset || 1;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Normalised to [-1, 1], then divided by the inset so the artwork
          // shrinks inside the frame rather than the frame growing.
          const px = (((x + (sx + 0.5) / SS) / S) * 2 - 1) / k;
          const py = (((y + (sy + 0.5) / SS) / S) * 2 - 1) / k;

          // Coverage from a distance, in pixels, so edges stay one pixel wide
          // at every size instead of blurring as the icon grows.
          const px2px = (S * k) / 2;
          const cover = (d) => Math.min(1, Math.max(0, 0.5 - d * px2px));

          const badge = cover(sdRoundRect(px, py, 0, 0, 0.94, 0.94, 0.30));
          if (badge <= 0) continue;

          // Cow geometry, in units of the head. Written relative to one
          // scale so the whole animal can be resized without re-tuning
          // fifteen numbers by hand.
          const Z = 0.88, CX = 0, CY = 0.04;
          const E = (x, y, rx, ry) =>
            sdEllipse(px, py, CX + x * Z, CY + y * Z, rx * Z, ry * Z);
          const G = (ax, ay, bx, by, t) =>
            sdSegment(px, py, CX + ax * Z, CY + ay * Z, CX + bx * Z, CY + by * Z, t * Z);

          // Horns sit low and stubby and point outwards rather than up. The
          // first pass had them long, thin and diagonal, which put two cream
          // strokes at roughly the slash's own angle -- the mark read as a
          // cow behind a pair of chopsticks.
          // Short and thick. Long horns at this scale stopped reading as
          // horns and started reading as rabbit ears, which put the mark in
          // the wrong animal entirely.
          // Horns splay sideways out of the skull with only a slight rise,
          // and their base starts inside the head so it is hidden. Anything
          // that climbs from the top corners at forty-five degrees reads as
          // antlers or as rabbit ears, and puts the mark in the wrong animal.
          const horns = Math.min(G(-0.22, -0.30, -0.62, -0.45, 0.115),
                                 G(0.22, -0.30, 0.62, -0.45, 0.115));
          const ears  = Math.min(E(-0.74, 0.06, 0.27, 0.160),
                                 E(0.74, 0.06, 0.27, 0.160));
          const head  = sdRoundRect(px, py, CX, CY + 0.06 * Z,
                                    0.49 * Z, 0.49 * Z, 0.28 * Z);
          const face  = Math.min(head, ears);
          const muzzle = E(0, 0.37, 0.37, 0.235);
          const eyes  = Math.min(E(-0.25, -0.13, 0.10, 0.105),
                                 E(0.25, -0.13, 0.10, 0.105));
          const nose  = Math.min(E(-0.145, 0.37, 0.062, 0.078),
                                 E(0.145, 0.37, 0.062, 0.078));

          // Detail ladder. At 128px every feature is worth drawing; at 16px
          // most of them are a pixel across, where they stop being detail and
          // start being dirt. The eyes are the worst offenders -- they are
          // punched in the badge colour, so once they are a pixel wide they
          // stop reading as eyes and merge into the slash's gap.
          const nostrils = S >= 48;
          const eyeholes = S >= 32;

          // Drawn twice: a wider cut in the badge colour underneath the
          // accent, so the strike reads as a gap through the animal rather
          // than a stripe painted over it.
          // Thin, because the gap is subtractive: every unit of it is taken
          // out of the face, and the face is the part that has to survive.
          // The livestock ear tag, and the whole joke. Bo do are not being
          // called cattle by accident: the complaint about them is that they
          // are numbered, interchangeable, and say what they are issued to
          // say. A tag punched through one ear says that in one shape, which
          // a slash across the face cannot.
          //
          // It also happens to be the only asymmetric thing in the mark, and
          // asymmetry is what makes a 16px silhouette identifiable, so it
          // earns its place twice.
          const tag = E(-0.80, 0.16, 0.125, 0.125);
          const cut = 0, strike = 0;

          let c = BADGE;
          c = mix(c, CREAM, cover(horns));
          c = mix(c, COW, cover(face));
          c = mix(c, CREAM, cover(muzzle));
          if (nostrils) c = mix(c, COW, cover(nose));
          if (eyeholes) c = mix(c, BADGE, cover(eyes));
          // No halo: it is meant to be clipped through the ear, and a
          // badge-coloured gap around it made it float alongside instead.
          c = mix(c, TAG, cover(tag));

          r += c[0] * badge; g += c[1] * badge; b += c[2] * badge;
          a += badge;
        }
      }

      const n = SS * SS;
      const i = (y * S + x) * 4;
      const alpha = a / n;
      // Un-premultiply, or the antialiased rim darkens towards black.
      buf[i]     = alpha > 0 ? Math.round(r / n / alpha) : 0;
      buf[i + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
      buf[i + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(S, S, buf);
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const iconDir = path.join(root, 'icons');
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(iconDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });

  for (const size of [16, 32, 48, 128]) {
    const file = path.join(iconDir, `icon${size}.png`);
    fs.writeFileSync(file, render(size, 1));
    console.log('wrote', path.relative(root, file), fs.statSync(file).size, 'bytes');
  }

  // The store listing icon wants 96px of artwork centred in a 128px canvas,
  // so Chrome can add its own shadow and hover states without clipping ours.
  const store = path.join(storeDir, 'icon128.png');
  fs.writeFileSync(store, render(128, 96 / 128));
  console.log('wrote', path.relative(root, store), fs.statSync(store).size, 'bytes');
}

module.exports = { render, encodePNG };
