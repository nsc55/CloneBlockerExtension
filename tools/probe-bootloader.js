/**
 * Read-only: can Meta's own module loader be asked to fetch the block module on
 * demand, so the extension never has to prime it through the UI?
 *
 *   node tools/probe-bootloader.js
 *
 * Loads code only. Nothing is executed against the account.
 */
const CDP_PORT = 9333;
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
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 60000);
    });
  }
}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)/.test(t.url));
  if (!page) { console.error('no Threads page'); process.exit(1); }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);

  const r = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        const req = (n) => { try { const m = window.require(n); return m && m.__esModule && m.default !== undefined ? m.default : m; } catch (e) { return null; } };
        const NAME = 'useTHUserBlockMutation.graphql';
        const out = { before: !!req(NAME) };

        const BL = req('Bootloader');
        if (!BL || typeof BL.loadModules !== 'function') { out.error = 'no Bootloader.loadModules'; return JSON.stringify(out); }

        // Ask Meta's own loader for the module by name.
        out.loadModules = await new Promise((resolve) => {
          let done = false;
          const finish = (v) => { if (!done) { done = true; resolve(v); } };
          setTimeout(() => finish('timeout'), 12000);
          try {
            BL.loadModules([NAME], function () { finish('callback fired'); }, 'cloneblocker');
          } catch (e) { finish('threw: ' + (e && e.message)); }
        });
        out.afterLoadModules = !!req(NAME);

        // Some builds expose a resource-map based path instead.
        if (!out.afterLoadModules && typeof BL.loadResources === 'function') {
          out.loadResourcesTried = true;
        }

        // requireLazy is the other public entry point.
        if (!out.afterLoadModules && typeof window.requireLazy === 'function') {
          out.requireLazy = await new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            setTimeout(() => finish('timeout'), 12000);
            try { window.requireLazy([NAME], function () { finish('callback fired'); }); }
            catch (e) { finish('threw: ' + (e && e.message)); }
          });
          out.afterRequireLazy = !!req(NAME);
        }

        const node = req(NAME);
        if (node && node.params) out.params = { doc_id: node.params.id, op: node.params.name };
        return JSON.stringify(out, null, 2);
      })()
    `, awaitPromise: true, returnByValue: true
  }, sessionId);

  console.log(r.result && r.result.value);
  if (r.exceptionDetails) console.log('EXC ' + r.exceptionDetails.text);
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
