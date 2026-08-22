/**
 * Diagnostic: determine how this Chrome build allows an unpacked extension to
 * be loaded for automation.
 *
 * Recent Chrome releases restricted the --load-extension command line switch,
 * so the working path may instead be the CDP Extensions domain
 * (Extensions.loadUnpacked), which requires --enable-unsafe-extension-debugging.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9444;

function newestTestExt() {
  const tmp = os.tmpdir();
  const dirs = fs.readdirSync(tmp).filter(d => d.startsWith('cb-ext-'));
  if (!dirs.length) throw new Error('no cb-ext-* dir; run the e2e test with --keep first');
  return dirs.map(d => ({ d: path.join(tmp, d), t: fs.statSync(path.join(tmp, d)).mtimeMs }))
             .sort((a, b) => b.t - a.t)[0].d;
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pend = new Map();
    this.ready = new Promise(r => this.ws.addEventListener('open', r));
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) {
        const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
  }
  send(method, params) {
    const i = ++this.id;
    return new Promise((res, rej) => {
      this.pend.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params: params || {} }));
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 15000);
    });
  }
}

(async () => {
  const extDir = newestTestExt();
  console.log('extension dir:', extDir);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ];
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', d => { stderr += d; });

  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://localhost:${PORT}/json/version`)).json(); break; }
    catch (e) { await sleep(400); }
  }
  if (!version) { console.log('CDP never came up\n', stderr.slice(0, 2000)); chrome.kill(); return; }
  console.log('browser:', version.Browser);

  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  const before = await cdp.send('Target.getTargets');
  console.log('service workers (via --load-extension):',
    before.targetInfos.filter(t => t.type === 'service_worker').map(t => t.url));

  // Does this build expose the Extensions domain?
  try {
    const r = await cdp.send('Extensions.loadUnpacked', { path: extDir });
    console.log('Extensions.loadUnpacked OK ->', JSON.stringify(r));
  } catch (e) {
    console.log('Extensions.loadUnpacked ERROR ->', e.message);
  }

  await sleep(3000);
  const after = await cdp.send('Target.getTargets');
  console.log('service workers after loadUnpacked:',
    after.targetInfos.filter(t => t.type === 'service_worker').map(t => t.url));

  const extLines = stderr.split('\n').filter(l => /extension|manifest/i.test(l)).slice(0, 8);
  if (extLines.length) console.log('chrome stderr:\n' + extLines.join('\n'));

  chrome.kill();
  setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error(e); process.exit(1); });
