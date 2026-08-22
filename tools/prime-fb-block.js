/**
 * Opens a Facebook profile's overflow menu to force the lazily-bundled block
 * module to load, then reports what became reachable.
 *
 *   node tools/prime-fb-block.js https://www.facebook.com/fake.tiger.01/
 *
 * Opens a menu and reads it. Nothing inside the menu is ever clicked, and the
 * menu is dismissed afterwards.
 */
const CDP_PORT = 9333;
const TARGET = process.argv[2] || 'https://www.facebook.com/';
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
  const r = await c.send('Runtime.evaluate',
    { expression: expr, returnByValue: true, userGesture: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result && r.result.value;
}
async function click(c, s, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s);
  }
}

const PROBE = `
  (() => {
    const req = (n) => { try { const m = window.require(n); return m && m.__esModule && m.default !== undefined ? m.default : m; } catch (e) { return null; } };
    const names = [
      'ProfileCometActionBlockUserMutation.graphql',
      'ProfileCometActionBlockUserMutation_facebookRelayOperation',
      'BlockingSettingsBlockMutation.graphql',
      'useGroupsCometBlockUserMutation.graphql',
      'CometBlockUserMutation.graphql',
      'FBBlockUserMutation.graphql'
    ];
    const out = { resolved: {}, missing: [] };
    for (const n of names) {
      const r = req(n);
      if (r && r.params) out.resolved[n] = { doc_id: r.params.id, op: r.params.name, kind: r.params.operationKind };
      else out.missing.push(n);
    }
    return JSON.stringify(out, null, 2);
  })()`;

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /www\.facebook\.com/.test(t.url));
  if (!page) { console.error('no www.facebook.com tab'); process.exit(1); }
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);

  await c.send('Page.navigate', { url: TARGET }, sessionId);
  await sleep(11000);
  console.log('before priming: ' + await ev(c, sessionId, PROBE));

  // Facebook labels this control variously; match anything option-ish that sits
  // in the profile action row rather than the top chrome.
  const btn = await ev(c, sessionId, `
    (() => {
      const cands = [];
      // Facebook does not label this control tidily -- on a profile it reads
      // "Profile settings see more options", so an exact match finds nothing.
      // Match on intent (a menu popup whose label mentions more/options) and
      // rank the profile-actions one above the section tabs.
      document.querySelectorAll('[role="button"],[aria-haspopup]').forEach(el => {
        const label = (el.getAttribute('aria-label') || '').trim();
        const txt = (el.textContent || '').trim();
        const pop = el.getAttribute('aria-haspopup') || '';
        const looksMenu = pop === 'menu' || pop === 'true';
        const saysMore = /more options|see more|^more$|^options$|^actions$/i.test(label) ||
                         /^(\\.\\.\\.|…)$/.test(txt);
        if (!(looksMenu && saysMore)) return;
        const b = el.getBoundingClientRect();
        if (b.width < 8 || b.height < 8 || b.y < 120) return;
        // "More profile sections" is the tab overflow, not the actions menu.
        const isSections = /profile sections/i.test(label);
        cands.push({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2),
                     label: label || txt, isSections, x0: Math.round(b.x) });
      });
      cands.sort((a, b) => (a.isSections - b.isSections) || (b.x0 - a.x0));
      return JSON.stringify(cands.slice(0, 6));
    })()`);
  console.log('overflow candidates: ' + btn);

  const cands = JSON.parse(btn);
  if (!cands.length) {
    console.log('no overflow button found on this profile');
    setTimeout(() => process.exit(0), 150); return;
  }

  for (const b of cands.slice(0, 3)) {
    console.log('clicking "' + b.label + '" at ' + b.x + ',' + b.y);
    await click(c, sessionId, b.x, b.y);
    await sleep(4500);
    const items = await ev(c, sessionId,
      `JSON.stringify(Array.from(document.querySelectorAll('[role="menuitem"]')).map(e => (e.textContent||'').trim()).filter(Boolean).slice(0, 14))`);
    console.log('  menu: ' + items);
    if (/Block/i.test(items)) { console.log('  -> block option present'); break; }
    for (const t of ['keyDown', 'keyUp']) {
      await c.send('Input.dispatchKeyEvent',
        { type: t, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    }
    await sleep(1200);
  }

  await sleep(2500);
  console.log('after menu:     ' + await ev(c, sessionId, PROBE));

  // On Threads the mutation module only appeared once the confirmation DIALOG
  // was raised, not merely the menu. Do the same here, and dismiss it.
  if (process.argv.includes('--open-dialog')) {
    const blockItem = await ev(c, sessionId, `
      (() => {
        for (const el of document.querySelectorAll('[role="menuitem"]')) {
          if (!/^Block$/i.test((el.textContent || '').trim())) continue;
          const b = el.getBoundingClientRect();
          if (b.width < 4) continue;
          return JSON.stringify({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) });
        }
        return null;
      })()`);
    if (blockItem) {
      const p = JSON.parse(blockItem);
      console.log('opening the Block dialog (will NOT confirm) at ' + p.x + ',' + p.y);
      await click(c, sessionId, p.x, p.y);
      await sleep(5000);

      const dlg = await ev(c, sessionId, `
        JSON.stringify({
          text: (document.querySelector('[role="dialog"]')?.innerText || '').slice(0, 240),
          buttons: Array.from(document.querySelectorAll('[role="dialog"] [role="button"]'))
            .map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 8)
        })`);
      console.log('dialog: ' + dlg);
      console.log('after dialog:   ' + await ev(c, sessionId, PROBE));

      // Dismiss: prefer an explicit Cancel over Escape.
      const cancel = await ev(c, sessionId, `
        (() => {
          for (const el of document.querySelectorAll('[role="dialog"] [role="button"]')) {
            if (!/^(Cancel|Close)$/i.test((el.textContent || '').trim())) continue;
            const b = el.getBoundingClientRect();
            if (b.width < 4) continue;
            return JSON.stringify({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) });
          }
          return null;
        })()`);
      if (cancel) {
        const cp = JSON.parse(cancel);
        console.log('clicking Cancel');
        await click(c, sessionId, cp.x, cp.y);
      }
      await sleep(1500);
    } else {
      console.log('no Block menu item found to open the dialog with');
    }
  }

  for (const t of ['keyDown', 'keyUp']) {
    await c.send('Input.dispatchKeyEvent',
      { type: t, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  }
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
