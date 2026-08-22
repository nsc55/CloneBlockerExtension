/**
 * Read-only: resolve a Facebook profile to its numeric id and report the
 * relationship state.
 *
 *   node tools/probe-fb-profile.js https://www.facebook.com/fake.tiger.01/
 *
 * The friendship question is not cosmetic. Blocking someone on Facebook removes
 * the friendship, and unblocking does NOT restore it -- so a block/unblock test
 * against a friend is not reversible, unlike the Threads case where no follow
 * relationship existed in either direction.
 */
const CDP_PORT = 9333;
const TARGET = process.argv[2];
if (!TARGET) { console.error('usage: node tools/probe-fb-profile.js <profile url>'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
    this.ready=new Promise(r=>this.ws.addEventListener('open',r));
    this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
      if(m.id&&this.p.has(m.id)){const q=this.p.get(m.id);this.p.delete(m.id);
        m.error?q.rej(new Error(m.error.message)):q.res(m.result);}});}
  send(me,pa,s){const i=++this.id;const o={id:i,method:me,params:pa||{}};if(s)o.sessionId=s;
    return new Promise((res,rej)=>{this.p.set(i,{res,rej});this.ws.send(JSON.stringify(o));
      setTimeout(()=>{if(this.p.has(i)){this.p.delete(i);rej(new Error('t/o '+me))}},60000)})}
}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /www\.facebook\.com/.test(t.url));
  if (!page) { console.error('no www.facebook.com tab open'); process.exit(1); }

  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Page.navigate', { url: TARGET }, sessionId);
  await sleep(11000);

  const r = await c.send('Runtime.evaluate', { expression: `
    (() => {
      const out = { url: location.href.slice(0, 100) };
      const req = (n) => { try { const m = window.require(n); return m && m.__esModule && m.default !== undefined ? m.default : m; } catch (e) { return null; } };

      let acc = '';
      document.querySelectorAll('script:not([src])').forEach(s => { acc += s.textContent || ''; });
      const g = (re) => { const m = acc.match(re); return m ? m[1] : null; };

      out.viewer = (document.cookie.match(/(?:^|; )c_user=([^;]*)/) || [])[1] || null;
      // The profile owner's id appears under several keys depending on surface.
      out.profileId = g(/"userID":"(\\d+)"/) || g(/"profile_id":"?(\\d+)"?/) ||
                      g(/"profileOwnerID":"(\\d+)"/) || g(/"entity_id":"(\\d+)"/) || null;
      out.name = (document.title || '').replace(/\\s*\\|\\s*Facebook\\s*$/, '').slice(0, 60);

      // What the page offers tells us the relationship without guessing.
      const txt = (document.body.innerText || '');
      const btns = Array.from(document.querySelectorAll('[role="button"],a[role="link"]'))
        .map(b => (b.textContent || '').trim()).filter(t => t && t.length < 30);
      out.buttons = Array.from(new Set(btns)).slice(0, 22);
      out.saysFriends       = /\\bFriends\\b/.test(btns.join('|'));
      out.saysAddFriend     = /Add friend/i.test(btns.join('|'));
      out.saysMessage       = /\\bMessage\\b/.test(btns.join('|'));
      out.saysBlocked       = /you blocked|blocked this account|Unblock/i.test(txt);
      out.mutualFriendsHint = (txt.match(/(\\d+)\\s+mutual friends?/i) || [])[1] || null;

      // Cross-check against the Relay store if the profile record is there.
      const env = req('CometRelayEnvironment');
      if (env && typeof env.getStore === 'function') {
        try {
          const src = env.getStore().getSource();
          const ids = src.getRecordIDs();
          out.relayRecords = ids.length;
          for (const k of ids) {
            const rec = src.get(k);
            if (!rec || !rec.__typename || !/^User$/.test(rec.__typename)) continue;
            if (out.profileId && String(rec.id) !== String(out.profileId)) continue;
            out.relayUser = { id: rec.id, name: rec.name || null,
              keys: Object.keys(rec).filter(x => !x.startsWith('__')).slice(0, 14) };
            break;
          }
        } catch (e) { out.relayErr = String(e && e.message).slice(0, 80); }
      }
      return JSON.stringify(out, null, 2);
    })()`, returnByValue: true }, sessionId);

  console.log(r.result && r.result.value);
  if (r.exceptionDetails) console.log('EXC ' + r.exceptionDetails.text);
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
