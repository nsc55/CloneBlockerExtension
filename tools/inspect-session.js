/**
 * Inspects the running dev-session browser (see tools/dev-session.js).
 *
 * Everything here is READ-ONLY with respect to the account. It reports what the
 * extension can see and do while signed in; it never issues a block. The one
 * exception is `--dry-block <id>`, which asks the MAIN world to resolve a
 * strategy and report what it *would* send, with dryRun forced on, so no
 * request that changes anything is ever made.
 *
 *   node tools/inspect-session.js
 *   node tools/inspect-session.js --dry-block 63082166531
 */
const CDP_PORT = parseInt(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1] : '9333', 10);
const DRY_BLOCK = process.argv.includes('--dry-block')
  ? process.argv[process.argv.indexOf('--dry-block') + 1] : null;

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Resolve the extension id.
 *
 * Preferring the file written by dev-session.js matters: MV3 service workers
 * shut down when idle, so looking for a service_worker target finds nothing
 * most of the time even though the extension is installed and fine.
 */
async function resolveExtId(cdp) {
  const f = path.join(os.tmpdir(), 'claude', 'C--src-3queblocker', 'dev-session', 'session.json');
  try {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (rec && rec.extId) return rec.extId;
  } catch (e) { /* fall through */ }
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find(t => t.type === 'service_worker' &&
                                   t.url.includes('src/background/service-worker.js'));
  return sw ? new URL(sw.url).host : null;
}

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
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 60000);
    });
  }
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
                    r.exceptionDetails.text);
  }
  return r.result && r.result.value;
}

function line(k, v) { console.log('  ' + String(k).padEnd(26) + (v === undefined ? '' : v)); }
function head(t) { console.log('\n' + t + '\n' + '-'.repeat(t.length)); }

(async () => {
  let version;
  try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); }
  catch (e) { console.error('No browser on port ' + CDP_PORT + '. Run: node tools/dev-session.js'); process.exit(1); }

  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  const extId = await resolveExtId(cdp);
  if (!extId) { console.error('extension not found; run: node tools/dev-session.js'); process.exit(1); }

  // Work through an extension page: it has full chrome.* and can message both
  // the service worker and any content script.
  const { targetId } = await cdp.send('Target.createTarget',
    { url: `chrome-extension://${extId}/src/options/options.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(1200);

  const cleanup = async () => { try { await cdp.send('Target.closeTarget', { targetId }); } catch (e) {} };

  // -- which tabs are open on a supported site? -----------------------------
  const tabsRaw = await evalIn(cdp, sessionId, `
    (async () => {
      const tabs = await chrome.tabs.query({
        url: ['https://*.facebook.com/*','https://*.threads.net/*','https://*.threads.com/*'] });
      return JSON.stringify(tabs.map(t => ({ id: t.id, url: t.url, title: t.title })));
    })()
  `);
  const tabs = JSON.parse(tabsRaw);

  // Reloading the extension orphans the content scripts already injected into
  // open tabs -- they keep running but their message port is dead, which shows
  // up as "Receiving end does not exist". A page reload re-injects them.
  if (process.argv.includes('--reload') && tabs.length) {
    console.log('reloading ' + tabs.length + ' tab(s) to re-inject content scripts...');
    await evalIn(cdp, sessionId,
      `(async () => { ${tabs.map(t => `chrome.tabs.reload(${t.id});`).join(' ')} return 1; })()`);
    await sleep(12000);
  }

  head('Session');
  line('extension', extId);
  line('supported tabs open', tabs.length);
  for (const t of tabs) line('', t.url.slice(0, 90));

  if (!tabs.length) {
    console.log('\nOpen a Facebook or Threads tab in that browser first.');
    await cleanup(); process.exit(0);
  }

  // -- per-tab status -------------------------------------------------------
  for (const t of tabs) {
    let st;
    try {
      const raw = await evalIn(cdp, sessionId, `
        new Promise(r => chrome.tabs.sendMessage(${t.id}, { type: 'tab:status' },
          x => r(JSON.stringify(x || { error: (chrome.runtime.lastError||{}).message }))))
      `);
      st = JSON.parse(raw);
    } catch (e) { st = { error: e.message }; }

    head('Tab ' + t.id + ' — ' + (st.platform || '?'));
    if (st.error) { line('error', st.error); continue; }

    line('bridge handshake', st.handshake ? 'connected' : 'NOT CONNECTED');
    line('signed in as', st.viewerId || 'SIGNED OUT');
    line('blocklist', st.identity
      ? `${st.identity.blockedIds} ids, ${st.identity.blockedUsernames} usernames` : '?');
    line('aliases learned', st.identity ? st.identity.aliasesKnown : '?');
    line('hidden on this page', st.dom ? st.dom.hidden : '?');
    line('containers scanned', st.dom ? st.dom.scanned : '?');
    if (st.unresolved && st.unresolved.length) {
      line('unresolved usernames', st.unresolved.join(', ').slice(0, 80));
    }

    const cap = st.capability;
    if (!cap) { line('capability', 'not reported yet'); continue; }
    line('relay environment', cap.hasRelay ? `${cap.relayEnv} (${cap.relayRecords} records)` : 'NONE');
    line('commitMutation', cap.hasCommitMutation ? 'available' : 'MISSING');
    line('modules indexed', `${cap.moduleCount} (${cap.graphqlModuleCount} graphql)`);
    line('fb_dtsg / lsd', `${cap.hasDtsg ? 'yes' : 'no'} / ${cap.hasLsd ? 'yes' : 'no'}`);
    line('learned template', cap.hasLearnedTemplate ? 'yes' : 'no');
    line('captured requests', cap.capturedCount);

    const cands = cap.blockMutationCandidates || [];
    head('  Block mutation candidates (' + cands.length + ')');
    if (!cands.length) {
      console.log('  none yet — the module loads lazily. Open a profile, open its "..." menu,');
      console.log('  choose Block and then Cancel in the confirmation: that loads the');
      console.log('  operation (useTHUserBlockMutation on Threads) and blocks nobody.');
    }
    for (const c of cands.slice(0, 10)) {
      console.log('  ' + (c.params
        ? `${c.params.name}  doc_id=${c.params.id}  [${c.params.kind}]`
        : c.name + '  (not resolved)'));
    }
  }

  // -- optional: list registered modules matching a pattern ----------------
  if (process.argv.includes('--modules')) {
    const pattern = process.argv[process.argv.indexOf('--modules') + 1] || 'block';
    head('Modules matching /' + pattern + '/i');
    const raw = await evalIn(cdp, sessionId, `
      new Promise(r => chrome.tabs.sendMessage(${tabs[0].id},
        { type: 'tab:dump-modules', pattern: ${JSON.stringify(pattern)} },
        x => r(JSON.stringify(x || { error: (chrome.runtime.lastError||{}).message }))))
    `);
    const parsed = JSON.parse(raw);
    if (!parsed.ok) { console.log('  ' + (parsed.error || 'failed')); }
    else {
      const res = parsed.res || {};
      line('modules total', res.total);
      line('matched', res.matched);
      console.log('');
      for (const n of res.names || []) console.log('  ' + n);
      if ((res.resolved || []).length) {
        head('  Resolved Relay operations');
        for (const r of res.resolved) {
          console.log(`  ${r.op}  doc_id=${r.id}  [${r.kind}]`);
        }
      }
    }
  }

  // -- optional: resolve a strategy without sending anything ---------------
  if (DRY_BLOCK) {
    head('Dry-run strategy resolution for ' + DRY_BLOCK);
    console.log('  (dryRun is forced on — nothing is sent that changes anything)\n');
    // Pick the tab explicitly when several supported sites are open, otherwise
    // a dry run aimed at Facebook can land on the Threads tab.
    const want = process.argv.includes('--site')
      ? process.argv[process.argv.indexOf('--site') + 1] : null;
    const target = (want && tabs.find(t => t.url.includes(want))) || tabs[0];
    console.log('  against tab: ' + target.url.slice(0, 70));
    const raw = await evalIn(cdp, sessionId, `
      new Promise(r => chrome.tabs.sendMessage(${target.id},
        { type: 'tab:dry-block', targetId: ${JSON.stringify(String(DRY_BLOCK))} },
        x => r(JSON.stringify(x || { error: (chrome.runtime.lastError||{}).message }))))
    `);
    console.log(raw);
  }

  await cleanup();
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message); process.exit(1); });
