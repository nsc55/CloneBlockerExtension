/**
 * ISOLATED-world bridge.
 *
 * Sits between three parties that cannot talk to each other directly:
 *
 *   MAIN world  <--window.postMessage-->  THIS  <--chrome.runtime-->  service worker
 *
 * The MAIN-world script has the page's `require`/Relay but no chrome.* APIs.
 * This script has chrome.* but cannot see the page's JS realm. The service
 * worker is the only context that may fetch our own blocklist server, because
 * a content-script fetch is bound by facebook.com's origin and CSP.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const MARK = P.MARK;

  // A per-page-load nonce. The bridge runs over window.postMessage, which the
  // page can also see and write to. The nonce is hygiene, not a security
  // boundary: the page here IS facebook.com, which can already do anything this
  // extension can do on its own origin. Treat every inbound payload as data.
  const nonce = (() => {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  })();

  const listeners = new Map();     // type -> Set<fn>
  const pending = new Map();       // ticket -> {resolve, reject, timer}
  let mainReady = false;
  let handshakeDone = false;
  let ticketSeq = 0;

  const state = {
    platform: /(^|\.)threads\.(net|com)$/.test(location.hostname) ? 'threads' : 'facebook',
    viewerId: null,
    capability: null,
    debug: false
  };

  function log(...a) { if (state.debug) console.debug('[CloneBlocker/iso]', ...a); }

  // -- MAIN world -----------------------------------------------------------

  function toMain(type, payload) {
    window.postMessage({ [MARK]: true, dir: 'iso->main', nonce, type, payload }, location.origin);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[MARK] !== true || d.dir !== 'main->iso') return;

    // The handshake frames arrive before a nonce is agreed, so they are the
    // only ones exempt from the nonce check.
    if (d.type === P.MAIN_READY) {
      mainReady = true;
      toMain(P.HELLO, { nonce, debug: state.debug });
      return;
    }
    if (d.type === P.HELLO_ACK) {
      handshakeDone = true;
      log('handshake complete');
      emit(P.HELLO_ACK, d.payload || {});
      return;
    }
    if (d.nonce !== nonce) return;

    if (d.type === P.VIEWER && d.payload) state.viewerId = d.payload.viewerId || null;
    if (d.type === P.CAPABILITY && d.payload && !d.payload.capturedTemplate) state.capability = d.payload;

    // Resolve any request waiting on this ticket.
    const ticket = d.payload && d.payload.ticket;
    if (ticket && pending.has(ticket)) {
      const entry = pending.get(ticket);
      pending.delete(ticket);
      clearTimeout(entry.timer);
      entry.resolve(d.payload);
    }
    emit(d.type, d.payload || {});
  });

  /** Fire-and-forget send to MAIN. */
  function send(type, payload) { toMain(type, payload); }

  /** Request/response against MAIN, correlated by ticket. */
  function request(type, payload, timeoutMs) {
    const ticket = 't' + (++ticketSeq) + '_' + Date.now().toString(36);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(ticket);
        reject(new Error('MAIN world timed out on ' + type));
      }, timeoutMs || 30000);
      pending.set(ticket, { resolve, reject, timer });
      toMain(type, Object.assign({ ticket }, payload || {}));
    });
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  }

  function emit(type, payload) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (e) { console.warn('[CloneBlocker] listener error', e); }
    }
  }

  /** Keep poking MAIN until the handshake lands. Either world may win the race
   *  to load, so we cannot assume we saw its MAIN_READY. */
  function beginHandshake() {
    let tries = 0;
    const tick = () => {
      if (handshakeDone || tries++ > 40) return;
      toMain(P.HELLO, { nonce, debug: state.debug });
      setTimeout(tick, tries < 10 ? 50 : 500);
    };
    tick();
  }

  // -- service worker -------------------------------------------------------

  function sw(type, payload) {
    return new Promise((resolve) => {
      let settled = false;
      // Clearing the timer matters: the worker loop and the 15s store sweep
      // call this constantly, so a timer left pending on every call would keep
      // a closure alive for 15 seconds each time.
      const settle = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(
        () => settle({ ok: false, error: 'service worker timeout' }), 15000);
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          // A dead service worker or a torn-down extension context surfaces
          // here; swallow it rather than throwing into page code.
          if (chrome.runtime.lastError) { settle({ ok: false, error: chrome.runtime.lastError.message }); return; }
          settle(res || { ok: false, error: 'no response' });
        });
      } catch (e) {
        settle({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  // Broadcasts from the service worker (e.g. the blocklist refreshed).
  const swListeners = new Map();
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      const set = swListeners.get(msg.type);
      if (set) for (const fn of set) { try { fn(msg.payload || {}); } catch (e) { /* ignore */ } }
    });
  } catch (e) { /* extension context may be gone */ }

  function onSw(type, fn) {
    if (!swListeners.has(type)) swListeners.set(type, new Set());
    swListeners.get(type).add(fn);
  }

  globalThis.CB_BRIDGE = {
    state, nonce,
    send, request, on,
    sw, onSw,
    beginHandshake,
    isMainReady: () => mainReady,
    isHandshakeDone: () => handshakeDone,
    setDebug: (v) => { state.debug = !!v; }
  };
})();
