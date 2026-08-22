/**
 * Verifies the in-thread report button in the headful dev-session browser.
 *
 *   node tools/thread-button-visual.js [--shot-dir DIR] [--open]
 *
 * Checks the button lands in each post's action row next to Share, and with
 * --open clicks one to show the confirmation dialog. Submits nothing.
 */
const fs = require('fs');
const path = require('path');
const CDP_PORT = 9333;
const OUT = process.argv.includes('--shot-dir')
  ? process.argv[process.argv.indexOf('--shot-dir') + 1] : '.';
const OPEN = process.argv.includes('--open');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
async function ev(c,s,e){const r=await c.send('Runtime.evaluate',
  {expression:e,returnByValue:true,userGesture:true},s);
  if(r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result&&r.result.value;}
async function shot(c,s,f){const r=await c.send('Page.captureScreenshot',{format:'png'},s);
  fs.writeFileSync(f,Buffer.from(r.data,'base64')); console.log('wrote '+f);}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)/.test(t.url));
  if (!page) { console.error('open a Threads tab first'); process.exit(1); }
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Page.navigate', { url: 'https://www.threads.com/' }, sessionId);
  await sleep(14000);

  const report = await ev(c, sessionId, `
    (() => {
      var btns = document.querySelectorAll('[data-cloneblocker-report-btn]');
      var rows = [];
      for (var i = 0; i < btns.length && rows.length < 4; i++) {
        var b = btns[i];
        var rect = b.getBoundingClientRect();
        // What sits beside it in the same row?
        var row = b.parentElement;
        var labels = [];
        if (row) {
          var svgs = row.querySelectorAll('svg[aria-label]');
          for (var j = 0; j < svgs.length; j++) labels.push(svgs[j].getAttribute('aria-label'));
        }
        rows.push({
          post: b.getAttribute('data-cloneblocker-post'),
          x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height),
          rowLabels: labels
        });
      }
      return JSON.stringify({ count: btns.length,
        containers: document.querySelectorAll('[data-pressable-container]').length,
        rows: rows }, null, 1);
    })()`);
  console.log(report);

  const parsed = JSON.parse(report);
  if (!parsed.count) { console.log('NO BUTTONS INJECTED'); process.exit(2); }
  await shot(c, sessionId, path.join(OUT, 'thread-buttons.png'));

  if (OPEN) {
    // Click the first button and screenshot the confirmation dialog.
    await ev(c, sessionId,
      `(() => { document.querySelector('[data-cloneblocker-report-btn]').click(); return 1; })()`);
    await sleep(1500);
    const sheet = await ev(c, sessionId, `
      (() => {
        var h = document.querySelector('[data-cloneblocker-ui]');
        var r = h && h.shadowRoot;
        if (!r || !r.querySelector('.sheet')) return null;
        return JSON.stringify({
          who: r.querySelector('.who .n').textContent.trim(),
          meta: r.querySelector('.who .m').textContent.trim(),
          summary: (r.querySelector('.psummary') || {}).textContent || null,
          url: (r.querySelector('.purl') || {}).textContent || null
        });
      })()`);
    console.log('dialog: ' + sheet);
    await shot(c, sessionId, path.join(OUT, 'thread-report-dialog.png'));
    await ev(c, sessionId,
      `(() => { var b = document.querySelector('[data-cloneblocker-ui]').shadowRoot.querySelector('.cancel'); if (b) b.click(); return 1; })()`);
    console.log('closed without submitting');
  }
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message); process.exit(1); });
