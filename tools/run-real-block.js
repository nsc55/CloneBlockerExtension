/**
 * Executes ONE real platform block through the extension's normal pipeline,
 * then immediately disables blocking again.
 *
 *   node tools/run-real-block.js 9100000001
 *
 * This is the only script in the project that causes a real account mutation.
 * Guard rails, in order:
 *   - the server blocklist is REPLACED with exactly the one id passed in, so the
 *     worker cannot reach any other profile;
 *   - the queue, done-set, cooldowns and leases are cleared first, so nothing
 *     left over from an earlier run can be picked up;
 *   - blocking is switched off again as soon as one result is reported, whether
 *     it succeeded or failed.
 *
 * It deliberately drives the real queue/claim/worker path rather than calling
 * the block directly -- the point is to test the pipeline, not just the request.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TARGET = String(process.argv[2] || '').trim();
if (!/^\d{5,}$/.test(TARGET)) {
  console.error('usage: node tools/run-real-block.js <numeric-profile-id>');
  process.exit(1);
}

const CDP_PORT = 9333;
const SERVER_PORT = 8790;
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
  // 1. Narrow the server list to exactly one target.
  const listFile = path.join(SESSION_DIR, 'server', 'blocklist.json');
  const previous = fs.existsSync(listFile) ? fs.readFileSync(listFile, 'utf8') : null;
  // Keep any docIdOverrides the list already carries -- that is the production
  // mechanism for surviving a Meta persisted-query rotation, and narrowing the
  // target list must not quietly discard it.
  let carriedOverrides = {};
  try { carriedOverrides = (JSON.parse(previous || '{}').docIdOverrides) || {}; } catch (e) {}
  fs.writeFileSync(listFile, JSON.stringify(
    { ids: [TARGET], usernames: [], docIdOverrides: carriedOverrides }, null, 2));
  if (Object.keys(carriedOverrides).length) {
    console.log('carrying doc_id overrides: ' + JSON.stringify(carriedOverrides));
  }
  console.log('blocklist narrowed to a single id: ' + TARGET);

  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;

  const rec = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'session.json'), 'utf8'));
  const { targetId } = await cdp.send('Target.createTarget',
    { url: `chrome-extension://${rec.extId}/src/options/options.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(1500);

  // 2. Clear any prior queue state, reload the list, arm blocking.
  const armed = await evalIn(cdp, sessionId, `
    (async () => {
      await chrome.storage.local.remove(['platformQueue','platformDone','stats','leases','cooldowns','failures']);
      const s = (await chrome.storage.sync.get('settings')).settings || {};
      s.platformBlockEnabled = true;
      s.platformBlockDryRun = false;
      s.minDelayMs = 20000; s.maxDelayMs = 45000;
      s.maxBlocksPerHour = 5; s.maxBlocksPerDay = 5;
      await chrome.storage.sync.set({ settings: s });
      const r = await new Promise(x => chrome.runtime.sendMessage({ type: 'sw:refresh-now' }, x));
      return JSON.stringify({ refresh: r && r.ok, ids: r && r.blocklist && r.blocklist.ids });
    })()
  `);
  console.log('armed: ' + armed);

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

  // 5. Disarm immediately, whatever happened.
  const disarmed = await evalIn(cdp, sessionId, `
    (async () => {
      const s = (await chrome.storage.sync.get('settings')).settings || {};
      s.platformBlockEnabled = false;
      s.platformBlockDryRun = true;
      await chrome.storage.sync.set({ settings: s });
      return 'layer 2 disabled';
    })()
  `);
  console.log(disarmed);

  if (previous !== null) { fs.writeFileSync(listFile, previous); console.log('blocklist restored'); }

  console.log('\nresult:');
  console.log(JSON.stringify(final, null, 2));

  await cdp.send('Target.closeTarget', { targetId });
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message); process.exit(1); });
