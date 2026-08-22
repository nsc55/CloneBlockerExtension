/**
 * Popup: what you can do about the profile in front of you.
 *
 * This used to be a status readout with the master switches and a Page
 * capability panel attached -- Bridge, Relay store, Block mutation, doc_ids.
 * All of that is diagnostics, it belongs in Settings, and it crowded out the
 * only two things anyone opens this popup to do: report the profile they are
 * looking at, or block it. Those are now the first thing in the window, named
 * after the actual profile.
 *
 * The hide toggle went the same way. Hiding ships off by default -- real
 * blocks are the product -- so it is a Settings choice rather than a switch to
 * flip from here. What took its place is the queue: how much is waiting, and
 * whatever silently stops it moving.
 *
 * Two questions live here and they are not the same one:
 *
 *   can I act on the profile in front of me?  That is the active tab, and the
 *     Report and Block buttons are right to go away when it is not a profile.
 *   is blocking working?                      That is whether ANY Facebook or
 *     Threads tab is open, anywhere. The active tab has nothing to do with it.
 *
 * The popup used to answer the second with the first, and told anyone reading
 * their email in a fourth tab that the extension was doing nothing while it
 * was blocking away in the other three.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const T = globalThis.CB_T;
  const $ = (id) => document.getElementById(id);
  const show = (id, on) => $(id).classList.toggle('hidden', !on);

  function sw(type, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      // A service worker that keeps the port open but never responds would
      // otherwise hang the popup with no feedback at all.
      setTimeout(() => done({ ok: false, error: T('common_workerSilent') }), 10000);
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) { done({ ok: false, error: chrome.runtime.lastError.message }); return; }
        done(res || { ok: false, error: T('common_noResponse') });
      });
    });
  }

  function ago(ts) {
    if (!ts) return T('time_never');
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return T('time_secondsAgo', s);
    if (s < 3600) return T('time_minutesAgo', Math.floor(s / 60));
    if (s < 86400) return T('time_hoursAgo', Math.floor(s / 3600));
    return T('time_daysAgo', Math.floor(s / 86400));
  }

  /** A pause, said in whichever unit reads better at that length. */
  function forMinutes(mins) {
    return mins > 90 ? T('time_hours', Math.ceil(mins / 60)) : T('time_minutes', mins);
  }

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !/facebook\.com|threads\.(net|com)/.test(tab.url || '')) return null;
    return tab;
  }

  // Blocks are issued by the content script, through the site's own code, so a
  // queued block has nowhere to run unless a Facebook or Threads tab is open.
  // These are the same patterns the service worker's badge counts against.
  const SITE_TAB_URLS = [
    'https://*.facebook.com/*', 'https://*.threads.net/*', 'https://*.threads.com/*'
  ];

  /**
   * How many Facebook or Threads tabs are open, anywhere.
   *
   * "Can I act on the profile in front of me?" and "is blocking working?" are
   * different questions, and this popup used to answer both with the active
   * tab. The first one it was right about; the second it was not. Somebody
   * with three Threads tabs open in another window, reading their email, was
   * told "Not on Facebook or Threads" -- which reads as "the extension is
   * off" while it is in fact blocking away in all three.
   *
   * null means the lookup itself failed. A warning that might be wrong is
   * worse than no warning, so callers say nothing rather than guess.
   */
  async function siteTabCount() {
    try {
      const tabs = await chrome.tabs.query({ url: SITE_TAB_URLS });
      return (tabs || []).length;
    } catch (e) {
      return null;
    }
  }

  /**
   * How much is queued, and how much of that is cold.
   *
   * Warm targets were on screen when they were queued, so in practice they
   * never sit waiting for a tab -- there was one. The cold ones came from the
   * ranked list, and nothing on screen will ever trigger them, so they are the
   * ones that can wait indefinitely. A bare string predates the warm flag and
   * the queue treats it as cold.
   */
  function queueCounts(state) {
    const q = (state && state.queue) || {};
    let total = 0, cold = 0;
    for (const platform of Object.keys(q)) {
      for (const e of q[platform] || []) {
        total++;
        if (!(e && typeof e === 'object' && e.warm)) cold++;
      }
    }
    return { total, cold };
  }

  async function tabStatus(tab) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'tab:status' }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res || null);
      });
    });
  }

  /** The label for whoever this page is about. */
  function nameOf(profile, platform) {
    if (!profile) return null;
    if (profile.username) return '@' + profile.username;
    // The page did not give up a username this time, but some earlier tab or
    // the published list may already have said who this id is.
    const known = knownNames[platform + ':' + profile.profileId];
    if (known && (known.d || known.u)) return known.d || '@' + known.u;
    if (profile.profileId) return T('common_profile', profile.profileId);
    return null;
  }

  // Filled from every GET_STATE, so nameOf can stay synchronous.
  let knownNames = {};

  let current = { tab: null, profile: null, platform: null };

  async function render() {
    const state = await sw(P.SW.GET_STATE);
    knownNames = (state && state.idNames) || {};
    const settings = (state && state.settings) || {};
    const stats = (state && state.stats) || {};
    const bl = state && state.blocklist;

    $('listLine').textContent = bl
      ? T('popup_listLine', bl.ids.length + bl.usernames.length, ago(bl.fetchedAt))
      : T('popup_listNotLoaded');

    const tab = await activeTab();
    current.tab = tab;
    let status = null;

    if (!tab) {
      $('platform').textContent = T('popup_platformUnsupported');
      $('who').textContent = T('popup_notOnSite');
      $('whoState').textContent = '';
      $('whoState').className = 'state';
      show('reportProfile', false);
      show('blockProfile', false);
      $('actionNote').textContent = T('popup_openProfileNote');
      $('hiddenCount').textContent = '—';
    } else {
      status = await tabStatus(tab);
      current.platform = (status && status.platform) || null;
      $('platform').textContent = current.platform || T('popup_platformLoading');
      $('hiddenCount').textContent = status && status.dom ? String(status.dom.hidden) : '—';

      if (!status) {
        $('who').textContent = T('popup_pageNotReady');
        $('whoState').textContent = '';
        $('whoState').className = 'state';
        show('reportProfile', false);
        show('blockProfile', false);
        $('actionNote').textContent = T('popup_reloadNote');
      } else {
        renderPage(status, settings);
      }
    }

    // Deliberately outside those branches, and it is told whether this tab is
    // a supported one rather than deciding for itself. Everything above is
    // about the page in front of you; everything below is about whether
    // blocking is running at all, which the active tab does not determine.
    await renderBlocking(state, settings, stats, status, !!tab);
  }

  /** The action card: who this is, and the one or two things to do about it. */
  function renderPage(status, settings) {
    const profile = status.profile || null;
    current.profile = profile;
    const label = nameOf(profile, current.platform);

    if (!label) {
      $('who').textContent = T('popup_noProfile');
      $('whoState').textContent = '';
      $('whoState').className = 'state';
      show('reportProfile', false);
      show('blockProfile', false);
      $('actionNote').textContent = T('popup_noProfileNote');
      return;
    }

    $('who').textContent = label;

    if (profile.isViewer) {
      $('whoState').textContent = T('popup_thisIsYou');
      $('whoState').className = 'state you';
      show('reportProfile', false);
      show('blockProfile', false);
      $('actionNote').textContent = '';
      return;
    }

    if (profile.listed) {
      $('whoState').textContent = T('popup_listed');
      $('whoState').className = 'state listed';
    } else {
      $('whoState').textContent = T('popup_notListed');
      $('whoState').className = 'state clear';
    }

    show('reportProfile', true);
    $('reportProfile').textContent = T(profile.listed
      ? 'popup_reportAgainButton' : 'popup_reportButton');

    // Blocking needs a numeric target, and blocking someone whose profile is
    // open is the cheap case -- so this offer is only made when it can
    // actually be honoured.
    const canBlock = settings.platformBlockEnabled && !!profile.profileId;
    show('blockProfile', canBlock);
    if (canBlock) {
      $('blockProfile').textContent = T('popup_blockButton');
      $('blockProfile').disabled = false;
    }

    // Only say something that is true of *this* profile. "Blocking is off, so
    // it is only hidden" is misleading for someone who is not on the list at
    // all -- they are not being hidden either.
    if (settings.platformBlockEnabled && !profile.profileId) {
      $('actionNote').textContent = T('popup_needsProfileId');
    } else if (!settings.platformBlockEnabled && profile.listed) {
      $('actionNote').textContent = T('popup_blockingOffHidden');
    } else {
      $('actionNote').textContent = '';
    }
  }

  /** The queue in two numbers, plus whatever is holding it up. */
  async function renderBlocking(state, settings, stats, status, onSite) {
    const counts = queueCounts(state);
    const on = !!settings.platformBlockEnabled;
    // Two independent switches, not two halves of one dial: one for profiles
    // you run into, one for working through the ranked list. Either can be off
    // without the other, and "off" means a different sentence in each case.
    const modes = globalThis.CB_BLOCK_MODES(settings);
    const cold = counts.cold;
    $('queuedCount').textContent = String(counts.total);

    const tabs = await siteTabCount();
    // What an open tab could actually carry out right now. Cold targets do not
    // count while the list is switched off -- those are parked by a setting,
    // and telling their owner to go and open a tab would not move them.
    const actionable = counts.total - (modes.fromList ? 0 : cold);
    const blocking = on && (modes.seen || modes.fromList);

    // Where blocking is running, said with the count, whether or not this tab
    // is one of the places. Silent when nothing is blocking at all or when the
    // tab lookup failed: the note below has the honest answer in both cases.
    const where = $('tabsNote');
    if (!blocking || !tabs) {
      where.textContent = '';
    } else if (onSite) {
      // The pacing is worth naming here. Someone who opens five tabs expecting
      // five times the speed should find out from the popup that the gate is
      // one block at a time for the whole browser, deliberately.
      where.textContent = tabs === 1 ? T('popup_tabsHere')
        : tabs === 2 ? T('popup_tabsHereAndOne')
        : T('popup_tabsHereAndMany', tabs - 1);
    } else {
      where.textContent = tabs === 1 ? T('popup_tabsElsewhereOne')
        : T('popup_tabsElsewhereMany', tabs);
    }

    // A checkpoint pause is otherwise invisible: blocking silently stops and
    // the extension just looks broken, so say so plainly.
    const pausedFor = stats.pausedUntil && stats.pausedUntil > Date.now()
      ? Math.ceil((stats.pausedUntil - Date.now()) / 60000) : 0;

    const note = $('blockingNote');
    note.className = 'note';
    if (!on) {
      note.textContent = T(counts.total ? 'popup_queueParked' : 'popup_blockingPaused');
    } else if (!modes.seen && !modes.fromList) {
      // Both switches off. Nothing else below is worth saying -- no tab, no
      // pause and no pacing explains a queue that nobody is working.
      note.textContent = T('popup_blockingNothingOn');
    } else if (pausedFor) {
      // Two whole messages rather than one sentence with a swappable tail: a
      // checkpoint and a rate limit ask different things of the reader, and a
      // tail that has to graft onto a translated stem is the one shape no
      // other language can be relied on to accept.
      note.textContent = T(stats.halted ? 'popup_pausedCheckpoint' : 'popup_pausedRateLimit',
        forMinutes(pausedFor));
    } else if (tabs === 0 && actionable) {
      // The genuinely stalled case, and the only one an open tab fixes.
      note.className = 'note warn';
      note.textContent = actionable === 1
        ? T('popup_noTabOne') : T('popup_noTabMany', actionable);
    } else if (cold && !modes.fromList) {
      // Above the empty-handed tab note on purpose. Work parked by a switch
      // would not move if a tab were open, so naming the tab first would send
      // the reader to fix the wrong thing -- and "nothing is waiting" directly
      // under a queue count of 2 is simply untrue.
      note.textContent = cold === 1
        ? T('popup_queueListOffOne') : T('popup_queueListOffMany', cold);
    } else if (tabs === 0) {
      // Nothing queued, nowhere to run it either. Worth saying, quietly: this
      // is the state someone checks the popup in when they wonder whether the
      // extension is alive at all.
      note.className = 'note warn';
      note.textContent = T('popup_noTabIdle');
    } else if (counts.total && !(tabs > 1)) {
      // Skipped when there are several tabs, because the line above has just
      // said the same thing in the form that actually needs saying: more tabs
      // do not mean more blocks.
      note.textContent = T('popup_queuePacing');
    } else {
      note.textContent = '';
    }

    // A recorded failure is only worth showing while it is still true. A
    // signed-out complaint is plainly stale once the page reports a viewer,
    // and anything older than the last hour is history rather than status.
    const err = stats.lastError;
    // The worker stamps a code now; the English test behind it is for stats
    // written by a build that predates the code, whose message is in English
    // whatever locale this popup is running in.
    const signedOut = stats.lastErrorCode === 'signed-out' ||
      /Signed out of the site/.test(err || '');
    const staleSignedOut = err && signedOut && status && status.viewerId;
    const old = stats.lastErrorAt && (Date.now() - stats.lastErrorAt) > 3600 * 1000;
    if (err && !staleSignedOut && !old) {
      $('blockError').textContent = stats.lastErrorAt
        ? `${err}  (${ago(stats.lastErrorAt)})` : err;
      show('blockError', true);
    } else {
      show('blockError', false);
    }
  }

  // -- actions ---------------------------------------------------------------

  // Reporting has to happen in the page: the report sheet is rendered by the
  // content script, which is what knows the profile's identity. The popup just
  // asks, then gets out of the way so the sheet is visible.
  $('reportProfile').addEventListener('click', () => {
    if (!current.tab) return;
    chrome.tabs.sendMessage(current.tab.id, { type: 'tab:report-current' }, (res) => {
      if (chrome.runtime.lastError) {
        $('actionNote').textContent = T('popup_reloadAndRetry');
        return;
      }
      if (!res || !res.ok) {
        $('actionNote').textContent = (res && res.error) || T('popup_couldNotIdentify');
        return;
      }
      window.close();
    });
  });

  $('blockProfile').addEventListener('click', async () => {
    const p = current.profile;
    if (!p || !p.profileId || !current.platform) return;
    $('blockProfile').disabled = true;
    $('blockProfile').textContent = T('popup_blockQueueing');
    // warm: this profile is on screen right now, which is the pattern the
    // platform finds unremarkable, so it is paced normally rather than being
    // held to the cold ceiling.
    //
    // userInitiated: somebody pressed a button labelled Block now while
    // looking at this account. That outranks the "which kinds get blocked"
    // preference, which is about what the extension does unprompted -- a
    // filtered-out click would leave a dead button and no explanation.
    const res = await sw(P.SW.ENQUEUE_PLATFORM_BLOCK, {
      platform: current.platform, ids: [p.profileId], warm: true, userInitiated: true,
      // The popup is already showing this person's name in its heading; it
      // costs nothing to make sure the history can show it too.
      names: p.username ? { [String(p.profileId)]: p.username } : undefined
    });
    if (!res || res.ok === false) {
      $('blockProfile').disabled = false;
      $('blockProfile').textContent = T('popup_blockButton');
      $('actionNote').textContent = (res && res.error) || T('popup_couldNotQueue');
      return;
    }

    // HERE we wait, and the report sheet deliberately does not.
    //
    // The difference is what the person is looking at. The sheet is over a
    // post in a feed: the post can go, the dialog can close, and the feed
    // carries on -- there is nothing on screen that would be wrong a moment
    // later. This is a profile page, whose every pixel is about the account
    // being blocked. Closing the popup and leaving that page exactly as it was
    // would look like nothing happened, and reloading it before the block
    // lands would show it unblocked and look like it failed.
    //
    // So this one waits, then reloads, and the reload IS the confirmation.
    $('blockProfile').textContent = T('popup_blocking');
    $('actionNote').textContent = T('popup_blockingNote');
    const landed = await blockLanded(current.platform, String(p.profileId), 20000);
    if (landed) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id != null) await chrome.tabs.reload(tab.id);
      } catch (e) { /* the block happened either way; the reload is a courtesy */ }
      window.close();
      return;
    }
    // Still queued after twenty seconds -- usually no tab is free to run it.
    // Say so rather than reloading a page that would look unchanged, and leave
    // the popup open so the sentence is actually read.
    $('blockProfile').textContent = T('popup_blockQueued');
    $('actionNote').textContent = T('popup_queuedNote');
  });

  /**
   * Wait for a target to actually be blocked.
   *
   * Polling rather than a subscription because the answer is wanted for a few
   * seconds, once, by a window that is about to close -- a listener would have
   * to be registered, torn down on close, and would outlive the question.
   */
  async function blockLanded(platform, profileId, ms) {
    const deadline = Date.now() + (ms || 20000);
    while (Date.now() < deadline) {
      const st = await sw(P.SW.GET_STATE).catch(() => null);
      const done = st && st.done && st.done[platform];
      if (Array.isArray(done) && done.includes(profileId)) return true;
      await new Promise(r => setTimeout(r, 400));
    }
    return false;
  }

  $('refresh').addEventListener('click', async (e) => {
    e.preventDefault();
    $('listLine').textContent = T('popup_refreshing');
    const res = await sw(P.SW.REFRESH_NOW);
    if (!res.ok) $('listLine').textContent = res.error || T('popup_refreshFailed');
    render();
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $('openActivity').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/activity/activity.html') });
    window.close();
  });

  // The first draw waits for the language.
  //
  // CB_T is synchronous but the override behind it arrives from storage, so
  // rendering before this resolves means building the page out of whatever
  // chrome.i18n happened to return -- the browser's language, not the reader's
  // choice. Static data-i18n markup is immune because apply() runs after the
  // same await; text built in script is not, which is why this page needed the
  // gate and the welcome page did not.
  (globalThis.CB_I18N_READY || Promise.resolve()).then(render);
})();
