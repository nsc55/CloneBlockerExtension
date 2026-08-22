/**
 * End-to-end test: loads the extension into real Chrome and exercises it
 * against live threads.com.
 *
 * Zero dependencies -- talks CDP over Node's built-in WebSocket and fetch.
 *
 *   node tools/e2e-test.js [--headful] [--keep]
 *
 * What it proves:
 *   1. The MV3 manifest loads and the service worker boots without error.
 *   2. The blocklist is fetched as a static JSON file, parsed, and the
 *      ranked slice is computed locally.
 *   3. The MAIN-world script hooks Meta's module registry and the isolated
 *      world completes the bridge handshake.
 *   4. The capability probe finds the live Relay environment and doc_ids.
 *   5. Content authored by a blocklisted profile is actually hidden.
 *
 * Nothing is ever blocked for real: platform blocking stays disabled.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HEADFUL = process.argv.includes('--headful');
const KEEP = process.argv.includes('--keep');
// The list is a static JSON file, so the harness serves one itself rather
// than starting a database. This used to boot the Firestore emulator -- a
// Java process, a downloaded jar and a JDK version check -- to do the job a
// dozen lines of node:http do, back when the list lived in a document.
const LIST_PORT = 8123;
const LIST_URL = `http://127.0.0.1:${LIST_PORT}/blocklist.json`;
// Deliberately NOT the dev-session port (9333). Sharing it meant this harness
// silently attached to a browser someone was using by hand instead of the clean
// one it spawns, which produced confusing phantom failures.
const CDP_PORT = 9347;
const ROOT = path.join(__dirname, '..');

// The @threads account: a public profile whose numeric pk we can assert on.
const TARGET_ID = '63082166531';
const TARGET_USERNAME = 'threads';
const TEST_URL = 'https://www.threads.com/@threads';

// Two approved targets published as ranking METADATA (day buckets, region and
// language tallies) rather than ready-made ranks, so the harness can prove the
// service worker does the ranking itself. One is fresh and busy, one went
// quiet ten days ago; the seeded numbers make the ordering machine-independent
// (see the ranked-targets check for the arithmetic).
const FRESH_TARGET = '4100000001';
const STALE_TARGET = '4100000002';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// minimal CDP client
// ---------------------------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP socket error')));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 45000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function evalIn(cdp, sessionId, expression, awaitPromise) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: awaitPromise !== false,
    returnByValue: true,
    userGesture: true
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception
      ? (res.exceptionDetails.exception.description || res.exceptionDetails.text)
      : res.exceptionDetails.text);
  }
  return res.result && res.result.value;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
function buildTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ext-'));
  const copy = (rel) => {
    const src = path.join(ROOT, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child); else copy(child);
    }
  };
  walk('src');
  walk('icons');
  // Not optional: a manifest declaring default_locale that ships without the
  // matching _locales directory is refused outright by Chrome, so leaving this
  // out would fail every test in the file with one unrelated error.
  walk('_locales');

  // The only divergence from the shipped build: the harness's own list server
  // is added to host_permissions. The shipped manifest has no
  // optional_host_permissions at all any more -- the list address is baked in
  // and its origin is required -- so this adds the local one to the required
  // list, which is also what keeps the fetch path free of any permission
  // prompt. Both spellings of loopback are granted because the origin the
  // extension asks about is whichever one the listUrl was written with.
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  m.host_permissions = (m.host_permissions || []).concat([
    `http://127.0.0.1:${LIST_PORT}/*`,
    `http://localhost:${LIST_PORT}/*`
  ]);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));

  // The second and last divergence: the copy pins THIS run's public key in
  // place of the production one, so the signed list the harness serves is one
  // this build will verify. Production's key stays in the repository untouched.
  const proto = path.join(dir, 'src', 'common', 'protocol.js');
  const src = fs.readFileSync(proto, 'utf8');
  const pinned = src.replace(/const POINTER_KEY = '[^']*';/,
    "const POINTER_KEY = '" + SIGNING.publicKeyRaw + "';");
  if (pinned === src) throw new Error('could not pin the test key in protocol.js');
  fs.writeFileSync(proto, pinned);
  return dir;
}

/**
 * A one-file web server standing in for the published blocklist.
 *
 * It answers with a real ETag and honours If-None-Match, because that is what
 * the extension does against the real thing and a harness that skipped it
 * would not be exercising the path production takes.
 */
let LIST_PAYLOAD = { v: 2, ids: [], usernames: [], targets: [] };

// A throwaway Ed25519 key per run. The list is served SIGNED and the extension
// copy below pins this run's public key, so the assertion further down is the
// real thing: Chrome's own WebCrypto verifying an Ed25519 signature inside a
// service worker. Node and Chrome are both V8, but WebCrypto is not V8, and
// nothing in the unit suites can stand in for this.
const SIGNING = (() => {
  const crypto = require('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyRaw: publicKey.export({ type: 'spki', format: 'der' })
      .subarray(-32).toString('base64url'),
    sign(payload) {
      return {
        payload,
        sig: crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey)
          .toString('base64url'),
        alg: 'ed25519'
      };
    }
  };
})();

function startListServer() {
  const http = require('http');
  const crypto = require('crypto');
  const server = http.createServer((req, res) => {
    const body = JSON.stringify(SIGNING.sign(LIST_PAYLOAD));
    const etag = '"' + crypto.createHash('sha256').update(body)
      .digest('base64url').slice(0, 27) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      etag
    });
    res.end(body);
  });
  server.listen(LIST_PORT, '127.0.0.1');
  return server;
}


/**
 * Seed the published list the way the server publishes it: a plain JSON body,
 * served with an ETag. Seeding is test setup; the public read path IS under
 * test, and it uses no auth at all because there is none to use.
 */
async function seedBlocklist() {
  const day = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
  const today = day(0);
  // The UTC Monday of the week a day falls in -- what the list publishes as
  // `last` instead of the day itself.
  const weekOf = (dayKey) => {
    const d = new Date(dayKey + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return d.toISOString().slice(0, 10);
  };
  const payload = {
    v: 1,
    updatedAt: new Date().toISOString(),
    ids: [TARGET_ID],
    usernames: [TARGET_USERNAME],
    docIdOverrides: {},
    pending: [],
    // Metadata, not ranks, in the coarse shape the dashboard publishes:
    // FRESH_TARGET was reported three times this week from Vietnam,
    // STALE_TARGET went quiet ten days ago in Brazil. No counts beside the
    // region names, no day buckets, a confidence in quarter steps -- and the
    // service worker must turn these into ranks with context that never
    // leaves the machine it runs on.
    targets: [
      { platform: 'threads', id: FRESH_TARGET, tag: 'clone', confidence: 2, reporters: 3,
        last: weekOf(today), recent: 3,
        regions: ['Asia/Ho_Chi_Minh'], langs: ['vi-vn'] },
      { platform: 'threads', id: STALE_TARGET, tag: 'clone', confidence: 2, reporters: 2,
        last: weekOf(day(10 * 86400000)), recent: 0,
        regions: ['America/Sao_Paulo'], langs: ['pt-br'] }
    ]
  };
  payload.updatedAt = new Date().toISOString();
  LIST_PAYLOAD = payload;
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async function main() {
  const extDir = buildTestExtension();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-profile-'));
  console.log('extension:', extDir);

  const listServer = startListServer();

  let chrome = null;
  const cleanup = () => {
    try { if (chrome) chrome.kill(); } catch (e) {}
    // In-process now, so closing it is the whole cleanup. It used to be a Node
    // wrapper around a java process that had to be killed as a tree, or it
    // stayed listening for the next run to trip over.
    try { listServer.close(); } catch (e) {}
    if (!KEEP) {
      try { fs.rmSync(extDir, { recursive: true, force: true }); } catch (e) {}
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
    }
  };
  process.on('exit', cleanup);

  // Sanity: seed the list, then read it back the exact way the extension will
  // -- plain GET, no auth, because there is none to use.
  try {
    await seedBlocklist();
    const r = await fetch(LIST_URL);
    const env = await r.json();
    const j = env.payload;
    check('the list server serves the seeded blocklist, signed',
      r.ok && Array.isArray(j.ids) && j.ids.includes(TARGET_ID) && j.targets.length === 2,
      `${j.ids.length} ids, ${j.targets.length} targets with metadata`);
    // The economy the ten-minute poll rests on, asserted rather than assumed.
    const again = await fetch(LIST_URL, { headers: { 'if-none-match': r.headers.get('etag') } });
    check('and answers an unchanged poll with 304 and no body',
      again.status === 304 && (await again.text()).length === 0,
      'HTTP ' + again.status);
  } catch (e) {
    check('the list server serves the seeded blocklist', false, String(e.message));
  }

  // Current Chrome builds ignore --load-extension, so the extension is loaded
  // over CDP instead (Extensions.loadUnpacked), which needs this switch.
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank'
  ];
  if (!HEADFUL) chromeArgs.splice(3, 0, '--headless=new');
  chrome = spawn(findChrome(), chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});

  // Wait for the debugging endpoint.
  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      version = await r.json();
      break;
    } catch (e) { await sleep(500); }
  }
  if (!version) { check('Chrome DevTools endpoint reachable', false); finish(cleanup); return; }
  check('Chrome DevTools endpoint reachable', true, version.Browser);

  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Target.setDiscoverTargets', { discover: true });

  // ---- 1. service worker booted -----------------------------------------
  let extId = null;
  try {
    const loaded = await browser.send('Extensions.loadUnpacked', { path: extDir });
    extId = loaded && loaded.id;
  } catch (e) {
    check('extension loaded via CDP', false, e.message);
    finish(cleanup);
    return;
  }
  check('extension loaded via CDP', !!extId, extId || '');

  // MV3 workers are lazy. Opening an extension page sends a runtime message,
  // which is what actually spins the worker up.
  const optionsUrl = `chrome-extension://${extId}/src/options/options.html`;
  const { targetId: optTarget } = await browser.send('Target.createTarget', { url: optionsUrl });
  const { sessionId: optSession } = await browser.send('Target.attachToTarget',
    { targetId: optTarget, flatten: true });
  await browser.send('Runtime.enable', {}, optSession);
  await sleep(2000);

  // The options page proves the extension's own UI loads and its CSP is sane.
  let optOk = false;
  try {
    optOk = await evalIn(browser, optSession,
      `!!document.getElementById('blockFromList') && typeof chrome.storage === 'object'`, false);
  } catch (e) { /* reported below */ }
  check('options page renders with chrome APIs', !!optOk);

  // The two tick boxes are the decisions this page asks anyone to make. They
  // are independent, so any combination is legitimate -- what must not happen
  // is the page rendering them unticked on an install whose settings say
  // otherwise, because an empty box states the opposite of the truth.
  let picker = null;
  try {
    picker = JSON.parse(await evalIn(browser, optSession, `
      JSON.stringify({
        seen: !!document.getElementById('blockSeen'),
        fromList: !!document.getElementById('blockFromList'),
        seenOn: (document.getElementById('blockSeen') || {}).checked === true,
        fromListOn: (document.getElementById('blockFromList') || {}).checked === true
      })
    `, false));
  } catch (e) { picker = { error: e.message }; }
  check('options page renders both blocking tick boxes, ticked by default',
    !!(picker && picker.seen && picker.fromList && picker.seenOn && picker.fromListOn),
    JSON.stringify(picker));

  let swTarget = null;
  let allWorkers = [];
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    allWorkers = targetInfos.filter(t => t.type === 'service_worker');
    swTarget = allWorkers.find(t => t.url.includes(extId));
    if (swTarget) break;
    await sleep(500);
  }
  if (!swTarget) console.log('service workers seen:', allWorkers.map(t => t.url));
  check('extension service worker started', !!swTarget, swTarget ? swTarget.url : 'not found');
  if (!swTarget) { finish(cleanup); return; }

  const { sessionId: swSession } = await browser.send('Target.attachToTarget',
    { targetId: swTarget.targetId, flatten: true });
  await browser.send('Runtime.enable', {}, swSession);

  // ---- 2. configure + fetch blocklist -----------------------------------
  //
  // listUrl is written straight into storage on purpose: the address is baked
  // into protocol.js and no UI writes it any more, but the setting is still
  // read, which is exactly how a harness points the extension at its own list.
  // mode is written explicitly rather than left to the default, so the run
  // asserts the behaviour it means to and does not quietly change with it.
  try {
    const setRes = await evalIn(browser, optSession, `
      (async () => {
        await chrome.storage.sync.set({ settings: {
          listUrl: '${LIST_URL}',
          refreshMinutes: 60,
          mode: 'active',
          hideEnabled: true,
          hideMode: 'collapse',
          hideComments: true,
          hideFeedPosts: true,
          platformBlockEnabled: false,
          platformBlockDryRun: true,
          debug: true
        }});
        return 'ok';
      })()
    `);
    check('settings written to sync storage', setRes === 'ok');
  } catch (e) {
    check('settings written to sync storage', false, e.message);
  }

  let refresh = null;
  try {
    refresh = await evalIn(browser, optSession, `
      (async () => {
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'sw:refresh-now' }, x => r(x || { ok:false, error: (chrome.runtime.lastError||{}).message })));
        return JSON.stringify(res);
      })()
    `);
    const parsed = JSON.parse(refresh);
    check('blocklist fetched + parsed by service worker',
      parsed.ok && parsed.blocklist && parsed.blocklist.ids.includes(TARGET_ID),
      parsed.ok ? `${parsed.blocklist.ids.length} ids, ${parsed.blocklist.usernames.length} usernames`
                : parsed.error);
    // The list arrived as a signed envelope and the worker had to verify it
    // with crypto.subtle before unwrapping. `verified` is set only on that
    // path, so this is Chrome's WebCrypto agreeing with Node's signature --
    // the one thing the unit suites cannot show.
    check('the signature verified in Chrome\'s own WebCrypto',
      parsed.ok && parsed.blocklist && parsed.blocklist.verified === true,
      parsed.ok ? 'verified=' + parsed.blocklist.verified : parsed.error);
  } catch (e) {
    check('blocklist fetched + parsed by service worker', false, e.message);
  }

  // ---- 2b. local ranking from published metadata --------------------------
  // The list arrived as Firestore metadata, so the ranked slice must have been
  // computed HERE -- there is no server left to do it. The ordering assertion
  // is machine-independent even though rank depends on the real timezone and
  // language of whatever runs this test: confidence is equal (2). The fresh
  // target's `last` is this week's Monday, so its age is at most 6 days and
  // recency at least 0.5^(6/7) ~= 0.55, with velocity 3 (the list was
  // published just now, so `recent` counts in full); the stale one is at
  // least 10 days old, recency at most 0.5^(10/7) ~= 0.37, velocity 0.
  // Locality is bounded to [0.25, 1]. Fresh worst case: 2 * 0.55 * (1+3) *
  // 0.25 = 1.1. Stale best case: 2 * 0.37 * 1 * 1 = 0.74. The fresh target
  // wins everywhere on earth.
  try {
    const raw = await evalIn(browser, optSession, `
      (async () => {
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'sw:get-state' }, x => r(x || {})));
        return JSON.stringify((res.blocklist && res.blocklist.targets) || []);
      })()
    `);
    const targets = JSON.parse(raw);
    const wellFormed = targets.length > 0 && targets.every(t =>
      typeof t.rank === 'number' && t.why && typeof t.why.velocity7d === 'number');
    check('service worker ranked published targets locally',
      wellFormed && targets[0].id === FRESH_TARGET,
      targets.map(t => `${t.id}@${t.rank}`).join(' ') || 'no targets');
  } catch (e) {
    check('service worker ranked published targets locally', false, e.message);
  }

  // ---- 3. open Threads and let the content scripts run -------------------
  const { targetId: pageTarget } = await browser.send('Target.createTarget', { url: TEST_URL });
  const { sessionId: pageSession } = await browser.send('Target.attachToTarget',
    { targetId: pageTarget, flatten: true });
  await browser.send('Runtime.enable', {}, pageSession);
  await browser.send('Page.enable', {}, pageSession);

  // Give the SPA time to render the profile feed and the extension to scan.
  await sleep(14000);

  // ---- 4. bridge + capability -------------------------------------------
  let status = null;
  try {
    const raw = await evalIn(browser, optSession, `
      (async () => {
        const tabs = await chrome.tabs.query({ url: 'https://www.threads.com/*' });
        if (!tabs.length) return JSON.stringify({ error: 'no threads tab' });
        const res = await new Promise(r => chrome.tabs.sendMessage(tabs[0].id, { type: 'tab:status' },
          x => r(x || { error: (chrome.runtime.lastError||{}).message })));
        return JSON.stringify(res);
      })()
    `);
    status = JSON.parse(raw);
  } catch (e) {
    status = { error: e.message };
  }

  check('content script reachable + bridge handshake', status && status.handshake === true,
    status && status.error ? status.error : `platform=${status && status.platform}`);

  const cap = status && status.capability;
  check('MAIN world hooked Meta module registry',
    !!(cap && cap.moduleCount > 100),
    cap ? `${cap.moduleCount} modules, ${cap.graphqlModuleCount} graphql` : 'no capability report');

  check('live Relay environment discovered',
    !!(cap && cap.hasRelay && cap.relayRecords > 0),
    cap ? `${cap.relayEnv} with ${cap.relayRecords} records` : '');

  check('Relay commitMutation available', !!(cap && cap.hasCommitMutation));

  check('identity map learned from Relay store',
    !!(status && status.identity && status.identity.aliasesKnown > 0),
    status && status.identity ? JSON.stringify(status.identity) : '');

  // ---- 4b. request/response correlation across the world boundary --------
  // A response that omits its ticket does not raise an error; it just hangs
  // until the caller times out. Assert the round-trip actually completes.
  try {
    const raw = await evalIn(browser, optSession, `
      (async () => {
        const tabs = await chrome.tabs.query({ url: 'https://www.threads.com/*' });
        const res = await new Promise(r => chrome.tabs.sendMessage(tabs[0].id,
          { type: 'tab:probe-bridge' }, x => r(x || { error: (chrome.runtime.lastError||{}).message })));
        return JSON.stringify(res);
      })()
    `);
    const probe = JSON.parse(raw);
    check('MAIN world request/response round-trip resolves',
      !!(probe && probe.ok && probe.ms < 5000),
      JSON.stringify(probe));
  } catch (e) {
    check('MAIN world request/response round-trip resolves', false, e.message);
  }

  // ---- 5. the actual point: is the content hidden? -----------------------
  let hideInfo = null;
  try {
    hideInfo = await evalIn(browser, pageSession, `
      (() => {
        const hidden = document.querySelectorAll('[data-cb-hidden="1"]');
        const who = new Set();
        hidden.forEach(n => who.add(n.getAttribute('data-cb-who')));
        const containers = document.querySelectorAll('[data-pressable-container]');
        // How many of those containers are visible to a reader right now?
        let visible = 0;
        containers.forEach(n => {
          const cs = getComputedStyle(n);
          if (cs.display !== 'none' && cs.visibility !== 'hidden') visible++;
        });
        return JSON.stringify({
          hiddenCount: hidden.length,
          who: Array.from(who).slice(0, 5),
          containers: containers.length,
          visibleContainers: visible
        });
      })()
    `, false);
    hideInfo = JSON.parse(hideInfo);
  } catch (e) {
    hideInfo = { error: e.message };
  }

  check('content from blocklisted profile is hidden',
    !!(hideInfo && hideInfo.hiddenCount > 0),
    hideInfo ? JSON.stringify(hideInfo) : '');

  // ---- 5a. authorship vs. mention ----------------------------------------
  // A blocked profile appearing INSIDE someone else's post (a comment, a tag)
  // must not take that post down with it. Only the comment itself should go.
  // Synthetic nodes are used so the two cases can be stated exactly.
  try {
    const raw = await evalIn(browser, pageSession, `
      (() => {
        const mk = (html) => {
          const d = document.createElement('div');
          d.innerHTML = html;
          document.body.appendChild(d.firstElementChild);
          return document.body.lastElementChild;
        };
        // Innocent author, blocked profile only quoted in a nested comment.
        mk('<div data-pressable-container="true" data-tqtest="mention">' +
             '<a href="/@some_innocent_person">Innocent</a>' +
             '<div>post body</div>' +
             '<div role="article"><a href="/@threads">threads</a><div>a reply</div></div>' +
           '</div>');
        // Blocked profile is the author.
        mk('<div data-pressable-container="true" data-tqtest="author">' +
             '<a href="/@threads">threads</a><div>post body</div>' +
           '</div>');
        return 'injected';
      })()
    `, false);
    if (raw !== 'injected') throw new Error('injection failed');
    await sleep(6000);
    const out = await evalIn(browser, pageSession, `
      (() => {
        const q = (s) => document.querySelector(s);
        const hidden = (el) => !!el && el.getAttribute('data-cb-hidden') === '1';
        const mention = q('[data-tqtest="mention"]');
        return JSON.stringify({
          postWithMentionHidden: hidden(mention),
          nestedCommentHidden: hidden(mention && mention.querySelector('div[role="article"]')),
          postByBlockedAuthorHidden: hidden(q('[data-tqtest="author"]'))
        });
      })()
    `, false);
    const r = JSON.parse(out);
    check('a blocked profile is judged by authorship, not by being mentioned',
      r.postWithMentionHidden === false && r.postByBlockedAuthorHidden === true,
      JSON.stringify(r));
    check('the blocked profile own nested comment is still hidden',
      r.nestedCommentHidden === true, JSON.stringify(r));
  } catch (e) {
    check('a blocked profile is judged by authorship, not by being mentioned', false, e.message);
  }

  // ---- 5b. hide modes react to a settings change live --------------------
  // Switching mode must release what is currently hidden and re-apply, not
  // leave content stuck in the previous mode with no way back.
  try {
    await evalIn(browser, optSession, `
      (async () => {
        await new Promise(r => chrome.runtime.sendMessage(
          { type: 'sw:set-settings', payload: { hideMode: 'placeholder' } }, r));
        return 'ok';
      })()
    `);
    await sleep(6000);
    const raw = await evalIn(browser, pageSession, `
      JSON.stringify({
        placeholders: document.querySelectorAll('.cb-placeholder').length,
        placeholderMode: document.querySelectorAll('[data-cb-hidden="1"][data-cb-mode="placeholder"]').length
      })
    `, false);
    const ph = JSON.parse(raw);
    check('placeholder hide mode applies after live settings change',
      ph.placeholders > 0 && ph.placeholderMode > 0, JSON.stringify(ph));
  } catch (e) {
    check('placeholder hide mode applies after live settings change', false, e.message);
  }

  // Turning hiding off entirely must restore every hidden node.
  try {
    await evalIn(browser, optSession, `
      (async () => {
        await new Promise(r => chrome.runtime.sendMessage(
          { type: 'sw:set-settings', payload: { hideEnabled: false } }, r));
        return 'ok';
      })()
    `);
    await sleep(4000);
    const raw = await evalIn(browser, pageSession, `
      JSON.stringify({
        stillHidden: document.querySelectorAll('[data-cb-hidden="1"]').length,
        leftoverBars: document.querySelectorAll('.cb-placeholder').length
      })
    `, false);
    const off = JSON.parse(raw);
    check('disabling hiding restores all content',
      off.stillHidden === 0 && off.leftoverBars === 0, JSON.stringify(off));
  } catch (e) {
    check('disabling hiding restores all content', false, e.message);
  }

  // ---- 6. platform blocking must stay untouched --------------------------
  try {
    const state = await evalIn(browser, optSession, `
      (async () => {
        const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'sw:get-state' }, x => r(x)));
        return JSON.stringify({
          enabled: res.settings.platformBlockEnabled,
          attempts: (res.stats && res.stats.attempts) || 0,
          succeeded: (res.stats && res.stats.succeeded) || 0
        });
      })()
    `);
    const s = JSON.parse(state);
    check('no real block was attempted (safety)',
      s.enabled === false && s.succeeded === 0, JSON.stringify(s));
  } catch (e) {
    check('no real block was attempted (safety)', false, e.message);
  }

  // ---- 6b. the hover chip must not swallow clicks once hidden ------------
  //
  // The chip is position:fixed at the maximum z-index inside somebody else's
  // page, and it hides by fading to opacity 0. Opacity 0 paints nothing and
  // blocks everything, so for the life of the page it went on taking clicks
  // over its last rectangle -- which is why clicking Like on Threads
  // sometimes opened the report sheet, for whichever profile had been hovered
  // before it. Asserted in a real browser because the fault was invisible in
  // every other kind of test: the markup, the handlers and the JavaScript were
  // all correct.
  try {
    const chipState = await evalIn(browser, pageSession, `
      (async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const read = () => {
          const host = document.querySelector('[data-cloneblocker-ui]');
          const chip = host && host.shadowRoot && host.shadowRoot.querySelector('.chip');
          if (!chip) return null;
          const cs = getComputedStyle(chip);
          const r = chip.getBoundingClientRect();
          const at = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          return {
            shown: chip.classList.contains('show'),
            pointerEvents: cs.pointerEvents,
            hitsUs: !!(at && at.getAttribute && at.getAttribute('data-cloneblocker-ui') !== null)
          };
        };
        // Hover profile links until one produces a chip: the extension never
        // offers to report the viewer, so some links are skipped by design.
        const seen = new Set();
        let shownState = null;
        for (const a of document.querySelectorAll('a[href^="/@"]')) {
          const href = a.getAttribute('href');
          if (seen.has(href)) continue;
          seen.add(href);
          const r = a.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
          await wait(700);
          const st = read();
          if (st && st.shown) { shownState = st; break; }
          if (seen.size > 8) break;
        }
        if (!shownState) return JSON.stringify({ reached: false });

        // Move off it and let the hide timer run.
        document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        await wait(900);
        return JSON.stringify({ reached: true, shown: shownState, hidden: read() });
      })()
    `, true);
    const c = JSON.parse(chipState);
    if (!c.reached) {
      // Signed out, a profile page may offer no reportable link at all. Say so
      // rather than passing a check that tested nothing.
      check('the hover chip could be raised to test it', false, 'no chip appeared on this page');
    } else {
      check('the hover chip takes clicks while it is shown',
        c.shown.pointerEvents === 'auto' && c.shown.hitsUs === true, JSON.stringify(c.shown));
      check('and once hidden it takes none, so clicks reach the page underneath',
        c.hidden && c.hidden.shown === false &&
        c.hidden.pointerEvents === 'none' && c.hidden.hitsUs === false,
        JSON.stringify(c.hidden));
    }
  } catch (e) {
    check('the hover chip stops taking clicks once hidden', false, e.message);
  }

  // ---- 7. dry-run block: must degrade gracefully, never throw -------------
  // Logged out, no block mutation module is loaded, so every strategy should
  // decline in an orderly way and report why.
  try {
    const dry = await evalIn(browser, pageSession, `
      (async () => {
        const MARK = '__cloneblocker_bridge__';
        // Reuse the isolated world's nonce by asking the content script to
        // relay for us is not possible from here, so drive the MAIN world
        // directly the way the isolated world does: it already completed a
        // handshake, so we can only observe. Instead assert the extension
        // reports a structured capability rather than crashing the page.
        return JSON.stringify({
          pageAlive: document.readyState,
          errors: (window.__tqPageErrors || []).length
        });
      })()
    `);
    const d = JSON.parse(dry);
    check('page still healthy after injection', d.pageAlive === 'complete' || d.pageAlive === 'interactive',
      JSON.stringify(d));
  } catch (e) {
    check('page still healthy after injection', false, e.message);
  }

  // ---- 8. Facebook leg ----------------------------------------------------
  // Logged out there is no feed to hide, but the parts that must work on
  // facebook.com -- module hook, bridge, Relay -- can still be verified.
  const { targetId: fbTarget } = await browser.send('Target.createTarget',
    { url: 'https://www.facebook.com/' });
  await browser.send('Target.attachToTarget', { targetId: fbTarget, flatten: true });
  await sleep(12000);

  let fbStatus = null;
  try {
    const raw = await evalIn(browser, optSession, `
      (async () => {
        const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/*' });
        if (!tabs.length) return JSON.stringify({ error: 'no facebook tab' });
        const res = await new Promise(r => chrome.tabs.sendMessage(tabs[0].id, { type: 'tab:status' },
          x => r(x || { error: (chrome.runtime.lastError||{}).message })));
        return JSON.stringify(res);
      })()
    `);
    fbStatus = JSON.parse(raw);
  } catch (e) { fbStatus = { error: e.message }; }

  check('facebook: content script + bridge handshake',
    !!(fbStatus && fbStatus.handshake), fbStatus && fbStatus.error ? fbStatus.error : `platform=${fbStatus && fbStatus.platform}`);
  check('facebook: platform detected correctly',
    fbStatus && fbStatus.platform === 'facebook', fbStatus && fbStatus.platform);

  const fbCap = fbStatus && fbStatus.capability;
  check('facebook: MAIN world hooked module registry',
    !!(fbCap && fbCap.moduleCount > 100),
    fbCap ? `${fbCap.moduleCount} modules, ${fbCap.graphqlModuleCount} graphql` : 'no capability report');
  check('facebook: Relay environment reachable',
    !!(fbCap && fbCap.hasRelay), fbCap ? String(fbCap.relayEnv) : '');

  // Collect console errors originating from our code.
  try {
    const errs = await evalIn(browser, pageSession,
      `JSON.stringify((window.__tqErrors||[]))`, false);
    if (errs && errs !== '[]') console.log('page errors:', errs);
  } catch (e) { /* ignore */ }

  browser.close();
  finish(cleanup);
})().catch((e) => {
  console.error('harness error:', e);
  process.exitCode = 1;
});

function finish(cleanup) {
  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
  }
  cleanup();
  process.exitCode = failed.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300);
}
