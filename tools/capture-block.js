/**
 * Performs a block through the site's own UI while recording every network
 * request, to learn what the platform actually sends.
 *
 *   node tools/capture-block.js @nguyenvana.clone          # block, capture, report
 *   node tools/capture-block.js @nguyenvana.clone --unblock  # reverse it again
 *
 * This DOES perform a real block (or unblock) -- it is driving the same buttons
 * a person would. It exists because both documented REST paths 404 on
 * threads.com, so the real request shape can only be learned by observation.
 *
 * Recording is done with CDP's Network domain rather than the extension's own
 * hook, so the result is independent of whatever URL filter the extension uses
 * -- which is the point, since that filter is one of the things under test.
 */
const fs = require('fs');
const CDP_PORT = 9333;
const HANDLE = (process.argv[2] || '').replace(/^@/, '');
const UNBLOCK = process.argv.includes('--unblock');
if (!HANDLE) { console.error('usage: node tools/capture-block.js @handle [--unblock]'); process.exit(1); }

const WANT = UNBLOCK ? 'unblock' : 'block';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pend = new Map(); this.handlers = [];
    this.ready = new Promise(r => this.ws.addEventListener('open', r));
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) {
        const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    });
  }
  on(fn) { this.handlers.push(fn); }
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

async function evalPage(cdp, sessionId, expr) {
  const r = await cdp.send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
                    r.exceptionDetails.text);
  }
  return r.result && r.result.value;
}

/** Click an element by visible text or aria-label, via a real mouse event. */
async function clickByText(cdp, sessionId, pattern, opts) {
  // `scope` matters for the confirmation step: the overflow menu can still be
  // in the DOM behind the dialog, and its item has the same label as the
  // dialog's confirm button. Clicking the menu item just reopens the dialog,
  // so the confirm never fires and nothing is sent.
  const scope = (opts && opts.scope) ? JSON.stringify(opts.scope) : 'null';
  const found = await evalPage(cdp, sessionId, `
    (() => {
      const re = ${pattern};
      const scopeSel = ${scope};
      const root = scopeSel ? document.querySelector(scopeSel) : document;
      if (!root) return null;
      const els = Array.from(root.querySelectorAll('[role="menuitem"],[role="button"],button,div[tabindex]'));
      for (const el of els) {
        const t = (el.textContent || '').trim();
        const l = (el.getAttribute('aria-label') || '').trim();
        if (!re.test(t) && !re.test(l)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        ${opts && opts.minY ? `if (r.y < ${opts.minY}) continue;` : ''}
        return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), t: t.slice(0,40) });
      }
      return null;
    })()
  `);
  if (!found) return null;
  const b = JSON.parse(found);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent',
      { type, x: b.x, y: b.y, button: 'left', clickCount: 1 }, sessionId);
  }
  return b;
}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;

  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)/.test(t.url));
  if (!page) { console.error('no Threads tab'); process.exit(1); }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  const requests = new Map();
  cdp.on((m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params) {
      const r = m.params.request || {};
      requests.set(m.params.requestId, {
        url: r.url, method: r.method, headers: r.headers, postData: r.postData
      });
    }
    if (m.method === 'Network.responseReceived' && m.params) {
      const e = requests.get(m.params.requestId);
      if (e) { e.status = m.params.response.status; e.mime = m.params.response.mimeType; }
    }
  });

  await cdp.send('Page.navigate', { url: 'https://www.threads.com/@' + HANDLE }, sessionId);
  await sleep(9000);
  requests.clear();   // only interested in what the click produces

  console.log('opening profile menu...');
  // Same selection as load-block-module.js, which is known to hit the right
  // control: exact "More", and NOT the one in the top navigation bar.
  const btn = await evalPage(cdp, sessionId, `
    (() => {
      const cands = [];
      document.querySelectorAll('[role="button"],button,[aria-haspopup]').forEach(el => {
        const svg = el.querySelector && el.querySelector('svg[aria-label]');
        const label = (el.getAttribute('aria-label') || (svg && svg.getAttribute('aria-label')) || '').trim();
        if (!/^(more|options)$/i.test(label)) return;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        cands.push({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), label,
                     inHeader: r.y < 100 });
      });
      cands.sort((a, b) => (a.inHeader - b.inHeader) || (b.x - a.x));
      return cands.length ? JSON.stringify(cands[0]) : null;
    })()
  `);
  if (!btn) { console.error('could not find the profile More button'); process.exit(1); }
  const mb = JSON.parse(btn);
  console.log('clicking More at ' + mb.x + ',' + mb.y);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent',
      { type, x: mb.x, y: mb.y, button: 'left', clickCount: 1 }, sessionId);
  }
  await sleep(3500);

  // The menu items are not all role=menuitem; include dialog buttons too.
  const items = await evalPage(cdp, sessionId,
    `JSON.stringify(Array.from(document.querySelectorAll('[role="menuitem"], [role="dialog"] [role="button"]'))
       .map(e => (e.textContent||'').trim()).filter(Boolean).slice(0, 15))`);
  console.log('menu: ' + items);

  console.log(`clicking ${WANT}...`);
  const hit = await clickByText(cdp, sessionId,
    UNBLOCK ? '/^Unblock$/i' : '/^Block$/i');
  if (!hit) { console.error('could not find the ' + WANT + ' item'); process.exit(1); }
  await sleep(3000);

  // A confirmation dialog usually follows.
  const dlg = await evalPage(cdp, sessionId, `
    JSON.stringify({
      text: (document.querySelector('[role="dialog"]')?.innerText || '').slice(0, 200),
      buttons: Array.from(document.querySelectorAll('[role="dialog"] [role="button"], [role="dialog"] button'))
        .map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 8)
    })
  `);
  console.log('dialog: ' + dlg);

  const confirmed = await clickByText(cdp, sessionId,
    UNBLOCK ? '/^Unblock$/i' : '/^Block$/i', { scope: '[role="dialog"]' });
  if (confirmed) console.log('confirmed: ' + confirmed.t);
  await sleep(6000);

  // Report anything that looks like it carried the action.
  console.log('\n--- candidate requests ---');
  const rows = [];
  for (const [, r] of requests) {
    if (!r.url || r.method !== 'POST') continue;
    if (/\.(js|css|png|jpg|webp|svg|woff2?)(\?|$)/i.test(r.url)) continue;
    rows.push(r);
  }
  for (const r of rows) {
    const body = r.postData || '';
    const interesting = /block/i.test(r.url) || /block/i.test(body);
    console.log(`${interesting ? '>>' : '  '} ${r.status || '?'} ${r.url.slice(0, 110)}`);
    if (interesting && body) {
      try {
        const p = new URLSearchParams(body);
        const fn = p.get('fb_api_req_friendly_name'), doc = p.get('doc_id'), vars = p.get('variables');
        if (fn || doc) console.log(`     friendly_name=${fn}\n     doc_id=${doc}\n     variables=${(vars||'').slice(0,300)}`);
        else console.log('     body: ' + body.slice(0, 300));
      } catch (e) { console.log('     body: ' + body.slice(0, 300)); }
    }
  }
  if (!rows.length) console.log('  (no POSTs captured)');

  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  if (out) { fs.writeFileSync(out, JSON.stringify(rows, null, 2)); console.log('\nfull capture: ' + out); }

  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message); process.exit(1); });
