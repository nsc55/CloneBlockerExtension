/**
 * Polls the dev-session browser until a supported tab reports a signed-in
 * viewer id, then exits. Read-only.
 *
 *   node tools/wait-for-login.js [--timeout 300]
 */
const CDP_PORT = 9333;
const TIMEOUT_S = parseInt(process.argv.includes('--timeout')
  ? process.argv[process.argv.indexOf('--timeout') + 1] : '240', 10);

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Resolve the extension id.
 *
 * Preferring the file written by dev-session.js matters: MV3 service workers
 * shut down when idle, so looking for a service_worker target finds nothing
 * most of the time even though the extension is installed and fine.
 */
async function resolveExtId(cdp) {
  const f = path.join(os.tmpdir(), 'claude', 'C--src-3queblocker', 'dev-session', 'session.json');
  try {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (rec && rec.extId) return rec.extId;
  } catch (e) { /* fall through */ }
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find(t => t.type === 'service_worker' &&
                                   t.url.includes('src/background/service-worker.js'));
  return sw ? new URL(sw.url).host : null;
}

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
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result && r.result.value;
}

(async () => {
  const version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  const extId = await resolveExtId(cdp);
  if (!extId) { console.log('extension not found; run: node tools/dev-session.js'); process.exit(1); }

  const { targetId } = await cdp.send('Target.createTarget',
    { url: `chrome-extension://${extId}/src/options/options.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(1000);

  const deadline = Date.now() + TIMEOUT_S * 1000;
  let last = '';
  while (Date.now() < deadline) {
    let report = null;
    try {
      const raw = await evalIn(cdp, sessionId, `
        (async () => {
          const tabs = await chrome.tabs.query({
            url: ['https://*.threads.com/*','https://*.threads.net/*','https://*.facebook.com/*'] });
          const out = [];
          for (const t of tabs) {
            const st = await new Promise(r => chrome.tabs.sendMessage(t.id, { type: 'tab:status' },
              x => r(x || { error: (chrome.runtime.lastError||{}).message })));
            out.push({ id: t.id, url: t.url, viewerId: st && st.viewerId,
                       handshake: st && st.handshake, err: st && st.error });
          }
          return JSON.stringify(out);
        })()
      `);
      report = JSON.parse(raw);
    } catch (e) { /* transient during navigation */ }

    if (report && report.length) {
      const signedIn = report.find(r => r.viewerId);
      const summary = report.map(r =>
        `${r.url.replace(/^https?:\/\//, '').slice(0, 42)} -> ` +
        (r.err ? 'no content script' : (r.viewerId ? 'signed in as ' + r.viewerId : 'signed out'))
      ).join(' | ');
      if (summary !== last) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + summary); last = summary; }
      if (signedIn) {
        console.log('\nSIGNED IN  viewerId=' + signedIn.viewerId);
        console.log('tab: ' + signedIn.url);
        await cdp.send('Target.closeTarget', { targetId });
        setTimeout(() => process.exit(0), 150);
        return;
      }
    }
    await sleep(6000);
  }

  console.log('\nstill not signed in after ' + TIMEOUT_S + 's');
  await cdp.send('Target.closeTarget', { targetId });
  setTimeout(() => process.exit(2), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
