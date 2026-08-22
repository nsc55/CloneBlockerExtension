/**
 * Read-only: locate Facebook's current "Blocking" settings surface by walking
 * the settings navigation, since the historical /settings?tab=blocking URL now
 * redirects to the general settings page.
 */
const fs = require('fs');
const CDP_PORT = 9333;
const SHOT = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null;
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

const LINKS = [
  '(function(){',
  '  var out = [];',
  '  var as = document.querySelectorAll("a[href]");',
  '  for (var i = 0; i < as.length && out.length < 40; i++) {',
  '    var h = as[i].getAttribute("href") || "";',
  '    var t = (as[i].textContent || "").trim();',
  '    if (!/block|privacy|settings/i.test(h + " " + t)) continue;',
  '    out.push(t.slice(0, 34) + "  ->  " + h.slice(0, 80));',
  '  }',
  '  return JSON.stringify({ url: location.href.slice(0, 90), links: out }, null, 1);',
  '})()'
].join('\n');

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /www\.facebook\.com/.test(t.url));
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);

  await c.send('Page.navigate', { url: 'https://www.facebook.com/settings' }, sessionId);
  await sleep(12000);
  const r = await c.send('Runtime.evaluate', { expression: LINKS, returnByValue: true }, sessionId);
  if (r.exceptionDetails) console.log('EXC ' + r.exceptionDetails.text);
  console.log(r.result && r.result.value);

  if (SHOT) {
    const s = await c.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(SHOT, Buffer.from(s.data, 'base64'));
    console.log('screenshot: ' + SHOT);
  }
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
