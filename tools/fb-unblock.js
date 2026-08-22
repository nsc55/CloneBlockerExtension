/**
 * Unblocks someone on Facebook through the site's own Blocking settings UI.
 *
 *   node tools/fb-unblock.js "Quoc Nghi"
 *
 * Drives the same buttons a person would. Used to restore state after a block
 * test. Reports what it finds if it cannot locate the entry, rather than
 * clicking blindly.
 */
const CDP_PORT = 9333;
const NAME = process.argv[2];
if (!NAME) { console.error('usage: node tools/fb-unblock.js "<display name>"'); process.exit(1); }
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

// Find a clickable whose text matches, optionally near a given label.
function finderExpr(pattern, nearText) {
  return [
    '(function(){',
    '  var re = ' + pattern + ';',
    '  var near = ' + (nearText ? JSON.stringify(nearText) : 'null') + ';',
    '  var els = document.querySelectorAll("[role=\\"button\\"],button,a[role=\\"link\\"]");',
    '  for (var i = 0; i < els.length; i++) {',
    '    var el = els[i];',
    '    var t = (el.textContent || "").trim();',
    '    var l = (el.getAttribute("aria-label") || "").trim();',
    '    if (!re.test(t) && !re.test(l)) continue;',
    '    if (near) {',
    '      var row = el.closest("div");',
    '      for (var d = 0; d < 6 && row; d++) {',
    '        if ((row.innerText || "").indexOf(near) !== -1) break;',
    '        row = row.parentElement;',
    '      }',
    '      if (!row || (row.innerText || "").indexOf(near) === -1) continue;',
    '    }',
    '    var b = el.getBoundingClientRect();',
    '    if (b.width < 4 || b.height < 4) continue;',
    '    // A synthetic mouse event is dispatched at viewport coordinates, so an',
    '    // element scrolled out of view would be clicked at empty space. Bring',
    '    // it on screen and re-measure before reporting a position.',
    '    if (b.y < 0 || b.bottom > (window.innerHeight || 0)) {',
    '      el.scrollIntoView({ block: "center" });',
    '      b = el.getBoundingClientRect();',
    '    }',
    '    return JSON.stringify({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2),',
    '                            t: (t || l).slice(0, 40) });',
    '  }',
    '  return null;',
    '})()'
  ].join('\n');
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

  // The historical ?tab=blocking URL now lands on the settings index -- the SPA
  // only renders the blocking panel when its nav item is clicked. So load
  // settings, then click through.
  await c.send('Page.navigate', { url: 'https://www.facebook.com/settings' }, sessionId);
  await sleep(12000);

  const nav = await ev(c, sessionId, finderExpr('/^Blocking$/i'));
  if (nav) {
    const nb = JSON.parse(nav);
    console.log('clicking settings nav "Blocking" at ' + nb.x + ',' + nb.y);
    await click(c, sessionId, nb.x, nb.y);
    await sleep(9000);
  } else {
    // Fall back to the link's href if the label is not directly clickable.
    const href = await ev(c, sessionId,
      '(function(){var as=document.querySelectorAll("a[href]");for(var i=0;i<as.length;i++){' +
      'if(/^Blocking/i.test((as[i].textContent||"").trim()))return JSON.stringify(as[i].href);}return null;})()');
    if (href) {
      await c.send('Page.navigate', { url: JSON.parse(href) }, sessionId);
      await sleep(11000);
    }
  }

  // The panel lists categories, not people. The blocked-profile list lives
  // behind the "Edit" next to "Block profiles and Pages".
  // Walking up the DOM for a section heading picked the wrong row -- every
  // section shares an ancestor whose text contains all of them. Match on
  // geometry instead: the Edit that sits on the same line as the heading.
  const edit = await ev(c, sessionId, [
    '(function(){',
    '  var heads = document.querySelectorAll("span,div,h2,h3");',
    '  var head = null;',
    '  for (var i = 0; i < heads.length; i++) {',
    '    if ((heads[i].textContent || "").trim() === "Block profiles and Pages") {',
    '      var hb = heads[i].getBoundingClientRect();',
    '      if (hb.height > 0 && hb.width > 0) { head = hb; break; }',
    '    }',
    '  }',
    '  if (!head) return null;',
    '  var best = null, bestD = 1e9;',
    '  var els = document.querySelectorAll("[role=\\"button\\"]");',
    '  for (var j = 0; j < els.length; j++) {',
    '    if ((els[j].textContent || "").trim() !== "Edit") continue;',
    '    var b = els[j].getBoundingClientRect();',
    '    if (b.width < 4) continue;',
    '    var d = Math.abs((b.y + b.height/2) - (head.y + head.height/2));',
    '    if (d < bestD) { bestD = d; best = b; }',
    '  }',
    '  if (!best) return null;',
    '  return JSON.stringify({ x: Math.round(best.x + best.width/2),',
    '                          y: Math.round(best.y + best.height/2), dy: Math.round(bestD) });',
    '})()'
  ].join('\n'));
  if (edit) {
    const eb = JSON.parse(edit);
    console.log('opening "Block profiles and Pages" at ' + eb.x + ',' + eb.y);
    await click(c, sessionId, eb.x, eb.y);
    await sleep(7000);
  } else {
    console.log('could not find the Edit control for blocked profiles');
  }

  // That Edit opens a chooser, not the list itself.
  const seeList = await ev(c, sessionId, finderExpr('/^See your blocked list$/i'));
  if (seeList) {
    const sb = JSON.parse(seeList);
    console.log('clicking "See your blocked list" at ' + sb.x + ',' + sb.y);
    await click(c, sessionId, sb.x, sb.y);
    await sleep(8000);
  } else {
    console.log('no "See your blocked list" entry found');
  }

  const state = await ev(c, sessionId,
    '(function(){var t=document.body.innerText||"";return JSON.stringify({url:location.href.slice(0,80),hasName:t.indexOf(' +
    JSON.stringify(NAME) + ')!==-1,hasUnblock:/Unblock/i.test(t),head:t.split("\\n").filter(function(l){return l.trim()}).slice(0,12).join(" | ").slice(0,280)});})()');
  console.log(state);
  const parsed = JSON.parse(state);
  const found = parsed.hasName && parsed.hasUnblock;
  if (!found) {
    console.log('could not find a Blocking settings page listing that name');
    setTimeout(() => process.exit(2), 150); return;
  }

  const btn = await ev(c, sessionId, finderExpr('/^Unblock$/i', NAME));
  if (!btn) { console.log('no Unblock button next to that name'); setTimeout(()=>process.exit(2),150); return; }
  const b = JSON.parse(btn);
  console.log('clicking Unblock at ' + b.x + ',' + b.y);
  await click(c, sessionId, b.x, b.y);
  await sleep(4000);

  const dlg = await ev(c, sessionId,
    '(function(){var d=document.querySelector("[role=\\"dialog\\"]");return JSON.stringify({text:(d?d.innerText:"").slice(0,200)});})()');
  console.log('dialog: ' + dlg);

  const confirm = await ev(c, sessionId,
    '(function(){var els=document.querySelectorAll("[role=\\"dialog\\"] [role=\\"button\\"],[role=\\"dialog\\"] button");' +
    'for(var i=0;i<els.length;i++){var t=(els[i].textContent||"").trim();if(!/^(Unblock|Confirm)$/i.test(t))continue;' +
    'var b=els[i].getBoundingClientRect();if(b.width<4)continue;' +
    'return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),t:t});}return null;})()');
  if (confirm) {
    const cb = JSON.parse(confirm);
    console.log('confirming: ' + cb.t);
    await click(c, sessionId, cb.x, cb.y);
    await sleep(5000);
  } else {
    console.log('no confirmation dialog appeared (may have unblocked directly)');
  }

  const after = await ev(c, sessionId,
    '(function(){var t=document.body.innerText||"";return JSON.stringify({stillListed:t.indexOf(' +
    JSON.stringify(NAME) + ')!==-1});})()');
  console.log('after: ' + after);
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
