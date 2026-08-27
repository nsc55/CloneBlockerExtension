/**
 * Unit tests for the MAIN-world script, src/main/inject.js.
 *
 * That file runs inside Meta's page with no extension API, and until now had
 * no test at all: everything it does was only ever checked by hand against a
 * signed-in browser. The 1.0.4 failure lived entirely in it -- a settings
 * QUERY with "block" in its name was captured as the block template, promoted
 * into the ladder, executed as the only candidate on every Facebook tab, and
 * its answer (an ARRAY of payloads, which is how Facebook's Relay network
 * layer delivers everything) was read as "no data". Three separate mistakes,
 * none of which a service-worker test can reach.
 *
 * The script is loaded into a vm context that stands in for the page: a
 * window that records what the MAIN world posts back, a require() serving a
 * fake Relay environment, and a fetch the observer can hook. The isolated
 * world is played by this file -- handshake, config push, block request --
 * so the real message handler, the real ladder and the real response reader
 * are what run.
 *
 *   node tools/inject-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// CB_INJECT points this at another copy of the script -- the regression check
// runs it against the 1.0.4 file to prove these cases would have failed there.
const SRC = fs.readFileSync(process.env.CB_INJECT ||
  path.join(__dirname, '..', 'src', 'main', 'inject.js'), 'utf8');
const MARK = '__cloneblocker_bridge__';
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * A page for the script to live in.
 *
 * opts.hostname   which site this is (decides PLATFORM inside the script)
 * opts.modules    what window.require() answers, by name
 */
function makePage(opts) {
  opts = opts || {};
  const hostname = opts.hostname || 'www.facebook.com';
  const origin = 'https://' + hostname;
  const posted = [];        // every message the MAIN world posted to the page
  const listeners = {};     // window event listeners the script installed
  const fetches = [];       // what went through the (hooked) fetch
  const modules = opts.modules || {};

  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};
  XMLHttpRequest.prototype.setRequestHeader = function () {};

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, TextEncoder,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    performance: { now: () => Number(process.hrtime.bigint() / 1000000n) },
    location: { hostname, origin, href: origin + '/', protocol: 'https:' },
    document: {
      cookie: 'c_user=1000000000001; ds_user_id=1000000000001',
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      documentElement: { innerHTML: '' },
      body: null,
      readyState: 'loading'
    },
    navigator: { userAgent: 'test' },
    require: (name) => {
      if (!(name in modules)) throw new Error('Requiring unknown module "' + name + '"');
      return modules[name];
    },
    fetch: (input, init) => {
      fetches.push({ url: String(typeof input === 'string' ? input : (input && input.url)), init });
      return Promise.resolve({ status: 200, text: async () => '{}' });
    },
    XMLHttpRequest,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    postMessage: (msg, targetOrigin) => { posted.push({ msg, targetOrigin }); }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'inject.js' });
  // Inside the context `window` is the global proxy, not the object handed to
  // createContext, and the script compares ev.source against THAT.
  const win = vm.runInContext('window', sandbox);

  const NONCE = 'iso-nonce-1';
  let tickets = 0;
  const deliver = (data) => { for (const fn of listeners.message || []) fn({ source: win, data }); };
  const send = (type, payload, nonce) => deliver({
    [MARK]: true, dir: 'iso->main', type, nonce: nonce === undefined ? NONCE : nonce, payload
  });
  const messages = () => posted.map(p => p.msg);
  const ofType = (type) => messages().filter(m => m && m.type === type);

  return {
    sandbox, posted, fetches, messages, ofType,
    async handshake() { send('iso:hello', { nonce: NONCE, debug: false }, null); await sleep(10); },
    async config(p) { send('iso:set-config', p); await sleep(10); },
    /** Send a request carrying a ticket and return the reply that echoes it. */
    async request(type, payload, replyType, waitMs) {
      const ticket = 't' + (++tickets);
      send(type, Object.assign({ ticket }, payload));
      await sleep(waitMs || 40);
      return ofType(replyType).map(m => m.payload).find(p => p && p.ticket === ticket) || null;
    },
    captured() {
      return ofType('main:capability').map(m => m.payload && m.payload.capturedTemplate).filter(Boolean);
    }
  };
}

/** A Relay environment whose network answers every execute() with `respond`. */
function relayModules(executed, respond) {
  return {
    CometRelayEnvironment: {
      getStore: () => ({ getSource: () => ({ getRecordIDs: () => ['record:1'], get: () => null }) }),
      getNetwork: () => ({
        execute: (params, variables) => {
          executed.push({ id: params.id, name: params.name, kind: params.operationKind, variables });
          return {
            subscribe: (obs) => {
              const r = respond(params);
              if (r.error) obs.error(r.error);
              else obs.next(r.payload);
              return { unsubscribe() {} };
            }
          };
        }
      })
    }
  };
}

const graphqlPost = (page, friendly, docId, variables) => page.sandbox.fetch(
  'https://www.facebook.com/api/graphql/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'av=1000000000001&__user=1000000000001&fb_dtsg=x&jazoest=1&lsd=y' +
          '&fb_api_req_friendly_name=' + friendly + '&doc_id=' + docId +
          '&variables=' + encodeURIComponent(JSON.stringify(variables))
  });

(async () => {
  // -- 1. capture mode believes only a block MUTATION -----------------------
  {
    const page = makePage();
    await page.handshake();

    await graphqlPost(page, 'RTWebCallBlockSettingHooksQuery', '9989124061109700', {});
    await sleep(10);
    check('a settings QUERY with "block" in its name is not captured as a block request',
      page.captured().length === 0, JSON.stringify(page.captured().map(t => t.friendlyName)));

    await graphqlPost(page, 'ProfileCometActionUnblockUserMutation', '1234567890', { input: { user_id: 100012345678901 } });
    await sleep(10);
    check('an UNBLOCK mutation is not captured either',
      page.captured().length === 0, JSON.stringify(page.captured().map(t => t.friendlyName)));

    await graphqlPost(page, 'ProfileCometActionBlockUserMutation', '7777777777777', { input: { user_id: 100012345678901 } });
    await sleep(10);
    const got = page.captured();
    check('the block mutation itself is captured, with its doc_id and the target id it carried',
      got.length === 1 && got[0].friendlyName === 'ProfileCometActionBlockUserMutation' &&
      got[0].docId === '7777777777777' && got[0].capturedTargetId === '100012345678901',
      JSON.stringify(got.map(t => ({ n: t.friendlyName, d: t.docId, t: t.capturedTargetId }))));
    check('the page fetch still went out underneath the observer',
      page.fetches.length === 3, String(page.fetches.length));
  }

  // -- 1b. the REST path (no operation name) is judged by its URL -----------
  {
    const page = makePage({ hostname: 'www.threads.com' });
    await page.handshake();
    await page.sandbox.fetch('https://www.threads.com/api/v1/friendships/unblock/123456789/', { method: 'POST', body: '' });
    await page.sandbox.fetch('https://www.threads.com/api/v1/friendships/block/123456789/', { method: 'POST', body: '' });
    await sleep(10);
    const got = page.captured();
    check('a REST friendships/block call is captured and friendships/unblock is not',
      got.length === 1 && /friendships\/block\//.test(got[0].url),
      JSON.stringify(got.map(t => t.url)));
  }

  // -- 2. a stored template is only used if it names the block mutation -----
  {
    const page = makePage();
    await page.handshake();
    await page.config({
      learnedTemplate: { friendlyName: 'RTWebCallBlockSettingHooksQuery', docId: '9989124061109700',
                         url: 'https://www.facebook.com/api/graphql/', fields: { doc_id: '9989124061109700' } }
    });
    let cap = await page.request('iso:probe', {}, 'main:capability');
    check('a junk template pushed from storage is refused: no candidate, no template',
      !!cap && cap.hasLearnedTemplate === false &&
      !cap.blockDocIds.some(c => c.docId === '9989124061109700'),
      JSON.stringify(cap && { has: cap.hasLearnedTemplate, ids: cap.blockDocIds }));

    await page.config({
      learnedTemplate: { friendlyName: 'ProfileCometActionBlockUserMutation', docId: '7777777777777',
                         url: 'https://www.facebook.com/api/graphql/', fields: { doc_id: '7777777777777' } }
    });
    cap = await page.request('iso:probe', {}, 'main:capability');
    const mine = cap && cap.blockDocIds.find(c => c.docId === '7777777777777');
    check('a genuine block-mutation template is accepted and its doc_id offered as a captured candidate',
      !!cap && cap.hasLearnedTemplate === true && !!mine && mine.source === 'captured' &&
      mine.name === 'ProfileCometActionBlockUserMutation',
      JSON.stringify(cap && { has: cap.hasLearnedTemplate, ids: cap.blockDocIds }));

    await page.config({ learnedTemplate: null });
    cap = await page.request('iso:probe', {}, 'main:capability');
    check('pushing a null template clears it',
      !!cap && cap.hasLearnedTemplate === false && cap.blockDocIds.length === 0,
      JSON.stringify(cap && cap.blockDocIds));
  }

  // -- 3. the relay-network tier reads Facebook's ARRAY payloads ------------
  const FB_ARRAY_OK = [{ data: { block_user: { id: 'MTAwMDAxMjM0NTY3ODkwMQ==' } },
                        extensions: { server_metadata: {}, is_final: true } }];
  const runBlock = async (respond, cfg) => {
    const executed = [];
    const page = makePage({ modules: relayModules(executed, respond) });
    await page.handshake();
    await page.config(Object.assign({
      docIdOverrides: { ProfileCometActionBlockUserMutation: '5555555555555' },
      // The junk that broke 1.0.4, pushed alongside: it must never be executed.
      learnedTemplate: { friendlyName: 'RTWebCallBlockSettingHooksQuery', docId: '9989124061109700',
                         url: 'https://www.facebook.com/api/graphql/', fields: { doc_id: '9989124061109700' } }
    }, cfg || {}));
    const res = await page.request('iso:platform-block',
      { targetId: '100012345678901', dryRun: false }, 'main:block-result', 80);
    return { res, executed };
  };

  {
    const { res, executed } = await runBlock(() => ({ payload: FB_ARRAY_OK }));
    check('a block answered as [{data}] -- the Facebook network format -- is a success',
      !!res && res.ok === true && res.result && res.result.strategy === 'relay-network',
      JSON.stringify(res && { ok: res.ok, detail: res.detail, attempts: res.attempts }));
    check('it was executed with the supplied doc_id and never with the junk one',
      executed.length === 1 && executed[0].id === '5555555555555' && executed[0].kind === 'mutation' &&
      !executed.some(e => e.id === '9989124061109700'),
      JSON.stringify(executed));
    check('the variables carried the target under the known operation shape',
      executed[0] && executed[0].variables && executed[0].variables.input &&
      String(executed[0].variables.input.user_id) === '100012345678901' &&
      String(executed[0].variables.input.actor_id) === '1000000000001',
      JSON.stringify(executed[0] && executed[0].variables));
  }
  {
    const { res } = await runBlock(() => ({ payload: { data: { xdt_block_user: { status: 'ok' } } } }));
    check('a block answered as a plain {data} object is still a success',
      !!res && res.ok === true, JSON.stringify(res && { ok: res.ok, detail: res.detail }));
  }
  {
    const { res } = await runBlock(() => ({ payload: [{ data: {}, extensions: { is_final: true } }] }));
    check('an array whose data is empty is NOT a success',
      !!res && res.ok === false && /no data/.test(res.detail),
      JSON.stringify(res && { ok: res.ok, detail: res.detail }));
  }
  {
    const { res } = await runBlock(() => ({ payload: [{ data: null,
      errors: [{ message: 'GraphQL operation responded with error 4630001' }] }] }));
    check('an array carrying errors is a failure that names the error',
      !!res && res.ok === false && /4630001/.test(res.detail),
      JSON.stringify(res && { ok: res.ok, detail: res.detail }));
  }
  {
    const { res, executed } = await runBlock(() => ({ payload: [{ data: { viewer: { call_blocked_until: 0 } },
      extensions: { is_final: true } }] }), { docIdOverrides: {} });
    check('with nothing but the junk template, no request is made at all (not-ready, not a failure)',
      !!res && res.ok === false && res.notReady === true && executed.length === 0,
      JSON.stringify(res && { ok: res.ok, notReady: res.notReady, attempts: res.attempts, executed }));
  }
  {
    const { res } = await runBlock(() => ({ error: new Error('GraphQL operation responded with error 4630001') }));
    check('a network-layer error is read fail-closed, not swallowed',
      !!res && res.ok === false && /4630001/.test(res.detail),
      JSON.stringify(res && { ok: res.ok, detail: res.detail }));
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
