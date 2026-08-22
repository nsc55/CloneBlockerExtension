/**
 * Read-only: reproduce the extension's token/viewer resolution on the Facebook
 * tab specifically, to see which source is failing.
 */
const CDP_PORT = 9333;
class CDP {
  constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
    this.ready=new Promise(r=>this.ws.addEventListener('open',r));
    this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
      if(m.id&&this.p.has(m.id)){const q=this.p.get(m.id);this.p.delete(m.id);
        m.error?q.rej(new Error(m.error.message)):q.res(m.result);}});}
  send(me,pa,s){const i=++this.id;const o={id:i,method:me,params:pa||{}};if(s)o.sessionId=s;
    return new Promise((res,rej)=>{this.p.set(i,{res,rej});this.ws.send(JSON.stringify(o));
      setTimeout(()=>{if(this.p.has(i)){this.p.delete(i);rej(new Error('t/o '+me))}},45000)})}
}
(async()=>{
  const v=await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c=new CDP(v.webSocketDebuggerUrl); await c.ready;
  const list=await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page=list.find(t=>t.type==='page'&&/facebook\.com/.test(t.url));
  if(!page){console.error('no facebook tab');process.exit(1);}
  console.log('page: '+page.url.slice(0,90));
  const {sessionId}=await c.send('Target.attachToTarget',{targetId:page.id,flatten:true});
  await c.send('Runtime.enable',{},sessionId);

  const r=await c.send('Runtime.evaluate',{expression:`
    (() => {
      const req = (n) => { try { const m = window.require(n); return m && m.__esModule && m.default !== undefined ? m.default : m; } catch (e) { return 'THREW:'+String(e&&e.message).slice(0,60); } };
      const ck = (n) => { const m = document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)')); return m ? m[1] : null; };

      // Same inline-script scan the extension now uses.
      let acc=''; document.querySelectorAll('script:not([src])').forEach(s=>{ acc += s.textContent||''; });

      const out = {
        hasRequire: typeof window.require,
        cookie_c_user: ck('c_user'),
        cookie_xs: ck('xs') ? 'present' : null,
        DTSGInitialData: req('DTSGInitialData'),
        DTSGInitData: req('DTSGInitData'),
        CurrentUserInitialData: (() => { const m = req('CurrentUserInitialData');
          return m && typeof m === 'object' ? { USER_ID: m.USER_ID, ACCOUNT_ID: m.ACCOUNT_ID, NAME: m.NAME } : m; })(),
        LSD: (() => { const m = req('LSD'); return m && m.token ? 'token present' : m; })(),
        scriptTextLen: acc.length,
        fullHtmlLen: document.documentElement.innerHTML.length,
        rx_dtsg_in_scripts: (acc.match(/"DTSGInitialData",\\[\\],\\{"token":"([^"]+)"/)||[])[1] ? 'FOUND' : null,
        rx_dtsg_in_html: (document.documentElement.innerHTML.match(/"DTSGInitialData",\\[\\],\\{"token":"([^"]+)"/)||[])[1] ? 'FOUND' : null,
        rx_userid_in_scripts: (acc.match(/"USER_ID":"(\\d+)"/)||[])[1] || null,
        rx_actorid: (acc.match(/"actorID":"(\\d+)"/)||[])[1] || null
      };
      return JSON.stringify(out, null, 2);
    })()`, returnByValue:true},sessionId);
  console.log(r.result && r.result.value);
  if(r.exceptionDetails) console.log('EXC', r.exceptionDetails.text);
  setTimeout(()=>process.exit(0),150);
})().catch(e=>{console.error(e.message);process.exit(1)});
