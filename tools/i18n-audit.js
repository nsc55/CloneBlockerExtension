// Read every visible string on the extension's pages, in Vietnamese, and
// report anything that is still English.
//
// The point is not to check a list of keys -- locale parity already passes,
// with 316 keys on both sides and nothing missing. What that cannot see is
// text a page renders WITHOUT asking the translator: a literal in a script, a
// label that fell back to its key, a value echoed straight from data. So this
// looks at the rendered page instead, which is the only place that shows.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const CDP_PORT = 9393;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pend = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', () => rej(new Error('cdp')));
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) {
        const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
  }
  send(method, params, sessionId) {
    const i = ++this.id;
    const pl = { id: i, method, params: params || {} };
    if (sessionId) pl.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pend.set(i, { res, rej }); this.ws.send(JSON.stringify(pl));
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
}

function findChrome() {
  for (const p of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ]) if (fs.existsSync(p)) return p;
  throw new Error('no chrome');
}

function buildExt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-audit-ext-'));
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = rel + '/' + e.name;
      if (e.isDirectory()) walk(child);
      else {
        fs.mkdirSync(path.join(dir, rel), { recursive: true });
        fs.copyFileSync(path.join(REPO, child), path.join(dir, child));
      }
    }
  };
  walk('src'); walk('icons'); walk('_locales');
  fs.copyFileSync(path.join(REPO, 'manifest.json'), path.join(dir, 'manifest.json'));
  return dir;
}

(async () => {
  const extDir = buildExt();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-audit-prof-'));
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});
  process.on('exit', () => {
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(extDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  });

  let v = null;
  for (let i = 0; i < 60 && !v; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); }
    catch (e) { await sleep(400); }
  }
  const cdp = new CDP(v.webSocketDebuggerUrl); await cdp.ready;
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: extDir });
  await sleep(1500);

  const open = async (rel) => {
    const { targetId } = await cdp.send('Target.createTarget',
      { url: `chrome-extension://${extId}/${rel}` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await sleep(1500);
    return { targetId, sessionId };
  };
  const ev = async (sid, expr) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  };

  // Switch to Vietnamese, and seed enough state that every chip, control and
  // empty-state actually renders. An unpopulated page hides most of its text.
  const opt = await open('src/options/options.html');
  await ev(opt.sessionId, `
    (async () => {
      const got = await chrome.storage.sync.get('settings');
      const s = Object.assign({}, got.settings || {}, { uiLanguage: 'vi' });
      await chrome.storage.sync.set({ settings: s });
      const now = Date.now();
      await chrome.storage.local.set({
        platformQueue: { threads: [
          { id: '9900000001', at: now, warm: true,  rank: 3.2, user: true },
          { id: '9900000002', at: now, warm: false, rank: 1.1 },
          { id: '9900000003', at: now, warm: false, rank: 0.4 }
        ], facebook: [ { id: '8800000001', at: now, warm: true, rank: 2 } ] },
        cooldowns: { 'threads:9900000002': now + 900000 },
        failures:  { 'threads:9900000002': 2 },
        blockLog: [
          { platform: 'threads',  id: '7700000001', ok: true,  dryRun: false, at: now - 60000,  warm: true,  rank: 2.5 },
          { platform: 'threads',  id: '7700000002', ok: false, dryRun: false, at: now - 120000, detail: 'no mutation' },
          { platform: 'facebook', id: '7700000003', ok: true,  dryRun: true,  at: now - 300000 }
        ],
        blocklist: {
          ids: ['7700000001', '9900000001'], usernames: [],
          idTags: { '7700000001': 'redbull', '9900000001': 'clone', '9900000002': 'scam' },
          targets: [], fetchedAt: now, source: 'x', count: 2,
          updatedAt: new Date(now).toISOString()
        },
        idNames: { 'threads:9900000001': { u: 'someclone', d: 'Ai Do' } }
      });
      return 1;
    })()`);
  await cdp.send('Target.closeTarget', { targetId: opt.targetId });

  // Vietnamese uses Latin letters with diacritics, so "is this English?" cannot
  // be decided by script. What CAN be decided: a run of ASCII-only words that
  // appears verbatim in the English locale and does NOT appear in the
  // Vietnamese one is English text that reached the screen untranslated.
  const en = JSON.parse(fs.readFileSync(path.join(REPO, '_locales/en/messages.json'), 'utf8'));
  const vi = JSON.parse(fs.readFileSync(path.join(REPO, '_locales/vi/messages.json'), 'utf8'));
  const enText = new Map();     // normalised english message -> key
  const viText = new Set();
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  for (const k of Object.keys(en)) {
    const m = (en[k].message || '').replace(/<\/?[bc]>/g, '');
    if (m.length > 2) enText.set(norm(m), k);
  }
  for (const k of Object.keys(vi)) {
    const m = (vi[k].message || '').replace(/<\/?[bc]>/g, '');
    if (m.length > 2) viText.add(norm(m));
  }

  const PAGES = [
    'src/activity/activity.html',
    'src/options/options.html',
    'src/welcome/welcome.html',
    'src/popup/popup.html'
  ];

  let findings = 0;
  for (const rel of PAGES) {
    const p = await open(rel);
    const lang = await ev(p.sessionId, 'document.documentElement.lang');
    // Every visible text node and every control label, with where it sits.
    const raw = await ev(p.sessionId, `
      JSON.stringify((() => {
        const out = [];
        const seen = new Set();
        const push = (text, where) => {
          const t = String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
          if (!t || t.length < 3) return;
          const k = t + '|' + where;
          if (seen.has(k)) return;
          seen.add(k);
          out.push({ t, where });
        };
        const walk = (node, path) => {
          for (const child of node.childNodes) {
            if (child.nodeType === 3) {
              const el = child.parentElement;
              if (!el) continue;
              const cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              if (el.closest('.hidden')) continue;
              push(child.nodeValue, el.tagName.toLowerCase() +
                (el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : ''));
            } else if (child.nodeType === 1) {
              if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
              if (child.placeholder) push(child.placeholder, 'placeholder');
              if (child.title) push(child.title, 'title');
              const al = child.getAttribute && child.getAttribute('aria-label');
              if (al) push(al, 'aria-label');
              walk(child, path);
            }
          }
        };
        walk(document.body, '');
        return out;
      })())`);
    const strings = JSON.parse(raw);

    const english = strings.filter(s => {
      const n = norm(s.t);
      return enText.has(n) && !viText.has(n);
    });

    console.log('\\n' + rel + '  (lang=' + lang + ', ' + strings.length + ' strings)');
    if (!english.length) console.log('  -- all translated');
    for (const e of english) {
      findings++;
      console.log('  ENGLISH  ' + JSON.stringify(e.t).slice(0, 78) +
                  '\\n           key=' + enText.get(norm(e.t)) + '  at ' + e.where);
    }
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
  }

  cdp.ws.close();
  console.log('\\n' + findings + ' untranslated string(s) on screen');
  process.exit(0);
})().catch(e => { console.error('failed: ' + e.message); process.exit(1); });
