/**
 * Navigates to Facebook's blocked-profiles list, reports what is there, and can
 * unblock one entry.
 *
 *   node tools/fb-open-blocklist.js [--shot out.png] [--unblock "Name"]
 *
 * The confirmation step is fussier than it looks: this page keeps several
 * [role="dialog"] nodes alive at once (the notifications flyout and the
 * settings panel among them), so "find a dialog mentioning unblock" matched the
 * list itself and clicked the same row button twice. The modal is identified
 * here by being the SMALLEST visible dialog, which is what a confirmation is.
 */
const fs = require('fs');
const CDP_PORT = 9333;
const SHOT = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null;
const UNBLOCK = process.argv.includes('--unblock') ? process.argv[process.argv.indexOf('--unblock') + 1] : null;
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

async function ev(c, s, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result && r.result.value;
}
async function click(c, s, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s);
  }
}

const CLICKABLE = String.raw`[role="button"],button,a[role="link"],[role="menuitem"]`;

function byExactText(text) {
  return `(function(){
    var els = document.querySelectorAll('${CLICKABLE}');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (t !== ${JSON.stringify(text)}) continue;
      var b = els[i].getBoundingClientRect();
      if (b.width < 4 || b.height < 4) continue;
      if (b.y < 0 || b.bottom > (window.innerHeight || 0)) {
        els[i].scrollIntoView({ block: 'center' });
        b = els[i].getBoundingClientRect();
      }
      return JSON.stringify({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2), t: t });
    }
    return null;
  })()`;
}

const EDIT_FOR_PROFILES = `(function(){
  var heads = document.querySelectorAll('span,div,h2,h3'), head = null;
  for (var i = 0; i < heads.length; i++) {
    if ((heads[i].textContent || '').trim() === 'Block profiles and Pages') {
      var hb = heads[i].getBoundingClientRect();
      if (hb.width > 0) { head = hb; break; }
    }
  }
  if (!head) return null;
  var best = null, bd = 1e9;
  var els = document.querySelectorAll('[role="button"]');
  for (var j = 0; j < els.length; j++) {
    if ((els[j].textContent || '').trim() !== 'Edit') continue;
    var b = els[j].getBoundingClientRect();
    if (b.width < 4) continue;
    var d = Math.abs((b.y + b.height/2) - (head.y + head.height/2));
    if (d < bd) { bd = d; best = b; }
  }
  return best ? JSON.stringify({ x: Math.round(best.x + best.width/2),
                                 y: Math.round(best.y + best.height/2), t: 'Edit' }) : null;
})()`;

const LIST_ENTRIES = `(function(){
  var out = [];
  var els = document.querySelectorAll('[role="button"]');
  for (var i = 0; i < els.length; i++) {
    if ((els[i].textContent || '').trim() !== 'Unblock') continue;
    var b = els[i].getBoundingClientRect();
    if (b.width < 4) continue;
    var row = els[i], label = '';
    for (var d = 0; d < 8 && row; d++) {
      row = row.parentElement;
      if (!row) break;
      var txt = (row.innerText || '').split('Unblock').join('').trim();
      if (txt && txt.length < 80) { label = txt.split('\\n')[0]; break; }
    }
    out.push({ label: label.slice(0, 40), x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) });
  }
  return JSON.stringify(out);
})()`;

const DIALOGS = `(function(){
  var out = [];
  var d = document.querySelectorAll('[role="dialog"]');
  for (var i = 0; i < d.length; i++) {
    var b = d[i].getBoundingClientRect();
    if (b.width < 40 || b.height < 40) continue;
    var btns = [];
    var e = d[i].querySelectorAll('[role="button"],button');
    for (var j = 0; j < e.length && btns.length < 10; j++) {
      var t = (e[j].textContent || '').trim();
      if (t && t.length < 24) btns.push(t);
    }
    out.push({ i: i, w: Math.round(b.width), h: Math.round(b.height),
               area: Math.round(b.width * b.height),
               text: (d[i].innerText || '').replace(/\\s+/g, ' ').slice(0, 130), btns: btns });
  }
  out.sort(function(a, b){ return a.area - b.area; });
  return JSON.stringify(out, null, 1);
})()`;

/** Confirm button inside the smallest visible dialog (i.e. the modal). */
const CONFIRM_IN_MODAL = `(function(){
  var d = document.querySelectorAll('[role="dialog"]');
  var best = null, bestArea = 1e12;
  for (var i = 0; i < d.length; i++) {
    var b = d[i].getBoundingClientRect();
    if (b.width < 40 || b.height < 40) continue;
    var a = b.width * b.height;
    if (a < bestArea) { bestArea = a; best = d[i]; }
  }
  if (!best) return null;
  var els = best.querySelectorAll('[role="button"],button');
  for (var j = 0; j < els.length; j++) {
    var t = (els[j].textContent || '').trim();
    if (!/^(Unblock|Confirm|Yes)$/i.test(t)) continue;
    var r = els[j].getBoundingClientRect();
    if (r.width < 4) continue;
    return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
                            t: t, dlg: (best.innerText||'').replace(/\\s+/g,' ').slice(0,120) });
  }
  return null;
})()`;

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /www\.facebook\.com/.test(t.url));
  if (!page) { console.error('no facebook tab'); process.exit(1); }
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);

  await c.send('Page.navigate', { url: 'https://www.facebook.com/settings' }, sessionId);
  await sleep(12000);

  const steps = [
    { name: 'Blocking', expr: byExactText('Blocking'), wait: 6000 },
    { name: 'Edit (profiles)', expr: EDIT_FOR_PROFILES, wait: 6000 },
    { name: 'See your blocked list', expr: byExactText('See your blocked list'), wait: 9000 }
  ];
  for (const s of steps) {
    const t = await ev(c, sessionId, s.expr);
    if (!t) { console.log('step not found: ' + s.name); break; }
    const p = JSON.parse(t);
    console.log('click "' + s.name + '" at ' + p.x + ',' + p.y);
    await click(c, sessionId, p.x, p.y);
    await sleep(s.wait);
  }

  const entries = await ev(c, sessionId, LIST_ENTRIES);
  const rows = JSON.parse(entries || '[]');
  console.log('blocked entries (' + rows.length + '): ' + rows.map(r => r.label).join(', '));

  if (SHOT) {
    const s = await c.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(SHOT, Buffer.from(s.data, 'base64'));
    console.log('screenshot: ' + SHOT);
  }

  if (UNBLOCK) {
    const hit = rows.find(r => new RegExp(UNBLOCK, 'i').test(r.label));
    if (!hit) { console.log('no row matched ' + UNBLOCK); setTimeout(()=>process.exit(2),150); return; }
    console.log('clicking Unblock for "' + hit.label + '" at ' + hit.x + ',' + hit.y);
    await click(c, sessionId, hit.x, hit.y);
    await sleep(5000);

    console.log('dialogs now: ' + await ev(c, sessionId, DIALOGS));

    const confirm = await ev(c, sessionId, CONFIRM_IN_MODAL);
    if (!confirm) { console.log('no confirm control located'); setTimeout(()=>process.exit(2),150); return; }
    const cb = JSON.parse(confirm);
    if (cb.x === hit.x && cb.y === hit.y) {
      console.log('refusing to click the same row button again (no modal appeared)');
      setTimeout(()=>process.exit(2),150); return;
    }
    console.log('modal: ' + cb.dlg);
    console.log('confirming "' + cb.t + '" at ' + cb.x + ',' + cb.y);
    await click(c, sessionId, cb.x, cb.y);
    await sleep(7000);

    const after = JSON.parse(await ev(c, sessionId, LIST_ENTRIES) || '[]');
    console.log('remaining (' + after.length + '): ' + after.map(r => r.label).join(', '));
  }
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
