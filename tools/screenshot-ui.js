/**
 * Renders the extension's popup and options pages in real Chrome and saves
 * PNGs, so the UI can be eyeballed without a manual install.
 *
 *   node tools/screenshot-ui.js [outDir]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'cb-shots');
const CDP_PORT = 9355;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  send(method, params, sessionId) {
    const i = ++this.id;
    const payload = { id: i, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pend.set(i, { res, rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
    });
  }
}

function findChrome() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome'
  ]) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-shot-'));
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});

  let v = null;
  for (let i = 0; i < 40; i++) {
    try { v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); break; }
    catch (e) { await sleep(400); }
  }
  if (!v) { console.error('CDP did not start'); chrome.kill(); process.exit(1); }

  const cdp = new CDP(v.webSocketDebuggerUrl);
  await cdp.ready;
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
  console.log('loaded', extId);

  const shots = [
    { name: 'options', url: `chrome-extension://${extId}/src/options/options.html`, w: 760, h: 1500 },
    { name: 'popup', url: `chrome-extension://${extId}/src/popup/popup.html`, w: 360, h: 640 }
  ];

  for (const s of shots) {
    for (const scheme of ['light', 'dark']) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: s.w, height: s.h, deviceScaleFactor: 2, mobile: false }, sessionId);
      await cdp.send('Page.navigate', { url: s.url }, sessionId);
      await sleep(2500);
      const shot = await cdp.send('Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true }, sessionId);
      const file = path.join(OUT, `${s.name}-${scheme}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('wrote', file);
      await cdp.send('Target.closeTarget', { targetId });
    }
  }

  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error(e); process.exit(1); });
