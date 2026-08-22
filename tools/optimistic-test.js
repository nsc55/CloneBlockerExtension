// Does the report sheet answer immediately, and does the post actually go?
//
// The whole point of the change is that nothing waits, which is precisely what
// a unit test cannot show: it has to be measured against a backend that is
// deliberately slow, in a real page, with real CSS and a real animation. So
// this stands up a page with a post on it, injects the content script, makes
// the service worker take three seconds to answer, and times the click.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8231;
const CDP_PORT = 9395;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (d ? '  -- ' + d : ''));
  ok ? pass++ : fail++;
};

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pend = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', () => rej(new Error('cdp')));
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (!m.id && this.onEvent) { try { this.onEvent(m.method, m.params); } catch (e) {} }
      if (m.id && this.pend.has(m.id)) {
        const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
  }
  send(method, params, sessionId) {
    const i = ++this.id;
    const pl = { id: i, method, params: params || {} };
    if (sessionId) pl.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pend.set(i, { res, rej }); this.ws.send(JSON.stringify(pl));
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
}

function findChrome() {
  for (const p of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ]) if (fs.existsSync(p)) return p;
  throw new Error('no chrome');
}

// A page shaped like a Threads post, enough for the sheet's context extractor.
const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title>
<style>body{background:#111;color:#eee;font:14px system-ui;margin:0;padding:20px}
 .post{border:1px solid #333;padding:16px;margin:12px 0;border-radius:8px;background:#181818}</style>
<div data-pressable-container="true" class="post" id="post1">
  <a href="/@someclone">someclone</a>
  <a href="/@someclone/post/ABC123">permalink</a>
  <div>A post that should disappear when reported.</div>
  <div class="row" style="display:flex;gap:12px">
    <div role="button"><svg width="16" height="16" aria-label="Like"></svg></div>
    <div role="button"><svg width="16" height="16" aria-label="Reply"></svg></div>
    <div role="button"><svg width="16" height="16" aria-label="Repost"></svg></div>
    <div role="button"><svg width="16" height="16" aria-label="Share"></svg></div>
  </div>
</div>
<div data-pressable-container="true" class="post" id="post2">
  <a href="/@other">other</a>
  <a href="/@other/post/DEF456">permalink</a>
  <div>A post that should stay exactly where it is.</div>
  <div class="row" style="display:flex;gap:12px">
    <div role="button"><svg width="16" height="16" aria-label="Share"></svg></div>
  </div>
</div>`;

(async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  server.listen(PORT, '127.0.0.1');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-opt-'));
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});
  process.on('exit', () => {
    try { chrome.kill(); } catch (e) {}
    try { server.close(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  });

  let v = null;
  for (let i = 0; i < 60 && !v; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); }
    catch (e) { await sleep(400); }
  }
  const cdp = new CDP(v.webSocketDebuggerUrl); await cdp.ready;
  const pageUrl = `http://127.0.0.1:${PORT}/` + (process.env.CB_PATH || '');
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.enable', {}, sid);

  // Open a BLANK page, then navigate, then wait for the load event, and only
  // then inject.
  //
  // Target.createTarget(url) returns as soon as the target exists, not when the
  // document has committed. Attaching and injecting at that point races the
  // navigation: when the real document commits it brings a NEW execution
  // context with it, and everything put into the old one -- the chrome stub,
  // the bridge, the content script -- is discarded. The page then looks
  // perfectly correct and behaves as though the extension had never loaded,
  // which is precisely what this harness went on to report.
  //
  // It passed for months on timing alone, and a Chrome update moved the
  // timing. Waiting for readyState is not enough either: the document can be
  // complete while the context that ran the injections is already dead.
  await cdp.send('Page.navigate', { url: pageUrl }, sid);
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    cdp.onEvent = (method) => { if (method === 'Page.loadEventFired') done(); };
    setTimeout(done, 8000);
  });
  await sleep(250);
  await sleep(300);

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  };

  // Wait for the navigation to FINISH before injecting anything.
  //
  // Target.createTarget returns as soon as the target exists, not when it has
  // loaded. Attaching and injecting into the context that happens to be there
  // races the real one: when the document commits, that context is replaced
  // and everything put into it -- the chrome stub, the bridge, the content
  // script -- goes with it. The symptom is not an error; it is a page that
  // looks right and behaves as though the extension was never loaded, which is
  // exactly what this harness then reports.
  //
  // It used to pass on timing alone. A Chrome update moved the timing.
  for (let i = 0; i < 100; i++) {
    const st = await ev('document.readyState').catch(() => null);
    if (st === 'complete' || st === 'interactive') break;
    await sleep(100);
  }


  // The page-level stylesheet the manifest would inject.
  const css = fs.readFileSync(path.join(ROOT, 'src/content/blocker.css'), 'utf8');
  await ev(`(() => { const s = document.createElement('style');
    s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); return 1; })()`);

  // A stand-in for the extension world: chrome.i18n, the protocol, and a
  // bridge whose service worker is DELIBERATELY SLOW. Three seconds is longer
  // than anybody would tolerate staring at a disabled button, which is the
  // whole point being measured.
  await ev(`(() => {
    globalThis.chrome = { runtime: { id: 'test', getURL: (p) => p }, i18n: null };
    globalThis.__swCalls = [];
    globalThis.__swDelay = 3000;
    return 1;
  })()`);

  for (const f of ['src/common/i18n.js', 'src/common/protocol.js']) {
    await ev(`(() => { const s = document.createElement('script');
      s.textContent = ${JSON.stringify(fs.readFileSync(path.join(ROOT, f), 'utf8'))};
      document.head.appendChild(s); return 1; })()`);
  }

  await ev(`(() => {
    globalThis.CB_BRIDGE = {
      state: { platform: 'threads', viewerId: '5550001111', debug: false },
      sw: (type, payload) => {
        globalThis.__swCalls.push({ type, at: Date.now() });
        return new Promise(r => setTimeout(() => r({ ok: true }), globalThis.__swDelay));
      },
      onSw: () => {}
    };
    // The identity map the content world normally builds from Meta's own Relay
    // store. Nothing here needs it to know anything; it needs it to exist.
    globalThis.CB_IDENTITY = {
      idForUsername: (u) => (u === 'someclone' ? '9001234567' : null),
      usernameForId: () => null,
      noteIdentity: () => {}
    };
    return 1;
  })()`);

  await ev(`(() => { const s = document.createElement('script');
    s.textContent = ${JSON.stringify(fs.readFileSync(path.join(ROOT, 'src/content/report-ui.js'), 'utf8'))};
    document.head.appendChild(s); return 1; })()`);
  // The real content script is started by main.js once the bridge handshake
  // completes; here that is this line.
  await ev(`globalThis.CB_REPORT.start()`);
  await sleep(1500);

  const injected = await ev(`document.querySelectorAll('[data-cloneblocker-post]').length`);
  check('the report button is added to each post', injected >= 1, String(injected));
  if (!injected) { console.log('\\ncannot continue without the button'); process.exit(1); }

  // Open the sheet on the first post.
  await ev(`(() => {
    document.querySelector('#post1 [data-cloneblocker-post]').click(); return 1; })()`);
  await sleep(700);
  const sheetUp = await ev(`(() => {
    const h = document.querySelector('[data-cloneblocker-ui]');
    return !!(h && h.shadowRoot && h.shadowRoot.querySelector('.submit'));
  })()`);
  check('the sheet opens on the post', sheetUp === true, String(sheetUp));

  // Press Send, and time how long until the success state is on screen.
  const timing = JSON.parse(await ev(`
    (async () => {
      const root = document.querySelector('[data-cloneblocker-ui]').shadowRoot;
      const t0 = Date.now();
      root.querySelector('.submit').click();
      // Poll tightly; we are measuring the gap, not waiting for a backend.
      let shown = -1;
      for (let i = 0; i < 400; i++) {
        if (root.querySelector('.ok')) { shown = Date.now() - t0; break; }
        await new Promise(r => setTimeout(r, 5));
      }
      const dismissing = document.querySelector('#post1').getAttribute('data-cb-dismissing');
      return JSON.stringify({ shown, dismissing, swDelay: globalThis.__swDelay,
                              calls: globalThis.__swCalls.length });
    })()`));

  check('the success state appears immediately, not after the round trip',
    timing.shown >= 0 && timing.shown < 400,
    timing.shown + 'ms, with a ' + timing.swDelay + 'ms backend');
  check('and the post starts disappearing at the same moment',
    timing.dismissing === '1', String(timing.dismissing));

  // The animation finishes and the post is really gone -- and only that one.
  await sleep(900);
  const after = JSON.parse(await ev(`JSON.stringify({
    one: document.querySelector('#post1').getAttribute('data-cb-dismissed'),
    oneVisible: document.querySelector('#post1').getBoundingClientRect().height,
    two: document.querySelector('#post2').getAttribute('data-cb-dismissed'),
    twoVisible: document.querySelector('#post2').getBoundingClientRect().height > 0
  })`));
  check('the post is gone once the animation ends', after.one === '1' && after.oneVisible === 0,
    JSON.stringify(after));
  check('and no other post was touched', after.two === null && after.twoVisible === true,
    JSON.stringify({ two: after.two, visible: after.twoVisible }));

  // The work still happened, in the background, after the sheet had answered.
  await sleep(300);
  const calls = JSON.parse(await ev(`JSON.stringify(globalThis.__swCalls.map(c => c.type))`));
  check('the report was still submitted, in the background',
    calls.includes('sw:submit-report'), JSON.stringify(calls));
  check('and the block was still queued',
    calls.includes('sw:enqueue-platform-block'), JSON.stringify(calls));

  cdp.ws.close();
  console.log('\\n' + pass + '/' + (pass + fail) + ' checks passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('failed: ' + e.message); process.exit(1); });
