/**
 * Read-only: resolve a Threads profile to its numeric pk and report the current
 * relationship state from Meta's own Relay store.
 *
 *   node tools/probe-profile.js @nguyenvana.clone
 *
 * Navigates to the profile (an ordinary page view) and reads records the page
 * has already fetched. Sends nothing and changes nothing.
 */
const CDP_PORT = 9333;
const HANDLE = (process.argv[2] || '').replace(/^@/, '').replace(/^https?:\/\/[^/]+\/@?/, '');
if (!HANDLE) { console.error('usage: node tools/probe-profile.js @handle'); process.exit(1); }

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
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)/.test(t.url));
  if (!page) { console.error('no Threads tab open'); process.exit(1); }

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  await cdp.send('Page.navigate', { url: 'https://www.threads.com/@' + HANDLE }, sessionId);
  await sleep(9000);

  const out = await evalPage(cdp, sessionId, `
    (() => {
      const req = (n) => { try { const m = window.require(n); return m && m.__esModule && m.default !== undefined ? m.default : m; } catch (e) { return null; } };
      const res = { handle: ${JSON.stringify(HANDLE)} };

      // Page HTML carries the pk directly.
      const html = document.documentElement.innerHTML;
      const g = (re) => { const m = html.match(re); return m ? m[1] : null; };
      res.pk_from_html = g(/"user_id":"(\\d+)"/) || g(/"pk":"(\\d+)"/);
      res.viewer = (document.cookie.match(/(?:^|; )ds_user_id=([^;]*)/) || [])[1] || null;

      // Relay store: authoritative record for this user, including the
      // relationship flags Meta itself renders the profile from.
      let env = null;
      for (const n of ['BarcelonaRelayEnvironment','CometRelayEnvironment']) {
        const e = req(n);
        if (e && typeof e.getStore === 'function') {
          try { if (e.getStore().getSource().getRecordIDs().length > 0) { env = e; break; } } catch (err) {}
        }
      }
      if (!env) { res.error = 'no relay store'; return JSON.stringify(res, null, 2); }

      const source = env.getStore().getSource();
      const ids = source.getRecordIDs();
      const wanted = ${JSON.stringify(HANDLE)}.toLowerCase();
      for (const key of ids) {
        const r = source.get(key);
        if (!r || !r.__typename || !/User/i.test(r.__typename)) continue;
        if (String(r.username || '').toLowerCase() !== wanted) continue;
        res.record = key;
        res.id = r.id || r.pk || null;
        res.username = r.username;
        res.full_name = r.full_name || r.name || null;
        res.is_private = r.text_post_app_is_private !== undefined ? r.text_post_app_is_private : r.is_private;
        res.follower_count = r.follower_count;
        const fs = r.friendship_status;
        if (fs && fs.__ref) {
          const sub = source.get(fs.__ref);
          if (sub) res.friendship = {
            following: sub.following, followed_by: sub.followed_by,
            blocking: sub.blocking, is_bestie: sub.is_bestie,
            muting: sub.muting, is_restricted: sub.is_restricted,
            outgoing_request: sub.outgoing_request, incoming_request: sub.incoming_request
          };
        } else if (fs) {
          res.friendship = { following: fs.following, followed_by: fs.followed_by, blocking: fs.blocking };
        }
        break;
      }
      if (!res.id) res.note = 'user record not found in store; pk_from_html may still be right';
      return JSON.stringify(res, null, 2);
    })()
  `);

  console.log(out);
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
