/**
 * In-page clone reporting (ISOLATED world).
 *
 * Puts a small "Report" affordance on profile links wherever they appear --
 * feed posts, comments, reply threads, profile headers -- so someone can flag a
 * clone at the moment they notice it, without leaving the page or hunting for
 * the extension.
 *
 * Two deliberate implementation choices:
 *
 *   Shadow DOM. Every piece of our UI lives inside a closed-ish shadow root on
 *   a single host element. Facebook and Threads ship enormous global
 *   stylesheets and rotate class names constantly; without a shadow boundary
 *   our widget would inherit their styles and, worse, could be caught by their
 *   own selectors. It also keeps us from leaking styles into their page.
 *
 *   Hover with a delay, not a permanent badge. Injecting a visible control next
 *   to every author on screen would be its own kind of vandalism, and would
 *   fight the feed's virtualisation. The chip is summoned by intent instead.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const T = globalThis.CB_T;
  const bridge = globalThis.CB_BRIDGE;
  const identity = globalThis.CB_IDENTITY;

  const PLATFORM = bridge.state.platform;
  const settings = { reportUiEnabled: true, reportHoverDelayMs: 350, debug: false };

  // The reasons offered here ARE the tag vocabulary, in its order: a reason is
  // a vote for a tag, so one the tags do not contain is a vote nothing can
  // ever count. Built from the shared list rather than written out again --
  // a second copy is the copy that goes stale when a category is added.
  //
  // Read when the sheet is BUILT, not when this file parses. The content
  // script loads at document_start, long before the language override has
  // been fetched, so a list captured here would pin the reasons to the
  // browser's language while the rest of the sheet spoke the chosen one.
  const reasons = () => (globalThis.CB_TAGS || [])
    .map(t => [t, (globalThis.CB_TAG_LABELS || {})[t] || t]);

  function log(...a) { if (settings.debug) console.debug('[CloneBlocker/report]', ...a); }

  // -- identity of a hovered anchor -----------------------------------------
  const FB_RESERVED = /^(profile\.php|photo|photo\.php|watch|groups|pages|events|marketplace|reel|reels|stories|share|permalink|posts|videos|hashtag|search|messages|notifications|friends|settings|privacy|help|policies|login|reg|home|gaming|weather|fundraisers|saved|memories|bookmarks|ads|business|legal|terms|about|careers|people|places|games|live|media|story\.php|browse|allactivity|pages_feed|pg|me)$/i;

  function identityFromAnchor(a) {
    const href = a.getAttribute('href') || '';
    let m;
    if ((m = href.match(/profile\.php\?id=(\d+)/))) {
      return { profileId: m[1], username: null };
    }
    if ((m = href.match(/(?:threads\.(?:net|com))?\/@([A-Za-z0-9._]+)/))) {
      return { profileId: null, username: m[1] };
    }
    if ((m = href.match(/^https?:\/\/[^/]*facebook\.com\/([A-Za-z0-9.\-]+)(?:[/?#]|$)/)) ||
        (m = href.match(/^\/([A-Za-z0-9.\-]+)(?:[/?#]|$)/))) {
      if (!FB_RESERVED.test(m[1])) return { profileId: null, username: m[1] };
    }
    return null;
  }

  /** Fill in whichever half of the identity we can from the learned alias map. */
  function enrich(ident) {
    const out = Object.assign({}, ident);
    if (!out.profileId && out.username) {
      const id = identity.idForUsername(out.username);
      if (id) out.profileId = id;
    }
    if (!out.username && out.profileId) {
      const u = identity.usernameForId(out.profileId);
      if (u) out.username = u;
    }
    return out;
  }

  /** Is this identity the signed-in user? Reporting yourself is never wanted,
   *  and the site links to your own profile in its navigation constantly. */
  function isViewer(ident) {
    const me = bridge.state.viewerId;
    if (!me) return false;
    if (ident.profileId && String(ident.profileId) === String(me)) return true;
    const myName = identity.usernameForId(me);
    if (myName && ident.username && identity.norm(ident.username) === identity.norm(myName)) return true;
    return false;
  }

  const CHROME_LABELS = /^(profile|home|search|messages|notifications|activity|saved|insights|feeds|settings|menu|more)$/i;

  function displayNameFor(anchor) {
    let t = (anchor.textContent || '').trim();
    // Some links repeat their label ("ProfileProfile") because of visually
    // hidden text; collapse that before judging it.
    const half = t.slice(0, t.length / 2);
    if (half && half + half === t) t = half;
    if (t && t.length <= 60 && !/^https?:/.test(t) && !CHROME_LABELS.test(t)) return t;
    const img = anchor.querySelector && anchor.querySelector('img[alt]');
    if (img) return (img.getAttribute('alt') || '').slice(0, 60);
    return '';
  }

  function profileUrlFor(ident) {
    if (PLATFORM === 'threads') {
      return ident.username ? 'https://www.threads.com/@' + ident.username : null;
    }
    if (ident.profileId) return 'https://www.facebook.com/profile.php?id=' + ident.profileId;
    return ident.username ? 'https://www.facebook.com/' + ident.username : null;
  }

  // -- shadow host ----------------------------------------------------------
  let host = null, root = null, chip = null, modal = null;
  let hoverTimer = null, currentAnchor = null, currentIdent = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }

    .chip {
      position: fixed; z-index: 2147483647;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px; border-radius: 999px;
      background: #1c1e21; color: #fff;
      font-size: 12px; font-weight: 600; line-height: 1;
      border: 1px solid rgba(255,255,255,.18);
      box-shadow: 0 4px 14px rgba(0,0,0,.35);
      cursor: pointer; user-select: none;
      opacity: 0; transform: translateY(2px);
      transition: opacity .12s ease, transform .12s ease;
      /* Hidden means UNCLICKABLE, and this line is the whole of that.
         Without it the chip stayed a 59x24 hit target at the maximum z-index,
         parked wherever it was last shown, for the life of the page: opacity 0
         paints nothing and blocks everything. Clicking Like -- or anything
         else that happened to be underneath -- opened the report sheet, for
         whichever profile had last been hovered. */
      pointer-events: none;
    }
    .chip.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
    .chip:hover { background: #33363a; }
    .chip.reported { background: #7a4b00; }
    .chip.blocked  { background: #6b1f1f; }
    .chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #ff6b6b; }

    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center;
    }
    .sheet {
      width: min(420px, calc(100vw - 32px));
      background: #fff; color: #16181c;
      border-radius: 14px; overflow: hidden;
      box-shadow: 0 18px 50px rgba(0,0,0,.4);
    }
    @media (prefers-color-scheme: dark) {
      .sheet { background: #1e2127; color: #e8eaed; }
      .sheet input, .sheet select, .sheet textarea {
        background: #16181c; color: #e8eaed; border-color: #333;
      }
      .who, .post { background: #16181c !important; }
    }
    .hd { padding: 14px 16px; font-size: 15px; font-weight: 700;
          border-bottom: 1px solid rgba(128,128,128,.25); }
    .bd { padding: 14px 16px; }
    .who { display: flex; flex-direction: column; gap: 2px;
           background: #f2f3f5; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
    .who .n { font-weight: 700; font-size: 13px; }
    .who .m { font-size: 12px; opacity: .7; word-break: break-all; }
    .post { background: #f2f3f5; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
    .plabel { font-size: 11px; font-weight: 700; text-transform: uppercase;
              letter-spacing: .05em; opacity: .6; margin-bottom: 4px; }
    .psummary { font-size: 13px; line-height: 1.4; max-height: 96px; overflow: hidden;
                white-space: pre-wrap; word-break: break-word; }
    .purl { display: block; margin-top: 6px; font-size: 11px; color: #1d6fe0;
            word-break: break-all; text-decoration: none; }
    .purl:hover { text-decoration: underline; }
    label { display: block; font-size: 12px; font-weight: 600; margin: 10px 0 4px; }
    select, textarea {
      width: 100%; padding: 8px 10px; font: inherit; font-size: 13px;
      border: 1px solid rgba(128,128,128,.4); border-radius: 8px; background: #fff;
    }
    textarea { resize: vertical; min-height: 62px; }
    .alsoblock {
      display: flex; align-items: center; gap: 8px; margin: 12px 0 0;
      font-size: 13px; cursor: pointer;
    }
    .alsoblock input { margin: 0; cursor: pointer; }
    .alsoblock input:disabled { cursor: default; }
    .blocknote { margin-top: 4px; }
    .ft { display: flex; gap: 8px; justify-content: flex-end;
          padding: 12px 16px; border-top: 1px solid rgba(128,128,128,.25); }
    button {
      padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 600;
      border-radius: 8px; border: 1px solid rgba(128,128,128,.4);
      background: transparent; color: inherit; cursor: pointer;
    }
    button.primary { background: #1d6fe0; border-color: #1d6fe0; color: #fff; }
    button.primary:disabled { opacity: .6; cursor: default; }
    .note { font-size: 12px; opacity: .75; margin-top: 10px; }
    .err { color: #c0392b; font-size: 12px; margin-top: 10px; }
    .ok  { color: #2e7d32; font-size: 13px; }
    .badge { display:inline-block; padding:2px 7px; border-radius:999px;
             font-size:11px; font-weight:700; background:#eee; color:#333; margin-left:6px; }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-cloneblocker-ui', '');
    // Keep the host itself inert; only children inside the shadow root paint.
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
  }

  // -- the hover chip -------------------------------------------------------
  function hideChip() {
    if (chip) { chip.classList.remove('show'); }
    currentAnchor = null;
    // The identity goes with it. It was left behind before, so anything that
    // did reach the chip's handler reported the last profile hovered rather
    // than the one under the pointer -- the wrong account, silently.
    currentIdent = null;
  }

  function showChipFor(anchor, ident) {
    ensureHost();
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'chip';
      chip.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
      chip.addEventListener('click', (e) => {
        // Belt to the CSS braces: only a chip that is actually on screen, for
        // a profile we still know, may open anything. A click arriving at a
        // hidden chip is a click meant for whatever is underneath it, so it is
        // left alone rather than swallowed.
        if (!chip.classList.contains('show') || !currentIdent) return;
        e.preventDefault(); e.stopPropagation();
        openModal(currentIdent, currentAnchor);
      });
      root.appendChild(chip);
    }
    currentAnchor = anchor;
    currentIdent = ident;

    chip.className = 'chip';
    chip.textContent = '';
    const label = document.createElement('span');
    label.textContent = T('report_chip');
    chip.appendChild(label);

    const r = anchor.getBoundingClientRect();
    // Anchor to the link, nudged clear of it, and kept inside the viewport.
    const top = Math.max(4, Math.min(window.innerHeight - 30, r.top - 26));
    const left = Math.max(4, Math.min(window.innerWidth - 96, r.left));
    chip.style.top = top + 'px';
    chip.style.left = left + 'px';
    requestAnimationFrame(() => chip.classList.add('show'));

    // Decorate with what we already know, then refresh from the server.
    bridge.sw(P.SW.REPORT_STATUS, {
      platform: PLATFORM, profileId: ident.profileId, username: ident.username
    }).then((st) => {
      if (!chip || currentAnchor !== anchor) return;
      if (st && st.blocked) {
        chip.classList.add('blocked');
        label.textContent = T('report_chipBlocked');
      } else if (st && st.status === 'pending') {
        chip.classList.add('reported');
        label.textContent = st.count > 1
          ? T('report_chipReportedCount', st.count) : T('report_chipReported');
      }
    }).catch(() => {});
  }

  function onPointerOver(ev) {
    if (!settings.reportUiEnabled) return;
    const t = ev.target;
    if (!t || t.nodeType !== 1) return;
    if (host && host.contains(t)) return;

    const anchor = t.closest && t.closest('a[href]');
    if (!anchor) { scheduleHide(); return; }
    if (anchor === currentAnchor) return;

    // Site chrome links to profiles too -- the sidebar "Profile" entry, the
    // account switcher. Those are navigation, not someone you encountered in
    // content, and their link text makes a nonsense display name.
    if (anchor.closest('nav, [role="navigation"], [role="banner"], header')) { scheduleHide(); return; }

    const ident = identityFromAnchor(anchor);
    if (!ident) { scheduleHide(); return; }

    const enriched = enrich(ident);
    if (isViewer(enriched)) { scheduleHide(); return; }   // never offer to report yourself

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showChipFor(anchor, enriched),
                            Math.max(0, settings.reportHoverDelayMs | 0));
  }

  let hideTimer = null;
  function scheduleHide() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideChip, 400);
  }

  // -- the report sheet -----------------------------------------------------

  /**
   * Take a post off the screen, once, because the reader just acted on it.
   *
   * Not the same thing as hiding, and it deliberately does not go through
   * dom-blocker. That is a standing judgement about an account: reversible,
   * re-applied on every rescan, owned by the blocklist. This is an
   * acknowledgement of a click, so it happens whether or not hiding is
   * switched on and nothing reverses it.
   *
   * The height is pinned before the collapse starts because `max-height` has
   * nothing to animate from when it is `none`, which is every real post -- the
   * animation would jump instead of collapsing. `animationend` is backed by a
   * timer because an element taken out of the document mid-animation (React
   * recycles these constantly) never fires it, and the attribute would be left
   * on a node handed back later.
   */
  function dismissPost(el) {
    if (!el || !el.isConnected) return;
    if (el.getAttribute('data-cb-dismissing') === '1') return;
    try {
      el.style.setProperty('max-height', el.getBoundingClientRect().height + 'px', 'important');
      el.setAttribute('data-cb-dismissing', '1');
      const done = () => {
        el.setAttribute('data-cb-dismissed', '1');
        el.removeAttribute('data-cb-dismissing');
        el.style.removeProperty('max-height');
      };
      el.addEventListener('animationend', done, { once: true });
      setTimeout(done, 600);
    } catch (e) { /* a post that will not animate is not worth an exception */ }
  }

  function closeModal() {
    if (modal) { modal.remove(); modal = null; }
  }

  /**
   * @param context optional {postUrl, summary, postId} when the report was
   *   raised from a specific post rather than from a bare profile link. The
   *   dialog shows exactly what will be sent -- someone confirming a report
   *   should be able to see the post it refers to, not just a name.
   */
  function openModal(ident, anchor, context) {
    ensureHost();
    closeModal();
    hideChip();

    const ctx = context || {};
    const name = (anchor ? displayNameFor(anchor) : '') || ctx.displayName || '';
    const url = ctx.postUrl || profileUrlFor(ident);

    modal = document.createElement('div');
    modal.className = 'backdrop';
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    // The skeleton carries data-i18n keys and no text of its own, so this
    // dialog picks up a language the same way the extension's own pages do --
    // and a string added here later cannot quietly skip translation.
    sheet.innerHTML = `
      <div class="hd" data-i18n="report_sheetTitle"></div>
      <div class="bd">
        <div class="who">
          <span class="n"></span>
          <span class="m"></span>
        </div>
        <div class="post" hidden>
          <div class="plabel" data-i18n="report_postLabel"></div>
          <div class="psummary"></div>
          <a class="purl" target="_blank" rel="noreferrer noopener"></a>
        </div>
        <label for="reason" data-i18n="report_reasonLabel"></label>
        <select id="reason"></select>
        <label for="note" data-i18n="report_noteLabel"></label>
        <textarea id="note" data-i18n-placeholder="report_notePlaceholder"></textarea>
        <label class="alsoblock">
          <input type="checkbox" id="alsoBlock">
          <span data-i18n="report_alsoBlock"></span>
        </label>
        <div class="blocknote note" hidden></div>
        <!-- What sending this actually leads to, said BEFORE the button
             rather than only on the confirmation afterwards. It was only in
             the success state, which meant the one fact that might persuade
             somebody to bother reporting was shown exclusively to people who
             already had. -->
        <div class="note" data-i18n="report_adminReviews"></div>
        <div class="note" data-i18n="report_disclaimer"></div>
        <div class="err" hidden></div>
      </div>
      <div class="ft">
        <button class="cancel" data-i18n="report_cancel"></button>
        <button class="primary submit" data-i18n="report_submit"></button>
      </div>`;
    globalThis.CB_APPLY_I18N(sheet);
    modal.appendChild(sheet);
    root.appendChild(modal);

    const $ = (s) => sheet.querySelector(s);
    $('.who .n').textContent = name ||
      (ident.username ? '@' + ident.username : T('report_unknownProfile'));
    $('.who .m').textContent = [
      ident.username ? '@' + ident.username : null,
      ident.profileId ? T('common_idValue', ident.profileId) : T('report_noNumericId'),
      PLATFORM
    ].filter(Boolean).join('  ·  ');

    if (ctx.summary || ctx.postUrl) {
      $('.post').hidden = false;
      $('.psummary').textContent = ctx.summary || T('report_noPostText');
      if (ctx.postUrl) {
        $('.purl').textContent = ctx.postUrl;
        $('.purl').href = ctx.postUrl;
      } else {
        $('.purl').remove();
      }
    }

    const sel = $('#reason');
    for (const [value, text] of reasons()) {
      const o = document.createElement('option');
      o.value = value; o.textContent = text;
      sel.appendChild(o);
    }

    // A report has to carry the account behind it, so say so up front rather
    // than letting someone write out a case and lose it to a 401 on submit.
    if (!bridge.state.viewerId) {
      const err = $('.err');
      err.hidden = false;
      err.textContent = T('report_signIn', PLATFORM === 'facebook' ? 'Facebook' : 'Threads');
      $('.submit').disabled = true;
    }

    // The box is never disabled. It was, on two conditions that both looked
    // like good reasons and were not:
    //
    //   blocking paused -- the block is QUEUED either way, and a queue
    //     survives until somebody turns blocking back on. Greying the box out
    //     refused an intent it could have recorded perfectly well, from a
    //     dialog where the reader cannot see what some other screen is set to.
    //
    //   no numeric id yet -- a block is issued against an id, never a
    //     username, and on Threads the id is learned from the page rather
    //     than being in the URL. So this is not "impossible", it is "not yet",
    //     and how long it takes depends on how far the page has loaded. A box
    //     that is dead for the first few seconds of every visit, on the
    //     profile the reader is actually looking at, is indistinguishable
    //     from a broken one -- which is exactly how it was reported.
    //
    // So: always tickable, ticked by default, and the note says what will
    // actually happen rather than what cannot.
    const box = $('#alsoBlock');
    const blockNote = $('.blocknote');
    box.disabled = false;
    box.checked = settings.reportAlsoBlocks !== false;

    if (!ident.profileId) {
      blockNote.hidden = false;
      blockNote.textContent = T('report_alsoBlockWhenSeen');
    } else if (settings.platformBlockEnabled === false) {
      blockNote.hidden = false;
      blockNote.textContent = T('report_alsoBlockQueued');
    }
    box.addEventListener('change', () => {
      // Remembered, because someone who unticks it means it.
      bridge.sw(P.SW.SET_SETTINGS, { reportAlsoBlocks: box.checked });
      settings.reportAlsoBlocks = box.checked;
    });

    $('.cancel').addEventListener('click', closeModal);
    $('.submit').addEventListener('click', () => {
      const btn = $('.submit');
      btn.disabled = true;

      // OPTIMISTIC, and the outbox is what makes that honest rather than
      // hopeful.
      //
      // This used to send the report, then queue the block, then poll for up
      // to six seconds to find out whether the block had landed, and only then
      // say something -- so that the one sentence somebody reads after acting
      // would be true. The intent was right and the result was not: six
      // seconds of a disabled button is long enough to wonder whether the
      // click registered, and the post they were reporting sat there the whole
      // time.
      //
      // What changed underneath is that a report which cannot be sent is now
      // kept and retried rather than lost, so "sent" is a promise the
      // extension can actually keep at the instant the button is pressed. The
      // block is a queue entry served first and woken for, so "being blocked"
      // is true then too. Neither claims to have finished, because neither
      // has.
      //
      // And if either does fail, that reaches them: a failed block they asked
      // for puts a count on the toolbar icon. Optimism without that channel
      // would just be a lie with better timing.
      const wantsBlock = box.checked;

      // Resolve the identity again HERE, rather than trusting the one the
      // sheet opened with.
      //
      // The block below already did this and the report did not, and that
      // asymmetry was doing real damage. On Threads an id is only ever learned
      // by a sweep that runs every fifteen seconds, and this sheet stays open
      // for as long as it takes somebody to pick a reason and type a note. So
      // the ordinary case was a sweep landing WHILE the dialog was up -- after
      // which the block resolved an id and succeeded, and the report, still
      // holding the null from the moment of the click, was filed against
      // nothing and refused. The account went away and the report never
      // arrived, which is exactly as baffling to the person as it sounds.
      //
      // The worker's username fallback means neither outcome loses a report
      // any more. This is still worth doing: a report that carries the id
      // aggregates with every other report of that account, where one carrying
      // only the handle opens a second record the server then has to
      // reconcile.
      const fresh = enrich(ident);

      const payload = {
        platform: PLATFORM,
        viewerId: bridge.state.viewerId || null,
        profileId: fresh.profileId,
        username: fresh.username || ident.username,
        displayName: name,
        url,
        reason: sel.value,
        note: $('#note').value.slice(0, 400),
        postUrl: ctx.postUrl || null,
        postId: ctx.postId || null,
        contentSummary: ctx.summary || null
      };

      // WHERE we are decides what happens next, and the two cases want
      // opposite things.
      //
      // In a feed, the post is one item among many: take it off the screen,
      // say "sent", and let the rest of the page carry on. Nothing left in
      // view is made wrong by the block landing a moment later.
      //
      // On the reported account's OWN profile page, every pixel is about them.
      // Dismissing one post there is pointless -- the rest of the page is
      // still theirs -- and leaving the page untouched after somebody pressed
      // Block reads as nothing having happened. So that case waits for the
      // block and reloads, exactly as the popup does, and for the same reason:
      // the reload is the confirmation.
      //
      // Only when a block was actually asked for. A report on its own changes
      // nothing about what this page should show, so reloading would throw
      // away their scroll position to no purpose.
      const reloadAfter = wantsBlock && onProfilePageFor(ident);
      if (!reloadAfter && ctx.postEl) dismissPost(ctx.postEl);
      showSent(wantsBlock, reloadAfter);

      // Deliberately not awaited. The sheet is already showing the outcome and
      // will be gone shortly; the worker owns what happens next either way.
      // Both at once, not one after the other. The block does not depend on
      // anything the report comes back with, and chaining them meant a slow
      // report delayed the block by exactly as long as it took -- which is the
      // one part of this that the person can actually see the consequences of,
      // because until it lands the account keeps appearing in front of them.
      void bridge.sw(P.SW.SUBMIT_REPORT, payload).catch(() => null);
      if (wantsBlock) {
        // The same resolution the report was just built from, deliberately
        // reused rather than taken again. Two enrich() calls a few statements
        // apart could disagree if a sweep landed between them, and a block
        // aimed at one target while the report names another is the one
        // outcome neither of them should be able to produce.
        const now = fresh;
        // No id: the report still carries the username, and once that is on
        // the list the ordinary sweep blocks the profile the next time it is
        // seen. Nothing is lost, so nothing is claimed -- but the sheet has
        // already said "being blocked", so say the truer thing instead.
        if (now.profileId) {
          const queued = bridge.sw(P.SW.ENQUEUE_PLATFORM_BLOCK, {
            platform: PLATFORM,
            ids: [String(now.profileId)],
            names: now.username ? { [String(now.profileId)]: now.username } : undefined,
            warm: true,
            userInitiated: true
          }).catch(() => null);

          if (reloadAfter) {
            void (async () => {
              await queued;
              // Twenty seconds, then give up quietly. A block that has not
              // landed by then is usually waiting on the gate, and reloading
              // would show the account exactly as it is now -- which looks
              // like the block failed rather than like it is still coming.
              // The sheet already says what was asked for, and a failure has
              // the toolbar badge.
              if (await blockLanded(now.profileId, 20000)) location.reload();
            })();
          }
        }
      }
    });

    /**
     * The success state, drawn from what is true at the moment of the click.
     *
     * It cannot say "blocked" and it cannot say "duplicate": both are answers
     * that only exist after a round trip, and waiting for them is exactly what
     * this stopped doing. It says what was asked for, which is what somebody
     * pressing the button wants confirmed.
     */
    function showSent(wantsBlock, willReload) {
      // Built out of nodes rather than out of a string of HTML, which is what
      // lets the status word and the count be separate translated messages
      // instead of fragments concatenated around markup.
      const bd = sheet.querySelector('.bd');
      bd.textContent = '';
      const ok = document.createElement('div');
      ok.className = 'ok';
      ok.textContent = T('report_sent');
      // Asked for, accepted, not finished yet. Said plainly rather than
      // rounded up to "blocked".
      const queuedNote = wantsBlock ? document.createElement('div') : null;
      if (queuedNote) {
        queuedNote.className = 'note';
        // Warn about the reload rather than letting the page vanish mid-read.
        // A page that reloads unannounced feels like a crash, even when it is
        // the thing that was asked for.
        queuedNote.textContent = willReload
          ? T('report_blockThenReload') : T('report_blockQueued');
      }
      const foot = document.createElement('div');
      foot.className = 'note';
      // What used to sit here was the server's own status word and a count of
      // how many people had reported this account. Both were genuinely useful
      // and both are gone, because both are answers that only exist after the
      // round trip this no longer waits for. Claiming either now would mean
      // guessing. The activity page still shows the real status once it
      // arrives, which is the right place for a fact that takes time.
      foot.textContent = T('report_adminReviews');
      bd.appendChild(ok);
      if (queuedNote) bd.appendChild(queuedNote);
      bd.appendChild(foot);
      sheet.querySelector('.ft').textContent = '';
      const done = document.createElement('button');
      done.className = 'primary'; done.textContent = T('report_done');
      done.addEventListener('click', closeModal);
      sheet.querySelector('.ft').appendChild(done);
      done.focus();
    }

    sel.focus();
  }

  // -- public entry points (used by the popup) ------------------------------

  /** Whose profile is this page showing, from the URL alone? */
/**
   * Is the page we are on the profile of the account being reported?
   *
   * `/@someone`, `/@someone/replies`, `/@someone/media` are all that person's
   * profile, so the match is on the leading segment rather than the whole
   * path -- identityFromLocation() already reads it that way.
   *
   * Only the username is compared. On Threads the URL never carries a numeric
   * id, so an id-to-id comparison would answer "no" on exactly the pages this
   * exists for.
   */
  function onProfilePageFor(who) {
    const here = identityFromLocation();
    if (!here || !who) return false;
    const a = String(here.username || '').trim().toLowerCase().replace(/^@/, '');
    const b = String(who.username || '').trim().toLowerCase().replace(/^@/, '');
    if (a && b) return a === b;
    // Facebook can name a profile by id in the URL; use it when that is what
    // both sides have.
    return !!(here.profileId && who.profileId && String(here.profileId) === String(who.profileId));
  }

  /**
   * Wait for a target to actually be blocked.
   *
   * Only used on the path that reloads afterwards. Polling rather than a
   * subscription because the answer is wanted once, for a few seconds, by a
   * page that is about to be replaced.
   */
  async function blockLanded(profileId, ms) {
    const deadline = Date.now() + (ms || 20000);
    while (Date.now() < deadline) {
      const st = await bridge.sw(P.SW.GET_STATE).catch(() => null);
      const done = st && st.done && st.done[PLATFORM];
      if (Array.isArray(done) && done.includes(String(profileId))) return true;
      await new Promise(r => setTimeout(r, 400));
    }
    return false;
  }

  function identityFromLocation() {
    if (PLATFORM === 'threads') {
      const m = location.pathname.match(/^\/@([A-Za-z0-9._]+)/);
      return m ? { profileId: null, username: m[1] } : null;
    }
    const m = location.search.match(/[?&]id=(\d+)/);
    if (m) return { profileId: m[1], username: null };
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (seg && !FB_RESERVED.test(seg)) return { profileId: null, username: seg };
    return null;
  }

  /**
   * What the popup needs to offer an action for this page, without opening
   * anything. Reporting and blocking are both about a specific profile, so a
   * popup that cannot name the profile can only offer generic settings -- which
   * is what it used to do.
   */
  function currentProfileInfo() {
    const ident = identityFromLocation();
    if (!ident) return null;
    const enriched = enrich(ident);
    const hit = identity.match({ id: enriched.profileId, username: enriched.username });
    return {
      profileId: enriched.profileId || null,
      username: enriched.username || null,
      isViewer: isViewer(enriched),
      listed: !!hit,
      listedBy: hit ? hit.by : null
    };
  }

  /** Report whatever profile this page is currently showing. */
  function reportCurrentProfile() {
    let anchor = null;
    const ident = identityFromLocation();
    if (!ident) return { ok: false, error: T('report_notAProfile') };
    const enriched = enrich(ident);
    if (isViewer(enriched)) return { ok: false, error: T('report_ownProfile') };
    // Prefer a real byline anchor so the display name comes out right.
    anchor = document.querySelector('a[href*="' + (ident.username || ident.profileId) + '"]');
    openModal(enriched, anchor);
    return { ok: true, ident: enriched };
  }

  // ==========================================================================
  // Threads: a report button in each post's action bar.
  //
  // The hover chip is fine for a name in passing, but reporting a clone is
  // usually prompted by a *post*, and the report is far more useful to a
  // reviewer when it carries that post. So on Threads the button sits in the
  // action row next to Share, and the report it raises includes the permalink
  // and a summary of the content.
  // ==========================================================================
  const MARK_ATTR = 'data-cloneblocker-report-btn';
  const SHARE_LABELS = /^(share|send to|send)$/i;
  const ACTION_LABELS = /^(like|reply|repost|share|send to|send)$/i;

  /** Pull the reportable facts out of a post container. */
  function extractPostContext(container) {
    let permalink = null, authorHref = null;
    const anchors = container.querySelectorAll('a[href]');
    for (const a of anchors) {
      const h = a.getAttribute('href') || '';
      if (!permalink && /\/@[^/]+\/post\//.test(h)) permalink = h;
      if (!authorHref && /^\/@[^/]+$/.test(h)) authorHref = h;
    }
    // The permalink also names the author, which is the most reliable source:
    // a repost shows one name in the header and another on the post itself.
    let username = null;
    const pm = permalink && permalink.match(/^\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/);
    if (pm) username = pm[1];
    else if (authorHref) username = authorHref.replace(/^\/@/, '');

    // Content summary: the longest auto-direction text block that is not the
    // author's own handle or an interface label.
    let best = '';
    for (const el of container.querySelectorAll('span[dir="auto"], div[dir="auto"]')) {
      const t = (el.innerText || '').trim();
      if (t.length <= best.length) continue;
      if (username && t === username) continue;
      if (/^(translate|edited|follow|reply|repost|share|like)$/i.test(t)) continue;
      best = t;
    }
    // Trim trailing interface words the text nodes tend to absorb.
    best = best.replace(/\s*\bTranslate\s*$/i, '').trim();

    return {
      username,
      postId: pm ? pm[2] : null,
      postUrl: permalink ? new URL(permalink, location.origin).href : null,
      summary: best ? best.slice(0, 280) : ''
    };
  }

  function reportIconSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-label', T('report_iconLabel'));
    // A block glyph, not a flag. Flagging is what you do to ask someone else
    // to look; this control reports AND, by default, blocks -- and it is the
    // same mark the extension wears in the toolbar, so the two read as one
    // product rather than two unrelated affordances.
    const ring = document.createElementNS(ns, 'circle');
    ring.setAttribute('cx', '12');
    ring.setAttribute('cy', '12');
    ring.setAttribute('r', '9');
    const slash = document.createElementNS(ns, 'line');
    slash.setAttribute('x1', '5.6');
    slash.setAttribute('y1', '5.6');
    slash.setAttribute('x2', '18.4');
    slash.setAttribute('y2', '18.4');
    svg.appendChild(ring);
    svg.appendChild(slash);
    return svg;
  }

  /**
   * Find the last control in a post's action row, to sit after it.
   *
   * Two passes, and the second one is the point. Matching the word "Share" is
   * fast and precise -- on an English page. On a Vietnamese one the label
   * reads "Chia sẻ", nothing matched, and the in-post report button was never
   * injected at all: the whole affordance was dead for every non-English user,
   * silently, and this deployment's users are overwhelmingly Vietnamese.
   *
   * So if no label matches, fall back to the SHAPE the row has in every
   * language: several sibling icon buttons in one row inside a post. Take the
   * last of them and sit after it, which is where the labelled pass would have
   * put us anyway.
   */
  function findShareSlot(container) {
    return findShareSlotByLabel(container) || findShareSlotByShape(container);
  }

  function findShareSlotByLabel(container) {
    const svgs = container.querySelectorAll('svg[aria-label]');
    for (const svg of svgs) {
      const label = (svg.getAttribute('aria-label') || '').trim();
      if (!SHARE_LABELS.test(label)) continue;
      const btn = svg.closest('[role="button"],button,div[tabindex]');
      if (!btn) continue;
      // Sit alongside the other actions: use the button's own wrapper so the
      // row's flex layout treats ours the same way it treats theirs.
      const slot = btn.parentElement && btn.parentElement.children.length === 1
        ? btn.parentElement : btn;
      // Only accept it if this really is the action row -- a post can contain
      // other share affordances (embedded quotes carry their own).
      const row = slot.parentElement;
      if (!row) continue;
      let siblingActions = 0;
      for (const s of row.querySelectorAll('svg[aria-label]')) {
        if (ACTION_LABELS.test((s.getAttribute('aria-label') || '').trim())) siblingActions++;
      }
      if (siblingActions >= 2) return slot;
    }
    return null;
  }

  /**
   * The same row, found by its shape rather than by English.
   *
   * An action row is a single element whose children are icon buttons -- three
   * or more of them, each wrapping one labelled svg, all on one line. That
   * description holds in every language Meta ships, and it is specific enough
   * that no other part of a post matches it: a post's body has text nodes and
   * links, not a run of icon-only buttons.
   *
   * Deliberately conservative. Injecting into the wrong element would put a
   * report control somewhere meaningless, so a row must earn it by having at
   * least three icon children and no text of its own.
   */
  function findShareSlotByShape(container) {
    const rows = new Map();
    for (const svg of container.querySelectorAll('svg[aria-label]')) {
      const btn = svg.closest('[role="button"],button,div[tabindex]');
      if (!btn) continue;
      const slot = btn.parentElement && btn.parentElement.children.length === 1
        ? btn.parentElement : btn;
      const row = slot.parentElement;
      if (!row) continue;
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push(slot);
    }
    for (const [row, slots] of rows) {
      if (slots.length < 3) continue;
      // A row of controls, not a paragraph that happens to contain some.
      const text = (row.textContent || '').replace(/\s+/g, '');
      if (text.length > 40) continue;
      // Sit after the last one, which is where the labelled pass would land.
      let last = slots[0];
      for (const s of slots) {
        if (last.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) last = s;
      }
      return last;
    }
    return null;
  }

  function buildThreadButton(container) {
    const btn = document.createElement('div');
    btn.setAttribute(MARK_ATTR, '1');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-label', T('report_buttonLabel'));
    btn.title = T('report_buttonLabel');
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'gap:4px', 'height:36px', 'min-width:36px', 'padding:0 8px',
      'border-radius:999px', 'cursor:pointer', 'color:inherit', 'opacity:.62',
      'transition:opacity .12s ease,background-color .12s ease', 'user-select:none'
    ].join(';');
    btn.appendChild(reportIconSvg());

    btn.addEventListener('mouseenter', () => {
      btn.style.opacity = '1';
      btn.style.backgroundColor = 'rgba(128,128,128,.15)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.opacity = '.62';
      btn.style.backgroundColor = 'transparent';
    });

    const activate = (e) => {
      // Posts are themselves clickable; without this the click also navigates.
      e.preventDefault();
      e.stopPropagation();
      const ctx = extractPostContext(container);
      const ident = enrich({ profileId: null, username: ctx.username });
      if (isViewer(ident)) {
        // Nothing useful to do, and reporting yourself is never intended.
        return;
      }
      // The container comes along so the sheet can take the post off screen
      // the moment somebody acts on it. `postEl` first, so a key of the same
      // name in ctx could never quietly replace the node with a string.
      openModal(ident, null, Object.assign(
        { displayName: ctx.username ? '@' + ctx.username : '', postEl: container }, ctx));
    };
    btn.addEventListener('click', activate, true);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') activate(e);
    });
    return btn;
  }

  let injectQueued = false;
  function injectThreadButtons() {
    if (PLATFORM !== 'threads' || !settings.reportUiEnabled) return;
    const containers = document.querySelectorAll('[data-pressable-container]');
    let added = 0;
    for (const c of containers) {
      // React reuses these nodes, so an existing button may belong to a post
      // that is no longer displayed here; keying on the permalink keeps it
      // honest.
      const slot = findShareSlot(c);
      if (!slot || !slot.parentElement) continue;
      const row = slot.parentElement;
      const existing = row.querySelector('[' + MARK_ATTR + ']');
      const ctx = extractPostContext(c);
      if (existing) {
        if (existing.getAttribute('data-cloneblocker-post') === (ctx.postUrl || '')) continue;
        existing.remove();
      }
      const btn = buildThreadButton(c);
      btn.setAttribute('data-cloneblocker-post', ctx.postUrl || '');
      slot.insertAdjacentElement('afterend', btn);
      added++;
    }
    if (added) log('injected', added, 'thread report buttons');
  }

  function queueInject() {
    if (injectQueued) return;
    injectQueued = true;
    let ran = false;
    const run = () => {
      if (ran) return;
      ran = true;
      injectQueued = false;
      injectThreadButtons();
    };
    // Idle when the browser offers it, AND a timer regardless -- whichever
    // arrives first wins, which is what `ran` is for.
    //
    // requestIdleCallback is an optimisation, not a guarantee. It can be
    // starved indefinitely on a busy feed, and there are contexts where it
    // simply never fires: this used to be `requestIdleCallback` alone with the
    // timer only as a fallback for browsers lacking the API, and a Chrome
    // update quietly stopped firing it -- so the report button stopped
    // appearing at all, with no error anywhere. The periodic re-scan did not
    // save it either, because that also went through here.
    //
    // A button that appears during a slightly busy frame is a much smaller
    // problem than one that never appears.
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 500 });
    setTimeout(run, 250);
  }

  function startThreadButtons() {
    if (PLATFORM !== 'threads') return;
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList' && r.addedNodes.length) { queueInject(); return; }
      }
    });
    const attach = () => {
      obs.observe(document.documentElement || document, { childList: true, subtree: true });
      queueInject();
    };
    if (document.documentElement) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
    // The feed virtualises aggressively; a periodic pass catches rows the
    // observer's batching coalesced away.
    setInterval(queueInject, 3000);
  }

  function removeThreadButtons() {
    for (const b of document.querySelectorAll('[' + MARK_ATTR + ']')) b.remove();
  }

  function updateSettings(next) {
    Object.assign(settings, next || {});
    // The sheet is painted inside somebody else's page, so it never ran the
    // boot that extension pages use to pick up a language override. Settings
    // arriving here is the one moment it learns of one; the load is async and
    // the sheet is built on demand, so by the time anybody opens it the
    // dictionary is in place.
    if (globalThis.CB_LOAD_LOCALE) {
      globalThis.CB_LOAD_LOCALE(settings.uiLanguage).catch(() => {});
    }
    if (!settings.reportUiEnabled) { hideChip(); closeModal(); removeThreadButtons(); }
    else queueInject();
  }

  function start() {
    // Both, deliberately. pointerover is the modern event, but it is not
    // always synthesised for programmatic mouse input, and mouseover is the
    // one every path reliably produces. onPointerOver is idempotent for a
    // given anchor, so receiving both costs nothing.
    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('mouseover', onPointerOver, true);
    // The chip is position:fixed and its coordinates are taken once, from the
    // link it belongs to. The moment the page scrolls it is somewhere else --
    // over another post's actions, as often as not. It has no business
    // outliving the view it was measured in.
    window.addEventListener('scroll', hideChip, { capture: true, passive: true });
    document.addEventListener('pointerdown', (e) => {
      if (host && host.contains(e.target)) return;
      hideChip();
    }, true);
    window.addEventListener('scroll', hideChip, { passive: true, capture: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideChip(); closeModal(); } });
    startThreadButtons();
  }

  globalThis.CB_REPORT = {
    start, updateSettings, reportCurrentProfile, currentProfileInfo, openModal
  };
})();
