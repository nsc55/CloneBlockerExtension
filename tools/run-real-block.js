/**
 * Executes ONE real platform block through the extension's normal pipeline,
 * then immediately disables blocking again.
 *
 *   node tools/run-real-block.js 9100000001
 *
 * This is the only script in the project that causes a real account mutation.
 * Guard rails, in order:
 *   - the extension is pointed at a ONE-ROW list served by this script -- a
 *     chunked tree holding exactly the id passed in, on a loopback port -- so
 *     the worker cannot reach any other profile;
 *   - the queue, done-set, cooldowns and leases are cleared first, so nothing
 *     left over from an earlier run can be picked up;
 *   - blocking is switched off again as soon as one result is reported, whether
 *     it succeeded or failed;
 *   - the list address is put back to what the session had, and refreshed, so
 *     the browser is left reading the real list again.
 *
 * It deliberately drives the real queue/claim/worker path rather than calling
 * the block directly -- the point is to test the pipeline, not just the request.
 *
 * The tree is unsigned: a listUrl ending in /blocklist/v3/manifest.json is the
 * self-hosted chunked shape, and a self-hosted base may serve an unsigned root
 * -- the same exemption a self-hosted whole-file list has always had. Nothing
 * else in the session is touched: the doc_id overrides the real list installed
 * stay in storage, because a root that carries none leaves them alone.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const V3 = require('./lib/v3-fixture.js');
const { startListServer } = require('./e2e-test.js');

const TARGET = String(process.argv[2] || '').trim();
if (!/^\d{5,}$/.test(TARGET)) {
  console.error('usage: node tools/run-real-block.js <numeric-profile-id>');
  process.exit(1);
}

const CDP_PORT = 9333;
const SERVER_PORT = 8790;
const LIST_V3_URL = `http://127.0.0.1:${SERVER_PORT}/blocklist/v3/manifest.json`;
const SESSION_DIR = path.join(os.tmpdir(), 'claude', 'C--src-3queblocker', 'dev-session');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pend = new Map();
    this.ready = new Promise(r => this.ws.addEventListener('open', r));
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
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 45000);
    });
  }
}

async function evalIn(cdp, sessionId, expr) {
  const r = await cdp.send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
                    r.exceptionDetails.text);
  }
  return r.result && r.result.value;
}

(async () => {
  // 1. A list of exactly one target, served from here. One id row on Threads,
  // tagged 'other' so every install's tag filter admits it, no extras.
  const tree = V3.build({
    platforms: { threads: [{ i: TARGET, t: 'other' }], facebook: [] },
    extras: { targets: [], targetsAvailable: 0, manual: { ids: [], usernames: [] } },
    rankWeights: {},
    docIdOverrides: {}
  }, { updatedAt: new Date().toISOString() });
  const list = startListServer({ port: SERVER_PORT, getTree: () => tree, getLegacy: () => null });
  console.log('serving a one-row list for ' + TARGET + ' at ' + LIST_V3_URL);

  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;

  const rec = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'session.json'), 'utf8'));
  const { targetId } = await cdp.send('Target.createTarget',
    { url: `chrome-extension://${rec.extId}/src/options/options.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(1500);

  // 2. Clear any prior queue state, point the extension at the one-row list,
  // refresh, arm blocking. The list address the session had is remembered so
  // step 5 can put it back.
  const armed = await evalIn(cdp, sessionId, `
    (async () => {
      await chrome.storage.local.remove(['platformQueue','platformDone','stats','leases','cooldowns','failures']);
      const s = (await chrome.storage.sync.get('settings')).settings || {};
      const hadListUrl = ('listUrl' in s) ? s.listUrl : null;
      s.listUrl = '${LIST_V3_URL}';
      s.platformBlockEnabled = true;
      s.platformBlockDryRun = false;
      s.minDelayMs = 20000; s.maxDelayMs = 45000;
      s.maxBlocksPerHour = 5; s.maxBlocksPerDay = 5;
      await chrome.storage.sync.set({ settings: s });
      const r = await new Promise(x => chrome.runtime.sendMessage({ type: 'sw:refresh-now' }, x));
      return JSON.stringify({ refresh: r && r.ok, error: r && r.error, hadListUrl,
        counts: r && r.blocklist && r.blocklist.counts, format: r && r.blocklist && r.blocklist.format });
    })()
  `);
  console.log('armed: ' + armed);
  const armedRec = JSON.parse(armed);
  if (!armedRec.refresh || !armedRec.counts || armedRec.counts.ids !== 1) {
    console.error('the one-row list did not load; not arming a block against an unknown list');
    list.close();
    await cdp.send('Target.closeTarget', { targetId });
    process.exit(1);
  }

  // 3. Start the worker.
  //
  // --no-reload matters when the Relay path is in play: the site's block module
  // is lazily loaded and a reload discards it, so reloading here would destroy
  // the very thing under test. The content script's storage.onChanged listener
  // starts the worker without needing a reload.
  if (process.argv.includes('--no-reload')) {
    console.log('not reloading (preserving any lazily-loaded page modules)');
  } else {
    await evalIn(cdp, sessionId, `
      (async () => {
        const tabs = await chrome.tabs.query({ url: ['https://*.threads.com/*','https://*.threads.net/*'] });
        for (const t of tabs) chrome.tabs.reload(t.id);
        return 1;
      })()
    `);
    console.log('tab reloaded');
  }
  console.log('worker settles for ~8s then claims one target');

  // 4. Wait for exactly one reported result.
  let final = null;
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const raw = await evalIn(cdp, sessionId, `
      new Promise(r => chrome.runtime.sendMessage({ type: 'sw:get-state' },
        x => r(JSON.stringify({ stats: x && x.stats, queue: x && x.queue, done: x && x.done }))))
    `);
    const st = JSON.parse(raw);
    const s = st.stats || {};
    const attempts = s.attempts || 0;
    process.stdout.write(`  t+${(i + 1) * 5}s attempts=${attempts} ok=${s.succeeded || 0} fail=${s.failed || 0}\r`);
    if (attempts > 0) { final = st; break; }
  }
  console.log('');

  // 5. Disarm immediately, whatever happened -- and put the list back. The
  // address the session had is restored (or removed, which is the shipped
  // default) and refreshed, so the browser is left reading the real list and
  // the one-row tree is gone from it before this script's server is.
  const disarmed = await evalIn(cdp, sessionId, `
    (async () => {
      const s = (await chrome.storage.sync.get('settings')).settings || {};
      s.platformBlockEnabled = false;
      s.platformBlockDryRun = true;
      const had = ${JSON.stringify(armedRec.hadListUrl)};
      if (had === null) delete s.listUrl; else s.listUrl = had;
      await chrome.storage.sync.set({ settings: s });
      const r = await new Promise(x => chrome.runtime.sendMessage({ type: 'sw:refresh-now' }, x));
      return 'layer 2 disabled; list restored (' + (r && r.ok
        ? (r.blocklist.counts.ids + ' ids, ' + r.blocklist.counts.usernames + ' usernames')
        : 'refresh failed: ' + (r && r.error)) + ')';
    })()
  `);
  console.log(disarmed);
  list.close();

  console.log('\nresult:');
  console.log(JSON.stringify(final, null, 2));

  await cdp.send('Target.closeTarget', { targetId });
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message); process.exit(1); });
