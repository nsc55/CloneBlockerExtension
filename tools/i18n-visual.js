// Does the welcome page actually speak Vietnamese?
//
// Loads a clean unpacked copy of the extension in a headless Chrome, opens the
// welcome page, reads what it says, drives the language picker the way a person
// would, and reads it again. Then does the same for the other extension pages,
// because a bug in the shared i18n boot would show up on all of them and a bug
// in one page's picker would not.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = require('path').join(__dirname, '..');
const CDP_PORT = 9391;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (d ? '  -- ' + d : ''));
  ok ? pass++ : fail++;
};

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pend = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', () => rej(new Error('cdp socket')));
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

// A clean copy, so nothing here depends on a browser somebody has been using.
function buildExt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-vi-ext-'));
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = rel + '/' + e.name;
      if (e.isDirectory()) walk(child);
      else {
        fs.mkdirSync(path.join(dir, rel), { recursive: true });
        fs.copyFileSync(path.join(ROOT, child), path.join(dir, child));
      }
    }
  };
  walk('src'); walk('icons'); walk('_locales');
  fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  return dir;
}

(async () => {
  const extDir = buildExt();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-vi-prof-'));
  // Current Chrome builds ignore --load-extension; the extension is loaded
  // over CDP instead (Extensions.loadUnpacked), which needs this switch.
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});
  const cleanup = () => {
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(extDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  };
  process.on('exit', cleanup);

  let v = null;
  for (let i = 0; i < 60 && !v; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); }
    catch (e) { await sleep(400); }
  }
  const cdp = new CDP(v.webSocketDebuggerUrl); await cdp.ready;

  const loaded = await cdp.send('Extensions.loadUnpacked', { path: extDir });
  const extId = loaded && loaded.id;
  if (!extId) { console.error('extension never loaded'); process.exit(1); }
  await sleep(1200);
  console.log('extension:', extId);

  const open = async (rel) => {
    const { targetId } = await cdp.send('Target.createTarget',
      { url: `chrome-extension://${extId}/${rel}` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await sleep(1400);
    return { targetId, sessionId };
  };
  const ev = async (sid, expr) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
    return r.result && r.result.value;
  };

  // The Vietnamese the page is supposed to show, read from the locale file so
  // the assertion cannot drift from the translation.
  const vi = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/vi/messages.json'), 'utf8'));
  const enM = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));
  const viHeading = vi.welcome_heading.message;
  const enHeading = enM.welcome_heading.message;

  // ---- the welcome page --------------------------------------------------
  const w = await open('src/welcome/welcome.html');

  const before = await ev(w.sessionId, `
    JSON.stringify({
      heading: (document.querySelector('[data-i18n="welcome_heading"]')||{}).textContent,
      lang: document.documentElement.lang,
      picker: !!document.getElementById('uiLanguage'),
      options: [...document.querySelectorAll('#uiLanguage option')].map(o => o.value)
    })`);
  const b = JSON.parse(before);
  check('the welcome page offers a Vietnamese option', b.picker && b.options.includes('vi'),
    JSON.stringify(b.options));
  // The browser running this harness is English. A fresh install speaks
  // Vietnamese anyway, which is the point of DEFAULT_LANG: the users this is
  // built for overwhelmingly run an English-language Chrome.
  check('and starts in Vietnamese even though the browser is English',
    b.heading === viHeading, JSON.stringify(b.heading));

  const pick = async (lang) => {
    await ev(w.sessionId, `
      (async () => {
        const sel = document.getElementById('uiLanguage');
        sel.value = '${lang}';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 1;
      })()`);
    await sleep(1600);
    return JSON.parse(await ev(w.sessionId, `
      JSON.stringify({
        heading: (document.querySelector('[data-i18n="welcome_heading"]')||{}).textContent,
        lede: (document.querySelector('[data-i18n="welcome_lede"]')||{}).textContent,
        lang: document.documentElement.lang,
        picker: (document.getElementById('uiLanguage')||{}).value,
        step1: (document.querySelector('[data-i18n="welcome_step1Title"]')||{}).textContent
      })`));
  };

  // English first. Switching TO Vietnamese would now prove nothing about the
  // picker, because that is where the page already was.
  const toEn = await pick('en');
  check('choosing English actually switches the page', toEn.heading === enHeading,
    JSON.stringify(toEn.heading));
  check('and the whole page switches, not just one line',
    toEn.lede === enM.welcome_lede.message && toEn.step1 === enM.welcome_step1Title.message,
    JSON.stringify((toEn.step1 || '').slice(0, 40)));

  await ev(w.sessionId, `
    (async () => {
      const sel = document.getElementById('uiLanguage');
      sel.value = 'vi';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 1;
    })()`);
  await sleep(1600);

  const after = JSON.parse(await ev(w.sessionId, `
    JSON.stringify({
      heading: (document.querySelector('[data-i18n="welcome_heading"]')||{}).textContent,
      lede: (document.querySelector('[data-i18n="welcome_lede"]')||{}).textContent,
      lang: document.documentElement.lang,
      picker: (document.getElementById('uiLanguage')||{}).value,
      step1: (document.querySelector('[data-i18n="welcome_step1Title"]')||{}).textContent
    })`));
  check('and choosing Tiếng Việt switches it back', after.heading === viHeading,
    JSON.stringify(after.heading));
  check('the whole page switches, not just one line',
    after.lede === vi.welcome_lede.message && after.step1 === vi.welcome_step1Title.message,
    JSON.stringify((after.step1 || '').slice(0, 40)));
  check('the picker keeps showing the choice that was made', after.picker === 'vi', after.picker);
  check('and <html lang> follows, for spellcheck and screen readers',
    after.lang === 'vi', after.lang);
  await cdp.send('Target.closeTarget', { targetId: w.targetId });

  // ---- the choice persists to the other pages ----------------------------
  for (const [rel, key] of [
    ['src/options/options.html', 'options_pageTitle'],
    ['src/activity/activity.html', 'activity_pageTitle'],
    ['src/welcome/welcome.html', 'welcome_heading']
  ]) {
    if (!vi[key]) { check('locale has a key for ' + rel, false, key); continue; }
    const t = await open(rel);
    const got = await ev(t.sessionId,
      `(document.querySelector('[data-i18n="${key}"]')||{}).textContent`);
    check('after choosing it once, ' + rel.split('/')[1] + ' opens in Vietnamese',
      got === vi[key].message, JSON.stringify(got));
    await cdp.send('Target.closeTarget', { targetId: t.targetId });
  }

  cdp.ws.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' checks passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('failed: ' + e.message); process.exit(1); });
