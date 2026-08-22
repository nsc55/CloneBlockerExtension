/**
 * Makes Meta load its lazily-bundled block module, then reports what the
 * extension discovered.
 *
 *   node tools/load-block-module.js [--profile https://www.threads.com/@someone]
 *
 * Navigates to a profile and opens its overflow ("...") menu. Opening a menu is
 * a read-only UI action -- it loads the JavaScript bundle that contains the
 * block mutation without invoking it. The menu is closed again with Escape and
 * NOTHING inside it is ever clicked.
 */
const CDP_PORT = 9333;
const PROFILE = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : 'https://www.threads.com/@threads';

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

async function evalPage(cdp, sessionId, expr) {
  const r = await cdp.send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
                    r.exceptionDetails.text);
  }
  return r.result && r.result.value;
}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;

  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)|facebook\.com/.test(t.url));
  if (!page) { console.log('no supported page open'); process.exit(1); }

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  console.log('navigating to ' + PROFILE);
  await cdp.send('Page.navigate', { url: PROFILE }, sessionId);
  await sleep(9000);

  // What did simply visiting the profile load?
  const before = await evalPage(cdp, sessionId, `
    (() => {
      const names = [];
      try {
        // The extension's own index is in the isolated world, so count from the
        // page side instead: ask require() for each known block module name.
      } catch (e) {}
      return 'ok';
    })()
  `);

  // Find the overflow menu button without clicking anything destructive.
  const buttons = await evalPage(cdp, sessionId, `
    (() => {
      const cands = [];
      const els = document.querySelectorAll('[role="button"], button, [aria-haspopup]');
      els.forEach((el, i) => {
        const svg = el.querySelector && el.querySelector('svg[aria-label]');
        const label = (el.getAttribute('aria-label') ||
                       (svg && svg.getAttribute('aria-label')) || '').trim();
        const txt = (el.textContent || '').trim().slice(0, 24);
        // Exact "More" is the profile overflow trigger. Loose matching picked up
        // unrelated "learn more" affordances, so score exact matches highest.
        const exact = /^(more|options|thêm|tùy chọn)$/i.test(label);
        const loose = /more|option|menu/i.test(label) || /^(\\.\\.\\.|…|⋯)$/.test(txt);
        if (exact || loose) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            cands.push({ i, label, txt, exact,
              x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
          }
        }
      });
      // The top navigation bar has its own "More" (app settings). The profile's
      // overflow trigger sits lower in the page, so prefer that.
      cands.forEach(c => { c.inHeader = c.y < 100; });
      cands.sort((a, b) => (b.exact - a.exact) || (a.inHeader - b.inHeader) || (b.x - a.x));
      return JSON.stringify(cands.slice(0, 12));
    })()
  `);
  console.log('overflow-menu candidates: ' + buttons);

  const cands = JSON.parse(buttons);
  if (cands.length) {
    const b = cands[0];   // sorted: exact "More" first, rightmost wins ties
    console.log('clicking menu button at ' + b.x + ',' + b.y + ' (' + (b.label || b.txt) + ')');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent',
        { type, x: b.x, y: b.y, button: 'left', clickCount: 1 }, sessionId);
    }
    await sleep(4000);

    // Read the menu contents WITHOUT clicking any of it.
    const menu = await evalPage(cdp, sessionId, `
      (() => {
        const items = [];
        document.querySelectorAll('[role="menuitem"], [role="dialog"] [role="button"]').forEach(el => {
          const t = (el.textContent || '').trim().slice(0, 40);
          if (t) items.push(t);
        });
        return JSON.stringify(items.slice(0, 15));
      })()
    `);
    console.log('menu items (not clicked): ' + menu);

    // Close it again.
    await cdp.send('Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  } else {
    console.log('no overflow menu button found - open one by hand in the browser');
  }

  await sleep(2500);

  // Ask the page which block-ish graphql modules are now registered.
  const found = await evalPage(cdp, sessionId, `
    (() => {
      const names = (window.__TQ_DEBUG_MODULES__ || []);
      return JSON.stringify({ hint: 'see extension probe for the authoritative list' });
    })()
  `);

  console.log('\nnow run:  node tools/inspect-session.js');
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message); process.exit(1); });
