/**
 * Opens (or focuses) a tab at a URL in the running dev-session browser.
 *
 *   node tools/open-tab.js https://www.facebook.com/
 */
const CDP_PORT = 9333;
const URL_ARG = process.argv[2];
if (!URL_ARG) { console.error('usage: node tools/open-tab.js <url>'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(u) {
    this.ws = new WebSocket(u); this.id = 0; this.p = new Map();
    this.ready = new Promise(r => this.ws.addEventListener('open', r));
    this.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const q = this.p.get(m.id); this.p.delete(m.id);
        m.error ? q.rej(new Error(m.error.message)) : q.res(m.result);
      }
    });
  }
  send(me, pa, s) {
    const i = ++this.id; const o = { id: i, method: me, params: pa || {} };
    if (s) o.sessionId = s;
    return new Promise((res, rej) => {
      this.p.set(i, { res, rej }); this.ws.send(JSON.stringify(o));
      setTimeout(() => { if (this.p.has(i)) { this.p.delete(i); rej(new Error('t/o ' + me)); } }, 45000);
    });
  }
}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c = new CDP(v.webSocketDebuggerUrl);
  await c.ready;

  const host = new URL(URL_ARG).host;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const existing = list.find(t => t.type === 'page' && t.url.includes(host));

  let targetId;
  if (existing) {
    targetId = existing.id;
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Page.enable', {}, sessionId);
    await c.send('Page.navigate', { url: URL_ARG }, sessionId);
    console.log('reused existing tab for ' + host);
  } else {
    const r = await c.send('Target.createTarget', { url: URL_ARG });
    targetId = r.targetId;
    console.log('opened a new tab for ' + host);
  }
  await c.send('Target.activateTarget', { targetId });
  await sleep(9000);

  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  await c.send('Runtime.enable', {}, sessionId);
  const st = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href.slice(0, 90),
      title: document.title.slice(0, 60),
      c_user: (document.cookie.match(/(?:^|; )c_user=([^;]*)/)||[])[1] || null,
      ds_user_id: (document.cookie.match(/(?:^|; )ds_user_id=([^;]*)/)||[])[1] || null,
      looksLoggedIn: !/log in|sign up/i.test((document.body.innerText||'').slice(0, 400))
    })`, returnByValue: true
  }, sessionId);
  console.log(st.result && st.result.value);
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
