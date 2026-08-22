/**
 * Renders every image the Chrome Web Store listing needs.
 *
 *   node tools/make-store-assets.js [--port 9360] [--keep]
 *
 * The promo tiles are laid out in HTML and screenshotted at their exact pixel
 * size, rather than drawn with distance fields like the icons. Tiles need real
 * type, and shipping a font rasteriser to set four words would be silly.
 *
 * The listing screenshots embed genuine captures of the extension's own pages,
 * taken from a real Chrome with the extension loaded -- the store asks for
 * actual user experience, and a mocked-up UI is both against the spirit of
 * that and the sort of thing reviewers notice. Nothing here shows a real
 * account or a real feed.
 *
 * Writes into store/:
 *   icon128.png                 (via tools/make-icons.js)
 *   small-promo-440x280.png     required
 *   marquee-1400x560.png        optional, needed to be eligible for featuring
 *   screenshot-1..4-1280x800.png
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CDP_PORT = parseInt(argOf('port', '9360'), 10);
const KEEP = args.includes('--keep');
// Tiles are the part that gets re-laid-out twenty times in a row. Capturing
// the extension's own pages needs a second browser with it loaded and takes
// about a minute, so let the fast half run on its own.
const TILES_ONLY = args.includes('--tiles');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'store');
const PROFILE = path.join(os.tmpdir(), 'claude', 'C--src-3queblocker', 'store-assets-profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome'
  ].filter(Boolean)) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found');
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pend = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', () => rej(new Error('CDP socket error')));
    });
    this.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) {
        const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
  }
  send(method, params, sessionId, ms = 30000) {
    const i = ++this.id;
    const payload = { id: i, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pend.set(i, { res, rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, ms);
    });
  }
}

/** Open a target, size it exactly, screenshot it, close it. */
async function shoot(cdp, url, width, height, file, settleMs, prep) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  // deviceScaleFactor 1: the store wants exact pixels, not a 2x image that
  // happens to be the right aspect ratio.
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  // A scrollbar sliced down the edge of a listing image just reads as a bad
  // crop, so it goes -- the content it scrolls is unaffected.
  try { await cdp.send('Emulation.setScrollbarsHidden', { hidden: true }, sessionId); } catch (e) {}
  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(settleMs || 900);
  // prep may return a y offset to capture from. The clip is in document
  // coordinates, not viewport coordinates -- scrolling the page and then
  // clipping at y=0 captures the (now unpainted) top of the document and
  // yields a black rectangle. Move the clip instead of the page.
  let top = 0;
  if (prep) {
    await cdp.send('Runtime.enable', {}, sessionId);
    const pr = await cdp.send('Runtime.evaluate',
      { expression: prep, awaitPromise: true, returnByValue: true }, sessionId, 20000);
    if (typeof pr.result.value === 'number') top = pr.result.value;
    await sleep(700);
  }
  const r = await cdp.send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: top > 0,
      clip: { x: 0, y: top, width, height, scale: 1 } },
    sessionId);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  console.log('  wrote', path.relative(ROOT, file), `(${width}x${height})`,
    fs.statSync(file).size + ' bytes');
}

const dataUrl = html => 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
const pngUri = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');

// -- shared page furniture -------------------------------------------------

const FONT = `-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

const BASE = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${FONT};
    -webkit-font-smoothing: antialiased;
    background: #12162b;
    color: #f4f6fc;
    overflow: hidden;
  }
  .field {
    position: absolute; inset: 0;
    background:
      radial-gradient(120% 120% at 12% 0%, #2b3566 0%, #1a2044 42%, #12162b 100%);
  }
  /* A herd behind everything: the same cow, at the same size, in the same
     pose, as many times as fits. That is the whole complaint about bo do in
     one texture -- not that there are many of them, but that there is only
     ever one of them, pasted. Low contrast, so it stays a texture and never
     competes with the mark. */
  .crowd { position: absolute; inset: 0; opacity: .2; }
  .crowd i { position: absolute; display: block; }
`;

/**
 * A row of ghost head-and-shoulders glyphs, as decorative texture.
 *
 * The shoulders are centred under the head with a flat bottom edge -- an
 * off-centre capsule floating below a circle reads as two unrelated blobs
 * rather than as a person, which is worse than no texture at all.
 */
/**
 * The mark's cow, flat, as inline SVG -- same geometry as tools/make-icons.js
 * so the herd in the background is literally the animal in the badge, not a
 * near-miss drawn a second time by hand.
 */
function cowSvg(size, fill, uid) {
  const Z = 0.88, CY = 0.04;
  const x = v => (v * Z).toFixed(4);
  const y = v => (CY + v * Z).toFixed(4);
  const r = v => (v * Z).toFixed(4);
  const body = (paint) =>
    `<g stroke="${paint}" fill="${paint}">` +
    `<g stroke-width="${r(0.23)}" stroke-linecap="round">` +
    `<line x1="${x(-0.22)}" y1="${y(-0.30)}" x2="${x(-0.62)}" y2="${y(-0.45)}"/>` +
    `<line x1="${x(0.22)}" y1="${y(-0.30)}" x2="${x(0.62)}" y2="${y(-0.45)}"/></g>` +
    `<g stroke="none">` +
    `<ellipse cx="${x(-0.74)}" cy="${y(0.06)}" rx="${r(0.27)}" ry="${r(0.16)}"/>` +
    `<ellipse cx="${x(0.74)}" cy="${y(0.06)}" rx="${r(0.27)}" ry="${r(0.16)}"/>` +
    `<rect x="${x(-0.49)}" y="${y(-0.43)}" width="${r(0.98)}" height="${r(0.98)}" ` +
    `rx="${r(0.28)}"/></g></g>`;
  // Eyes and nostrils are punched through with a mask rather than painted in
  // the background colour: the field behind is a gradient, so anything opaque
  // would only match it in one spot and show as a smudge everywhere else.
  const holes =
    `<g fill="#000" stroke="none">` +
    `<ellipse cx="${x(-0.25)}" cy="${y(-0.13)}" rx="${r(0.10)}" ry="${r(0.105)}"/>` +
    `<ellipse cx="${x(0.25)}" cy="${y(-0.13)}" rx="${r(0.10)}" ry="${r(0.105)}"/>` +
    `<ellipse cx="${x(-0.145)}" cy="${y(0.37)}" rx="${r(0.075)}" ry="${r(0.095)}"/>` +
    `<ellipse cx="${x(0.145)}" cy="${y(0.37)}" rx="${r(0.075)}" ry="${r(0.095)}"/></g>`;
  // Cropped to the animal. A square box left the cow floating in half a box
  // of nothing, which made a row of them read as scattered dots.
  const VB = { x: -0.92, y: -0.49, w: 1.84, h: 1.06 };
  return `<svg viewBox="${VB.x} ${VB.y} ${VB.w} ${VB.h}" width="${size}" ` +
    `height="${(size * VB.h / VB.w).toFixed(2)}">` +
    `<defs><mask id="cow${uid}" maskUnits="userSpaceOnUse" ` +
    `x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}">` +
    body('#fff') + holes + `</mask></defs>` +
    `<g mask="url(#cow${uid})"><rect x="${VB.x}" y="${VB.y}" width="${VB.w}" ` +
    `height="${VB.h}" fill="${fill}"/></g></svg>`;
}

/** A row of that cow, evenly spaced, with nothing varied between them. */
function crowd(count, size, top, gap, left) {
  let out = '';
  for (let i = 0; i < count; i++) {
    out += `<i style="left:${left + i * gap}px;top:${top}px">` +
           cowSvg(size, '#e6393f', i) + `</i>`;
  }
  return out;
}

// -- promo tiles -----------------------------------------------------------

function tileHtml(w, h, opts) {
  const icon = pngUri(path.join(ROOT, 'icons', 'icon128.png'));
  const big = opts.iconSize;
  return `<!doctype html><meta charset="utf-8"><style>${BASE}
    .wrap {
      position: absolute; inset: 0; display: flex; align-items: center;
      gap: ${opts.gap}px; padding: 0 ${opts.pad}px;
    }
    .mark {
      width: ${big}px; height: ${big}px; flex: none; border-radius: ${big * 0.235}px;
      background: url('${icon}') center/cover no-repeat;
      box-shadow: 0 ${big * 0.09}px ${big * 0.28}px rgba(6, 9, 24, .55);
    }
    /* The product name is the small line and the joke is the big one. A
       marquee has about a second to earn a click, and "Clone Blocker" is not
       what earns it -- being told where the grass is, is. The name still has
       to be present and legible, so it sits above as an eyebrow. */
    .name { font-size: ${opts.name}px; font-weight: 650; text-transform: uppercase;
            letter-spacing: .19em; color: #98a6dc; }
    .joke { margin-top: ${opts.jokeGap}px; font-size: ${opts.joke}px; font-weight: 700;
            letter-spacing: -.02em; line-height: 1.06; color: #ffc72e;
            max-width: ${opts.jokeWidth}px; }
    /* The one sentence that has to survive being glanced at. It was in the
       grey description underneath, where the single most important thing
       about the product read as the third clause of a paragraph. White on a
       lit panel with the brand's yellow down its edge -- loud enough to be
       read second, after the joke, and never mistaken for body copy. */
    .claim {
      margin-top: ${opts.claimGap}px; display: inline-block;
      font-size: ${opts.claim}px; font-weight: 620; line-height: 1.3;
      color: #f4f6fc; max-width: ${opts.tagWidth}px;
      background: rgba(255, 199, 46, .1); border: 1px solid rgba(255, 199, 46, .34);
      border-left: 3px solid #ffc72e; border-radius: 7px;
      padding: ${opts.claim * 0.42}px ${opts.claim * 0.62}px;
    }
    .tag  { margin-top: ${opts.tagGap}px; font-size: ${opts.tag}px; font-weight: 500;
            line-height: 1.34; color: #c2cbee; max-width: ${opts.tagWidth}px; }
    .rule { margin-top: ${opts.tagGap}px; width: ${opts.joke * 1.5}px; height: 3px;
            border-radius: 2px;
            background: linear-gradient(90deg, #ffc72e, #e6393f 60%, transparent); }
  </style>
  <div class="field"></div>
  <div class="crowd">${opts.crowd}</div>
  <div class="wrap">
    <div class="mark"></div>
    <div>
      <div class="name">Clone Blocker</div>
      <div class="joke">${opts.joke_}</div>
      <div class="rule"></div>
      <div class="claim">${opts.claim_}</div>
      ${opts.tagline ? `<div class="tag">${opts.tagline}</div>` : ''}
    </div>
  </div>`;
}

// -- listing screenshots ---------------------------------------------------

/**
 * Screenshot one: the poster. Deliberately the marquee tile again -- same
 * field, same herd, same yellow punchline -- because a listing that opens on
 * one joke and then shows a different product is a listing nobody trusts.
 */
function posterHtml() {
  const icon = pngUri(path.join(ROOT, 'icons', 'icon128.png'));
  return `<!doctype html><meta charset="utf-8"><style>${BASE}
    .page { position: absolute; inset: 0; display: flex; flex-direction: column;
            align-items: center; justify-content: center; text-align: center;
            padding: 0 90px 90px; }
    .mark { width: 124px; height: 124px; border-radius: 29px;
            background: url('${icon}') center/cover no-repeat;
            box-shadow: 0 16px 48px rgba(6, 9, 24, .62); }
    .name { margin-top: 30px; font-size: 20px; font-weight: 650; text-transform: uppercase;
            letter-spacing: .21em; color: #98a6dc; }
    h1 { margin: 16px 0 0; font-size: 68px; line-height: 1.06; font-weight: 700;
         letter-spacing: -.028em; color: #ffc72e; }
    p { margin: 20px 0 0; font-size: 23px; line-height: 1.5; color: #c2cbee; max-width: 820px; }
    /* Same panel as the tiles carry: this is the sentence the listing is
       actually selling, and it cannot be left to be found in a paragraph. */
    .claim {
      display: inline-block; margin: 22px 0 0; max-width: 800px;
      font-size: 25px; font-weight: 620; line-height: 1.32; color: #f4f6fc;
      background: rgba(255, 199, 46, .1); border: 1px solid rgba(255, 199, 46, .34);
      border-left: 3px solid #ffc72e; border-radius: 8px; padding: 12px 18px;
    }
    .pills { display: flex; gap: 12px; margin-top: 38px; flex-wrap: wrap; justify-content: center; }
    .pill { font-size: 17px; font-weight: 600; padding: 11px 20px; border-radius: 999px;
            background: rgba(150,168,235,.11); border: 1px solid rgba(150,168,235,.22);
            color: #d5ddf8; }
  </style>
  <div class="field"></div>
  <div class="crowd">${crowd(9, 168, 690, 168, -34)}</div>
  <div class="page">
    <div class="mark"></div>
    <div class="name">Clone Blocker</div>
    <h1>Bò đỏ ơi,<br>cỏ ở đằng kia.</h1>
    <div class="claim">Bạn báo cáo một lần &rarr; duyệt xong,<br>ai dùng Clone Blocker cũng chặn tài khoản đó</div>
    <p>Chặn bò đỏ, nick giả và mọi thứ na ná nhau trên Facebook và Threads.</p>
    <div class="pills">
      <span class="pill">Facebook &amp; Threads</span>
      <span class="pill">Báo cáo một lần</span>
      <span class="pill">Duyệt xong, cả cộng đồng cùng chặn</span>
      <span class="pill">Chặn từ tốn, an toàn</span>
    </div>
  </div>`;
}

/**
 * Screenshot two: the actual thing, in the same clothes. The options page
 * carries it and the popup sits in front of it, because those are the only
 * two surfaces a reader ever opens on purpose and showing one without the
 * other makes the extension look like half of itself.
 *
 * Both captures are of the Vietnamese interface -- see captureExtensionPages.
 * A listing that jokes in Vietnamese and then shows an English screenshot is
 * quietly telling the reader the translation is marketing.
 */
function productHtml(opts) {
  const main = pngUri(opts.main);
  const inset = opts.inset ? pngUri(opts.inset) : null;
  return `<!doctype html><meta charset="utf-8"><style>${BASE}
    .page { position: absolute; inset: 0; display: flex; flex-direction: column;
            padding: 52px 64px 0; }
    .name { font-size: 17px; font-weight: 650; text-transform: uppercase;
            letter-spacing: .21em; color: #98a6dc; }
    h1 { margin: 14px 0 0; font-size: 50px; line-height: 1.08; font-weight: 700;
         letter-spacing: -.026em; color: #ffc72e; }
    p  { margin: 16px 0 0; font-size: 21px; line-height: 1.45; font-weight: 450;
         color: #c2cbee; max-width: 840px; }
    .stage { flex: 1; margin-top: 30px; position: relative; }
    .frame {
      position: absolute; border-radius: 14px 14px 0 0; overflow: hidden;
      background: #0e1223;
      box-shadow: 0 -1px 0 rgba(255,255,255,.07) inset, 0 26px 70px rgba(4, 7, 20, .6);
      border: 1px solid rgba(150,168,235,.16); border-bottom: 0;
    }
    .frame img { display: block; width: 100%; }
    .main  { right: 0; top: 0; width: ${opts.mainWidth}px; }
    /* In front and to the left, overlapping. Side by side, the two frames
       read as two unrelated products; overlapped, they read as one. */
    .inset { left: 0; top: ${opts.insetTop}px; width: ${opts.insetWidth}px;
             border-radius: 14px; border-bottom: 1px solid rgba(150,168,235,.16);
             box-shadow: 0 30px 80px rgba(4, 7, 20, .72); }
  </style>
  <div class="field"></div>
  <div class="crowd">${crowd(9, 168, 690, 168, -34)}</div>
  <div class="page">
    <div class="name">Clone Blocker</div>
    <h1>${opts.title}</h1>
    <p>${opts.body}</p>
    <div class="stage">
      <div class="frame main"><img src="${main}"></div>
      ${inset ? `<div class="frame inset"><img src="${inset}"></div>` : ''}
    </div>
  </div>`;
}

// -- main ------------------------------------------------------------------

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Icons first: the tiles embed icon128.png, so a stale icon would silently
  // propagate into every promotional asset.
  require('child_process').execSync(`"${process.execPath}" "${path.join(__dirname, 'make-icons.js')}"`,
    { stdio: 'inherit' });

  // Real captures of the extension's own pages, from a browser that has it
  // loaded. Falls back to the long-lived dev session if one is already up.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-shots-'));
  const uiShots = TILES_ONLY ? {} : await captureExtensionPages(tmp);

  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    'about:blank'
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); break; }
    catch (e) { await sleep(400); }
  }
  if (!version) { console.error('renderer did not start'); process.exit(1); }
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  try {
    console.log('\npromotional tiles');
    // "Bo do oi, co o dang kia" -- hey red cow, the grass is that way. It is
    // a dismissal rather than an insult, which is both funnier and the
    // honest description of what the extension does: it does not argue with
    // the herd, it sends them somewhere else and gets on with the day.
    // Broken by hand rather than left to wrap: the setup on one line and the
    // punchline on the next. Wrapping on its own split it after "cỏ ở",
    // which puts the break in the middle of the joke and loses the timing.
    const JOKE = 'Bò đỏ ơi,<br>cỏ ở đằng kia.';

    await shoot(cdp, dataUrl(tileHtml(440, 280, {
      iconSize: 88, gap: 20, pad: 26, name: 11.5, joke: 27, jokeGap: 9, jokeWidth: 268,
      claim: 13, claimGap: 11, tag: 12, tagGap: 9, tagWidth: 250,
      joke_: JOKE,
      claim_: 'Báo cáo một lần &rarr;<br>cả cộng đồng cùng chặn',
      tagline: 'Bò đỏ và nick giả trên Facebook và Threads.',
      crowd: crowd(6, 84, 218, 84, -18)
    })), 440, 280, path.join(OUT, 'small-promo-440x280.png'));

    await shoot(cdp, dataUrl(tileHtml(1400, 560, {
      iconSize: 232, gap: 70, pad: 94, name: 25, joke: 82, jokeGap: 18, jokeWidth: 900,
      claim: 27, claimGap: 22, tag: 25, tagGap: 18, tagWidth: 800,
      joke_: JOKE,
      claim_: 'Bạn báo cáo một lần &rarr; duyệt xong, ai dùng Clone Blocker cũng chặn tài khoản đó',
      tagline: 'Chặn bò đỏ và nick giả trên Facebook và Threads.',
      crowd: crowd(9, 168, 448, 168, -34)
    })), 1400, 560, path.join(OUT, 'marquee-1400x560.png'));

    if (TILES_ONLY) return;

    console.log('\nlisting screenshots');

    // Two, not four. Four meant two drawn explainers standing in front of two
    // real captures, and the drawn ones were doing the captures' job --
    // describing an interface that was sitting right there. One poster to
    // land the joke, one photograph of the actual product, same clothes.
    await shoot(cdp, dataUrl(posterHtml()), 1280, 800,
      path.join(OUT, 'screenshot-1-1280x800.png'));

    if (uiShots.options && fs.existsSync(uiShots.options)) {
      await shoot(cdp, dataUrl(productHtml({
        main: uiShots.options,
        mainWidth: 720,
        inset: uiShots.popup && fs.existsSync(uiShots.popup) ? uiShots.popup : null,
        insetWidth: 430,
        insetTop: 84,
        title: 'Một người báo cáo. Cả cộng đồng cùng chặn.',
        body: 'Bạn báo cáo một tài khoản giả mạo, có người thật duyệt, rồi tài khoản đó ' +
              'vào danh sách chặn chung — mọi bản Clone Blocker đều chặn theo. ' +
              'Tốc độ và giới hạn vẫn do bạn chỉnh.'
      })), 1280, 800, path.join(OUT, 'screenshot-2-1280x800.png'));
    } else {
      console.log('  skipped screenshot 2: no capture of the extension pages');
      console.log('  (run tools/dev-session.js first, then re-run this)');
    }

    // Anything left from the four-screenshot listing would still be sitting
    // in the directory for whoever uploads it, so it goes.
    for (const stale of ['screenshot-3-1280x800.png', 'screenshot-4-1280x800.png']) {
      const f = path.join(OUT, stale);
      if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('  removed stale', stale); }
    }
  } finally {
    if (!KEEP) { try { chrome.kill(); } catch (e) {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\nstore assets in', path.relative(ROOT, OUT) + path.sep);
  process.exit(0);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });

/**
 * Screenshots the popup and options pages from a browser with the extension
 * loaded. Prefers the running dev session, because loading an unpacked
 * extension needs a non-headless Chrome and there is usually one up already.
 */
/**
 * Drives the options page's own language picker and returns what it was set
 * to before. Deliberately the picker rather than a settings write: the picker
 * is the path a real user takes, it repaints the open page in place, and
 * whatever the setting is wired to today it stays wired to.
 *
 * Every caller must put the restore in a finally. This is somebody's dev
 * browser, and leaving it in a language they did not choose is rude.
 */
async function onExtPage(cdp, extId, expression) {
  const { targetId } = await cdp.send('Target.createTarget',
    { url: `chrome-extension://${extId}/src/options/options.html` });
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await sleep(1200);
    const r = await cdp.send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, sessionId, 20000);
    return r.result && r.result.value;
  } finally {
    try { await cdp.send('Target.closeTarget', { targetId }); } catch (e) {}
  }
}

async function setUiLanguage(cdp, extId, lang) {
  const { targetId } = await cdp.send('Target.createTarget',
    { url: `chrome-extension://${extId}/src/options/options.html` });
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await sleep(1500);
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const sel = document.getElementById('uiLanguage');
        if (!sel) return null;
        const was = sel.value;
        sel.value = ${JSON.stringify(lang)};
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 900));
        return was;
      })()`,
      awaitPromise: true, returnByValue: true
    }, sessionId, 20000);
    return r.result && r.result.value;
  } finally {
    try { await cdp.send('Target.closeTarget', { targetId }); } catch (e) {}
  }
}

async function captureExtensionPages(dir) {
  // Both go to a temp dir that is deleted at the end. The popup in particular
  // must never land in the repo: its Page capability panel prints "Signed in
  // as <numeric account id>", so a committed copy would publish the real
  // account of whoever ran this.
  const out = { popup: path.join(dir, 'popup.png'), options: path.join(dir, 'options.png') };
  let version = null, port = null;
  for (const p of [9333, 9360]) {
    try { version = await (await fetch(`http://localhost:${p}/json/version`)).json(); port = p; break; }
    catch (e) { /* not up */ }
  }
  if (!version) {
    console.log('\nno browser with the extension loaded on 9333 -- run tools/dev-session.js first');
    console.log('(falling back to the hero screenshot and the dashboard only)');
    return {};
  }

  // The extension id is read from the session file the dev launcher writes.
  // Scanning for a live service_worker target does not work: MV3 workers idle
  // out after a few seconds, so a perfectly healthy extension shows no target
  // at all and the scan reports it as missing.
  const sessionFile = path.join(os.tmpdir(), 'claude', 'C--src-3queblocker', 'dev-session', 'session.json');
  let extId = null;
  try { extId = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).extId; } catch (e) { /* no session */ }
  if (!extId) {
    const c = new CDP(version.webSocketDebuggerUrl); await c.ready;
    const { targetInfos } = await c.send('Target.getTargets');
    c.ws.close();
    const sw = targetInfos.find(t => t.type === 'service_worker' &&
      t.url.includes('src/background/service-worker.js'));
    extId = sw ? new URL(sw.url).host : null;
  }
  if (!extId) { console.log('\nextension not loaded in the browser on ' + port); return {}; }
  console.log('\ncapturing extension pages from the browser on ' + port + ' (' + extId + ')');

  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  // Both captures are taken in Vietnamese, because the listing they go into
  // makes its joke in Vietnamese. Restored in the finally below whatever
  // happens -- the value is read back, not assumed, so a dev browser already
  // set to something returns to that something.
  let priorLang = null;
  try {
    priorLang = await setUiLanguage(cdp, extId, 'vi');
    console.log('  interface switched to Vietnamese for the capture');
  } catch (e) {
    console.log('  language switch skipped:', e.message);
  }

  try {
  // The mode picker is the first thing on the options page now, so this
  // captures from the top -- no scrolling, and nothing to stand in for. (It
  // used to scroll past an endpoint field to reach the pacing controls; the
  // field is gone and the pacing lives under Advanced, where a listing image
  // has no business dragging the reader.)
  //
  // One display-only correction: this browser is a dev session, which forces
  // blocking OFF for safety, and the page honestly says so. That paused note
  // is the harness's state, not the product's -- a fresh install ships
  // unpaused -- so it is cleared in the DOM for the capture. Nothing is
  // written to settings; the session stays exactly as paused as it was.
  await shoot(cdp, `chrome-extension://${extId}/src/options/options.html`, 880, 1180, out.options, 1600,
    `(async () => {
       const note = document.getElementById('pausedNote');
       if (note) note.classList.add('hidden');
       const pause = document.getElementById('pauseBlocking');
       if (pause) pause.checked = false;
       await new Promise(r => setTimeout(r, 150));
       return 0;
     })()`);
  try {
    await capturePopup(cdp, extId, out.popup);
  } catch (e) {
    console.log('  popup capture skipped:', e.message);
    delete out.popup;
  }
  } finally {
    if (priorLang !== null && priorLang !== undefined) {
      try { await setUiLanguage(cdp, extId, priorLang); } catch (e) {
        console.log('  WARNING: could not restore the interface language to', priorLang);
      }
    }
  }
  cdp.ws.close();
  return out;
}

/**
 * Screenshots the action popup as it actually appears: opened over a supported
 * site.
 *
 * Loading popup.html as a plain tab produces a misleading image -- the popup
 * asks chrome.tabs for the active tab of its own window, so on its own it
 * reports "not on a supported site" and renders its empty state. Driving
 * chrome.action.openPopup() from the service worker with a Threads tab in
 * front gives the real popup surface with real state behind it.
 */
async function capturePopup(cdp, extId, file) {
  const { targetId: tab } = await cdp.send('Target.createTarget',
    { url: 'https://www.threads.com/@threads' });
  // Taking this picture arms blocking, on a browser signed in to real
  // accounts. Whatever it was before goes back, on every path out.
  let restore = null;
  try {
    await cdp.send('Target.activateTarget', { targetId: tab });
    await sleep(5000);

    // Opening an extension page wakes the (idled) MV3 worker so there is a
    // target to drive, and is also where the display state is set.
    const { targetId: opt } = await cdp.send('Target.createTarget',
      { url: `chrome-extension://${extId}/src/options/options.html` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: opt, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await sleep(1400);
    // Blocking is shown ON, because that is what a fresh install ships with
    // and because the options page in the same screenshot shows it on: a
    // listing image where the popup says blocking is paused and the settings
    // beside it say it is running contradicts itself, and the reader has no
    // way to know which half is the product.
    //
    // Dry run stays ON regardless. This browser is signed in to real
    // accounts, and no screenshot is worth arming live blocking to take.
    //
    // The queue is emptied first. It is dev-session scratch either way, and a
    // backlog left in it makes the popup explain its own pacing -- true, but
    // it is answering a question the picture never asked.
    const priorBlocking = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const { settings = {} } = await chrome.storage.sync.get('settings');
        const was = {
          hideEnabled: settings.hideEnabled,
          platformBlockEnabled: settings.platformBlockEnabled,
          platformBlockDryRun: settings.platformBlockDryRun
        };
        await chrome.storage.sync.set({ settings: { ...settings,
          hideEnabled: true, platformBlockEnabled: true, platformBlockDryRun: true } });
        await chrome.storage.local.set({ platformQueue: {} });
        await new Promise(r => chrome.runtime.sendMessage({ type: 'sw:refresh-now' }, r));
        return JSON.stringify(was);
      })()`,
      awaitPromise: true, returnByValue: true
    }, sessionId, 20000);
    restore = priorBlocking.result && priorBlocking.result.value;
    await cdp.send('Target.closeTarget', { targetId: opt });
    await cdp.send('Target.activateTarget', { targetId: tab });
    await sleep(800);

    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.includes(extId));
    if (!sw) throw new Error('service worker not running');
    const { sessionId: swSession } = await cdp.send('Target.attachToTarget',
      { targetId: sw.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, swSession);
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'chrome.action.openPopup().then(() => "ok").catch(e => "ERR: " + e.message)',
      awaitPromise: true, returnByValue: true, userGesture: true
    }, swSession);
    if (r.result.value !== 'ok') throw new Error(String(r.result.value));
    await sleep(1800);

    const { targetInfos: after } = await cdp.send('Target.getTargets');
    const popup = after.find(t => t.type === 'page' && t.url.includes('/popup/popup.html'));
    if (!popup) throw new Error('popup did not appear');

    const { sessionId: pSession } = await cdp.send('Target.attachToTarget',
      { targetId: popup.targetId, flatten: true });
    await cdp.send('Page.enable', {}, pSession);
    // The popup really does overflow, so it really does have a scrollbar --
    // but a scrollbar sliced down the edge of a listing image just looks like
    // a bad crop. Hide the bar, keep the content.
    try { await cdp.send('Emulation.setScrollbarsHidden', { hidden: true }, pSession); } catch (e) {}
    await sleep(400);
    // No metrics override here: this is the real popup surface, and resizing
    // it would capture something the user never sees.
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, pSession);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('  wrote', path.basename(file), '(real action popup)',
      fs.statSync(file).size + ' bytes');
  } finally {
    if (restore) {
      try {
        await onExtPage(cdp, extId, `(async () => {
          const { settings = {} } = await chrome.storage.sync.get('settings');
          await chrome.storage.sync.set({
            settings: { ...settings, ...JSON.parse(${JSON.stringify(restore)}) } });
          await new Promise(r => chrome.runtime.sendMessage({ type: 'sw:refresh-now' }, r));
        })()`);
        console.log('  blocking settings restored');
      } catch (e) {
        console.log('  WARNING: could not restore blocking settings:', e.message);
      }
    }
    try { await cdp.send('Target.closeTarget', { targetId: tab }); } catch (e) {}
  }
}
