/**
 * DOM suppression engine (ISOLATED world): hiding.
 *
 * Hides content authored by blocked profiles. This layer is always safe: it
 * sends no requests and changes nothing on the account, so it is on by default
 * and takes effect as soon as the worker has answered for what is on screen --
 * the list lives in its IndexedDB, and this tab asks about authors in batches.
 *
 * Selector policy: Comet and Barcelona generate obfuscated, rotating CSS class
 * names, so keying on `class` guarantees breakage. We key only on semantic and
 * structural attributes -- role, aria-*, data-pagelet, data-pressable-container
 * -- which are load-bearing for accessibility and therefore stable.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const bridge = globalThis.CB_BRIDGE;
  const identity = globalThis.CB_IDENTITY;

  const IS_THREADS = bridge.state.platform === 'threads';

  const CONTAINERS = IS_THREADS
    ? [
        '[data-pressable-container="true"]',
        '[data-pressable-container]',
        'div[role="article"]'
      ]
    : [
        'div[role="feed"] > div',
        '[data-pagelet^="FeedUnit"]',
        'div[role="article"]',
        '[aria-posinset]',
        'div[data-testid="fbfeed_story"]'
      ];

  // Facebook labels each comment "Comment by <name> ...", which is both a
  // container hook and a name source.
  //
  // This must not overlap CONTAINERS, or the two visibility toggles stop being
  // separable: on Threads a bare div[role="article"] matches posts as well as
  // replies, so switching feed posts off would still hide them via this branch.
  // STRUCTURE FIRST, LABEL SECOND. Facebook labels each comment "Comment by
  // <name>", and matching that text meant the whole comment branch was dead on
  // any Facebook that is not in English -- on a Vietnamese account the label
  // reads "Bình luận của ...", nothing matched, and a blocked profile's
  // comments stayed visible under everyone else's posts while their own posts
  // vanished. That reads as a broken block, and it was invisible here because
  // every test ran against an English page.
  //
  // A comment is an article nested inside another article, in every language.
  // The English forms are kept after it: they cost one more selector and they
  // still match layouts where the nesting is flatter.
  const COMMENT_SELECTOR = IS_THREADS
    ? 'div[role="article"]:not([data-pressable-container])'
    : 'div[role="article"] div[role="article"], ' +
      'div[aria-label^="Comment by"], div[role="article"][aria-label*="Comment"]';

  const settings = { hideEnabled: true, hideMode: 'collapse', hideComments: true, hideFeedPosts: true };

  let probeSeq = 0;
  const decisions = new WeakMap();   // node -> { sig, blocked, match }
  const remoteTries = new WeakMap(); // node -> { sig, tries } for the content it shows now
  const MAX_REMOTE_TRIES = 3;
  const inflight = new Map();        // probe id -> node
  // Nodes whose authors the worker is being asked about, keyed to the content
  // they showed when the question went out. A node found here under the same
  // signature is skipped by the next pass rather than asked again; a node
  // whose content changed is a new question.
  const pendingLookup = new WeakMap(); // node -> sig
  const MAX_LOOKUP_NODES = 200;        // per pass; the rest wait for the next one
  let rescanWhenDone = false;
  let scanQueued = false;
  let identityInflight = false;
  let stats = { hidden: 0, scanned: 0 };

  function log(...a) { if (bridge.state.debug) console.debug('[CloneBlocker/dom]', ...a); }

  // -- signatures -----------------------------------------------------------
  // React reuses DOM nodes as the feed virtualises, so "already decided" must
  // be keyed on content, not node identity alone.
  function signature(node) {
    let hrefs = '';
    const anchors = node.querySelectorAll('a[href]');
    for (let i = 0; i < Math.min(anchors.length, 4); i++) {
      hrefs += anchors[i].getAttribute('href') || '';
    }
    const label = node.getAttribute('aria-label') || '';
    return hrefs.slice(0, 300) + '|' + label.slice(0, 80) + '|' + node.childElementCount;
  }

  // -- cheap local identity guess ------------------------------------------
  // Try to decide without a round-trip to the MAIN world. Anything with a
  // numeric id or an @handle in an href can be judged right here.
  const FB_RESERVED = /^(profile\.php|photo|photo\.php|watch|groups|pages|events|marketplace|reel|reels|stories|share|permalink|posts|videos|hashtag|search|messages|notifications|friends|settings|privacy|help|policies|login|reg|home|gaming|weather|fundraisers|saved|memories|bookmarks|ads|business|legal|terms|about|careers|people|places|games|live|media|story\.php|browse|allactivity|pages_feed|pg)$/i;

  function identityFromHref(href) {
    let m;
    if ((m = href.match(/profile\.php\?id=(\d+)/))) return { id: m[1] };
    if ((m = href.match(/(?:threads\.(?:net|com))?\/@([A-Za-z0-9._]+)/))) return { username: m[1] };
    if ((m = href.match(/^https?:\/\/[^/]*facebook\.com\/([A-Za-z0-9.\-]+)(?:[/?#]|$)/)) ||
        (m = href.match(/^\/([A-Za-z0-9.\-]+)(?:[/?#]|$)/))) {
      if (!FB_RESERVED.test(m[1])) return { username: m[1] };
    }
    return null;
  }

  // Nested comment containers. Anchors inside one of these belong to a
  // commenter, not to the author of the surrounding post.
  const NESTED_COMMENT = 'div[role="article"], [aria-label^="Comment by"]';

  /**
   * Identify who *wrote* this container -- not everyone mentioned in it.
   *
   * Harvesting every anchor is what makes a blocker feel broken: a feed story
   * contains comment previews, tag links and "X shared a post", so one blocked
   * person leaving a comment would take an innocent person's entire post with
   * it. (The comment itself is still hidden separately, by the comment
   * selector, which is the correct outcome.)
   *
   * Three narrowing passes, most reliable first.
   */
  function localIdentities(node) {
    const anchors = Array.from(node.querySelectorAll('a[href]')).slice(0, 60);

    // 1. Drop anything living inside a *nested* comment/article subtree.
    const own = anchors.filter((a) => {
      const holder = a.closest(NESTED_COMMENT);
      return !holder || holder === node;
    });

    // 2. Prefer the byline. Comet and Barcelona both wrap the actor name in a
    //    heading or <strong> next to the avatar, which no mention or tag uses.
    const byline = own.filter(a => a.closest('h1, h2, h3, h4, strong'));

    // 3. Otherwise fall back to the first couple of anchors in document order:
    //    in both designs the author's own link precedes the post body.
    const chosen = byline.length ? byline : own.slice(0, 3);

    const out = [];
    const seen = new Set();
    for (const a of chosen) {
      const ident = identityFromHref(a.getAttribute('href') || '');
      if (!ident) continue;
      const key = ident.id || '@' + ident.username;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ident);
    }
    return out;
  }

  // -- hiding ---------------------------------------------------------------
  function applyHide(node, matchInfo) {
    if (node.getAttribute('data-cb-hidden') === '1') return;
    // "revealed" means the reader explicitly clicked Show. Re-hiding it on the
    // next rescan would silently undo a deliberate choice, so that decision
    // sticks for as long as the node keeps showing the same content.
    if (node.getAttribute('data-cb-hidden') === 'revealed') return;
    node.setAttribute('data-cb-hidden', '1');
    node.setAttribute('data-cb-mode', settings.hideMode);
    const who = matchInfo && (matchInfo.username ? '@' + matchInfo.username : matchInfo.id) || 'blocked profile';
    node.setAttribute('data-cb-who', String(who));
    stats.hidden++;

    if (settings.hideMode === 'placeholder') {
      insertPlaceholder(node, who);
    }
    log('hid content from', who);
  }

  /**
   * @param {boolean} includeRevealed clear a reader's explicit "Show" too.
   *   False during a rescan, so a blocklist refresh does not silently re-hide
   *   something the reader chose to see. True when hiding is switched off
   *   entirely, or when the node has started showing different content and the
   *   old decision no longer applies to it.
   */
  function unhide(node, includeRevealed) {
    const state = node.getAttribute('data-cb-hidden');
    if (state !== '1' && !(includeRevealed && state === 'revealed')) return;
    node.removeAttribute('data-cb-hidden');
    node.removeAttribute('data-cb-mode');
    node.removeAttribute('data-cb-who');
    const ph = node.previousElementSibling;
    if (ph && ph.classList && ph.classList.contains('cb-placeholder')) ph.remove();
  }

  function insertPlaceholder(node, who) {
    const prev = node.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains('cb-placeholder')) return;
    const bar = document.createElement('div');
    bar.className = 'cb-placeholder';
    const label = document.createElement('span');
    label.className = 'cb-placeholder-text';
    label.textContent = globalThis.CB_T('hide_hiddenLabel', who);
    const btn = document.createElement('button');
    btn.className = 'cb-placeholder-btn';
    btn.type = 'button';
    btn.textContent = globalThis.CB_T('hide_showButton');
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      node.setAttribute('data-cb-hidden', 'revealed');
      bar.remove();
    });
    bar.appendChild(label);
    bar.appendChild(btn);
    try { node.parentNode.insertBefore(bar, node); } catch (e) { /* detached */ }
  }

  // -- scanning -------------------------------------------------------------
  function candidateNodes(root) {
    const parts = [];
    if (settings.hideFeedPosts !== false) parts.push(CONTAINERS.join(','));
    if (settings.hideComments) parts.push(COMMENT_SELECTOR);
    if (!parts.length) return [];
    const sel = parts.join(',');
    const found = [];
    try {
      if (root.nodeType === 1 && root.matches && root.matches(sel)) found.push(root);
      const list = root.querySelectorAll ? root.querySelectorAll(sel) : [];
      for (const n of list) found.push(n);
    } catch (e) { /* bad selector on an exotic node */ }
    return found;
  }

  function scan(root) {
    if (!settings.hideEnabled) return;
    const nodes = candidateNodes(root || document);
    const needRemote = [];
    const needLookup = [];

    for (const node of nodes) {
      if (!node.isConnected) continue;
      // Skip nested containers whose ancestor is already hidden.
      if (node.parentElement && node.parentElement.closest('[data-cb-hidden="1"]')) continue;

      const sig = signature(node);
      const prev = decisions.get(node);
      if (prev && prev.sig === sig) continue;   // already judged this content
      stats.scanned++;

      const local = localIdentities(node);
      const m = identity.matchAnyCached(local);
      if (m) {
        decisions.set(node, { sig, blocked: true, match: m });
        applyHide(node, m);
        continue;
      }

      // Not answered yet, for at least one of these identities: this tab has
      // never asked the worker about it, or asked under a list that has since
      // been replaced. Queue the question and leave the node exactly as it is
      // -- no verdict, no probe -- until the answer is in. In particular the
      // numeric-id shortcut below must not run: "the id did not match" is only
      // conclusive once somebody has actually looked it up.
      if (m === undefined) {
        if (pendingLookup.get(node) === sig) continue;   // already asked about this content
        if (needLookup.length >= MAX_LOOKUP_NODES) { rescanWhenDone = true; continue; }
        pendingLookup.set(node, sig);
        needLookup.push({ node, sig, identities: local });
        continue;
      }

      // Every identity is a cached miss. If the node previously was hidden
      // but its content changed, un-hide it before re-judging.
      if (prev && prev.blocked) unhide(node, true);   // content changed; old reveal no longer applies

      // A numeric id that did not match is a conclusive "not blocked" -- the
      // worker has answered for it. Only usernames -- or nothing at all --
      // leaves room for the Relay store or a React fiber to know better, so
      // those are worth a round-trip.
      const haveNumericId = local.some(x => x.id);
      if (haveNumericId) {
        decisions.set(node, { sig, blocked: false, match: null });
        continue;
      }

      // Needs the MAIN world. Deliberately do NOT cache a negative decision
      // yet: if this batch gets dropped (a round-trip is already in flight, or
      // the cap is reached) a cached "not blocked" would stop the node from
      // ever being looked at again. Cache only once an answer comes back, and
      // bound the retries so a genuinely unidentifiable node cannot be probed
      // forever.
      // The count must reset when the node starts showing different content.
      // Comet and Barcelona recycle a fixed pool of DOM nodes as the feed
      // virtualises, so a node-keyed counter would exhaust its retries once and
      // then never resolve an author again for the rest of the session.
      const rt = remoteTries.get(node);
      const tries = (rt && rt.sig === sig) ? rt.tries : 0;
      if (tries >= MAX_REMOTE_TRIES) {
        decisions.set(node, { sig, blocked: false, match: null });
        continue;
      }
      if (!identityInflight && needRemote.length < 30) {
        // The try is counted when an answer arrives, not when the request is
        // dispatched. A batch that fails wholesale -- say the MAIN world is not
        // listening yet, so the whole round-trip times out -- would otherwise
        // burn a try for all thirty nodes at once, and three such batches would
        // permanently give up on content that was never actually examined.
        const probe = 'p' + (++probeSeq);
        node.setAttribute('data-cb-probe', probe);
        inflight.set(probe, node);
        needRemote.push({ probe });
      }
    }

    if (needLookup.length) resolveLookups(needLookup);
    if (needRemote.length) requestIdentities(needRemote);
  }

  /**
   * Ask the worker about a pass's unanswered authors, then judge those nodes
   * the way scan() would have.
   *
   * One question per pass: identity.lookupAny coalesces everything into a
   * single message and answers from its cache from then on. scan() is only
   * ever called from an idle callback, a frame, the sweep timer or the
   * mutation observer, and nothing awaits it, so this tail can be async. By
   * the time it runs the feed may have moved -- React recycles these nodes --
   * so each node is judged only if it still shows the content it was asked
   * about; anything else is a new question for the next pass.
   */
  async function resolveLookups(list) {
    const union = [];
    for (const e of list) for (const ident of e.identities) union.push(ident);
    try {
      await identity.lookupAny(union);
    } catch (e) {
      log('lookup failed', e && e.message);
    }
    let again = false;
    for (const e of list) {
      const node = e.node;
      if (pendingLookup.get(node) === e.sig) pendingLookup.delete(node);
      if (!node.isConnected || signature(node) !== e.sig) continue;
      const m = identity.matchAnyCached(e.identities);
      if (m) {
        decisions.set(node, { sig: e.sig, blocked: true, match: m });
        applyHide(node, m);
        continue;
      }
      // Still unanswered: the list changed underneath the question, or the
      // worker did not reply. Left undecided, and NOT re-queued from here --
      // the refresh broadcast rescans on a new list, and the periodic sweep
      // asks again in a couple of seconds if the worker was merely away.
      // Re-queueing at once would spin against a worker that is gone.
      if (m === undefined) continue;
      const prev = decisions.get(node);
      if (prev && prev.blocked) unhide(node, true);   // content changed; old reveal no longer applies
      // The worker has answered, so a numeric id that did not match is now
      // conclusive. A username-only miss is left undecided: the next pass
      // sees the cached miss and takes it to the MAIN world, exactly as it
      // would have without the detour through here.
      if (e.identities.some(x => x.id)) decisions.set(node, { sig: e.sig, blocked: false, match: null });
      else again = true;
    }
    if (again || rescanWhenDone) { rescanWhenDone = false; queueScan(); }
  }

  async function requestIdentities(nodes) {
    if (identityInflight) return;   // one round-trip at a time keeps it cheap
    identityInflight = true;
    try {
      const res = await bridge.request(P.RESOLVE_IDS, { nodes }, 15000);
      await handleAnswers(res && res.answers);
    } catch (e) {
      log('identity request failed', e && e.message);
    } finally {
      identityInflight = false;
      // Clean up probe attributes so the page DOM stays tidy.
      for (const [probe, node] of inflight) {
        try { if (node.getAttribute('data-cb-probe') === probe) node.removeAttribute('data-cb-probe'); }
        catch (e) { /* detached */ }
      }
      inflight.clear();
    }
  }

  async function handleAnswers(answers) {
    const answered = [];
    for (const a of answers || []) {
      const node = inflight.get(a.probe);
      if (!node || !node.isConnected) continue;
      // This node genuinely got looked at, so the attempt counts now.
      const sigNow = signature(node);
      const rt = remoteTries.get(node);
      remoteTries.set(node, {
        sig: sigNow,
        tries: ((rt && rt.sig === sigNow) ? rt.tries : 0) + 1
      });
      // Anything the MAIN world learned about id<->username is worth keeping.
      const identities = a.identities || [];
      for (const ident of identities) {
        if (ident.id && ident.username) identity.learn(ident.id, ident.username);
      }
      answered.push({ node, identities });
    }
    // Every author of the batch in one question to the worker, learned pairs
    // included, so the alias bridge is in place before anything is judged.
    const all = [];
    for (const e of answered) for (const ident of e.identities) all.push(ident);
    if (all.length) await identity.lookupAny(all);
    for (const e of answered) {
      const node = e.node;
      if (!node.isConnected) continue;
      const m = identity.matchAnyCached(e.identities);
      if (m) {
        decisions.set(node, { sig: signature(node), blocked: true, match: m });
        applyHide(node, m);
      } else if (m === null && e.identities.length) {
        // The MAIN world identified the author and the worker says it is not
        // on the list, so this is now a conclusive answer worth caching. An
        // unanswered question (the list changed mid-flight) caches nothing;
        // the rescan that follows the refresh asks again.
        decisions.set(node, { sig: signature(node), blocked: false, match: null });
      }
    }
  }

  /**
   * Drop every cached verdict so the next scan re-judges from scratch.
   *
   * Needed when the identity map changes underneath us: a node can be cached
   * "not blocked" on the strength of a numeric id, and only later do we learn
   * that id belongs to a username that IS on the list. Its content signature
   * has not changed, so without this it would never be looked at again.
   */
  function invalidateDecisions() {
    for (const node of candidateNodes(document)) {
      decisions.delete(node);
      remoteTries.delete(node);
      // A question in flight is answered under whatever the cache holds when
      // it lands; dropping the stamp lets the next pass ask afresh.
      pendingLookup.delete(node);
    }
  }

  /** Re-evaluate everything from scratch, e.g. after the blocklist changes. */
  function rescanAll() {
    for (const node of document.querySelectorAll('[data-cb-hidden]')) unhide(node);
    for (const node of document.querySelectorAll('[data-cb-probe]')) node.removeAttribute('data-cb-probe');
    invalidateDecisions();
    scan(document);
  }

  function queueScan(root) {
    if (scanQueued) return;
    scanQueued = true;
    const run = () => { scanQueued = false; scan(root || document); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 400 });
    else requestAnimationFrame(run);
  }

  // -- observation ----------------------------------------------------------
  let observer = null;
  function start() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      if (!settings.hideEnabled) return;
      for (const r of records) {
        // Ignore our own attribute writes to avoid a feedback loop.
        if (r.type === 'attributes') continue;
        if (r.addedNodes && r.addedNodes.length) { queueScan(document); return; }
      }
    });
    const attach = () => {
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
      queueScan(document);
    };
    if (document.documentElement) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });

    // The SPA swaps routes without a page load; a periodic sweep catches
    // anything the observer's batching missed.
    setInterval(() => { if (settings.hideEnabled) queueScan(document); }, 2500);

    // Both sites are client-routed. popstate is the only native signal here --
    // pushState/replaceState fire no event at all, so those route changes are
    // picked up by the periodic sweep above rather than by a listener that
    // would never run.
    window.addEventListener('popstate', () => queueScan(document));
  }

  function updateSettings(next) {
    const before = {
      hideEnabled: settings.hideEnabled,
      hideFeedPosts: settings.hideFeedPosts,
      hideComments: settings.hideComments,
      hideMode: settings.hideMode
    };
    Object.assign(settings, next || {});

    if (!settings.hideEnabled) {
      if (before.hideEnabled) {
        for (const node of document.querySelectorAll('[data-cb-hidden]')) unhide(node, true);
      }
      return;
    }
    // Narrowing what we hide, or changing how, must release whatever is
    // currently hidden -- otherwise a post stays gone after its category is
    // switched off, with no way to get it back.
    const changed = before.hideEnabled !== settings.hideEnabled ||
                    before.hideFeedPosts !== settings.hideFeedPosts ||
                    before.hideComments !== settings.hideComments ||
                    before.hideMode !== settings.hideMode;
    if (changed) rescanAll();
  }

  globalThis.CB_DOM = {
    start, scan: queueScan, rescanAll, invalidateDecisions, updateSettings,
    stats: () => Object.assign({}, stats)
  };
})();
