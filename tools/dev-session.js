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

// The hands-on session runs against PRODUCTION Firebase -- there is nothing
// local left to run. The automated tests still use the emulator, because a
// test must never write junk into the real project; this session only READS
// the published list (and files reports if you use the sheet), which is
// exactly what a real install does.
const PROJECT = 'cloneblocker';
const LIST_URL = 'https://cloneblocker.tree55.com/blocklist.json';

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

  // Nothing to start: the list is the production document, published by the
  // dashboard. Just confirm it answers before wiring the extension to it.
  try {
    const r = await fetch(LIST_URL);
    if (!r.ok) console.warn('production list answered HTTP ' + r.status + ' -- continuing anyway');
  } catch (e) {
    console.warn('production list unreachable (' + e.message + ') -- continuing anyway');
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
    JSON.stringify({ extId, cdpPort: CDP_PORT, listUrl: LIST_URL }, null, 2));

  // -- configure it through its own options page ---------------------------
  const optionsUrl = `chrome-extension://${extId}/src/options/options.html`;
  const { targetId } = await cdp.send('Target.createTarget', { url: optionsUrl });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(1500);

  // The blocklist host lives in optional_host_permissions, so it has to be
  // granted before the service worker is allowed to fetch it. chrome.permissions
  // .request needs a user gesture, which Runtime.evaluate can synthesise.
  //
  // The request can also simply never settle -- it is answered by a native
  // Chrome bubble, and one already on screen from an earlier run leaves the
  // promise pending forever. Awaiting it directly means a 20s CDP timeout takes
  // down the whole launcher, abandoning a browser that is already up with an
  // orphan options tab. So: ask what we hold first, and cap the request in the
  // page rather than letting it decide whether the session gets configured.
  const perm = await evalIn(cdp, sessionId, `
    (async () => {
      const origins = ['https://cloneblocker.tree55.com/*'];
      if (await chrome.permissions.contains({ origins })) {
        return JSON.stringify({ granted: true, has: true, asked: false });
      }
      let granted = false;
      try {
        granted = await Promise.race([
          chrome.permissions.request({ origins }),
          new Promise(r => setTimeout(() => r('pending'), 10000))
        ]);
      } catch (e) { granted = 'error: ' + e.message; }
      return JSON.stringify({ granted, has: await chrome.permissions.contains({ origins }), asked: true });
    })()
  `);

  const applied = await evalIn(cdp, sessionId, `
    (async () => {
      await chrome.storage.sync.set({ settings: {
        // refreshMinutes is deliberately not pinned here: this session should
        // poll the way a real install does, and pinning it meant the shipped
        // default could change without this ever noticing.
        listUrl: '${LIST_URL}',
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
  console.log('  blocklist    : ' + LIST_URL);
  console.log('  host access  : ' + perm);
  console.log('  loaded       : ' + (parsed.ok
    ? `${parsed.blocklist.ids.length} ids, ${parsed.blocklist.usernames.length} usernames`
    : 'FAILED - ' + parsed.error));
  console.log('  layer 2      : DISABLED (dry run on) - nothing can be blocked for real');
  console.log('');
  console.log('  Chrome is running detached and will stay up after this exits.');
  console.log('  Sign in, then run: node tools/inspect-session.js');
  console.log('');

  // Leave the browser running.
  setTimeout(() => process.exit(0), 250);
})().catch((e) => { console.error(e); process.exit(1); });
