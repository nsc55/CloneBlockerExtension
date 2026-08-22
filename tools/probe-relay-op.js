/**
 * Read-only: is the site's block operation node reachable via require(), and
 * under what conditions?
 *
 *   node tools/probe-relay-op.js            # probe the page as it stands
 *   node tools/probe-relay-op.js --reload   # reload first, then probe cold
 *
 * This determines whether the extension can drive the platform's own Relay code
 * on an ordinary page, or only after the block UI has been opened once -- which
 * is the difference between a background blocker that works and one that needs
 * the user to prime it.
 */
const CDP_PORT = 9333;
const RELOAD = process.argv.includes('--reload');
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

const PROBE = `
  (() => {
    const req = (n) => { try { const m = window.require(n); return m && m.__esModule && m.default !== undefined ? m.default : m; } catch (e) { return null; } };
    const names = [
      'useTHUserBlockMutation.graphql',
      'useTHUserBlockMutation.threads.graphql',
      'useTHUserUnblockMutation.graphql',
      'ProfileCometActionBlockUserMutation.graphql'
    ];
    const out = { resolved: {}, missing: [] };
    for (const n of names) {
      const r = req(n);
      if (r && r.params) out.resolved[n] = { doc_id: r.params.id, op: r.params.name, kind: r.params.operationKind };
      else out.missing.push(n);
    }
    const RM = req('RelayModern');
    out.commitMutation = typeof (RM && RM.commitMutation);
    const envs = {};
    for (const n of ['BarcelonaRelayEnvironment','CometRelayEnvironment']) {
      const e = req(n);
      if (e && typeof e.getStore === 'function') {
        try { envs[n] = e.getStore().getSource().getRecordIDs().length; } catch (err) { envs[n] = 'err'; }
      }
    }
    out.envRecords = envs;
    // Can Meta's own loader pull the module on demand?
    const BL = req('Bootloader');
    out.bootloader = BL ? Object.keys(BL).filter(k => /load/i.test(k)) : null;
    return JSON.stringify(out, null, 2);
  })()`;

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)|facebook\.com/.test(t.url));
  if (!page) { console.error('no supported page'); process.exit(1); }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  if (RELOAD) {
    console.log('reloading for a cold probe...');
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(12000);
  }
  console.log('page: ' + page.url.slice(0, 80) + (RELOAD ? '  (cold)' : '  (as-is)'));

  const r = await cdp.send('Runtime.evaluate',
    { expression: PROBE, returnByValue: true }, sessionId);
  console.log(r.result && r.result.value);
  if (r.exceptionDetails) console.log('EXC ' + r.exceptionDetails.text);
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
