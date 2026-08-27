/**
 * Content-script orchestrator (ISOLATED world).
 *
 * Boot order matters here:
 *   1. Start the bridge handshake immediately -- the MAIN world may already be
 *      waiting, and its module hook is only useful if we can reach it.
 *   2. Load settings + blocklist from the service worker and start hiding.
 *      hiding must not wait on anything network-bound.
 *   3. Only once everything is settled, consider the opt-in platform-block
 *      worker.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const bridge = globalThis.CB_BRIDGE;
  const identity = globalThis.CB_IDENTITY;
  const dom = globalThis.CB_DOM;
  const report = globalThis.CB_REPORT;

  let settings = Object.assign({}, globalThis.CB_DEFAULT_SETTINGS);
  let workerRunning = false;

  function log(...a) { if (settings.debug) console.debug('[CloneBlocker]', ...a); }

  async function boot() {
    bridge.beginHandshake();

    // Settings first -- debug flag changes how noisy everything else is.
    const s = await bridge.sw(P.SW.GET_SETTINGS);
    if (s && s.ok && s.settings) settings = Object.assign(settings, s.settings);
    bridge.setDebug(settings.debug);

    await identity.loadAliases();

    const bl = await bridge.sw(P.SW.GET_BLOCKLIST);
    if (bl && bl.ok && bl.blocklist) {
      identity.setBlocklist(bl.blocklist);
      log('blocklist loaded', identity.stats());
      // Numeric ids are actionable immediately; nothing has to be discovered
      // for them first.
      maybeSeedQueue();
    } else {
      log('no blocklist available yet', bl && bl.error);
    }

    dom.updateSettings(settings);
    dom.start();

    // The in-page report affordance. Independent of the hiding layer: someone
    // may want to report clones without hiding anything, or vice versa.
    if (report) {
      report.updateSettings(settings);
      report.start();
    }

    // Push config the MAIN world needs (doc_id overrides, learned template).
    bridge.on(P.HELLO_ACK, () => pushMainConfig());
    if (bridge.isHandshakeDone()) pushMainConfig();

    // Keep the id<->username map fed from every Relay store sweep.
    bridge.on(P.STORE_SNAPSHOT, (payload) => {
      const res = identity.learnMany(payload && payload.users) || { learned: 0, relevant: 0 };
      if (res.learned) {
        log('learned', res.learned, 'pairs,', res.relevant, 'blocklist-relevant');
        if (res.relevant) {
          // One of these pairs bridges a blocklist entry to something on the
          // page. Verdicts cached before we knew that are now wrong, and their
          // signatures have not changed, so a plain re-scan would skip them.
          dom.invalidateDecisions();
        }
        dom.scan();
      }
      // Report resolved ids for blocklist usernames back to the worker queue.
      maybeSeedQueue();
    });

    // Capture mode: the MAIN world saw a real block request go by.
    bridge.on(P.CAPABILITY, (payload) => {
      // The page found the site's block operation: hand the doc_id to the
      // worker so later page loads -- which will not have the module -- can
      // still block. Sent either as a map (the page reported it the moment the
      // module registered) or inside a capability answer.
      if (payload) {
        const fromProbe = Array.isArray(payload.blockDocIds)
          ? payload.blockDocIds.filter(c => c && c.source === 'module')
              .reduce((m, c) => { m[c.name] = c.docId; return m; }, {})
          : null;
        const docIds = payload.docIds || fromProbe;
        if (docIds && Object.keys(docIds).length) {
          bridge.sw(P.SW.REMEMBER_DOC_IDS, { platform: bridge.state.platform, docIds })
            .then((r) => {
              // Only worth re-pushing when something actually changed; a
              // config push re-reads storage and re-crosses the bridge.
              if (r && r.changed) pushMainConfig().catch(() => {});
            })
            .catch(() => {});
        }
      }
      if (!payload || !payload.capturedTemplate) return;
      // The bridge's emit() only catches synchronous throws, so an async
      // listener has to own its rejections (storage quota, dead context).
      (async () => {
        const key = 'learnedTemplate_' + bridge.state.platform;
        const next = Object.assign({ at: Date.now() }, payload.capturedTemplate);
        // Second gate on the same rule the MAIN world applies before posting:
        // a request that does not name the block mutation is never persisted,
        // whatever the other side sent. The stored template is what survives
        // reloads and upgrades, so this is the door that matters most.
        if (!globalThis.CB_IS_BLOCK_MUTATION_NAME(next.friendlyName)) {
          log('ignoring captured request that is not a block mutation', next.friendlyName || next.url);
          return;
        }
        const existing = (await chrome.storage.local.get(key))[key];

        // Not every captured request is worth keeping. Rank them, and never let
        // a weaker capture displace a stronger one: a persisted-query request
        // (doc_id + operation name) is the real thing, while a bare URL with no
        // operation is usually a REST attempt that may well have failed.
        const score = (t) => {
          if (!t) return -1;
          let s = 0;
          if (t.docId) s += 10;
          if (t.friendlyName) s += 5;
          if (t.fields && Object.keys(t.fields).length > 3) s += 2;
          return s;
        };
        if (score(next) < score(existing)) {
          log('ignoring weaker captured template', next.url);
          return;
        }
        await bridge.sw(P.SW.LOG, { level: 'info', msg: 'captured block request template' });
        await chrome.storage.local.set({ [key]: next });
        pushMainConfig();
      })().catch((e) => log('could not persist captured template', e && e.message));
    });

    // Somebody pressed Block and is watching. Cut the current sleep short and
    // start the worker if it is not already going -- the queue may have been
    // empty when the loop last looked, which is precisely when it settles into
    // its longest wait.
    bridge.onSw(P.SW.WAKE_WORKER, () => {
      startWorkerIfEnabled();
      wakeNow();
    });

    // The service worker refreshed the list from your server.
    bridge.onSw(P.SW.BLOCKLIST_UPDATED, async () => {
      const fresh = await bridge.sw(P.SW.GET_BLOCKLIST);
      if (fresh && fresh.ok && fresh.blocklist) {
        identity.setBlocklist(fresh.blocklist);
        dom.rescanAll();
        lastSeeded = '';   // a replaced list must re-seed even if it is the same size
        maybeSeedQueue();
        log('blocklist refreshed', identity.stats());
      }
    });

    // React to settings edits made in the options page.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !changes[globalThis.CB_KEYS.SETTINGS]) return;
        settings = Object.assign(settings, changes[globalThis.CB_KEYS.SETTINGS].newValue || {});
        bridge.setDebug(settings.debug);
        dom.updateSettings(settings);
        if (report) report.updateSettings(settings);
        pushMainConfig();
        startWorkerIfEnabled();
      });
    } catch (e) { /* context gone */ }

    // Probe what the MAIN world can do. This has to be repeated, not one-shot:
    // Meta streams its bundles in over several seconds, so an early probe can
    // legitimately report zero modules and no Relay environment, and a stale
    // snapshot of that would misreport the extension as non-functional.
    for (const delay of [2500, 6000, 12000, 25000]) {
      setTimeout(() => bridge.send(P.PROBE_CAPABILITY, {}), delay);
    }

    startStoreSweep();
    startWorkerIfEnabled();
  }

  /**
   * Periodically sweep Meta's Relay store for id<->username pairs.
   *
   * This has to run on its own schedule rather than only when the DOM layer
   * asks a question. If every visible post happens to match on username alone,
   * the DOM layer never needs a round-trip -- and we would never learn the
   * numeric ids behind those usernames. Those ids are exactly what a real
   * platform block requires, so without this the block queue would sit empty
   * even though the profiles are right there on screen.
   *
   * The sweep is a plain in-memory walk of records the page already fetched:
   * no network, and only a few hundred records on a typical view.
   */
  function startStoreSweep() {
    const sweep = () => {
      if (document.hidden) return;
      bridge.send(P.RESOLVE_IDS, { nodes: [] });
    };
    setTimeout(sweep, 4000);
    setInterval(sweep, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sweep(); });
  }

  async function pushMainConfig() {
    let learnedTemplate = null;
    let docIdOverrides = {};
    let learnedDocIds = {};
    try {
      const key = 'learnedTemplate_' + bridge.state.platform;
      const got = await chrome.storage.local.get([key, 'docIdOverrides', 'learnedDocIds']);
      learnedTemplate = got[key] || null;
      // A template an earlier build stored under the looser rule is dropped
      // here, on the first page load that reads it, rather than handed to the
      // MAIN world to refuse on every load from now on.
      if (learnedTemplate && !globalThis.CB_IS_BLOCK_MUTATION_NAME(learnedTemplate.friendlyName)) {
        log('dropping stored template that is not a block mutation', learnedTemplate.friendlyName);
        learnedTemplate = null;
        chrome.storage.local.remove(key).catch(() => {});
      }
      // Published with the blocklist: the owner's lever for a doc_id rotation.
      docIdOverrides = got.docIdOverrides || {};
      // Seen working in this browser. Kept separate rather than merged, so the
      // page can prefer what has worked HERE over what was shipped to
      // everyone, and say which of the two it used.
      learnedDocIds = (got.learnedDocIds || {})[bridge.state.platform] || {};
    } catch (e) { /* ignore */ }
    bridge.send(P.SET_CONFIG, {
      debug: settings.debug, learnedTemplate, docIdOverrides, learnedDocIds,
      allowRawNetworkFallback: !!settings.allowRawNetworkFallback
    });
  }

  /** Tell the service worker which blocked profiles now have a numeric id, so
   *  it can queue them for a real platform block.
   *
   *  Called after every store sweep, so it only forwards when the resolvable
   *  set has actually grown -- otherwise each open tab would ship the whole id
   *  list across the message channel every 15 seconds for no reason. */
  let lastSeeded = '';
  async function maybeSeedQueue() {
    if (!settings.platformBlockEnabled) return;
    const ids = identity.blockableIds();
    if (!ids.length) return;
    const sig = ids.length + ':' + ids[ids.length - 1];
    if (sig === lastSeeded) return;
    lastSeeded = sig;
    // The alias map is how these ids were resolved in the first place, so the
    // username is already in hand. Sent along because nothing downstream can
    // work it out later: the worker only ever sees numbers, and the Activity
    // page had nothing to print but the number.
    const names = {};
    for (const id of ids) {
      const u = identity.usernameForId(id);
      if (u) names[id] = u;
    }

    await bridge.sw(P.SW.ENQUEUE_PLATFORM_BLOCK, {
      platform: bridge.state.platform,
      ids,
      names,
      // These came out of the page in front of the user. Blocking someone whose
      // posts you are actually looking at is ordinary behaviour, so it is paced
      // normally rather than rationed like a target the server nominated.
      warm: true
    });
  }

  // -- platform block worker --------------------------------------------------
  //
  // The service worker owns the queue and the rate limiter; this tab is only a
  // pair of hands. It claims one target at a time under a lease, so multiple
  // open Facebook tabs cannot double-block the same profile.
  function startWorkerIfEnabled() {
    if (workerRunning || !settings.platformBlockEnabled) return;
    // Seed before starting rather than waiting for a Relay store sweep to do
    // it. Ids that are already on the list need no discovery at all, and making
    // the queue depend on a sweep meant blocking could sit there reporting
    // nothing to do while the target was right there in the blocklist.
    maybeSeedQueue();
    workerRunning = true;
    log('platform-block worker starting (dryRun=' + settings.platformBlockDryRun + ')');
    workerLoop().catch((e) => {
      workerRunning = false;
      log('worker stopped', e && e.message);
    });
  }

  async function workerLoop() {
    // Give the page time to settle; a freshly-loaded tab has not yet loaded the
    // lazy modules the block mutation lives in.
    await sleep(8000);

    while (settings.platformBlockEnabled) {
      const claim = await bridge.sw(P.SW.QUEUE_CLAIM, { platform: bridge.state.platform });

      if (!claim || !claim.ok || !claim.target) {
        // Nothing to do, or the limiter says wait. Interruptible: an explicit
        // block arriving while the queue was empty is exactly the case worth
        // waking for.
        await nap(Math.max(30000, (claim && claim.retryInMs) || 60000));
        continue;
      }

      const targetId = claim.target;
      // The service worker sets the pace: short after a profile that was on
      // screen, long after one the server nominated.
      const pauseAfterMs = Number(claim.nextDelayMs) || 0;
      const wasDryRun = settings.platformBlockDryRun !== false;
      let outcome;
      try {
        outcome = await bridge.request(P.PLATFORM_BLOCK, {
          targetId,
          dryRun: wasDryRun
        }, 45000);
      } catch (e) {
        outcome = { ok: false, detail: 'MAIN world timeout: ' + (e && e.message) };
      }

      const res = (outcome && outcome.result) || {};
      // The page has not loaded the site's block operation and no fallback is
      // allowed: nothing was attempted, so nothing about the target failed.
      const notReady = !!((outcome && outcome.notReady) || res.notReady);
      await bridge.sw(P.SW.QUEUE_RESULT, {
        platform: bridge.state.platform,
        target: targetId,
        // Only cold attempts count against the cold ceiling.
        warm: !!claim.warm,
        ok: !!(outcome && outcome.ok),
        // Taken from what we asked for, never from the echoed result. The
        // result is structured-cloned and can come back null, which would make
        // a dry run look like a genuine block: the target would be retired to
        // "done" and would consume rate-limit budget without anyone having
        // actually been blocked.
        dryRun: wasDryRun,
        rateLimited: !!res.rateLimited,
        checkpoint: !!res.checkpoint,
        loggedOut: !!res.loggedOut,
        notReady,
        detail: (outcome && outcome.detail) || '',
        attempts: (outcome && outcome.attempts) || []
      });

      // A doc_id that actually carried a block is worth more than one that
      // merely resolved: pin it, so it leads the ladder next time and the
      // stale ones behind it are never tried again.
      if (outcome && outcome.ok && !wasDryRun && res.docId && res.operation) {
        bridge.sw(P.SW.REMEMBER_DOC_IDS, {
          platform: bridge.state.platform,
          docIds: { [res.operation]: res.docId }
        }).catch(() => {});
      }
      // The other direction: Meta rotated away from the one we remembered and
      // said so. Forget it rather than spending a real request on it against
      // every future target.
      if (res.docIdRejected && res.docIdSource === 'learned' && res.docId && res.operation) {
        bridge.sw(P.SW.REMEMBER_DOC_IDS, {
          platform: bridge.state.platform,
          forget: { [res.operation]: res.docId }
        }).then(() => pushMainConfig().catch(() => {})).catch(() => {});
      }

      if (notReady) {
        // Claiming again in twenty seconds would only produce the same answer
        // and the same error; the module arrives when the person opens a
        // profile's "..." menu or navigates somewhere that loads it. Wait a
        // few minutes between looks instead of burning claims.
        await nap(3 * 60 * 1000);
        continue;
      }

      if (res.loggedOut) {
        // The platform rejected the session. Every further attempt would fail
        // the same way, so stop and let the user sign in again.
        log('session rejected -- halting worker; sign in again');
        workerRunning = false;
        return;
      }

      if (res.checkpoint) {
        // The account hit a challenge. Stop rather than digging in deeper; this
        // needs a human in the site's own UI. Clear the running flag on the way
        // out, or re-enabling platform blocking after resolving the challenge
        // would do nothing in this tab until it was reloaded.
        log('checkpoint detected -- halting worker');
        workerRunning = false;
        return;
      }

      // Randomised delay. Fixed intervals are exactly what automation
      // detection looks for, and blocking is a rate-limit-sensitive mutation.
      //
      // The interval comes from the claim, which knows whether this target was
      // on the page or nominated by the server. Falls back to the cold setting
      // when the worker is talking to an older service worker.
      const lo = Math.max(2000, settings.minDelayMs | 0);
      const hi = Math.max(lo + 1000, settings.maxDelayMs | 0);
      const wait = res.rateLimited
        ? 15 * 60 * 1000                        // backed off hard on a 429
        : (pauseAfterMs || lo + Math.floor(Math.random() * (hi - lo)));
      await nap(wait);
    }
    workerRunning = false;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // The worker loop spends nearly all its time asleep, on intervals chosen for
  // unattended sweeping: up to two minutes between claims, thirty after a dry
  // run, five when the page has no block operation. That is right for the
  // extension working through its own backlog and wrong for somebody who has
  // just pressed Block and is watching the screen. So the sleep can be cut
  // short -- it never skips the browser-wide gate, the leases or the caps,
  // which is where the real pacing lives; it only stops the loop idling
  // through a delay that was never about this request.
  let wakeWorker = null;
  function nap(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { wakeWorker = null; resolve('slept'); }, ms);
      wakeWorker = () => { clearTimeout(t); wakeWorker = null; resolve('woken'); };
    });
  }
  function wakeNow() { if (wakeWorker) wakeWorker(); }

  // Expose a little surface for the popup to query this tab.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      // Round-trip probe: verifies the isolated world can issue a correlated
      // request to the MAIN world and get its answer back. Used by the test
      // suite, because a response that fails to echo its ticket does not error
      // -- it just hangs until timeout, which is easy to miss.
      if (msg && msg.type === 'tab:probe-bridge') {
        const t0 = Date.now();
        bridge.request(P.RESOLVE_IDS, { nodes: [] }, 8000)
          .then((res) => respond({ ok: true, ms: Date.now() - t0, hasAnswers: Array.isArray(res && res.answers) }))
          .catch((e) => respond({ ok: false, ms: Date.now() - t0, error: String(e && e.message) }));
        return true;
      }
      // Diagnostic: resolve which block strategy would be used for a target and
      // report what it would send. dryRun is hardcoded true here and is NOT
      // taken from settings -- this path must never be able to block anyone,
      // whatever the extension is configured to do.
      if (msg && msg.type === 'tab:dry-block') {
        bridge.request(P.PLATFORM_BLOCK, { targetId: String(msg.targetId || ''), dryRun: true }, 30000)
          .then((res) => respond({ ok: true, dryRun: true, res }))
          .catch((e) => respond({ ok: false, error: String(e && e.message) }));
        return true;
      }
      if (msg && msg.type === 'tab:dump-modules') {
        bridge.request(P.DUMP_MODULES, { pattern: msg.pattern || 'block' }, 20000)
          .then((res) => respond({ ok: true, res }))
          .catch((e) => respond({ ok: false, error: String(e && e.message) }));
        return true;
      }
      // Popup entry point: report the profile this page is showing.
      if (msg && msg.type === 'tab:report-current') {
        respond(report ? report.reportCurrentProfile() : { ok: false, error: 'report UI not loaded' });
        return true;
      }
      if (!msg || msg.type !== 'tab:status') return;
      // Ask for a fresh capability report rather than serving the last
      // snapshot, which may predate the page finishing its bundle load.
      const base = {
        ok: true,
        platform: bridge.state.platform,
        viewerId: bridge.state.viewerId,
        handshake: bridge.isHandshakeDone(),
        identity: identity.stats(),
        dom: dom.stats(),
        // Who this page is about, so the popup can offer an action for it
        // rather than a page of switches.
        profile: report ? report.currentProfileInfo() : null,
        unresolved: identity.unresolvedUsernames().slice(0, 25)
      };
      bridge.request(P.PROBE_CAPABILITY, {}, 5000)
        .then((cap) => respond(Object.assign(base, { capability: cap || bridge.state.capability })))
        .catch(() => respond(Object.assign(base, { capability: bridge.state.capability })));
      return true;
    });
  } catch (e) { /* ignore */ }

  boot().catch((e) => console.warn('[CloneBlocker] boot failed', e));
})();
