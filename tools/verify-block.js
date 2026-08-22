/**
 * Independent verification that a profile is (or is not) blocked, read from the
 * rendered page rather than from anything the extension reported about itself.
 *
 *   node tools/verify-block.js @nguyenvana.clone [--shot out.png]
 */
const fs = require('fs');
const CDP_PORT = 9333;
const HANDLE = (process.argv[2] || '').replace(/^@/, '');
const SHOT = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null;
if (!HANDLE) { console.error('usage: node tools/verify-block.js @handle [--shot file.png]'); process.exit(1); }

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
    { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result && r.result.value;
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

  // Hard reload so nothing is served from the client-side cache.
  await cdp.send('Page.navigate', { url: 'https://www.threads.com/@' + HANDLE }, sessionId);
  await sleep(9000);

  const out = await evalPage(cdp, sessionId, `
    (() => {
      const res = {};
      const text = document.body.innerText || '';
      res.hasUnblock  = /\\bUnblock\\b/i.test(text);
      res.hasBlocked  = /you (have )?blocked|blocked\\b/i.test(text);
      res.hasFollow   = /^\\s*Follow\\s*$/im.test(text);
      res.buttons = Array.from(document.querySelectorAll('[role="button"],button'))
        .map(b => (b.textContent || '').trim())
        .filter(t => t && t.length < 24).slice(0, 14);
      // Meta's own record, if the page happened to fetch it.
      const req = (n) => { try { const m = window.require(n); return m && m.__esModule && m.default !== undefined ? m.default : m; } catch (e) { return null; } };
      let env = null;
      for (const n of ['BarcelonaRelayEnvironment','CometRelayEnvironment']) {
        const e = req(n);
        if (e && typeof e.getStore === 'function') {
          try { if (e.getStore().getSource().getRecordIDs().length) { env = e; break; } } catch (err) {}
        }
      }
      if (env) {
        const src = env.getStore().getSource();
        for (const k of src.getRecordIDs()) {
          const r = src.get(k);
          if (!r || String(r.username || '').toLowerCase() !== ${JSON.stringify(HANDLE.toLowerCase())}) continue;
          const fs = r.friendship_status;
          const sub = fs && fs.__ref ? src.get(fs.__ref) : fs;
          if (sub) res.friendship = { blocking: sub.blocking, following: sub.following, followed_by: sub.followed_by };
          break;
        }
        // Fall back to scanning every friendship record for a blocking flag.
        if (!res.friendship) {
          const flags = [];
          for (const k of src.getRecordIDs()) {
            const r = src.get(k);
            if (r && typeof r.blocking === 'boolean') flags.push({ k: String(k).slice(0,60), blocking: r.blocking });
          }
          res.blockingFlags = flags.slice(0, 8);
        }
      }
      res.textHead = text.slice(0, 300).replace(/\\n+/g, ' | ');
      return JSON.stringify(res, null, 2);
    })()
  `);
  console.log(out);

  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('\nscreenshot: ' + SHOT);
  }
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
