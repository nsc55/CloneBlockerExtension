/**
 * Visual check of the in-page report UI in the headful dev-session browser.
 *
 *   node tools/report-visual.js [--shot-dir DIR]
 *
 * Hovers a profile link with a real synthetic pointer (which behaves properly
 * in a headful browser, unlike headless) and screenshots the chip, then opens
 * the sheet and screenshots that. Submits nothing.
 */
const fs = require('fs');
const path = require('path');
const CDP_PORT = 9333;
const OUT = process.argv.includes('--shot-dir')
  ? process.argv[process.argv.indexOf('--shot-dir') + 1] : '.';
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

async function shot(c, s, file) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' }, s);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('wrote ' + file);
}

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)/.test(t.url));
  if (!page) { console.error('open a Threads tab in the dev session first'); process.exit(1); }
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);

  await c.send('Page.navigate', { url: 'https://www.threads.com/@threads' }, sessionId);
  await sleep(12000);

  const target = await ev(c, sessionId, `
    (() => {
      // A link to someone else, in page content -- not the nav, and not the
      // viewer's own profile (the extension deliberately ignores both).
      var as = document.querySelectorAll('a[href^="/@"]');
      for (var i = 0; i < as.length; i++) {
        var a = as[i];
        if (a.closest('nav, [role="navigation"], [role="banner"], header')) continue;
        var b = a.getBoundingClientRect();
        if (b.width < 8 || b.height < 8) continue;
        if (b.top < 150 || b.bottom > window.innerHeight - 60) continue;
        return JSON.stringify({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2),
                                text: (a.textContent||'').trim().slice(0,30),
                                href: a.getAttribute('href') });
      }
      return null;
    })()`);
  if (!target) { console.error('no profile link in view'); process.exit(1); }
  const t = JSON.parse(target);
  console.log('hovering "' + t.text + '" at ' + t.x + ',' + t.y);

  // A real pointer path: move elsewhere, then onto the link.
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 300 }, sessionId);
  await sleep(300);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y }, sessionId);
  await sleep(2000);

  const chip = await ev(c, sessionId, `
    (() => {
      var h = document.querySelector('[data-cloneblocker-ui]');
      var ch = h && h.shadowRoot && h.shadowRoot.querySelector('.chip');
      if (!ch) return null;
      var b = ch.getBoundingClientRect();
      return JSON.stringify({ text: ch.textContent.trim(), cls: ch.className,
                              x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) });
    })()`);
  console.log('chip: ' + chip);
  if (!chip) { console.log('NO CHIP from a real pointer hover'); process.exit(2); }
  await shot(c, sessionId, path.join(OUT, 'report-chip.png'));

  // Open the sheet (click inside the shadow root; no submission).
  await ev(c, sessionId,
    `(() => { document.querySelector('[data-cloneblocker-ui]').shadowRoot.querySelector('.chip').click(); return 1; })()`);
  await sleep(1200);
  const sheet = await ev(c, sessionId, `
    (() => {
      var r = document.querySelector('[data-cloneblocker-ui]').shadowRoot;
      var s = r.querySelector('.sheet');
      return s ? JSON.stringify({ who: r.querySelector('.who .n').textContent.trim(),
                                  meta: r.querySelector('.who .m').textContent.trim() }) : null;
    })()`);
  console.log('sheet: ' + sheet);
  await shot(c, sessionId, path.join(OUT, 'report-sheet.png'));

  // Close without sending anything.
  await ev(c, sessionId,
    `(() => { var b = document.querySelector('[data-cloneblocker-ui]').shadowRoot.querySelector('.cancel'); if (b) b.click(); return 1; })()`);
  console.log('closed without submitting');
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message); process.exit(1); });
