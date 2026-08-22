/**
 * Read-only: read Facebook's own "Blocking" settings page, which is the
 * authoritative list of who this account has blocked.
 *
 *   node tools/fb-blocked-list.js [nameToLookFor]
 */
const CDP_PORT = 9333;
const LOOK_FOR = process.argv[2] || null;
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
  if (!page) { console.error('no facebook tab'); process.exit(1); }
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Page.navigate', { url: 'https://www.facebook.com/settings?tab=blocking' }, sessionId);
  await sleep(13000);

  const r = await c.send('Runtime.evaluate', {
    expression: `(function(){
      var txt = document.body.innerText || '';
      var flat = txt.split('\\n').filter(function(l){ return l.trim(); }).join(' | ');
      var i = flat.indexOf('Block users');
      return JSON.stringify({
        url: location.href.slice(0, 90),
        found: ${LOOK_FOR ? JSON.stringify(LOOK_FOR) : 'null'}
          ? new RegExp(${LOOK_FOR ? JSON.stringify(LOOK_FOR) : '""'}, 'i').test(txt) : null,
        section: i >= 0 ? flat.slice(i, i + 420) : flat.slice(0, 420)
      });
    })()`, returnByValue: true
  }, sessionId);

  if (r.exceptionDetails) console.log('EXC ' + r.exceptionDetails.text);
  console.log(r.result && r.result.value);
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
