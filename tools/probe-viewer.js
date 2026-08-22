/**
 * Read-only probe of the live page: is this session signed in, and by what
 * signal? Used to verify viewer-id detection on each platform.
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
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;

  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)|facebook\.com/.test(t.url));
  if (!page) { console.log('no supported page open'); process.exit(1); }
  console.log('page: ' + page.url.slice(0, 100) + '\n');

  // /json/list reports the target id as `id`, not `targetId`.
  const { sessionId } = await cdp.send('Target.attachToTarget',
    { targetId: page.id, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);

  const r = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const out = {};
        const ck = {};
        document.cookie.split('; ').forEach(c => {
          const i = c.indexOf('=');
          if (i > 0) ck[c.slice(0, i)] = c.slice(i + 1).slice(0, 40);
        });
        out.cookieNames = Object.keys(ck);
        // The identity-bearing cookies on each platform.
        out.c_user = ck.c_user || null;            // Facebook
        out.ds_user_id = ck.ds_user_id || null;    // Instagram / Threads
        out.sessionid = ck.sessionid ? 'present' : null;
        out.csrftoken = ck.csrftoken ? 'present' : null;

        const req = (n) => { try { const m = window.require(n); return m && m.__esModule && m.default !== undefined ? m.default : m; } catch (e) { return null; } };
        const cu = req('CurrentUserInitialData');
        out.CurrentUserInitialData = cu ? { USER_ID: cu.USER_ID, ACCOUNT_ID: cu.ACCOUNT_ID, NAME: cu.NAME } : null;

        // Threads/Instagram-specific viewer modules worth trying.
        for (const n of ['PolarisViewer', 'PolarisUserStore', 'BarcelonaViewer', 'IGViewer', 'PolarisLoggedInUser']) {
          const m = req(n);
          if (m) out['mod:' + n] = Object.keys(m).slice(0, 10);
        }

        const html = document.documentElement.innerHTML;
        const grab = (re) => { const m = html.match(re); return m ? m[1] : null; };
        out.rx_USER_ID = grab(/"USER_ID":"(\\d+)"/);
        out.rx_viewerId = grab(/"viewerId":"(\\d+)"/);
        out.rx_actorID = grab(/"actorID":"(\\d+)"/);
        out.rx_pk_viewer = grab(/"viewer".{0,80}?"pk":"?(\\d{5,})"?/);
        out.rx_logged_in = grab(/"is_logged_in":(true|false)/);
        out.rx_id_from_config = grab(/"config".{0,200}?"viewer".{0,120}?"id":"(\\d+)"/);
        // Instagram embeds the viewer under an "id" next to "username".
        out.rx_username = grab(/"viewer":\\{[^}]*"username":"([^"]+)"/);
        return JSON.stringify(out, null, 2);
      })()
    `, returnByValue: true
  }, sessionId);

  console.log(r.result && r.result.value);
  if (r.exceptionDetails) console.log('EXC', r.exceptionDetails.text);
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
