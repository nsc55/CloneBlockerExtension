/**
 * Launches a long-lived Chrome with the extension loaded, for hands-on testing
 * against a signed-in account.
 *
 * Unlike e2e-test.js this leaves the browser RUNNING after the script exits:
 * Chrome is spawned detached, so you can sign in, browse, and have the session
 * inspected later with tools/inspect-session.js over the same debugging port.
 *
 * The profile directory is stable, so a login survives restarting this script.
 *
 *   node tools/dev-session.js [--port 9333] [--fresh]
 *
 * SAFETY: platform blocking is written as DISABLED with dry-run ON. Nothing in
 * this session can block anyone until that is deliberately changed.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CDP_PORT = parseInt(argOf('port', '9333'), 10);
const FRESH = args.includes('--fresh');

const ROOT = path.join(__dirname, '..');
// The slug mirrors the workspace folder (C:/src/3queblocker), not the brand --
// the long-lived Chrome profile with its signed-in sessions lives under it.
const SESSION_DIR = path.join(os.tmpdir(), 'claude', 'C--src-3queblocker', 'dev-session');
const PROFILE = path.join(SESSION_DIR, 'chrome-profile');

// The hands-on session runs against PRODUCTION: the shipped default, which is
// the chunked list under the GitHub mirror with the other mirrors, the relay
// and the origin behind it -- there is nothing local left to run. The
// automated tests serve trees of their own, because a test must never read
// or write anything real; this session only READS the published list (and
// files reports if you use the sheet), which is exactly what a real install
// does. So no listUrl is written: the session polls whatever address the
// build ships with, and a change to that default is exercised here rather
// than hidden behind a pin. protocol.js is loaded for the address, so the
// pre-flight below asks the same root the worker will.
require(path.join(ROOT, 'src', 'common', 'protocol.js'));
const ROOT_URL = globalThis.CB_LIST_V3_BASE + 'manifest.json';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) {
        const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
  }
  send(method, params, sessionId) {
    const i = ++this.id;
    const payload = { id: i, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pend.set(i, { res, rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
    });
  }
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
                    r.exceptionDetails.text);
  }
  return r.result && r.result.value;
}

(async () => {
  if (FRESH) { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {} }
  fs.mkdirSync(PROFILE, { recursive: true });

  // Nothing to start: the list is the production tree, published by the
  // backend and mirrored. Just confirm its root answers before launching.
  try {
    const r = await fetch(ROOT_URL, { cache: 'no-cache' });
    if (!r.ok) console.warn('production root answered HTTP ' + r.status + ' -- continuing anyway');
  } catch (e) {
    console.warn('production root unreachable (' + e.message + ') -- continuing anyway');
  }

  // -- is a browser already listening on this port? ------------------------
  let version = null;
  try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); } catch (e) {}

  if (!version) {
    const chrome = spawn(findChrome(), [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--start-maximized',
      'https://www.threads.com/login'
    ], { detached: true, stdio: 'ignore' });
    chrome.unref();

    for (let i = 0; i < 60; i++) {
      try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); break; }
      catch (e) { await sleep(500); }
    }
    if (!version) { console.error('Chrome did not expose its debugging port'); process.exit(1); }
  } else {
    console.log('reusing the browser already on port ' + CDP_PORT);
  }

  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  // -- load (or find) the extension ----------------------------------------
  let extId = null;
  try {
    const r = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    extId = r && r.id;
  } catch (e) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find(t => t.type === 'service_worker' &&
                                     t.url.includes('src/background/service-worker.js'));
    if (sw) extId = new URL(sw.url).host;
    else { console.error('could not load the extension: ' + e.message); process.exit(1); }
  }

  fs.writeFileSync(path.join(SESSION_DIR, 'session.json'),
    JSON.stringify({ extId, cdpPort: CDP_PORT, listRoot: ROOT_URL }, null, 2));

  // -- configure it through its own options page ---------------------------
  const optionsUrl = `chrome-extension://${extId}/src/options/options.html`;
  const { targetId } = await cdp.send('Target.createTarget', { url: optionsUrl });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(1500);

  // Nothing to grant. The manifest has no optional_host_permissions any more:
  // the origin is a required host, and the shipped default -- the GitHub
  // mirror -- is read the way every mirror is, over CORS with no credentials
  // and no permission at all. This only reports what the build holds, so a
  // session whose manifest has drifted says so on the console rather than
  // failing a refresh with no explanation.
  const perm = await evalIn(cdp, sessionId, `
    (async () => JSON.stringify({
      origin: await chrome.permissions.contains({ origins: ['https://cloneblocker.tree55.com/*'] }),
      mirrorNeedsNone: !(await chrome.permissions.contains({ origins: ['https://raw.githubusercontent.com/*'] }))
    }))()
  `);

  const applied = await evalIn(cdp, sessionId, `
    (async () => {
      // The worker's one-time migration may be wiping storage on this very
      // load. Every message through its hub waits for that to finish, so
      // asking for the settings first guarantees ours are written AFTER the
      // wipe rather than being wiped by it -- with blocking silently back on.
      await new Promise(r => chrome.runtime.sendMessage({ type: 'sw:get-settings' }, r));
      await chrome.storage.sync.set({ settings: {
        // Neither refreshMinutes nor listUrl is pinned here: this session
        // should poll the way a real install does, and pinning either meant
        // the shipped default could change without this ever noticing. The
        // object is written whole, so a listUrl an earlier session wrote is
        // gone with it.
        hideEnabled: true,
        hideMode: 'placeholder',
        hideComments: true,
        hideFeedPosts: true,
        platformBlockEnabled: false,
        platformBlockDryRun: true,
        debug: true
      }});
      const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'sw:refresh-now' }, r));
      return JSON.stringify(res);
    })()
  `);
  await cdp.send('Target.closeTarget', { targetId });

  const parsed = JSON.parse(applied);
  console.log('');
  console.log('  extension id : ' + extId);
  console.log('  cdp port     : ' + CDP_PORT);
  console.log('  profile      : ' + PROFILE);
  console.log('  blocklist    : shipped default (' + ROOT_URL + ')');
  console.log('  host access  : ' + perm);
  console.log('  loaded       : ' + (parsed.ok
    ? `${parsed.blocklist.counts.ids} ids, ${parsed.blocklist.counts.usernames} usernames, ` +
      `${parsed.blocklist.format}, ${parsed.blocklist.chunks ? parsed.blocklist.chunks.changed : '?'} chunks changed, ` +
      `generation ${parsed.blocklist.generation}`
    : 'FAILED - ' + parsed.error));
  console.log('  layer 2      : DISABLED (dry run on) - nothing can be blocked for real');
  console.log('');
  console.log('  Chrome is running detached and will stay up after this exits.');
  console.log('  Sign in, then run: node tools/inspect-session.js');
  console.log('');

  // Leave the browser running.
  setTimeout(() => process.exit(0), 250);
})().catch((e) => { console.error(e); process.exit(1); });
