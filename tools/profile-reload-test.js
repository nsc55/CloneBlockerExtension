// Reporting from a profile page: does it reload, and only when it should?
//
// Three cases, and the whole point is that they differ:
//   1. profile page + block ticked   -> waits for the block, then reloads
//   2. profile page + block UNTICKED -> no reload (nothing on the page changed)
//   3. feed post    + block ticked   -> no reload; the post is dismissed instead
//   4. profile page + block that never lands -> no reload either
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8233, CDP_PORT = 9403;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (d ? '  -- ' + d : ''));
  ok ? pass++ : fail++;
};

class CDP {
  constructor(u) {
    this.ws = new WebSocket(u); this.id = 0; this.p = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', () => rej(new Error('cdp')));
    });
    this.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (!m.id && this.onEvent) { try { this.onEvent(m.method, m.params); } catch (err) {} }
      if (m.id && this.p.has(m.id)) {
        const x = this.p.get(m.id); this.p.delete(m.id);
        m.error ? x.rej(new Error(m.error.message)) : x.res(m.result);
      }
    });
  }
  send(m, p, s) {
    const i = ++this.id; const pl = { id: i, method: m, params: p || {} };
    if (s) pl.sessionId = s;
    return new Promise((res, rej) => {
      this.p.set(i, { res, rej }); this.ws.send(JSON.stringify(pl));
      setTimeout(() => { if (this.p.has(i)) { this.p.delete(i); rej(new Error('timeout ' + m)); } }, 30000);
    });
  }
}

const CHROME = [
  path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join('C:', 'Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe')
].find(p => fs.existsSync(p));

const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title>
<style>body{background:#111;color:#eee;font:14px system-ui;margin:0;padding:20px}
 .post{border:1px solid #333;padding:16px;margin:12px 0;border-radius:8px}</style>
<div data-pressable-container="true" class="post" id="post1">
  <a href="/@langthang1010">langthang1010</a>
  <a href="/@langthang1010/post/ABC123">permalink</a>
  <div>A post by the profile owner.</div>
  <div class="row" style="display:flex;gap:12px">
    <div role="button"><svg width="16" height="16" aria-label="Like"></svg></div>
    <div role="button"><svg width="16" height="16" aria-label="Reply"></svg></div>
    <div role="button"><svg width="16" height="16" aria-label="Repost"></svg></div>
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

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pr-'));
  const chrome = spawn(CHROME, [
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
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
    try { v = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); }
    catch (e) { await sleep(400); }
  }
  const cdp = new CDP(v.webSocketDebuggerUrl); await cdp.ready;

  const files = ['src/common/i18n.js', 'src/common/protocol.js']
    .map(f => fs.readFileSync(path.join(REPO, f), 'utf8'));
  const reportUi = fs.readFileSync(path.join(REPO, 'src/content/report-ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(REPO, 'src/content/blocker.css'), 'utf8');

  /** Load the page at `urlPath`, inject the world, return an evaluator. */
  async function open(urlPath, blockLands) {
    // Open a BLANK page, then navigate, then wait for the load event, and only
    // then inject.
    //
    // Target.createTarget(url) returns as soon as the target exists, not when
    // the document has committed. Attaching and injecting at that point races
    // the navigation: when the real document commits it brings a NEW execution
    // context, and everything put into the old one -- the chrome stub, the
    // bridge, the content script -- is discarded. The page then looks correct
    // and behaves as though the extension had never loaded, which is exactly
    // what this harness went on to report.
    //
    // It passed for months on timing alone, and a Chrome update moved the
    // timing. Waiting for readyState is not enough: the document can be
    // complete while the context that ran the injections is already dead.
    const pageUrl = 'http://127.0.0.1:' + PORT + urlPath;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      cdp.onEvent = (method) => { if (method === 'Page.loadEventFired') done(); };
      setTimeout(done, 8000);
    });
    await sleep(250);
    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        const ex = d.exception || {};
        throw new Error((ex.description || ex.value || d.text || 'unknown').slice(0, 700));
      }
      return r.result && r.result.value;
    };

    await ev(`(() => { const s=document.createElement('style');
      s.textContent=${JSON.stringify(css)}; document.head.appendChild(s); return 1; })()`);

    // The reload is detected by letting it HAPPEN, not by stubbing it out --
    // location.reload is not configurable, so replacing it throws. A real
    // reload wipes the injected world, so the marker below simply stops
    // existing, and that absence is the signal. It also means the reload being
    // tested is a real one rather than a call to a fake.
    await ev(`(() => {
      globalThis.chrome = { runtime: { id: 't', getURL: p => p }, i18n: null };
      globalThis.__alive = true;
      globalThis.__swCalls = [];
      globalThis.__blockLands = ${blockLands ? 'true' : 'false'};
      return 1;
    })()`);

    for (const src of files) {
      await ev(`(() => { const s=document.createElement('script');
        s.textContent=${JSON.stringify(src)}; document.head.appendChild(s); return 1; })()`);
    }

    await ev(`(() => {
      globalThis.CB_BRIDGE = {
        state: { platform: 'threads', viewerId: '5550001111', debug: false },
        sw: (type, payload) => {
          globalThis.__swCalls.push(type);
          if (type === 'sw:get-state') {
            return Promise.resolve({ ok: true,
              done: { threads: globalThis.__blockLands ? ['9001234567'] : [] } });
          }
          return Promise.resolve({ ok: true });
        },
        onSw: () => {}
      };
      globalThis.CB_IDENTITY = {
        idForUsername: u => (u === 'langthang1010' ? '9001234567' : null),
        usernameForId: () => null, noteIdentity: () => {}
      };
      return 1;
    })()`);

    await ev(`(() => { const s=document.createElement('script');
      s.textContent=${JSON.stringify(reportUi)}; document.head.appendChild(s); return 1; })()`);
    await ev(`globalThis.CB_REPORT.start()`);
    await sleep(1300);
    return { ev, targetId };
  }

  /** Did the page reload? The injected marker does not survive one. */
  async function reloaded(ev) {
    try { return (await ev('typeof globalThis.__alive')) === 'undefined'; }
    catch (e) { return true; }   // context torn down mid-call is also a reload
  }

  /** Open the sheet on the post, optionally untick the block box, send. */
  async function report(ev, wantBlock) {
    await ev(`document.querySelector('#post1 [data-cloneblocker-post]').click()`);
    await sleep(600);
    return ev(`(async () => {
      const root = document.querySelector('[data-cloneblocker-ui]').shadowRoot;
      const box = root.querySelector('input[type=checkbox]');
      const wanted = ${wantBlock ? 'true' : 'false'};
      if (box.checked !== wanted) box.click();
      root.querySelector('.submit').click();
      for (let i = 0; i < 60 && !root.querySelector('.ok'); i++) await new Promise(r => setTimeout(r, 25));
      const note = root.querySelector('.ok + .note');
      return JSON.stringify({ boxWas: wanted, note: note ? note.textContent : null });
    })()`);
  }

  // ---- 1. profile page, block ticked -> reload ----------------------------
  {
    const { ev, targetId } = await open('/@langthang1010/replies', true);
    const out = JSON.parse(await report(ev, true));
    check('on the profile page it says the page will reload',
      /reload|tải lại/i.test(out.note || ''), JSON.stringify(out.note));
    // The block "lands" immediately in this stub, so the reload follows shortly.
    await sleep(2000);
    const did = await reloaded(ev);
    check('and it reloads once the block lands', did === true, 'reloaded=' + did);
    await cdp.send('Target.closeTarget', { targetId });
  }

  // ---- 2. profile page, block UNTICKED -> no reload -----------------------
  {
    const { ev, targetId } = await open('/@langthang1010/replies', true);
    const out = JSON.parse(await report(ev, false));
    await sleep(2000);
    const did = await reloaded(ev);
    check('reporting without a block does not reload the profile page',
      did === false, 'reloaded=' + did);
    const calls = await ev('JSON.stringify(globalThis.__swCalls)');
    check('and no block was queued', !calls.includes('enqueue-platform-block'), calls);
    await cdp.send('Target.closeTarget', { targetId });
  }

  // ---- 3. a feed page, block ticked -> dismiss, do not reload -------------
  {
    const { ev, targetId } = await open('/', true);
    await report(ev, true);
    await sleep(2000);
    const did = await reloaded(ev);
    check('in a feed the post is dismissed instead of reloading', did === false, 'reloaded=' + did);
    const dismissed = await ev(`document.querySelector('#post1').getAttribute('data-cb-dismissed')`);
    check('and the post really goes', dismissed === '1', String(dismissed));
    await cdp.send('Target.closeTarget', { targetId });
  }

  // ---- 4. profile page, block ticked, block never lands -> no reload ------
  {
    const { ev, targetId } = await open('/@langthang1010', false);
    await report(ev, true);
    await sleep(2500);
    const did = await reloaded(ev);
    check('a block that has not landed does not reload a page that would look unchanged',
      did === false, 'reloaded=' + did);
    await cdp.send('Target.closeTarget', { targetId });
  }

  cdp.ws.close();
  console.log('\\n' + pass + '/' + (pass + fail) + ' checks passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('failed: ' + e.message); process.exit(1); });
