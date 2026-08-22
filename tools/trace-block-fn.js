/**
 * Traces the site's own block code path.
 *
 *   node tools/trace-block-fn.js
 *
 * Opens the profile overflow menu and the Block confirmation dialog (WITHOUT
 * confirming), which is what makes Meta load the lazily-bundled block module.
 * Then reports, from the page's own module registry:
 *
 *   - which modules registered while that happened
 *   - whether the Relay operation node is requireable, and its LIVE doc_id
 *   - which module depends on it (i.e. the hook that performs the block)
 *   - whether commitMutation can be driven with it
 *
 * Nothing is confirmed and nothing is sent.
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
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 45000);
    });
  }
}

async function ev(cdp, sessionId, expr) {
  const r = await cdp.send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
                    r.exceptionDetails.text);
  }
  return r.result && r.result.value;
}

async function click(cdp, sessionId, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  }
}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)|facebook\.com/.test(t.url));
  if (!page) { console.error('no supported page open'); process.exit(1); }
  console.log('page: ' + page.url.slice(0, 90));

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  // Install our own __d recorder that ALSO keeps the dependency list, so we can
  // work out which module consumes the mutation node. Done via addScriptToEvaluateOnNewDocument
  // so it is in place before the page's bootstrap runs.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const mods = {};            // name -> deps
      window.__TRACE__ = mods;
      let real;
      Object.defineProperty(window, '__d', {
        configurable: true,
        get() { return real ? wrapped : undefined; },
        set(v) { real = v; }
      });
      function wrapped(name, deps, factory) {
        try { mods[name] = Array.isArray(deps) ? deps.slice(0, 60) : []; } catch (e) {}
        return real.apply(this, arguments);
      }
    })();`
  }, sessionId);

  await cdp.send('Page.reload', {}, sessionId);
  await sleep(11000);

  const before = await ev(cdp, sessionId, `Object.keys(window.__TRACE__ || {}).length`);
  console.log('modules registered on load: ' + before);

  // Open the profile overflow menu.
  const btn = await ev(cdp, sessionId, `
    (() => {
      const c = [];
      document.querySelectorAll('[role="button"],button,[aria-haspopup]').forEach(el => {
        const svg = el.querySelector && el.querySelector('svg[aria-label]');
        const label = (el.getAttribute('aria-label') || (svg && svg.getAttribute('aria-label')) || '').trim();
        if (!/^(more|options)$/i.test(label)) return;
        const b = el.getBoundingClientRect();
        if (b.width < 2 || b.y < 100) return;
        c.push({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) });
      });
      c.sort((a, b) => b.x - a.x);
      return c.length ? JSON.stringify(c[0]) : null;
    })()`);
  if (!btn) { console.error('no profile More button'); process.exit(1); }
  const p1 = JSON.parse(btn);
  await click(cdp, sessionId, p1.x, p1.y);
  await sleep(4000);
  console.log('menu opened');

  // Click Block to raise the confirmation dialog -- but never confirm it.
  const blockItem = await ev(cdp, sessionId, `
    (() => {
      for (const el of document.querySelectorAll('[role="menuitem"],[role="button"]')) {
        if (!/^(Block|Unblock)$/i.test((el.textContent || '').trim())) continue;
        const b = el.getBoundingClientRect();
        if (b.width < 2) continue;
        return JSON.stringify({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2),
                                label: (el.textContent||'').trim() });
      }
      return null;
    })()`);
  if (blockItem) {
    const p2 = JSON.parse(blockItem);
    console.log('opening the "' + p2.label + '" dialog (will NOT confirm)');
    await click(cdp, sessionId, p2.x, p2.y);
    await sleep(4500);
  }

  const after = await ev(cdp, sessionId, `Object.keys(window.__TRACE__ || {}).length`);
  console.log('modules registered now: ' + after + '  (+' + (after - before) + ')');

  // Close the dialog without acting on it.
  for (const t of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent',
      { type: t, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  }

  const report = await ev(cdp, sessionId, `
    (() => {
      const mods = window.__TRACE__ || {};
      const out = {};
      const names = Object.keys(mods);

      out.blockish = names.filter(n => /block/i.test(n)).sort();

      // Which modules DEPEND on a block mutation node? That dependant is the
      // hook that actually performs the block.
      const opNodes = names.filter(n => /block/i.test(n) && /\\.graphql$/.test(n) );
      out.opNodes = opNodes;
      out.dependents = {};
      for (const op of opNodes) {
        const deps = names.filter(n => (mods[n] || []).includes(op));
        if (deps.length) out.dependents[op] = deps;
      }

      const req = (n) => { try { const m = window.require(n); return m && m.__esModule && m.default !== undefined ? m.default : m; } catch (e) { return null; } };

      // Can we require the operation node directly, and does it carry a doc_id?
      out.resolved = {};
      for (const n of ['useTHUserBlockMutation.graphql', 'useTHUserBlockMutation.threads.graphql',
                       'useTHUserUnblockMutation.graphql'].concat(opNodes)) {
        const m = req(n);
        const r = m && (m.default || m);
        if (r && r.params) out.resolved[n] = { doc_id: r.params.id, op: r.params.name, kind: r.params.operationKind };
        else if (r) out.resolved[n] = { keys: Object.keys(r).slice(0, 6) };
      }

      // Is Relay's commit machinery reachable?
      const RM = req('RelayModern');
      out.relay = {
        commitMutation: typeof (RM && RM.commitMutation),
        env: ['BarcelonaRelayEnvironment','CometRelayEnvironment'].filter(n => {
          const e = req(n); return e && typeof e.getStore === 'function';
        })
      };

      // The hook module itself, if present.
      out.hookModules = names.filter(n => /useTH.*Block|useBarcelona.*Block/i.test(n));
      return JSON.stringify(out, null, 2);
    })()`);

  console.log('\n' + report);
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message); process.exit(1); });
