/**
 * Read-only verification of a Facebook profile's block state, taken from the
 * rendered page rather than from anything the extension reported.
 *
 *   node tools/fb-verify.js https://www.facebook.com/fake.tiger.01/ [--shot out.png]
 */
const fs = require('fs');
const CDP_PORT = 9333;
const TARGET = process.argv[2] || 'https://www.facebook.com/';
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

const PROBE = [
  '(function(){',
  '  var lines = (document.body.innerText || "").split("\\n");',
  '  var kept = [];',
  '  for (var i = 0; i < lines.length && kept.length < 16; i++) {',
  '    if (lines[i].trim()) kept.push(lines[i].trim());',
  '  }',
  '  var txt = document.body.innerText || "";',
  '  var btns = [];',
  '  var els = document.querySelectorAll("[role=\\"button\\"]");',
  '  for (var j = 0; j < els.length && btns.length < 14; j++) {',
  '    var t = (els[j].textContent || "").trim();',
  '    if (t && t.length < 26 && btns.indexOf(t) === -1) btns.push(t);',
  '  }',
  '  return JSON.stringify({',
  '    url: location.href.slice(0, 90),',
  '    saysUnblock: /Unblock/i.test(txt),',
  '    saysUnavailable: /isn\'t available|content isn\'t available|not available/i.test(txt),',
  '    saysBlocked: /you blocked|blocked this/i.test(txt),',
  '    buttons: btns,',
  '    head: kept.join(" | ").slice(0, 300)',
  '  });',
  '})()'
].join('\n');

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /www\.facebook\.com/.test(t.url));
  if (!page) { console.error('no facebook tab'); process.exit(1); }
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Page.navigate', { url: TARGET }, sessionId);
  await sleep(12000);

  const r = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId);
  if (r.exceptionDetails) console.log('EXC: ' + r.exceptionDetails.text);
  console.log(r.result && r.result.value);

  if (SHOT) {
    const s = await c.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(SHOT, Buffer.from(s.data, 'base64'));
    console.log('screenshot: ' + SHOT);
  }
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
