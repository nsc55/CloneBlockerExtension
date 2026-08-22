/**
 * Works out how the site actually performs a block, by reading the JavaScript
 * it has already loaded.
 *
 *   node tools/analyse-block-method.js
 *
 * Uses CDP's Debugger domain to pull the source of every loaded script and
 * search it for the block code path. This is read-only and independent of the
 * extension, which matters because the extension's own URL filter is one of the
 * things being questioned.
 */
const fs = require('fs');
const CDP_PORT = 9333;
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
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
      } else if (m.method) { for (const h of this.handlers) h(m); }
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
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 60000);
    });
  }
}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;

  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const want = process.argv.includes('--site')
    ? process.argv[process.argv.indexOf('--site') + 1] : null;
  const page = list.find(t => t.type === 'page' &&
    (want ? t.url.includes(want) : /threads\.(com|net)|facebook\.com/.test(t.url)));
  if (!page) { console.error('no supported page open'); process.exit(1); }
  console.log('page: ' + page.url.slice(0, 90) + '\n');

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });

  const scripts = [];
  cdp.on((m) => {
    if (m.method === 'Debugger.scriptParsed' && m.params && m.params.url) {
      scripts.push({ id: m.params.scriptId, url: m.params.url });
    }
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  // Open the profile's overflow menu BEFORE enumerating scripts. The block code
  // ships in a lazily-loaded bundle, so it is simply absent until something
  // needs it -- and reloading the page to "start clean" would throw it away
  // again, which is what made the first attempt come up empty.
  const clicked = await (async () => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const cands = [];
          document.querySelectorAll('[role="button"],button,[aria-haspopup]').forEach(el => {
            const svg = el.querySelector && el.querySelector('svg[aria-label]');
            const label = (el.getAttribute('aria-label') || (svg && svg.getAttribute('aria-label')) || '').trim();
            if (!/^(more|options)$/i.test(label)) return;
            const b = el.getBoundingClientRect();
            if (b.width < 2 || b.height < 2 || b.y < 100) return;
            cands.push({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) });
          });
          cands.sort((a, b) => b.x - a.x);
          return cands.length ? JSON.stringify(cands[0]) : null;
        })()
      `, returnByValue: true
    }, sessionId);
    return r.result && r.result.value;
  })();

  if (clicked) {
    const c = JSON.parse(clicked);
    console.log('opening profile menu at ' + c.x + ',' + c.y);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent',
        { type, x: c.x, y: c.y, button: 'left', clickCount: 1 }, sessionId);
    }
    await sleep(5000);
    const items = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify(Array.from(document.querySelectorAll('[role="menuitem"], [role="dialog"] [role="button"]')).map(e => (e.textContent||'').trim()).filter(Boolean).slice(0,12))`,
      returnByValue: true
    }, sessionId);
    console.log('menu: ' + (items.result && items.result.value));
    // Close it again -- nothing inside is ever clicked.
    for (const t of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent',
        { type: t, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    }
  } else {
    console.log('no profile More button found; scanning what is already loaded');
  }

  // Debugger.enable re-emits scriptParsed for everything already parsed, so the
  // lazily-loaded bundle above is included without a reload.
  await cdp.send('Debugger.enable', {}, sessionId);
  await sleep(3000);

  console.log('scripts parsed: ' + scripts.length);

  // Patterns that would reveal the transport used for a block.
  const PROBES = [
    { key: 'overflow-block-component', re: /BarcelonaOverflowMenuBlockOption/ },
    { key: 'block-mutation-name',      re: /["'][A-Za-z]*Block[A-Za-z]*Mutation["']/g },
    { key: 'friendships-path',         re: /friendships[^"'`]{0,40}/g },
    { key: 'block-path',               re: /["'`][^"'`]{0,60}\/block[^"'`]{0,40}["'`]/g },
    { key: 'block-user-action',        re: /block_user|blockUser|BLOCK_USER|set_blocked/g },
    { key: 'bloks-action',             re: /com\.bloks[^"'`]{0,60}block[^"'`]{0,40}/gi }
  ];

  const hits = {};
  let scanned = 0, bytes = 0;

  for (const s of scripts) {
    if (!/threads\.com|cdninstagram|fbcdn|facebook\.(com|net)/.test(s.url)) continue;
    let src;
    try { src = (await cdp.send('Debugger.getScriptSource', { scriptId: s.id }, sessionId)).scriptSource; }
    catch (e) { continue; }
    if (!src) continue;
    scanned++; bytes += src.length;

    for (const p of PROBES) {
      const re = new RegExp(p.re.source, p.re.flags.includes('g') ? 'g' : 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        const val = m[0];
        hits[p.key] = hits[p.key] || new Map();
        if (!hits[p.key].has(val)) hits[p.key].set(val, { url: s.url, at: m.index });
        if (hits[p.key].size > 40) break;
      }
    }

    // If this script defines the block menu option, pull the surrounding code:
    // whatever the click handler calls is the answer.
    const idx = src.indexOf('BarcelonaOverflowMenuBlockOption');
    if (idx >= 0) {
      const from = Math.max(0, idx - 200);
      const slice = src.slice(from, idx + 5000);
      hits._component = hits._component || [];
      hits._component.push({ url: s.url, snippet: slice });
    }
  }

  console.log(`scanned ${scanned} scripts, ${(bytes / 1e6).toFixed(1)} MB\n`);

  for (const p of PROBES) {
    const set = hits[p.key];
    console.log('== ' + p.key + ' == ' + (set ? set.size : 0));
    if (!set) continue;
    let n = 0;
    for (const [val] of set) {
      console.log('   ' + val.slice(0, 120));
      if (++n >= 18) { console.log('   ...'); break; }
    }
    console.log('');
  }

  if (hits._component && hits._component.length) {
    console.log('== block menu component source (first match) ==');
    const snip = hits._component[0].snippet;
    console.log('from: ' + hits._component[0].url.slice(0, 90));
    // Surface the parts most likely to name the transport.
    const calls = snip.match(/\b(useMutation|commitMutation|useTHMutation|fetch|apiPost|xhr|BarcelonaAPI|IGDirect|Bloks|useBarcelona\w+)\b/g);
    console.log('notable identifiers: ' + JSON.stringify([...new Set(calls || [])]));
    if (OUT) { fs.writeFileSync(OUT, hits._component.map(h => '/* ' + h.url + ' */\n' + h.snippet).join('\n\n')); console.log('snippet written to ' + OUT); }
    else console.log(snip.slice(0, 1500));
  } else {
    console.log('block menu component not found in loaded scripts (open a profile menu first)');
  }

  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message); process.exit(1); });
