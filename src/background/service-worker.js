/**
 * MV3 service worker.
 *
 * Owns three things the content scripts cannot:
 *
 *  1. The server fetch. A content-script fetch is subject to facebook.com's
 *     origin and CSP; a service-worker fetch only needs host permission and is
 *     exempt from CORS. So the blocklist is always fetched here.
 *  2. The block queue and rate limiter. Several Facebook tabs may be open at
 *     once; centralising the queue is what stops them double-blocking the same
 *     profile or blowing through the hourly cap in parallel.
 *  3. Scheduled refresh via chrome.alarms.
 *
 * MV3 service workers are killed aggressively and restarted on demand, so
 * nothing here may live in a module-scope variable across calls. Every piece of
 * state round-trips through chrome.storage.
 */

// Executing these publishes CB_T and then CB_PROTOCOL / CB_KEYS /
// CB_DEFAULT_SETTINGS onto globalThis, so the wire format has exactly one
// definition. i18n first, because protocol.js resolves the tag labels through
// it and a missing CB_T would leave them in English here alone.
import '../common/i18n.js';
import '../common/protocol.js';

const P = globalThis.CB_PROTOCOL;
// Only the errors that surface in the popup or on the Activity page go through
// this. Log lines behind settings.debug stay in English: nobody reads them but
// whoever is debugging, and a translated log is a log that cannot be searched.
const T = globalThis.CB_T;
const KEYS = globalThis.CB_KEYS;
const modeOf = globalThis.CB_MODE_OF;
const blockModes = globalThis.CB_BLOCK_MODES;
const isDevBuild = globalThis.CB_IS_DEV_BUILD;
const DEFAULTS = globalThis.CB_DEFAULT_SETTINGS;
const TAGS = globalThis.CB_TAGS;

const ALARM_REFRESH = 'cb-refresh-blocklist';
const ALARM_DRAIN = 'cb-drain-queue';        // is there work nobody is around to do?
const ALARM_REOPEN = 'cb-reopen-work-tab';   // after somebody closed ours by hand
const OWN_TAB = 'ownWorkTab';                // local: the tab this extension keeps
// A tab that survived this long was not being rejected, so the count of
// consecutive closes-by-hand starts over.
const OWN_TAB_SETTLED_MS = 10 * 60 * 1000;
// A kept tab with work in front of it that has not claimed anything in this
// long is not working, whatever it looks like. Reload it.
const OWN_TAB_STALL_MS = 20 * 60 * 1000;
const DRAIN_EVERY_MINUTES = 15;
// Where to send a tab of our own. The home feed rather than a profile: it is
// the cheapest page that boots the site's own code, and it is what the person
// would see anyway if they opened the site themselves.
const PLATFORM_HOME = {
  facebook: 'https://www.facebook.com/',
  threads: 'https://www.threads.com/'
};
const TAB_PATTERNS = {
  facebook: ['*://*.facebook.com/*'],
  threads: ['*://*.threads.net/*', '*://*.threads.com/*']
};
const LEASE_MS = 90 * 1000;          // a claimed target is reserved this long
const MAX_TARGET_FAILURES = 5;       // stop retrying a target after this many errors
const DRYRUN_COOLDOWN_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------
async function getSettings() {
  const got = await chrome.storage.sync.get(KEYS.SETTINGS);
  const stored = got[KEYS.SETTINGS] || {};
  const merged = Object.assign({}, DEFAULTS, stored);
  // The mode has to be resolved from what was actually STORED. DEFAULTS
  // carries mode:'active', so merging first would hand modeOf a mode on every
  // call and its acceptServerTargets fallback could never fire -- an install
  // that switched server targets off before modes existed would have quietly
  // started working through the ranked list on upgrade, which is the one thing
  // that fallback exists to prevent. Everything reads settings through here,
  // so this is the only place that needs to know.
  // Resolved from what was actually STORED. DEFAULTS carries both switches
  // on, so merging first would hand the resolver an answer on every call and
  // the fallbacks for older installs could never fire.
  const modes = blockModes(stored);
  merged.blockSeen = modes.seen;
  merged.blockFromList = modes.fromList;
  merged.mode = modes.fromList ? 'active' : 'passive';
  // Experiments follow the BUILD until somebody actually chooses. Absent from
  // stored settings means "whatever this build should do" -- on when it was
  // loaded unpacked, off when it came from the store -- and the moment the
  // box in options is ticked or unticked the key exists and the build stops
  // having an opinion. Same reasoning as the modes above: it has to be read
  // off `stored`, because `merged` always has a value.
  if (!('experimentalOwnTab' in stored)) merged.experimentalOwnTab = isDevBuild();
  return merged;
}
async function setSettings(patch) {
  const p = Object.assign({}, patch || {});
  // A caller writing the old `mode` means the pair it stood for. Without this
  // the write would carry today's resolved blockSeen/blockFromList alongside
  // it, the explicit pair would win when the settings were next read, and the
  // mode the caller asked for would be silently ignored.
  if (p.mode === 'passive' || p.mode === 'active') {
    p.blockSeen = true;
    p.blockFromList = p.mode === 'active';
  }
  const next = Object.assign(await getSettings(), p);
  await chrome.storage.sync.set({ [KEYS.SETTINGS]: next });
  // Every recorded error is about platform blocking. Switching blocking off
  // makes all of them historical, so none should still be on screen.
  if (p.platformBlockEnabled === false) {
    const stats = await getLocal(KEYS.STATS, {});
    if (stats.lastError) { clearError(stats); await setLocal(KEYS.STATS, stats); }
  }
  // Switching to passive, or pausing, retires whatever the badge was warning
  // about: those cold targets are no longer waiting on anything.
  if ('mode' in p || 'blockFromList' in p || 'platformBlockEnabled' in p) await updateBadge();
  return next;
}
async function getLocal(key, fallback) {
  const got = await chrome.storage.local.get(key);
  return got[key] === undefined ? fallback : got[key];
}
async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// A failure is worth remembering, but only until it stops being true.
//
// These were three bare assignments with nothing anywhere that cleared them,
// so the first block that could not run left its message in the popup
// permanently -- through a successful block, through signing back in, through
// turning platform blocking off entirely. Stamping the time makes a stale one
// obvious; clearing on success makes it stop being stale.
//
// The optional `code` is the machine-readable half. Now that the message is
// translated, no reader of it may test what it says -- the popup used to match
// /Signed out of the site/ to decide whether a complaint had gone stale, and
// that test is false in every locale but one.
function noteError(stats, detail, code) {
  stats.lastError = String(detail || '').slice(0, 300);
  stats.lastErrorAt = Date.now();
  if (code) stats.lastErrorCode = code;
  else delete stats.lastErrorCode;
}
function clearError(stats) {
  delete stats.lastError;
  delete stats.lastErrorAt;
  delete stats.lastErrorCode;
}

// ---------------------------------------------------------------------------
// blocklist fetching
// ---------------------------------------------------------------------------

/**
 * Accepts several reasonable server shapes so you are not forced into one:
 *   ["123", "456"]
 *   { ids: [...], usernames: [...] }
 *   { blocked: [ { id, username }, ... ] }
 *   { data: { ids: [...] } }
 * plus an optional docIdOverrides map for hot-patching a Meta doc_id rotation.
 */
function normalizeBlocklist(payload) {
  const ids = new Set();
  const usernames = new Set();

  const takeScalar = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return;
    if (/^\d{4,}$/.test(s)) ids.add(s);
    else usernames.add(s.toLowerCase().replace(/^@/, ''));
  };
  const takeEntry = (e) => {
    if (e == null) return;
    if (typeof e === 'string' || typeof e === 'number') { takeScalar(e); return; }
    if (typeof e === 'object') {
      if (e.id != null) takeScalar(e.id);
      if (e.profileId != null) takeScalar(e.profileId);
      if (e.user_id != null) takeScalar(e.user_id);
      if (e.pk != null) takeScalar(e.pk);
      if (e.username != null) usernames.add(String(e.username).toLowerCase().replace(/^@/, ''));
      if (e.handle != null) usernames.add(String(e.handle).toLowerCase().replace(/^@/, ''));
    }
  };

  let root = payload;
  if (root && typeof root === 'object' && !Array.isArray(root) && root.data) root = root.data;

  if (Array.isArray(root)) {
    root.forEach(takeEntry);
  } else if (root && typeof root === 'object') {
    for (const key of ['ids', 'profileIds', 'profile_ids', 'blocked', 'entries', 'list', 'users']) {
      if (Array.isArray(root[key])) root[key].forEach(takeEntry);
    }
    if (Array.isArray(root.usernames)) {
      root.usernames.forEach(u => usernames.add(String(u).toLowerCase().replace(/^@/, '')));
    }
  }

  const rawOverrides =
    (payload && payload.docIdOverrides) ||
    (payload && payload.data && payload.data.docIdOverrides) || null;
  const docIdOverrides = rawOverrides ? sanitizeDocIdOverrides(rawOverrides) : null;

  return { ids: Array.from(ids), usernames: Array.from(usernames), docIdOverrides };
}

/**
 * The hot-patch map, validated before it is stored.
 *
 * A key names a GraphQL operation and a value is Meta's numeric doc_id for
 * it; the page-world script hands both to code that composes a request
 * against Meta. That path is off by default (allowRawNetworkFallback), so
 * this is defence in depth -- but the map arrives from the network with no
 * type, key or value check, and "stored and never used" is one setting away
 * from "used". The same check runs where the list is published
 * (hosting/logic.js) and again where the page reads it (inject.js).
 */
function sanitizeDocIdOverrides(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const k of Object.keys(map)) {
    if (!/^[A-Za-z0-9_]{1,120}$/.test(k)) continue;
    const v = String(map[k]);
    if (/^[0-9]{6,24}$/.test(v)) out[k] = v;
  }
  return out;
}

async function hasHostPermission(url) {
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (e) { return false; }
}

const ID_RE = /^\d{4,24}$/;

// ---------------------------------------------------------------------------
// Where the list comes from
// ---------------------------------------------------------------------------
//
// The blocklist is a static JSON file rather than anything served from a
// server: one public-read doc whose `json` field holds the whole published
// payload. Three things change when the URL points there, and only there:
// no ranking hints are appended to the URL (nothing about this browser is
// sent anywhere), the ranked slice is computed locally from published
// per-target metadata, and reports are written as create-only documents.
// Every legacy shape keeps working for self-hosted servers and static files.

const normUsername = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

/**
 * What a report is filed against.
 *
 * The numeric id when the page gave one. On Threads it very often did not: a
 * Threads URL never carries an id, only /@handle, so the id can only come from
 * the alias cache that the MAIN-world sweep of Meta's store fills
 * opportunistically -- and a profile the sweep has not happened to see yet
 * resolves to nothing at all.
 *
 * This used to send the empty string in that case. The server's schema requires
 * targetId to be at least one character, so the report earned a 400, and a 400
 * was treated as a refusal on the merits and dropped on the floor -- after the
 * sheet had already said "Sent". That is the whole of the lost-reports bug: not
 * a network problem, not the server, just the one field that is always present
 * on Threads never being used.
 *
 * So a username is a target in its own right. Everything downstream already
 * understood that and only intake validation did not: shared/logic.js routes a
 * non-numeric target into the published usernames array rather than ids,
 * the transparency page names it, and this extension's own blocklist index
 * matches on it (identity.js setBlocklist). What was missing was only ever
 * something non-empty to put in the field.
 *
 * Prefixed with '@' rather than sent bare, because the server decides which
 * kind of target it has by SHAPE -- the same shape ID_RE tests -- and a handle
 * that happens to be all digits would otherwise be filed as a numeric profile
 * id, then published into the ids array as an account id that does not exist. The
 * prefix makes the two impossible to confuse in either direction, and costs a
 * character.
 *
 * KNOWN CONSEQUENCE, and it is a real one. An account reported once while its
 * id was known and once while it was not produces TWO targets -- '9990007777'
 * and '@handle' -- which the server aggregates as two records, so the votes
 * split and a moderator sees the same account twice.
 *
 * That is accepted here rather than solved here, for two reasons. It is
 * strictly better than what it replaces: the split half used to be no vote at
 * all, because the report was destroyed. And it cannot be solved on this side
 * -- merging two records is a decision about the whole store, which only the
 * server can see. Everything the server needs is already on the wire: every
 * report carries targetUser whenever a handle is known, including the ones
 * filed against a numeric id, so the two records can be reconciled on the
 * username without this extension changing again. Doing it the other way --
 * always filing Threads against the handle -- would remove the split and cost
 * cold blocking, because the published ids array is what seeds ranked targets
 * and only a numeric id may go in it.
 */
function targetIdFor(payload) {
  const id = String((payload && payload.profileId) || '').trim();
  if (ID_RE.test(id)) return id.slice(0, 64);
  const user = normUsername(payload && payload.username);
  return user ? ('@' + user).slice(0, 64) : '';
}

const hex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

// -- the reporter pseudonym ---------------------------------------------------
//
// A report is filed under a pseudonym of the reporter's own account id, and
// that pseudonym is also part of the document id, which is what makes a
// repeat report a create conflict. It used to be a plain, unkeyed SHA-256 of
// the id -- "a pure client cannot keep a salt secret" -- and that was true of
// a salt SHARED across installs, which the old server had. Two things were
// wrong with it, both about strangers rather than the moderator. Account ids
// are public and enumerable, so anyone holding the report store could recover
// reporters by hashing candidates; and because creates are open and the id
// is predictable, anyone could learn whether a given account had reported a
// given target from the response code of a create they had no business
// making -- a deanonymisation primitive that needed no account at all.
//
// The key is a secret this install makes for itself and never sends. It is
// not shared, so nobody outside this browser can compute this browser's
// pseudonym: not a stranger probing document ids, not someone holding a copy
// of the store. What is given up is continuity across a reinstall -- a fresh
// secret is a fresh pseudonym with a newcomer's reputation -- which is a
// small price, and an honest one to state, for the property that the
// pseudonym is no longer a function of anything public.
const REPORTER_SECRET_KEY = 'reporterSecret';
let mintingSecret = null;

/**
 * This install's secret, minted on first use.
 *
 * Read from storage every time rather than cached: storage is the one place
 * the secret lives, and a worker that remembered an earlier value would go
 * on filing under a pseudonym the browser no longer holds. Minting is
 * serialised so two reports filed in the same instant cannot mint two
 * secrets and orphan one of them.
 */
async function reporterSecret() {
  const have = await getLocal(REPORTER_SECRET_KEY, null);
  if (typeof have === 'string' && /^[0-9a-f]{64}$/.test(have)) return have;
  if (!mintingSecret) {
    mintingSecret = (async () => {
      const fresh = hex(crypto.getRandomValues(new Uint8Array(32)));
      await setLocal(REPORTER_SECRET_KEY, fresh);
      return fresh;
    })().finally(() => { mintingSecret = null; });
  }
  return mintingSecret;
}

/** acct_ + 24 hex of HMAC-SHA256(installSecret, platform:accountId). */
async function reporterPseudonym(reporter) {
  const secret = await reporterSecret();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(reporter)));
  return 'acct_' + hex(mac).slice(0, 24);
}

// -- local ranking ----------------------------------------------------------
//
// Verbatim from the retired server (and duplicated in hosting/logic.js, which
// a service worker cannot import): recency halves every 7 days, velocity is
// the last 7 UTC day buckets, affinity is a smoothed share of where the
// clone's reports come from. The one inherited quirk -- language affinity
// divides by the REGION total -- is kept so rankings match the old ones.
// Everything quantises to whole days, so recomputing within a day is
// deterministic and the queue does not churn between polls.

const RANK_HALF_LIFE_DAYS = 7;
const rankDayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

// The dials the published list may carry, and what they mean when it carries
// none. These values ARE the ranking as it shipped: velocityWeight 1 and
// localityFloor 0.25 rebuild the old hardcoded expression term for term, and
// uniqueReporterBoost 0 makes the boost factor exactly 1, so a list published
// before rankWeights existed ranks here identically to the day it was made.
// Keep them equal to RANK_WEIGHTS in hosting/logic.js.
const RANK_WEIGHTS = {
  halfLifeDays: RANK_HALF_LIFE_DAYS,
  velocityWeight: 1,
  localityFloor: 0.25,
  localityLangFactor: 0.8,
  uniqueReporterBoost: 0
};

/** Fill a partial or absent weight set from the defaults, dial by dial. */
function rankWeightsOf(weights) {
  const src = (weights && typeof weights === 'object') ? weights : {};
  const num = (k) => {
    const v = Number(src[k]);
    return Number.isFinite(v) ? v : RANK_WEIGHTS[k];
  };
  const halfLifeDays = num('halfLifeDays');
  return {
    halfLifeDays: halfLifeDays > 0 ? halfLifeDays : RANK_WEIGHTS.halfLifeDays,
    velocityWeight: num('velocityWeight'),
    localityFloor: num('localityFloor'),
    localityLangFactor: num('localityLangFactor'),
    uniqueReporterBoost: num('uniqueReporterBoost')
  };
}

function rankVelocity(days, n) {
  const cutoff = rankDayKey(Date.now() - (n - 1) * 86400000);
  let total = 0;
  for (const k of Object.keys(days || {})) if (k >= cutoff) total += days[k];
  return total;
}

function rankAffinity(tally, key, total) {
  if (!key) return 1;
  const here = (tally && Object.prototype.hasOwnProperty.call(tally, key)) ? tally[key] : 0;
  return (here + 0.5) / (total + 1);
}

// Locality from region and language NAMES. A current list carries no counts
// (a count beside a region name is a hint about who reported), so affinity is
// membership: this browser's region is among the target's top few, or it is
// not. No tallies at all sits in the middle, as the smoothed share of nothing
// always did; no region on this side stays neutral, as before.
function rankNameAffinity(names, key) {
  if (!key) return 1;
  if (!Array.isArray(names) || !names.length) return 0.5;
  return names.includes(key) ? 1 : 0;
}

// Reports in the last week, from either shape the list has carried. A legacy
// list carries day buckets and the window is recomputed here; a current list
// carries one `recent` count taken when it was published, which is scaled
// down by how far the week has since slid past it -- zero once the list is a
// week old, when everything it counted is older than the window.
function rankVelocityOf(t, listAgeDays) {
  if (t && t.days && typeof t.days === 'object') return rankVelocity(t.days, 7);
  const recent = Math.max(0, Number(t && t.recent) || 0);
  const age = Math.max(0, Number(listAgeDays) || 0);
  return Math.round(recent * Math.max(0, 1 - age / 7) * 100) / 100;
}

/**
 * Rank published target metadata for THIS browser.
 *
 * The server used to do this per-request from query params; now the region
 * and language never leave the machine. `shareRegion` keeps its user-visible
 * meaning -- off means suggestions are not localised to you.
 *
 * Two shapes rank here, mirroring hosting/logic.js rankTargets exactly. A
 * list published before the metadata was coarsened carries `trust`, a `days`
 * histogram and region and language COUNTS, and ranks as it always did. A
 * current list carries `confidence`, one `recent` count and region and
 * language NAMES, and `updatedAt` -- the list's own timestamp -- is what ages
 * the count.
 *
 * `weights` is payload.rankWeights when the list carries it, so the owner can
 * retune ranking without shipping a new extension; an old list carries none
 * and gets the defaults, which are the values it was ranked with all along.
 */
function rankPublishedTargets(meta, settings, weights, updatedAt) {
  const w = rankWeightsOf(weights);
  let region = null, lang = null;
  if (settings.shareRegion !== false) {
    const c = clientContext();
    region = c.region || null;
    lang = c.lang ? String(c.lang).toLowerCase() : null;
  }
  const today = Date.now();
  const published = updatedAt ? Date.parse(updatedAt) : NaN;
  const listAgeDays = Number.isFinite(published)
    ? Math.max(0, Math.floor((today - published) / 86400000)) : 0;
  const out = [];
  for (const t of meta || []) {
    if (!t || !ID_RE.test(String(t.id))) continue;
    const trust = Number(t.confidence != null ? t.confidence : t.trust) || 0;
    const ageDays = Math.max(0, Math.floor((today - Date.parse(t.last || 0)) / 86400000));
    const recency = Math.pow(0.5, ageDays / w.halfLifeDays);
    const vel = rankVelocityOf(t, listAgeDays);
    let regionAff, langAff;
    if (Array.isArray(t.regions) || Array.isArray(t.langs)) {
      regionAff = rankNameAffinity(t.regions, region);
      langAff = rankNameAffinity(t.langs, lang);
    } else {
      // The inherited quirk, kept for legacy lists only: language affinity
      // divides by the REGION total.
      const total = Object.values(t.regions || {}).reduce((n, v) => n + v, 0);
      regionAff = rankAffinity(t.regions, region, total);
      langAff = rankAffinity(t.langs, lang, total);
    }
    const reporters = Math.max(0, Number(t.reporters) || 0);
    // Region never zeroes a target out; it dominates the ordering when it fits.
    const locality = w.localityFloor
      + (1 - w.localityFloor) * Math.max(regionAff, langAff * w.localityLangFactor);
    // What independence is worth on top of trust, which is already linear in
    // the number of reporters. At the shipped boost of 0 this is exactly 1.
    const boost = 1 + w.uniqueReporterBoost * Math.log2(1 + reporters);
    const rank = trust * recency * (1 + w.velocityWeight * vel) * locality * boost;
    out.push({
      id: String(t.id),
      platform: String(t.platform || ''),
      rank: Math.round(rank * 1000) / 1000,
      why: {
        trust: Math.round(trust * 100) / 100,
        recentDays: ageDays,
        velocity7d: vel,
        region: Math.round(regionAff * 100) / 100,
        lang: Math.round(langAff * 100) / 100,
        reporters
      }
    });
  }
  out.sort((a, b) => (b.rank - a.rank) || (a.id < b.id ? -1 : 1));
  return out;
}

/**
 * Where this browser is, coarsely.
 *
 * A time zone and a language tag -- both of which the browser already hands to
 * every site it loads, and neither of which needs an IP lookup, a geo database
 * or a third party. That is enough for the server to tell a clone wave running
 * in Vietnamese from one running in Portuguese, which is the distinction that
 * decides whose clones are worth this person's limited block budget.
 */
function clientContext() {
  let region = null, lang = null;
  try { region = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) {}
  try { lang = (navigator.language || '').trim() || null; } catch (e) {}
  return { region, lang };
}

/**
 * How many cold blocks the limiter would still allow in the next hour.
 *
 * Asking for more than that would be asking the server to rank work we have no
 * intention of doing, and would push genuinely urgent targets out of the slice.
 */
async function remainingBudget(settings) {
  const stats = await getLocal(KEYS.STATS, {});
  const hourAgo = Date.now() - 3600 * 1000;
  const cold = (stats.coldTimes || []).filter(t => t > hourAgo).length;
  const perHour = Math.max(0, (settings.maxColdBlocksPerHour | 0) - cold);
  // Ask for a few hours' worth: the queue should not run dry between polls.
  return Math.max(1, Math.min(perHour * 4 || 4, settings.targetBudget | 0 || 25));
}

// ---------------------------------------------------------------------------
// tags: which kinds of account this install agreed to block
// ---------------------------------------------------------------------------
//
// Blocking is rationed and irreversible-ish; hiding is neither. So the tag
// filter applies only to blocks -- everything approved stays on the list and
// stays hidden whatever is ticked here, which is why nothing in the hide path
// consults any of this.

/**
 * The tag of a target, tolerating everything that might not have one.
 *
 * A list published before tags existed, an id the published `idTags` map does
 * not name, a tag from a future release this build has never heard of: all of
 * them land on 'other'. That is the bucket every install blocks by default and
 * the first one an owner narrowing their tags would drop -- the right way
 * round for something nobody has actually voted on.
 */
function tagOf(value) {
  return TAGS.includes(value) ? value : 'other';
}

/**
 * The tags this user is willing to block.
 *
 * An install that has never met the setting blocks all of them, which is what
 * it did before the setting existed. An EMPTY array is a real answer -- "block
 * nothing, just hide" -- so it is not folded in with "unset".
 */
function blockTagsOf(settings) {
  const chosen = settings && settings.blockTags;
  if (!Array.isArray(chosen)) return TAGS.slice();
  return chosen.filter(t => TAGS.includes(t));
}

/**
 * Drop ids whose kind this user does not want blocked.
 *
 * `idTags` is the published tag of every listed id, cached with the list
 * exactly so this decision can be made without the whole target record.
 * Entries may be bare ids or {id, rank} objects, as enqueue() accepts.
 */
async function filterByBlockTags(ids, settings) {
  const allowed = new Set(blockTagsOf(settings));
  // Nothing is excluded -- the shipped default -- so skip the storage read.
  if (TAGS.every(t => allowed.has(t))) return ids || [];
  const bl = await getLocal(KEYS.BLOCKLIST, null);
  const idTags = (bl && bl.idTags) || {};
  return (ids || []).filter((raw) => {
    const id = String(raw && typeof raw === 'object' ? raw.id : raw);
    return allowed.has(tagOf(idTags[id]));
  });
}

/**
 * Queue what the server nominated, as cold work.
 *
 * These are accounts this browser has never seen, so they sit behind anything
 * on screen and are spent against the tighter cold ceiling. If the user later
 * scrolls past one, enqueue() promotes it to warm and it goes sooner.
 */
async function seedServerTargets(record) {
  const settings = await getSettings();
  // With the ranked list switched off, a queue of strangers is not something
  // to build -- whatever is happening with profiles on screen.
  if (!blockModes(settings).fromList) return { ok: true, added: 0 };
  if (!settings.platformBlockEnabled) return { ok: true, added: 0 };
  const allowed = new Set(blockTagsOf(settings));
  const byPlatform = {};
  for (const t of record.targets || []) {
    if (!t.platform) continue;
    // Cold work is the extension acting on its own initiative, so a kind the
    // user turned off never gets here at all. The profile stays on the list
    // and stays hidden; it simply does not spend one of their blocks.
    if (!allowed.has(tagOf(t.tag))) continue;
    (byPlatform[t.platform] = byPlatform[t.platform] || []).push({ id: t.id, rank: t.rank });
  }
  let added = 0;
  for (const platform of Object.keys(byPlatform)) {
    const r = await serialize(() => enqueue(platform, byPlatform[platform], { warm: false }));
    added += r.added;
  }
  return { ok: true, added };
}

async function refreshBlocklist(force) {
  const settings = await getSettings();
  if (!settings.listUrl) {
    return { ok: false, error: T('sw_noListUrl') };
  }
  if (!(await hasHostPermission(settings.listUrl))) {
    return {
      ok: false,
      needsPermission: true,
      error: T('sw_noListPermission')
    };
  }

  const prev = await getLocal(KEYS.BLOCKLIST, null);
  const headers = { accept: 'application/json' };
  if (settings.listAuthHeader) headers.authorization = settings.listAuthHeader;
  // Conditional request keeps refreshes cheap on an unchanged list.
  if (!force && prev && prev.etag) headers['if-none-match'] = prev.etag;

  // The URL carries nothing about this browser -- no budget, no region, no
  // language -- and that is structural now rather than conditional. It used to
  // append a ranking context for a server that ranked on our behalf; ranking
  // moved into this machine, so there is nothing left to tell anybody. Two
  // things follow: PRIVACY.md's claim that the poll says nothing about you is
  // true by construction, and every install requests a byte-identical URL, so
  // the CDN can actually cache it.
  //
  // MORE THAN ONE PLACE TO READ IT FROM. The primary is the compiled-in (or
  // self-hosted) address; after it come the mirrors the signed pointer named.
  // A tool for reporting state-aligned accounts should assume its domain gets
  // blocked, and the blocklist is the product's whole value, so it has to keep
  // arriving when the backend does not. What makes that safe is the rule in
  // the loop below: a mirror is believed ONLY when the list it serves carries
  // a signature this build can verify. A mirror can be stale, hostile, or
  // somebody else's entirely, and the worst it can do is fail to verify.
  const pointerRec = await getLocal('backendHosts', null);
  const mirrors = (pointerRec && Array.isArray(pointerRec.listMirrors))
    ? pointerRec.listMirrors.filter(u => u !== settings.listUrl) : [];
  const candidates = [settings.listUrl].concat(mirrors);

  // The list is a static file with a real ETag, so an unchanged poll is an
  // If-None-Match away from a 304 with no body -- a few hundred bytes, no
  // database read, and at this point usually no origin request at all because
  // Cloudflare answers it at the edge. That economy is what makes a ten-minute
  // poll affordable across every installation.
  let res = null, payload = null, source = null, verified = false;
  let lastError = null;
  for (const url of candidates) {
    const isPrimary = url === settings.listUrl;
    const h = Object.assign({}, headers);
    // An ETag only means something to the host that issued it.
    if (!(prev && prev.etag && prev.source === url && !force)) delete h['if-none-match'];

    let r;
    try {
      r = await fetch(url, { method: 'GET', headers: h, cache: 'no-cache' });
    } catch (e) {
      lastError = T('sw_fetchFailed', (e && e.message) || e);
      continue;
    }
    if (r.status === 304 && prev) {
      const touched = Object.assign({}, prev, { fetchedAt: Date.now() });
      await setLocal(KEYS.BLOCKLIST, touched);
      return { ok: true, unchanged: true, blocklist: touched };
    }
    if (!r.ok) { lastError = T('sw_httpStatus', r.status); continue; }

    let body;
    const text = await r.text();
    try { body = JSON.parse(text); }
    catch (e) {
      // Also accept a plain newline-delimited list of ids -- from the primary.
      // A mirror that is not even JSON is not a mirror.
      if (!isPrimary) { lastError = T('sw_notAList'); continue; }
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!lines.length) return { ok: false, error: T('sw_notAList') };
      body = lines;
    }

    // Signed, unsigned, and what each is allowed to mean.
    //
    //   signed + verifies      accepted from anywhere
    //   signed + fails         refused from anywhere: a thing that claims a
    //                          signature and cannot back it is an attack, not
    //                          a self-hosted list
    //   unsigned               accepted from the PRIMARY only, for lists
    //                          served by somebody who is not us
    let ok = false;
    if (isEnvelope(body)) {
      const inner = await verifyEnvelope(body);
      if (inner) { body = inner; ok = true; verified = true; }
      else { await bumpStat('badSignatures'); lastError = T('sw_badSignature'); }
    } else if (isPrimary) {
      ok = true;
    } else {
      lastError = T('sw_badSignature');
    }
    if (!ok) continue;

    // A mirror may never roll the cache back. A verified list older than the
    // one already held is a stale mirror, or a replayed copy -- either way the
    // cache wins. The primary is exempt: a server restored from backup is a
    // legitimate rollback, and refusing it would strand every installation on
    // a list the owner can no longer change.
    if (!isPrimary && prev && prev.updatedAt && body && body.updatedAt &&
        Date.parse(body.updatedAt) < Date.parse(prev.updatedAt)) {
      const touched = Object.assign({}, prev, { fetchedAt: Date.now() });
      await setLocal(KEYS.BLOCKLIST, touched);
      return { ok: true, unchanged: true, stale: url, blocklist: touched };
    }

    res = r; payload = body; source = url;
    break;
  }
  if (!res) {
    await bumpStat('fetchErrors');
    return { ok: false, error: lastError || T('sw_fetchFailed', 'unreachable') };
  }

  const norm = normalizeBlocklist(payload);
  // An empty list is a legitimate state -- nothing reported yet, or an admin
  // just removed the last entry. Refusing it meant the extension kept serving a
  // stale list after the final unblock, which is the one moment where being
  // out of date is most visible.
  //
  // A response that is not a recognisable list shape is a different matter:
  // that is an error page or a misconfigured URL, and accepting it would clear
  // everyone's blocklist.
  const looksLikeList = payload && (Array.isArray(payload) ||
    (typeof payload === 'object' && ['ids', 'usernames', 'blocked', 'entries', 'list', 'users', 'data']
      .some(k => k in payload)));
  if (!looksLikeList) {
    return { ok: false, error: T('sw_notABlocklist') };
  }

  // Ranked cold targets, if the list carries any and the user allows them.
  // The list carries per-target METADATA (day buckets, region tallies) rather
  // than a ranking, and the ranking happens right here, with context that
  // never leaves this machine.
  let targets = [], targetsAvailable = Number(payload.targetsAvailable) || 0;
  if (blockModes(settings).fromList && Array.isArray(payload.targets)) {
    const raw = payload.targets.filter(t => t && ID_RE.test(String(t.id)));
    // Ranking is about how urgent a target is, not what kind of account it is,
    // so the tag is carried alongside the ranked entry rather than through it.
    // The queue, the seeding filter and the activity page all read it here.
    const tagById = new Map(raw.map(t => [String(t.id), tagOf(t.tag)]));
    const withTag = (t) => Object.assign({}, t, { tag: tagById.get(String(t.id)) || 'other' });
    if (raw.some(t => t.days || t.regions || t.langs || t.recent != null || t.confidence != null)) {
      const budget = Math.max(1, Math.min(await remainingBudget(settings), 200));
      const ranked = rankPublishedTargets(raw, settings, payload.rankWeights, payload.updatedAt);
      targets = ranked.slice(0, budget).map(withTag);
      targetsAvailable = ranked.length;
    } else {
      targets = raw.map(t => ({ id: String(t.id), platform: String(t.platform || ''),
                                rank: Number(t.rank) || 0, why: t.why || null,
                                username: t.username || null,
                                displayName: t.displayName || null,
                                tag: tagOf(t.tag) }));
    }
  }

  // The tag of every published id, kept with the list.
  //
  // Warm blocking meets ids that have no target record behind them -- the
  // ranked slice is capped, and the flat id list is not -- and still has to
  // decide whether this user wants that kind of account blocked. Caching the
  // map is what lets that decision be made from storage instead of a fetch.
  const idTags = {};
  const publishedTags = (payload && payload.idTags && typeof payload.idTags === 'object')
    ? payload.idTags : {};
  for (const id of norm.ids) {
    if (publishedTags[id] != null) idTags[id] = tagOf(publishedTags[id]);
  }

  const record = {
    ids: norm.ids,
    usernames: norm.usernames,
    targets,
    targetsAvailable,
    idTags,
    etag: res.headers.get('etag') || null,
    fetchedAt: Date.now(),
    source,
    verified,
    updatedAt: (payload && payload.updatedAt) || null,
    count: norm.ids.length + norm.usernames.length
  };
  await setLocal(KEYS.BLOCKLIST, record);

  // Names off the published list.
  //
  // Taken from payload.targets rather than from the `targets` built above,
  // which is where this went wrong in the first place: that array is rebuilt
  // field by field for the queue, and username and displayName were simply
  // not among the fields copied -- so the Activity page, which looked for a
  // name there, never found one and printed the id on its own.
  //
  // Read unconditionally, too. `targets` is only populated when the user has
  // list blocking switched on; whether somebody wants the list WORKED THROUGH
  // has nothing to do with whether they should be able to read who an account
  // is once it turns up in their own history.
  {
    const byPlatform = {};
    for (const t of (Array.isArray(payload.targets) ? payload.targets : [])) {
      if (!t || !t.id || (!t.username && !t.displayName)) continue;
      const plat = t.platform || 'facebook';
      (byPlatform[plat] = byPlatform[plat] || {})[String(t.id)] =
        { u: t.username || null, d: t.displayName || null };
    }
    // The published id -> name map, which unlike `targets` covers EVERY listed
    // id rather than the ranked slice. Merged under the per-target names above
    // rather than over them: a target record is the moderator's published
    // detail for that account, and where both know a name they agree anyway.
    const published = (payload && payload.idNames && typeof payload.idNames === 'object')
      ? payload.idNames : {};
    for (const plat of Object.keys(published)) {
      const m = published[plat];
      if (!m || typeof m !== 'object') continue;
      byPlatform[plat] = Object.assign({}, m, byPlatform[plat] || {});
    }

    for (const [plat, m] of Object.entries(byPlatform)) await rememberNames(plat, m);
  }

  if (norm.docIdOverrides) await setLocal('docIdOverrides', norm.docIdOverrides);
  await pruneQueueToList(record);
  await seedServerTargets(record);
  await updateBadge();
  // A refresh is the moment work appears out of nowhere, so it is the moment
  // worth asking whether anybody is around to do it.
  await maybeOpenWorkTab('refresh').catch(() => {});

  await broadcast(P.SW.BLOCKLIST_UPDATED, { count: record.count });
  return { ok: true, blocklist: record };
}

/**
 * Drop queued targets that the freshly-fetched list no longer names.
 *
 * Without this the queue only ever grows: taking someone off your server list
 * would not stop them being blocked, because their id was already sitting in
 * the queue from an earlier fetch. Removing an entry from the list has to mean
 * removing it from the pending work, or the list is not actually in control.
 *
 * Ids the tabs resolved from usernames are pruned here too, but the content
 * scripts re-seed those immediately on BLOCKLIST_UPDATED, so the effect is a
 * brief gap rather than a loss -- and erring toward NOT blocking is the right
 * direction for a mistake to fall.
 */
async function pruneQueueToList(record) {
  return serialize(async () => {
    const q = await getLocal(KEYS.QUEUE, {});
    const allowed = new Set(record.ids || []);
    let removed = 0;
    for (const platform of Object.keys(q)) {
      const before = (q[platform] || []).length;
      q[platform] = (q[platform] || []).filter(e => allowed.has(entryId(e)));
      removed += before - q[platform].length;
    }
    if (removed) await setLocal(KEYS.QUEUE, q);
    return removed;
  });
}

async function broadcast(type, payload) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({
      url: ['https://*.facebook.com/*', 'https://*.threads.net/*', 'https://*.threads.com/*']
    });
  } catch (e) { return; }
  for (const t of tabs) {
    try { chrome.tabs.sendMessage(t.id, { type, payload }, () => void chrome.runtime.lastError); }
    catch (e) { /* tab may have no listener */ }
  }
}

// ---------------------------------------------------------------------------
// platform-block queue + rate limiter
// ---------------------------------------------------------------------------

/**
 * Serialises the queue/stats mutations.
 *
 * Each of these is a read-modify-write over chrome.storage, and every storage
 * call is an await point. With several Facebook tabs open, two of them can
 * report a result at the same time: both read the queue, both remove their own
 * target from the copy they read, and the second write silently discards the
 * first one's removal. Chaining the operations removes the interleaving.
 */
let opChain = Promise.resolve();
function serialize(fn) {
  const run = () => fn();
  const next = opChain.then(run, run);
  opChain = next.then(() => {}, () => {});
  return next;
}

/**
 * Queue entries.
 *
 * A queued target is not just an id: it carries how it got here, and that
 * decides how fast it may be spent.
 *
 *   warm  the profile was on the page when it was queued. Blocking someone you
 *         are looking at is what an ordinary person does all day, so it draws
 *         no attention and can go at a natural pace.
 *
 *   cold  the server nominated it from the trending list and this browser has
 *         never seen it. A run of blocks against accounts the user never
 *         encountered is the pattern that gets an account checkpointed, so it
 *         is rationed far more tightly.
 *
 * Older builds stored bare id strings; those are read as cold, which is the
 * safe direction for an unknown to fall.
 */
/**
 * Who an id belongs to, remembered.
 *
 * Keyed platform:id, because the two sites number their accounts separately
 * and nothing says the same digits cannot appear on both.
 *
 * Written from every place a name is known -- the content script resolving an
 * id out of a page, the published list's ranked targets, the report sheet --
 * and read by the Activity page, which otherwise has nothing to print but the
 * number. A name here is a convenience, never a fact anything acts on: blocks
 * are issued against ids, and a stale or wrong name in this map cannot cause
 * the wrong account to be blocked.
 */
const NAMES_CAP = 4000;

function nameKey(platform, id) { return String(platform) + ':' + String(id); }

/**
 * @param {Record<string, {u?: string, d?: string}|string>} incoming
 *        id -> username, or id -> { u: username, d: displayName }
 */
async function rememberNames(platform, incoming) {
  if (!platform || !incoming) return;
  const pairs = Object.entries(incoming);
  if (!pairs.length) return;

  const map = await getLocal('idNames', {});
  const now = Date.now();
  let touched = false;

  for (const [id, value] of pairs) {
    if (!/^\d+$/.test(String(id))) continue;
    const raw = typeof value === 'string' ? { u: value } : (value || {});
    const u = raw.u ? String(raw.u).replace(/^@/, '').slice(0, 80) : null;
    const d = raw.d ? String(raw.d).slice(0, 120) : null;
    if (!u && !d) continue;

    const key = nameKey(platform, id);
    const was = map[key];
    // Only overwrite with something, never with nothing: a later sighting
    // that resolved the username but not the display name must not erase a
    // display name an earlier one did resolve.
    const next = {
      u: u || (was && was.u) || null,
      d: d || (was && was.d) || null,
      at: now
    };
    if (was && was.u === next.u && was.d === next.d) {
      // Same name, seen again. Still worth stamping, so the pruner below
      // drops the accounts nobody has laid eyes on in months first.
      map[key] = next;
      continue;
    }
    map[key] = next;
    touched = true;
  }

  const keys = Object.keys(map);
  if (keys.length > NAMES_CAP) {
    // Oldest sighting first. Bounded because this grows with every account
    // anyone scrolls past, and it is a convenience rather than a record.
    keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
    for (const k of keys.slice(0, keys.length - NAMES_CAP)) delete map[k];
    touched = true;
  }
  if (touched || pairs.length) await setLocal('idNames', map);
}

/** Whatever is known about one id, or null. */
async function nameOfId(platform, id) {
  const map = await getLocal('idNames', {});
  return map[nameKey(platform, id)] || null;
}

function asEntry(e) {
  if (typeof e === 'string') return { id: e, warm: false, rank: 0, at: 0, user: false };
  return { id: String(e.id), warm: !!e.warm, rank: Number(e.rank) || 0,
           at: Number(e.at) || 0, user: !!e.user };
}
const entryId = (e) => (typeof e === 'string' ? e : String(e && e.id));

async function enqueue(platform, ids, opts) {
  const q = await getLocal(KEYS.QUEUE, {});
  const done = await getLocal(KEYS.DONE, {});
  const warm = !!(opts && opts.warm);
  // Somebody pressed a button for this one. It has to survive into the queue
  // entry: it decides which targets are served first, and it is the one thing
  // that outranks the two job switches -- an explicit request is not the
  // extension acting on its own initiative, so turning that initiative off
  // must not silently discard it.
  const user = !!(opts && opts.userInitiated);
  const ranks = (opts && opts.ranks) || {};
  const existing = (q[platform] || []).map(asEntry);
  const byId = new Map(existing.map(e => [e.id, e]));
  const finished = new Set(done[platform] || []);
  let added = 0, promoted = 0;
  const revived = [];

  for (const raw of ids || []) {
    const id = String(typeof raw === 'object' && raw ? raw.id : raw);
    if (!ID_RE.test(id)) continue;
    if (finished.has(id)) {
      // The done list is the extension's memory of what IT has blocked, and
      // for its own sweeping that memory is the whole point: without it, every
      // refresh would re-block the same accounts forever.
      //
      // For somebody pressing a button it is merely stale. It records what we
      // did, not what the account's state is now, and it goes stale precisely
      // when they unblocked someone by hand and want them blocked again. That
      // press used to hit this line and vanish -- no queue entry, nothing to
      // act on, and both the popup and the report sheet answering "Queued".
      // A silent no-op reported as success is the worst of both.
      if (!user) continue;
      finished.delete(id);
      revived.push(id);
    }
    const rank = Number(typeof raw === 'object' && raw ? raw.rank : ranks[id]) || 0;

    const seen = byId.get(id);
    if (seen) {
      // Seeing a cold target on screen upgrades it. That is the whole point of
      // the distinction: the same block is unremarkable now and conspicuous
      // later, so take it while it is cheap.
      if (warm && !seen.warm) { seen.warm = true; seen.at = Date.now(); promoted++; }
      // Asking for it explicitly promotes an entry that was already waiting.
      if (user && !seen.user) { seen.user = true; seen.at = Date.now(); }
      if (rank > seen.rank) seen.rank = rank;
      continue;
    }
    byId.set(id, { id, warm, rank, at: Date.now(), user });
    added++;
  }

  q[platform] = Array.from(byId.values());
  await setLocal(KEYS.QUEUE, q);
  if (revived.length) {
    // Out of the done list, or the next sweep would retire it again before
    // anything acted on it.
    done[platform] = (done[platform] || []).filter(id => !revived.includes(id));
    await setLocal(KEYS.DONE, done);
  }
  return { ok: true, added, promoted, revived: revived.length, queued: q[platform].length };
}

/**
 * Rate limiter.
 *
 * Counts every real request sent to the platform, not just the ones that
 * succeeded. Limiting successes would be the wrong meter: a target that always
 * errors would generate unlimited traffic while the counter stayed at zero,
 * which is exactly the burst pattern the caps exist to prevent.
 */
async function limiterVerdict(settings) {
  const stats = await getLocal(KEYS.STATS, {});
  const events = (stats.attemptTimes || []).filter(t => Date.now() - t < 24 * 3600 * 1000);
  const hourAgo = Date.now() - 3600 * 1000;
  const inHour = events.filter(t => t > hourAgo);
  const coldInHour = (stats.coldTimes || []).filter(t => t > hourAgo);

  if (inHour.length >= (settings.maxBlocksPerHour | 0)) {
    const oldest = Math.min.apply(null, inHour);
    return { allowed: false, retryInMs: Math.max(60000, 3600 * 1000 - (Date.now() - oldest)) };
  }
  if (events.length >= (settings.maxBlocksPerDay | 0)) {
    const oldest = Math.min.apply(null, events);
    return { allowed: false, retryInMs: Math.max(300000, 24 * 3600 * 1000 - (Date.now() - oldest)) };
  }
  if (stats.pausedUntil && Date.now() < stats.pausedUntil) {
    return { allowed: false, retryInMs: stats.pausedUntil - Date.now() };
  }
  // Warm work is still allowed when the cold ceiling is reached: blocking
  // someone on the page in front of you is the ordinary case, and rationing it
  // to protect against a risk it does not carry would just make the extension
  // feel broken.
  // Zero is a real setting -- "never block anyone I have not seen" -- so it
  // cannot be folded in with "unset". A truthiness check here meant asking for
  // no cold blocks at all granted unlimited ones, which is the exact opposite
  // of what someone choosing zero wants.
  const coldCap = Number.isFinite(settings.maxColdBlocksPerHour)
    ? Math.max(0, settings.maxColdBlocksPerHour)
    : 4;
  if (coldInHour.length >= coldCap) {
    // With a ceiling of zero there is no earlier attempt to wait out; check
    // back in an hour in case the setting changes.
    const oldest = coldInHour.length ? Math.min.apply(null, coldInHour) : Date.now();
    return { allowed: true, warmOnly: true,
             coldRetryInMs: Math.max(60000, 3600 * 1000 - (Date.now() - oldest)) };
  }
  return { allowed: true };
}

/** Backoff for a target that keeps failing: 2m, 6m, 18m, 54m, capped at 4h. */
function failureBackoffMs(failures) {
  return Math.min(2 * 60 * 1000 * Math.pow(3, Math.max(0, failures - 1)), 4 * 3600 * 1000);
}

// Jittered, so a run of blocks does not arrive on a metronome.
function rand(lo, hi) {
  const a = Math.max(0, lo || 0), b = Math.max(a, hi || a);
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function claim(platform) {
  const settings = await getSettings();
  if (!settings.platformBlockEnabled) return { ok: true, target: null, retryInMs: 300000 };

  const verdict = await limiterVerdict(settings);
  if (!verdict.allowed) return { ok: true, target: null, retryInMs: verdict.retryInMs };

  // ---- one block at a time, across every open tab -------------------------
  //
  // Each Facebook or Threads tab runs its own worker loop, and each paces
  // itself from the delay this function hands back. That is fine with one tab
  // and wrong with five: the leases stop two tabs blocking the SAME profile,
  // but nothing stopped five tabs blocking five DIFFERENT profiles in the same
  // second, which is five times the rate the caps were chosen for and exactly
  // the burst that earns a checkpoint.
  //
  // So the pace lives here rather than in the tabs. One gate for the whole
  // browser: it is closed while a block is in flight, and closed again for the
  // randomised delay after the result lands. Whichever tab asks first gets the
  // next target; the others are told when to come back, and their own sleep
  // becomes belt and braces rather than the only thing holding the line.
  const gateStats = await getLocal(KEYS.STATS, {});
  const gateNow = Date.now();
  if (gateStats.gateUntil && gateNow < gateStats.gateUntil) {
    return { ok: true, target: null, retryInMs: gateStats.gateUntil - gateNow };
  }

  const q = await getLocal(KEYS.QUEUE, {});
  const leases = await getLocal('leases', {});
  const cooldowns = await getLocal('cooldowns', {});
  const list = (q[platform] || []).map(asEntry);
  if (!list.length) return { ok: true, target: null, retryInMs: 120000 };

  // Asked for by name first, then warm before cold, then by the server's rank.
  //
  // Somebody who pressed Block now is watching the screen; the rest of the
  // queue is the extension working through its own backlog, and it can wait a
  // few seconds. Without this an explicit request went to the BACK of the
  // queue -- appended last, and sorted behind every warm target the feed had
  // already collected -- so the one block a person actually asked for was the
  // last one served.
  list.sort((a, b) =>
    (b.user ? 1 : 0) - (a.user ? 1 : 0) ||
    (b.warm ? 1 : 0) - (a.warm ? 1 : 0) ||
    (b.rank - a.rank));

  // What the two job switches say right now, not what they said when these
  // entries were queued.
  //
  // They were admission filters only: an entry already in the queue was
  // claimed and blocked however the switches stood afterwards. So unticking
  // "work through the list" left the cold queue draining anyway -- against
  // strangers, which is the exact thing the ranked list is and the cold
  // ceiling rations -- while the popup and the Activity page both said in so
  // many words that it was parked until switched back on. An explicit request
  // is exempt: pressing a button about one account is not the extension
  // acting on its own initiative.
  const modes = blockModes(settings);
  const parked = (entry) => !entry.user && (entry.warm ? !modes.seen : !modes.fromList);

  const now = Date.now();
  // Prune expired leases while we are here. Nothing else removes them, and a
  // tab closed mid-claim leaves one behind, so the object would grow forever
  // and be rewritten in full on every claim.
  for (const k of Object.keys(leases)) if (leases[k] <= now) delete leases[k];
  for (const k of Object.keys(cooldowns)) if (cooldowns[k] <= now) delete cooldowns[k];

  let soonest = Infinity;
  let heldCold = false;
  for (const entry of list) {
    const id = entry.id;
    // Switched off since it was queued. Left in place, not dropped: the switch
    // is about whether to ACT, and turning it back on should resume the work
    // rather than start it over.
    if (parked(entry)) continue;
    // The hourly cold ceiling is reached: leave these queued rather than
    // dropping them, and keep serving anything warm behind them.
    if (verdict.warmOnly && !entry.warm) {
      heldCold = true;
      soonest = Math.min(soonest, verdict.coldRetryInMs || 3600000);
      continue;
    }
    const key = platform + ':' + id;
    const lease = leases[key];
    if (lease && lease > now) { soonest = Math.min(soonest, lease - now); continue; }
    // A target in cooldown is skipped rather than retried, so one bad entry
    // cannot head-of-line block everything queued behind it.
    const cool = cooldowns[key];
    if (cool && cool > now) { soonest = Math.min(soonest, cool - now); continue; }
    leases[key] = now + LEASE_MS;
    await setLocal('leases', leases);
    // How long after this one finishes before anybody may claim again: short
    // for a profile that was on screen, long for one off the list.
    const s = await getSettings();
    const nextDelayMs = entry.warm
      ? rand(s.warmMinDelayMs | 0, s.warmMaxDelayMs | 0)
      : rand(s.minDelayMs | 0, s.maxDelayMs | 0);

    // Shut the gate for the flight, and remember the delay to apply when the
    // result arrives. The lease length is the outer bound on how long a block
    // can be in flight, so a tab that is closed mid-block cannot wedge the
    // queue for longer than that.
    const st = await getLocal(KEYS.STATS, {});
    st.gateUntil = now + LEASE_MS;
    st.pendingDelayMs = nextDelayMs;
    await setLocal(KEYS.STATS, st);

    return { ok: true, target: id, warm: entry.warm, rank: entry.rank, nextDelayMs };
  }
  return { ok: true, target: null, coldHeld: heldCold,
           retryInMs: Math.max(30000, Math.min(soonest, 15 * 60 * 1000)) };
}

/**
 * Keep the toolbar badge honest about the one thing that silently stops work.
 *
 * Blocks are issued by the content script, through the site's own code -- so
 * with no Facebook or Threads tab open there is nowhere for a queued block to
 * run, and the queue simply sits there. Warm targets are unaffected in
 * practice (they only ever arrive while a tab IS open), so this counts the
 * cold ones: profiles nominated by the list that nothing on screen will ever
 * trigger. A number means "this many are waiting on you to open a tab".
 */
/**
 * Things the person asked for that did not happen.
 *
 * The report sheet is optimistic now: it says "sent" and closes the moment
 * somebody presses the button, because the outbox guarantees the report
 * eventually goes and waiting three seconds to say so helped nobody. That
 * trade only holds if a failure still reaches them, and the badge is the one
 * surface that can carry it -- they are not looking at the sheet any more, and
 * an alert on a page nobody has open is not an alert.
 *
 * Keyed by target rather than counted, for two reasons. A block that fails and
 * is retried must not count twice, and one that later succeeds must stop
 * counting at all -- so a transient failure clears itself and only a real one
 * keeps the badge lit.
 */
const ALERTS = 'actionAlerts';

async function noteAlert(key, detail, kind) {
  const alerts = await getLocal(ALERTS, {});
  if (!alerts[key]) alerts[key] = { at: Date.now(), kind: kind || 'block' };
  alerts[key].detail = String(detail || '').slice(0, 200);
  alerts[key].tries = (alerts[key].tries || 0) + 1;
  await setLocal(ALERTS, alerts);
  await updateBadge();
}

/** It worked after all: stop saying it did not. */
async function clearAlert(key) {
  const alerts = await getLocal(ALERTS, {});
  if (!alerts[key]) return;
  delete alerts[key];
  await setLocal(ALERTS, alerts);
  await updateBadge();
}

async function alertsList() {
  const alerts = await getLocal(ALERTS, {});
  return Object.keys(alerts).map(k => Object.assign({ key: k }, alerts[k]))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

async function alertsClear() {
  await setLocal(ALERTS, {});
  await updateBadge();
  return { ok: true };
}

async function updateBadge() {
  try {
    const settings = await getSettings();
    let waiting = 0;
    if (settings.platformBlockEnabled && blockModes(settings).fromList) {
      const q = await getLocal(KEYS.QUEUE, {});
      for (const platform of Object.keys(q)) {
        for (const e of (q[platform] || [])) {
          const entry = asEntry(e);
          if (!entry.warm) waiting++;
        }
      }
    }
    const tabs = waiting
      ? await chrome.tabs.query({ url: ['*://*.facebook.com/*', '*://*.threads.net/*', '*://*.threads.com/*'] })
      : [];
    // A halted state already owns the badge and is the more urgent message.
    const stats = await getLocal(KEYS.STATS, {});
    if (stats.halted) return;

    // Failures outrank a backlog. A queue that has not drained yet is the
    // extension working slowly; something the person asked for that did not
    // happen is the extension having let them down, and only one of those is
    // worth interrupting them about. Red rather than amber, for the same
    // reason.
    const failed = Object.keys(await getLocal(ALERTS, {})).length;
    if (failed) {
      await chrome.action.setBadgeText({ text: String(Math.min(failed, 999)) });
      await chrome.action.setBadgeBackgroundColor({ color: '#c53030' });
      // A red number with no explanation is just alarming. The tooltip says
      // what it counts, for anybody who hovers before clicking.
      try { await chrome.action.setTitle({ title: T('alerts_badgeTitle', failed) }); }
      catch (e) { /* setTitle is not in every harness */ }
      return;
    }
    try { await chrome.action.setTitle({ title: '' }); } catch (e) {}

    const show = waiting > 0 && tabs.length === 0;
    await chrome.action.setBadgeText({ text: show ? String(Math.min(waiting, 999)) : '' });
    if (show) await chrome.action.setBadgeBackgroundColor({ color: '#b7791f' });
  } catch (e) { /* the badge is never worth breaking a caller over */ }
}

// The condition depends on tabs as much as on the queue, so watch both ends.
try {
  chrome.tabs.onRemoved.addListener(() => { updateBadge().catch(() => {}); });
  chrome.tabs.onUpdated.addListener((id, ch) => {
    if (ch && ch.url) updateBadge().catch(() => {});
  });
} catch (e) { /* not available in the test harness */ }

async function reportResult(info) {
  const { platform, target, ok, dryRun, rateLimited, checkpoint, loggedOut, notReady, detail } = info || {};
  const q = await getLocal(KEYS.QUEUE, {});
  const done = await getLocal(KEYS.DONE, {});
  const stats = await getLocal(KEYS.STATS, {});
  const leases = await getLocal('leases', {});
  const cooldowns = await getLocal('cooldowns', {});
  const failures = await getLocal('failures', {});
  const key = platform + ':' + target;
  const now = Date.now();

  // The activity page shows every attempt with what was known about the
  // target at the time. Capture that BEFORE the queue entry is consumed --
  // after a success the entry is gone, and the done list is bare ids.
  {
    const entry = (q[platform] || []).map(asEntry).find(e => e.id === String(target)) || {};
    // Only for something the person actually asked for. The list-driven queue
    // fails and retries all the time and none of that is theirs to worry
    // about; a block they pressed a button for is. A later success on the same
    // target clears it, so a transient failure puts the badge up and takes it
    // down again by itself.
    if (entry.user || info.userInitiated) {
      if (ok && !dryRun) await clearAlert(key);
      else if (!ok && !notReady) await noteAlert(key, detail, 'block');
    }
    const list = await getLocal(KEYS.BLOCKLIST, null);
    const meta = list && (list.targets || []).find(t => String(t.id) === String(target));
    const log = await getLocal('blockLog', []);
    // Snapshotted, not looked up at render time. This row is history: if the
    // account is renamed, or falls out of the name store months later, what
    // it said here on the day should not change underneath the reader.
    const known = await nameOfId(platform, target);
    log.unshift({
      at: now, platform, id: String(target),
      username: (known && known.u) || (meta && meta.username) || null,
      displayName: (known && known.d) || (meta && meta.displayName) || null,
      ok: !!ok, dryRun: !!dryRun, warm: !!info.warm,
      rank: entry.rank != null ? entry.rank : (meta ? meta.rank : null),
      why: meta ? meta.why : null,
      detail: ok ? null : String(detail || '').slice(0, 200)
    });
    await setLocal('blockLog', log.slice(0, 500));
  }

  delete leases[key];

  // The block is over, however it went. Re-arm the gate with the delay that
  // was chosen when this target was handed out, so the pause is measured from
  // when the work actually finished rather than from when it started.
  stats.gateUntil = now + (Number(stats.pendingDelayMs) || 0);
  delete stats.pendingDelayMs;

  stats.blockTimes = (stats.blockTimes || []).filter(t => now - t < 24 * 3600 * 1000);
  stats.attemptTimes = (stats.attemptTimes || []).filter(t => now - t < 24 * 3600 * 1000);
  stats.attempts = (stats.attempts || 0) + 1;

  // A real request left the browser whatever its outcome, so it counts.
  if (!dryRun) {
    stats.attemptTimes.push(now);
    // Counted separately: the cold ceiling exists because unencountered targets
    // are what look automated, and a warm block should never eat that budget.
    stats.coldTimes = (stats.coldTimes || []).filter(t => now - t < 24 * 3600 * 1000);
    if (!info.warm) stats.coldTimes.push(now);
  }

  if (ok && !dryRun) {
    q[platform] = (q[platform] || []).filter(e => entryId(e) !== String(target));
    done[platform] = Array.from(new Set([...(done[platform] || []), target]));
    stats.blockTimes.push(now);
    stats.succeeded = (stats.succeeded || 0) + 1;
    clearError(stats);
    delete failures[key];
    delete cooldowns[key];
  } else if (ok && dryRun) {
    // A dry run changes nothing, so the target stays queued -- but it must go
    // into cooldown, otherwise the worker would re-simulate the same first
    // entry forever and never reach the rest of the queue.
    stats.dryRuns = (stats.dryRuns || 0) + 1;
    // A dry run resolved a strategy end to end. Whatever the last complaint
    // was, it is no longer the current state of things.
    clearError(stats);
    cooldowns[key] = now + DRYRUN_COOLDOWN_MS;
  } else if (notReady) {
    // Nothing was attempted: the page has not loaded the site's own block
    // operation and raw fallbacks are off. That is a fact about the PAGE, not
    // the target, so it must not creep toward abandonment -- five of these
    // from a tab parked on the feed used to drop a good target from the
    // queue for good. Leave the count alone, step aside for a while so other
    // targets (and other tabs, which may have the module) get a turn, and
    // say why nothing is happening; a later success or dry run clears it.
    stats.notReady = (stats.notReady || 0) + 1;
    // Localised here rather than taken from the page: the page-world script
    // has no i18n, and this line is read by people.
    noteError(stats, T('sw_notReady') || detail, 'not-ready');
    cooldowns[key] = now + 5 * 60 * 1000;
  } else {
    stats.failed = (stats.failed || 0) + 1;
    noteError(stats, detail);
    const n = (failures[key] || 0) + 1;
    failures[key] = n;
    if (n >= MAX_TARGET_FAILURES) {
      // Give up rather than hammering it forever. It stays recorded so the
      // diagnostics panel can show why it never completed.
      q[platform] = (q[platform] || []).filter(e => entryId(e) !== String(target));
      stats.abandoned = (stats.abandoned || 0) + 1;
      stats.abandonedIds = Array.from(new Set([...(stats.abandonedIds || []), target])).slice(-200);
      delete cooldowns[key];
      delete failures[key];
    } else {
      cooldowns[key] = now + failureBackoffMs(n);
    }
  }

  if (loggedOut) {
    // Not the target's fault: leave it queued, clear the failure count that
    // would otherwise creep toward abandonment, and pause the whole run.
    delete failures[key];
    cooldowns[key] = now + 10 * 60 * 1000;
    stats.pausedUntil = now + 15 * 60 * 1000;
    noteError(stats, T('sw_signedOutPaused'), 'signed-out');
  }
  if (rateLimited) stats.pausedUntil = now + 20 * 60 * 1000;
  if (checkpoint) {
    stats.pausedUntil = now + 6 * 3600 * 1000;
    stats.halted = true;
    noteError(stats, T('sw_checkpoint'), 'checkpoint');
    await setSettings({ platformBlockEnabled: false });
    try {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
    } catch (e) { /* ignore */ }
  }

  await setLocal(KEYS.QUEUE, q);
  await setLocal(KEYS.DONE, done);
  await setLocal(KEYS.STATS, stats);
  await setLocal('leases', leases);
  await setLocal('cooldowns', cooldowns);
  await setLocal('failures', failures);
  await updateBadge();
  return { ok: true };
}

async function bumpStat(name) {
  const stats = await getLocal(KEYS.STATS, {});
  stats[name] = (stats[name] || 0) + 1;
  await setLocal(KEYS.STATS, stats);
}

// ---------------------------------------------------------------------------
// alarms
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// a tab of our own
// ---------------------------------------------------------------------------
//
// Blocking runs through the site's own code, and the site's own code lives in
// a page. So with no Facebook or Threads tab open, a queued target waits for
// the person to come back -- which is the one thing the queue exists to avoid.
//
// The tempting alternative is to send the block from here: the worker's fetch
// IS authenticated (measured -- the response carries the viewer's own id), and
// fresh fb_dtsg and lsd tokens can be scraped from one GET with no page at
// all. But a POST built here is a hand-built request, without the per-build
// __dyn / __csr / __spin_r bookkeeping a real one carries, and hand-built
// requests to Meta were twice observed invalidating the signed-in session.
// Being able to do a thing is not a reason to do it that way.
//
// So the extension does not fake a page. It keeps one.
//
// It used to open a tab, drain the queue and close it again, which was worse
// than it sounds: a tab appearing and vanishing in the strip every time work
// arrived, several times an hour. A PINNED tab is the shape this wants -- it
// is a favicon at the far left, it is what pinned tabs are for, and above all
// it holds still. So it opens once, when there is work and no page to do it
// in, and then it stays: through an empty queue, through the person browsing
// somewhere else, until they turn the experiment off.
//
// ONE RECORD PER PLATFORM, and that is not incidental. Facebook work can only
// be done on a facebook.com page and Threads work on a threads.com one, so a
// single "the tab" would strand whichever site it was not on -- and with the
// tab no longer closing when its own queue empties, strand it for the rest of
// the browser session while the badge, which counts any Meta tab as somewhere
// for work to run, reported everything as fine.
//
// The one thing it must never become is a tab that cannot be closed. Closing
// it by hand is answered by opening it again a minute later -- because the
// common case really is an accidental close -- but each further close pushes
// that out, and the fifth is taken as an answer: the experiment switches
// itself OFF, which unticks the box, closes the tabs, and leaves the person
// looking at a setting that agrees with what they did.

/** Every worker tab we hold, keyed by platform. */
async function ownTabs() {
  const rec = await getLocal(OWN_TAB, {});
  return (rec && typeof rec === 'object' && !Array.isArray(rec)) ? rec : {};
}
async function setOwnTab(platform, value) {
  const all = await ownTabs();
  all[platform] = value;
  await setLocal(OWN_TAB, all);
}

// How long to wait before opening another, after N closes by hand -- and then
// how many closes it takes before we stop asking altogether.
//
// The ladder alone would mean a tab reappearing once an hour forever, which is
// only a slower version of the thing being avoided. Reaching the end of it
// takes five closes EACH within ten minutes of opening (a tab that outlives
// that resets the count), which is not somebody mis-clicking. It is somebody
// telling us no, five times. So the fifth one is taken as an answer.
const REOPEN_LADDER_MINUTES = [1, 5, 30, 60];
function reopenDelayMinutes(manualCloses) {
  const i = Math.min(Math.max(manualCloses, 1), REOPEN_LADDER_MINUTES.length) - 1;
  return REOPEN_LADDER_MINUTES[i];
}
const givesUpAfter = (manualCloses) => manualCloses > REOPEN_LADDER_MINUTES.length;

/** Is a page already open on this platform -- ours, or one they opened? */
async function tabOpenFor(platform) {
  try {
    const tabs = await chrome.tabs.query({ url: TAB_PATTERNS[platform] || [] });
    return tabs.length > 0;
  } catch (e) { return false; }
}

/**
 * The tab is gone, and we did not do it.
 *
 * Only reached when a record still points at the tab, which is exactly the
 * case where somebody closed it themselves -- closeOwnTab clears the record
 * before removing the tab, so its own removals land here as a no-op.
 */
async function forgetOwnTab(tabId, reason) {
  const all = await ownTabs();
  const platform = Object.keys(all).find(p => all[p] && all[p].tabId === tabId);
  if (!platform) return false;
  const rec = all[platform];

  // A tab that lived a good while was not being rejected -- whatever happened
  // to it, it was not somebody batting away an unwanted tab -- so the count of
  // consecutive rejections starts again.
  const lived = Date.now() - (rec.openedAt || 0);
  const manualCloses = lived > OWN_TAB_SETTLED_MS ? 1 : (rec.manualCloses || 0) + 1;

  await setOwnTab(platform, {
    platform, closedAt: Date.now(), reason, manualCloses
  });

  if (givesUpAfter(manualCloses)) {
    // Answered. Switching the experiment off rather than only remembering a
    // "we gave up" flag is what makes this stick: the flag was invisible and
    // any later options save re-armed it, because the options page posts every
    // checkbox on every change and the box was still ticked. Unticking it is
    // both the honest UI and the only state a bulk save cannot undo by
    // accident -- turning it back on now has to be somebody ticking the box.
    try { await chrome.alarms.clear(ALARM_REOPEN); } catch (e) { /* ignore */ }
    await setSettings({ experimentalOwnTab: false });
    await closeAllOwnTabs('closed by hand too often');
    return true;
  }
  // Ask again later rather than now: reopening the instant it is closed is the
  // behaviour of a tab that cannot be closed.
  try {
    await chrome.alarms.create(ALARM_REOPEN, { delayInMinutes: reopenDelayMinutes(manualCloses) });
  } catch (e) { /* ignore */ }
  return true;
}

/** Close one worker tab. Ours, deliberately, for a stated reason. */
async function closeOwnTab(platform, reason) {
  const all = await ownTabs();
  const rec = all[platform];
  if (!rec || rec.tabId == null) return false;
  // Record first, remove second. Removing the tab fires onRemoved, and while
  // the record still points at that id the handler would count this as
  // somebody rejecting the tab and schedule a reopen -- when in fact we are
  // closing it precisely because it should not exist.
  await setOwnTab(platform, { platform, closedAt: Date.now(), reason, manualCloses: 0 });
  try { await chrome.tabs.remove(rec.tabId); } catch (e) { /* already gone */ }
  return true;
}

async function closeAllOwnTabs(reason) {
  const all = await ownTabs();
  for (const platform of Object.keys(all)) {
    if (all[platform] && all[platform].tabId != null) await closeOwnTab(platform, reason);
  }
  try { await chrome.alarms.clear(ALARM_REOPEN); } catch (e) { /* ignore */ }
}

/** Remember that one of our tabs is alive, so a stalled one can be told apart. */
async function noteWorkTabClaim(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) return false;
  const all = await ownTabs();
  const platform = Object.keys(all).find(p => all[p] && all[p].tabId === tabId);
  if (!platform) return false;
  await setOwnTab(platform, Object.assign({}, all[platform], { lastClaimAt: Date.now() }));
  return true;
}

/** Everything that has to be true for worker tabs to be worth having. */
async function workTabWanted() {
  const settings = await getSettings();
  if (!settings.experimentalOwnTab) return { want: false, why: 'experiment off' };
  if (!settings.platformBlockEnabled) return { want: false, why: 'blocking off' };
  const stats = await getLocal(KEYS.STATS, {});
  if (stats.halted) return { want: false, why: 'halted' };
  return { want: true };
}

/**
 * Make one platform's tab exist, or explain why it should not.
 *
 * Everything about a single platform lives here; maybeOpenWorkTab is the loop
 * over platforms and the lock around the whole thing.
 */
async function ensureWorkTabFor(platform, reason) {
  const all = await ownTabs();
  const rec = all[platform];

  if (rec && rec.tabId != null) {
    try {
      const tab = await chrome.tabs.get(rec.tabId);
      // Chrome reclaims memory by DISCARDING background tabs. The tab is still
      // listed and still ours, but the page inside it is gone -- and with it
      // the content script that does the blocking. Nothing else would notice:
      // the tab exists, so we would say "already open" forever while the queue
      // sat still. Waking it costs one page load and is the entire cure.
      if (tab && tab.discarded) {
        try { await chrome.tabs.reload(rec.tabId); } catch (e) { /* ignore */ }
        await setOwnTab(platform, Object.assign({}, rec, { wokeAt: Date.now() }));
        return { ok: true, skipped: 'already open', reloaded: 'discarded', tabId: rec.tabId };
      }
      // A page that is loaded but no longer working. The content script's
      // worker loop stops for good on a rejected session or a challenge, and
      // nothing in the page ever restarts it -- so the tab sits there looking
      // healthy, and because ANY Meta tab counts as somewhere for work to run,
      // even the badge stops saying anything is wrong. A reload is the only
      // thing here that can restart a loop inside a page.
      const q = await getLocal(KEYS.QUEUE, {});
      const waiting = (q[platform] || []).length;
      const since = rec.lastClaimAt || rec.wokeAt || rec.openedAt || 0;
      if (waiting && since && Date.now() - since > OWN_TAB_STALL_MS) {
        try { await chrome.tabs.reload(rec.tabId); } catch (e) { /* ignore */ }
        await setOwnTab(platform, Object.assign({}, rec, { wokeAt: Date.now() }));
        return { ok: true, skipped: 'already open', reloaded: 'stalled', tabId: rec.tabId };
      }
      // Somebody unpinned it. Pinning is the whole reason this is bearable to
      // live with, so put it back -- quietly, and without touching anything
      // else about the tab.
      if (tab && tab.pinned === false) {
        try { await chrome.tabs.update(rec.tabId, { pinned: true }); } catch (e) { /* ignore */ }
        return { ok: true, skipped: 'already open', repinned: true, tabId: rec.tabId };
      }
      return { ok: true, skipped: 'already open', tabId: rec.tabId };
    } catch (e) {
      // Gone without onRemoved reaching us -- a closed window, a worker that
      // was asleep at the time. Treat it as a close by hand, which is the
      // conservative reading: it schedules a reopen rather than forcing one.
      await forgetOwnTab(rec.tabId, 'vanished');
      return { ok: true, skipped: 'vanished, will reopen' };
    }
  }

  // Closed by hand recently: wait out the back-off. The reopen alarm is what
  // ends it, so nothing here has to poll.
  if (rec && rec.closedAt && rec.manualCloses) {
    const waitMs = reopenDelayMinutes(rec.manualCloses) * 60000;
    if (Date.now() - rec.closedAt < waitMs) return { ok: true, skipped: 'closed by hand, waiting' };
  }

  // Nothing CLAIMABLE queued for this platform: no reason to put a page in
  // front of anybody yet. Claimable, not merely queued -- entries parked by
  // the job switches are not work, and opening a pinned tab to carry out
  // blocking the popup describes as parked would be the same contradiction
  // one layer up. Note that once a tab IS open this is not consulted again:
  // an empty queue never closes it, because opening and closing is the thing
  // being avoided.
  const q = await getLocal(KEYS.QUEUE, {});
  const settings = await getSettings();
  const modes = blockModes(settings);
  const claimable = (q[platform] || []).map(asEntry)
    .filter(e => e.user || (e.warm ? modes.seen : modes.fromList));
  if (!claimable.length) return { ok: true, skipped: 'nothing to do' };
  // A page they already have open does the job, and costs nobody a tab.
  if (await tabOpenFor(platform)) return { ok: true, skipped: 'nothing to do' };

  const url = PLATFORM_HOME[platform];
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false, pinned: true });
  } catch (e) {
    // No window to put a tab in -- every window closed, Chrome still running.
    // A minimised window of its own is the only way through, and it is still
    // the site's own page doing the work.
    try {
      const win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
      tab = win && win.tabs && win.tabs[0];
      if (tab && tab.id != null) {
        try { await chrome.tabs.update(tab.id, { pinned: true }); } catch (e3) { /* ignore */ }
      }
    } catch (e2) { return { ok: false, error: String((e2 && e2.message) || e2) }; }
  }
  if (!tab || tab.id == null) return { ok: false, error: 'no tab was created' };

  await setOwnTab(platform, {
    tabId: tab.id, platform, openedAt: Date.now(),
    reason: reason || null, manualCloses: (rec && rec.manualCloses) || 0
  });
  return { ok: true, opened: platform, tabId: tab.id, pinned: true };
}

/**
 * Bring the world into line: open what should exist, close what should not.
 *
 * The only function that decides whether worker tabs exist. Called when work
 * arrives, when settings change, and on a slow alarm -- so a setting turned off
 * takes the tabs away without waiting for anything, and a tab that died with
 * its window comes back.
 *
 * Serialised, and that matters: the drain alarm and the reopen alarm can come
 * due in the same instant, and two runs interleaving between "read the record"
 * and "write the new tab id" would each create a pinned tab while only the
 * second was remembered. The first would then be a tab nothing owns -- not
 * closed by the off switch, not reopened, not reloaded, just there.
 */
function maybeOpenWorkTab(reason) {
  return serialize(async () => {
    const wanted = await workTabWanted();
    if (!wanted.want) {
      await closeAllOwnTabs(wanted.why);
      return { ok: true, skipped: wanted.why };
    }

    // The experiment is ON, next to a record whose close count had already run
    // off the end of the ladder. That combination has exactly one cause: we
    // switched ourselves off after the fifth close, and somebody has since
    // ticked the box again. Take them at their word and give them a fresh
    // ladder -- carrying the old count over would mean the next stray click
    // ended it for good. (`gaveUp` is the same state as an older build wrote
    // it, honoured so an upgrade does not strand anyone.)
    const all = await ownTabs();
    for (const p of Object.keys(all)) {
      const r = all[p];
      if (!r || r.tabId != null) continue;
      if (r.gaveUp || givesUpAfter(r.manualCloses || 0)) {
        await setOwnTab(p, { platform: p, closedAt: 0, manualCloses: 0 });
      }
    }

    const results = {};
    let opened = null, notable = {};
    for (const platform of ['threads', 'facebook']) {
      const r = await ensureWorkTabFor(platform, reason);
      results[platform] = r.opened ? 'opened' : (r.error || r.skipped);
      if (r.opened && !opened) opened = r;
      // Things that happened to a tab we already had. Worth carrying up: they
      // are the difference between "nothing to do" and "something was wrong
      // and has been put right", which is what a caller wants to know.
      for (const flag of ['repinned', 'reloaded']) if (r[flag]) notable[flag] = r[flag];
    }
    if (opened) return Object.assign({ ok: true, platforms: results }, notable, opened);
    // One line for the caller and the tests: what happened to each platform,
    // and a single word for the common case where they agree.
    const distinct = Array.from(new Set(Object.values(results)));
    return Object.assign(
      { ok: true, skipped: distinct.length === 1 ? distinct[0] : 'mixed', platforms: results },
      notable);
  });
}

async function installAlarm() {
  const settings = await getSettings();
  // Chrome clamps periods below 30 seconds; our floor is far above that, but
  // guard anyway so a bad setting cannot produce a silently-ignored alarm.
  const minutes = Math.max(1, settings.refreshMinutes | 0 || DEFAULTS.refreshMinutes);
  // Leave an existing alarm alone when the period is unchanged. Recreating it
  // on every settings save would push the next refresh back a minute each time,
  // so editing unrelated options could starve the refresh indefinitely.
  // The rebrand renamed this alarm. Alarms persist per extension install, so
  // the old name would keep firing (and being ignored) forever in installs
  // that predate it -- clear it once.
  try { await chrome.alarms.clear('tq-refresh-blocklist'); } catch (e) { /* ignore */ }
  // The drain alarm is unconditional: whether it does anything is decided when
  // it fires, by maybeOpenWorkTab, so turning the experiment on takes effect
  // without waiting for an alarm to be installed.
  try {
    const drain = await chrome.alarms.get(ALARM_DRAIN);
    if (!drain || drain.periodInMinutes !== DRAIN_EVERY_MINUTES) {
      await chrome.alarms.clear(ALARM_DRAIN);
      await chrome.alarms.create(ALARM_DRAIN,
        { periodInMinutes: DRAIN_EVERY_MINUTES, delayInMinutes: 2 });
    }
  } catch (e) { /* ignore */ }

  let existing = null;
  try { existing = await chrome.alarms.get(ALARM_REFRESH); } catch (e) { /* ignore */ }
  if (existing && existing.periodInMinutes === minutes) return;
  await chrome.alarms.clear(ALARM_REFRESH);
  await chrome.alarms.create(ALARM_REFRESH, { periodInMinutes: minutes, delayInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_REFRESH) {
    refreshBlocklist(false).catch(() => {});
    // Rides the refresh wakeup rather than holding an alarm of its own: an
    // outbox that is almost always empty does not deserve one, and the two
    // things it is waiting for -- the network coming back, or the server
    // stopping being busy -- are on the same timescale as a list refresh.
    flushOutbox().catch(() => {});
    return;
  }
  // Work arrived while nobody was browsing. This is the only thing that makes
  // the queue move for somebody who never opens the site.
  if (alarm.name === ALARM_DRAIN) { maybeOpenWorkTab('alarm').catch(() => {}); return; }
  // The back-off after a close by hand has run out; ask again.
  if (alarm.name === ALARM_REOPEN) { maybeOpenWorkTab('reopen').catch(() => {}); return; }
});

// However the tab went -- drained, closed by hand, window shut -- the record
// has to stop pointing at it, or nothing will ever open another one.
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetOwnTab(tabId, 'closed').catch(() => {});
});

/**
 * The one-time welcome tab.
 *
 * Gated on chrome.storage.local rather than on the install reason alone, for
 * two reasons that point the same way. An unpacked extension fires
 * onInstalled with reason "install" on every reload, so reason alone would
 * open a tab every time anyone working on this saved a file. And local
 * storage is wiped when the extension is removed, so somebody who genuinely
 * uninstalls and installs again does get the tour again -- which is right,
 * because for them it is a first run.
 *
 * Failures are swallowed on purpose. Not seeing the guide is a small loss;
 * an unhandled rejection in the install handler is not worth it.
 */
async function openWelcomeOnce() {
  const got = await chrome.storage.local.get('welcomedAt');
  // Seen it already -- unless this is an unpacked build, where reloading the
  // extension IS the edit-and-check loop and reopening the guide is the point.
  // Chrome fires onInstalled with reason "install" on every unpacked reload,
  // which is exactly why the flag exists: without it a published install would
  // reopen the tab on every browser event that looks like one. So the flag
  // still governs a real install, and only a development build ignores it.
  if (got && got.welcomedAt && !isDevBuild()) return;
  // Written before the tab is opened, not after. If creating the tab throws,
  // the flag is still set and the next reload does not try again -- a guide
  // that cannot open is not a guide worth retrying forever.
  await chrome.storage.local.set({ welcomedAt: Date.now() });
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
}

chrome.runtime.onInstalled.addListener((details) => {
  installAlarm().catch(() => {});
  refreshBlocklist(true).catch(() => {});
  if (details && details.reason === 'install') openWelcomeOnce().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  installAlarm().catch(() => {});
  refreshBlocklist(false).catch(() => {});
});

// ---------------------------------------------------------------------------
// message hub
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.type) return;

  (async () => {
    const payload = msg.payload || {};
    switch (msg.type) {
      case P.SW.GET_SETTINGS:
        respond({ ok: true, settings: await getSettings() });
        break;

      case P.SW.SET_SETTINGS: {
        const next = await setSettings(payload);
        await installAlarm();
        respond({ ok: true, settings: next });
        // Turning the experiment (or blocking) off has to take the tab away
        // now, not at the next alarm: a tab that outlives the switch that
        // governs it reads as one you cannot get rid of. Turning it on is the
        // same call from the other side.
        await maybeOpenWorkTab('settings').catch(() => {});
        break;
      }

      case P.SW.GET_BLOCKLIST: {
        const bl = await getLocal(KEYS.BLOCKLIST, null);
        respond(bl ? { ok: true, blocklist: bl } : { ok: false, error: T('sw_noBlocklistCached') });
        break;
      }

      case P.SW.REFRESH_NOW:
        respond(await refreshBlocklist(true));
        break;

      case P.SW.GET_STATE: {
        const [settings, blocklist, queue, done, stats, blockLog, cooldowns, failures, idNames] =
          await Promise.all([
            getSettings(),
            getLocal(KEYS.BLOCKLIST, null),
            getLocal(KEYS.QUEUE, {}),
            getLocal(KEYS.DONE, {}),
            getLocal(KEYS.STATS, {}),
            getLocal('blockLog', []),
            getLocal('cooldowns', {}),
            getLocal('failures', {}),
            getLocal('idNames', {})
          ]);
        respond({ ok: true, settings, blocklist, queue, done, stats, blockLog,
          cooldowns, failures, idNames });
        break;
      }

      case P.SW.ENQUEUE_PLATFORM_BLOCK: {
        // warm: these ids were resolved from the page the user is looking at.
        //
        // The tag filter belongs here because this is the extension's own
        // sweep talking: the content script forwards every listed id it can
        // see, and somebody who unticked "spam" did not want spam accounts
        // blocked merely because one scrolled past.
        //
        // `userInitiated` is the way out of that, and the popup's "Block now"
        // button sets it. Someone looking at a profile and pressing a button
        // labelled Block now has made a decision about THIS account; silently
        // dropping the click because of a category preference would leave them
        // with a button that does nothing and no way to find out why. A
        // deliberate act outranks the standing preference.
        const settings = await getSettings();
        const warm = payload.warm !== false;

        // Same reasoning one level up: with "block clones I run into"
        // unticked, a profile scrolling past is not a request to block it.
        // A deliberate act still outranks the standing preference, so a
        // userInitiated call is never refused here either -- that is the
        // popup's Block now and the report sheet's tick box, and both are
        // somebody pressing a button about THIS account.
        const modes = blockModes(settings);
        if (!payload.userInitiated && warm && !modes.seen) {
          respond({ ok: true, added: 0, queued: 0, skipped: (payload.ids || []).length });
          break;
        }

        // Remembered before the tag filter, and whether or not anything is
        // ultimately queued. Knowing who an id belongs to is worth keeping
        // even when this particular sighting is not worth acting on.
        if (payload.names) await rememberNames(payload.platform, payload.names);

        const ids = payload.userInitiated
          ? payload.ids
          : await filterByBlockTags(payload.ids, settings);
        const queued = await serialize(() =>
          enqueue(payload.platform, ids, { warm, userInitiated: !!payload.userInitiated }));
        respond(queued);
        // Somebody is watching for this to happen. The tabs' worker loops sleep
        // between claims -- up to two minutes, and longer after a dry run -- so
        // without a nudge an explicit block waits out a timer that was chosen
        // for the extension's own unattended sweeping.
        if (payload.userInitiated && queued && queued.added) {
          await broadcast(P.SW.WAKE_WORKER, { platform: payload.platform });
        }
        break;
      }

      case P.SW.QUEUE_CLAIM:
        // Serialised so two tabs cannot be handed the same target: the lease
        // write must land before the next claim reads the lease table.
        //
        // An empty answer used to close the tab we had opened. It does not any
        // more: a queue that is empty now will not be in an hour, and a tab
        // that comes and goes with the queue is a tab flickering in and out of
        // somebody's strip several times an hour. It stays until the person
        // says otherwise.
        respond(await serialize(() => claim(payload.platform)));
        // A claim -- even one answered with "nothing right now" -- is proof
        // that the worker loop inside that tab is still running. It is the
        // only such proof there is, and without it a tab whose loop had
        // stopped would look identical to one quietly waiting.
        await noteWorkTabClaim(sender).catch(() => {});
        break;

      case P.SW.QUEUE_RESULT:
        respond(await serialize(() => reportResult(payload)));
        break;

      case P.SW.ALERTS_GET:
        respond({ ok: true, alerts: await alertsList() });
        break;

      case P.SW.ALERTS_CLEAR:
        respond(await alertsClear());
        break;

      case P.SW.FLUSH_REPORTS:
        respond(await flushOutbox());
        break;

      case P.SW.RETRY_TARGET:
        respond(await serialize(() => retryTargets(payload.platform, [payload.id], true)));
        break;

      case P.SW.RETRY_ALL:
        respond(await serialize(() => retryTargets(payload.platform, null, false)));
        break;

      case P.SW.REMEMBER_DOC_IDS:
        respond(await rememberDocIds(payload));
        break;

      // Test hook: the first-run guide, without waiting for Chrome to fire an
      // install event. Every gate is inside openWelcomeOnce.
      case 'sw:open-welcome':
        await openWelcomeOnce();
        respond({ ok: true });
        break;

      // Test hook: ask the "is anybody around to do this work" question
      // directly instead of waiting a quarter of an hour for the alarm. Every
      // gate is inside maybeOpenWorkTab, so this can do nothing a fired alarm
      // could not.
      case 'sw:open-work-tab':
        respond(await maybeOpenWorkTab('asked'));
        break;

      // Test hook: drive the list-prune directly. Harmless in production --
      // it only ever removes queue entries.
      case 'sw:prune-test':
        respond({ ok: true, removed: await pruneQueueToList({ ids: (payload && payload.ids) || [] }) });
        break;

      case P.SW.SUBMIT_REPORT:
        respond(await submitReport(payload));
        break;

      case P.SW.REPORT_STATUS:
        respond(await reportStatus(payload, payload && payload.force));
        break;

      case P.SW.LOG:
        if (payload && payload.msg) console.debug('[CloneBlocker/sw]', payload.msg);
        respond({ ok: true });
        break;

      default:
        respond({ ok: false, error: 'unknown message type: ' + msg.type });
    }
  })().catch((e) => {
    try { respond({ ok: false, error: String((e && e.message) || e) }); } catch (_) { /* port closed */ }
  });

  return true;   // keep the port open for the async respond above
});


// ---------------------------------------------------------------------------
// clone reporting
//
// Users report; an admin reviews and decides. Everything here runs in the
// service worker because it is the only context allowed to reach the API at
// all: a content-script fetch is bound by facebook.com's origin, and the admin
// token must never travel through a page context.
// ---------------------------------------------------------------------------

/**
 * Where the report API lives.
 *
 * Derived from listUrl by default -- the blocklist and the report intake are
 * two routes on the same service, so configuring the base separately would
 * mostly be a way to get them out of sync.
 */
/**
 * Where the backend is today.
 *
 * Resolution order, and each step is there for a reason:
 *
 *   1. An explicit apiBase in settings. Somebody self-hosting has said where
 *      their server is and nothing should second-guess them.
 *   2. The host this browser last reached successfully. A working answer beats
 *      re-deriving one on every call, and it is what keeps the extension
 *      working through a pointer outage.
 *   3. The signed pointer, if one verifies.
 *   4. The address compiled into the build.
 *
 * The pointer is checked at most once an hour, and never on the path of a
 * report -- a person pressing a button should not wait on a discovery request.
 */
const POINTER_TTL_MS = 3600000;

/**
 * Check a signed envelope against the key compiled into this build.
 *
 * Used for both documents the extension ACTS on without a person in the loop:
 * the pointer that says where reports go, and the blocklist that says whom to
 * block. Returns the payload on success and null on anything else -- and
 * "anything else" includes a build with no key, because a build that cannot
 * verify must not accept, not accept anyway.
 */
async function verifyEnvelope(doc) {
  const key = globalThis.CB_POINTER_KEY;
  if (!key) return null;
  if (!doc || typeof doc !== 'object' || !doc.payload || !doc.sig || doc.alg !== 'ed25519') {
    return null;
  }
  const b64url = (v) => Uint8Array.from(
    atob(String(v).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const body = new TextEncoder().encode(JSON.stringify(doc.payload));
  try {
    const pub = await crypto.subtle.importKey('raw', b64url(key),
      { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, b64url(doc.sig), body);
    return ok ? doc.payload : null;
  } catch (e) { return null; }
}

/** Does this look like a signed envelope, whatever it claims to hold? */
function isEnvelope(doc) {
  return !!(doc && typeof doc === 'object' && doc.payload && doc.sig && doc.alg);
}

/**
 * Verify and read a pointer document.
 *
 * FAILS CLOSED at every step. An unverifiable pointer, an unpinned host, a
 * missing key, a stale timestamp: all of them mean "ignore this and keep using
 * what we have", never "trust it anyway". This function decides where every
 * installation sends its reports, so the bias has to run entirely one way.
 */
async function readPointer(url) {
  let doc;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    doc = await res.json();
  } catch (e) { return null; }
  const payload = await verifyEnvelope(doc);
  if (!payload) return null;

  // A signed pointer from six months ago is still signed. Refusing a stale one
  // is what stops somebody who captured an old copy from rolling installs back
  // onto a host that has since changed hands.
  const issued = Date.parse(payload.issuedAt || '');
  if (!Number.isFinite(issued) || Date.now() - issued > 30 * 86400000) return null;

  // Report hosts are PINNED: a valid signature still cannot send reports to a
  // host this build has never heard of. List mirrors are not, because the list
  // is itself signed and that signature is the control -- see lib/pointer.js
  // on the server for the full argument. They must at least be https.
  const pinned = globalThis.CB_POINTER_HOSTS || [];
  const hosts = (payload.hosts || [])
    .map(h => String(h || '').trim())
    .filter(h => pinned.includes(h));
  const listMirrors = (payload.listMirrors || [])
    .map(u => String(u || '').trim())
    .filter(u => /^https:\/\//i.test(u));
  return hosts.length ? { hosts, listMirrors } : null;
}

/** Ask the mirrors, in order, until one verifies. */
async function refreshPointer() {
  const urls = globalThis.CB_POINTER_URLS || [];
  for (const url of urls) {
    const found = await readPointer(url);
    if (found) {
      await setLocal('backendHosts', { hosts: found.hosts, listMirrors: found.listMirrors, at: Date.now() });
      return found.hosts;
    }
  }
  await setLocal('backendHosts', { hosts: null, listMirrors: [], at: Date.now() });
  return null;
}

async function apiBase(settings) {
  const s = settings || await getSettings();
  // Somebody self-hosting has said where their server is; nothing below should
  // second-guess them.
  if (s.apiBase) return s.apiBase.replace(/\/+$/, '');

  // The host this browser last reached. A working answer beats rediscovering
  // one, and it is what carries the extension through a pointer outage.
  const cached = await getLocal('backendHosts', null);
  if (cached && cached.hosts && cached.hosts.length) {
    return 'https://' + cached.hosts[0] + '/v1';
  }
  // Refreshed at most hourly, and never while somebody is waiting on a report:
  // pressing a button should not block on a discovery request.
  if (!cached || (Date.now() - (cached.at || 0)) > POINTER_TTL_MS) {
    refreshPointer().catch(() => {});
  }
  return globalThis.CB_API_BASE || null;
}

/**
 * This host did not answer. Move it to the back and try the next one.
 *
 * Demoted rather than dropped: a host that failed once is far more likely to
 * be having a bad minute than to be gone, and a list that shrinks on every
 * blip ends up empty exactly when it is needed.
 */
async function demoteHost(base) {
  const cached = await getLocal('backendHosts', null);
  if (!cached || !cached.hosts || cached.hosts.length < 2) return;
  const host = (() => { try { return new URL(base).hostname; } catch (e) { return null; } })();
  const i = cached.hosts.indexOf(host);
  if (i < 0) return;
  cached.hosts.push(cached.hosts.splice(i, 1)[0]);
  await setLocal('backendHosts', cached);
}

/** A stable per-install reporter id, so repeat reports from one person count
 *  once rather than inflating a profile's report count. */
/**
 * Who is filing this report.
 *
 * This used to be a UUID minted per installation, which made the identity
 * worthless: clearing extension storage produced a brand new reporter, so one
 * person could raise any report's count without limit. It is now the signed-in
 * platform account, supplied by the content script from the page.
 *
 * The server can no more verify this than we can -- proving a Meta session to a
 * third party needs Meta, and that means their API. What it changes is the cost:
 * inflating a count now takes real accounts, and reputation has something stable
 * to accumulate against. The server hashes it before storing it.
 */
function reporterRef(platform, viewerId) {
  if (!platform || !viewerId) return null;
  if (!ID_RE.test(String(viewerId))) return null;
  return platform + ':' + viewerId;
}


function reportKeyFor(platform, profileId, username) {
  const numeric = /^\d{4,}$/.test(String(profileId || ''));
  return numeric
    ? platform + ':' + profileId
    : platform + ':@' + String(username || '').toLowerCase().replace(/^@/, '');
}

/**
 * Try queued targets again now.
 *
 * A waiting row can be waiting on several different things -- the half-hour
 * cooldown after a dry run, the growing backoff after a failure, or nothing at
 * all -- and asking somebody to work out which before they may press a button
 * is asking them to know how the queue is built. So Retry clears both, for the
 * ids given or for the whole platform, and wakes a tab to act on it.
 *
 * What it does NOT do is touch the gate, the leases or the hourly caps. Those
 * are the pacing that keeps Meta from issuing a checkpoint, and a button that
 * quietly stepped over them would be a button that gets accounts flagged.
 *
 * `promote` is the difference between the two callers. Retrying ONE row is a
 * person pressing a button about that account, so it is marked user-initiated
 * and jumps the queue like any other explicit block. Retry all is a bulk
 * clear: marking everything user-initiated would exempt the entire queue from
 * the two job switches, which is not what anybody means by "try again".
 */
async function retryTargets(platform, ids, promote) {
  if (platform !== 'facebook' && platform !== 'threads') {
    return { ok: false, error: 'unknown platform' };
  }
  const q = await getLocal(KEYS.QUEUE, {});
  const list = (q[platform] || []).map(asEntry);
  const wanted = ids ? new Set(ids.map(String)) : null;
  const targets = list.filter(e => !wanted || wanted.has(e.id));
  if (!targets.length) return { ok: true, cleared: 0, waiting: 0 };

  const cooldowns = await getLocal('cooldowns', {});
  const failures = await getLocal('failures', {});
  let cleared = 0;
  const now = Date.now();
  for (const e of targets) {
    const key = platform + ':' + e.id;
    // "Cleared" counts what was actually waiting, so the confirmation can say
    // something true rather than the number of rows on screen.
    if ((cooldowns[key] && cooldowns[key] > now) || failures[key]) cleared++;
    delete cooldowns[key];
    delete failures[key];
    if (promote) { e.user = true; e.at = now; }
  }
  await setLocal('cooldowns', cooldowns);
  await setLocal('failures', failures);
  if (promote) {
    const byId = new Map(list.map(e => [e.id, e]));
    q[platform] = Array.from(byId.values());
    await setLocal(KEYS.QUEUE, q);
  }
  // Somebody is watching for this. Same nudge an explicit block gets: it cuts
  // a sleep short and changes nothing about the pacing.
  await broadcast(P.SW.WAKE_WORKER, { platform });
  await updateBadge();
  return { ok: true, cleared, waiting: targets.length };
}

/**
 * Remember a block operation's persisted-query id.
 *
 * Meta ships the block mutation lazily and it cannot be pulled by name -- the
 * page only has it once the site's own block dialog has rendered, which on a
 * normal browsing tab never happens. A page that DOES have it reports the
 * doc_id here; from then on every tab can drive the site's Relay network layer
 * with it and block without the module (see blockViaRelayNetwork).
 *
 * Kept per platform, because Facebook and Threads are different operations,
 * and validated the same way the published overrides are: an operation name
 * and a numeric id, nothing else. It is public site metadata, not user data.
 */
async function rememberDocIds(payload) {
  const platform = payload && payload.platform;
  if (platform !== 'facebook' && platform !== 'threads') {
    return { ok: false, error: 'unknown platform' };
  }
  const clean = sanitizeDocIdOverrides(payload && payload.docIds);
  const forget = sanitizeDocIdOverrides(payload && payload.forget);
  const names = Object.keys(clean);
  if (!names.length && !Object.keys(forget).length) return { ok: true, stored: 0, changed: false };

  const all = await getLocal('learnedDocIds', {});
  const before = JSON.stringify(all[platform] || {});
  // Newest wins: a rotation means the id just read off the page is right and
  // the remembered one is stale.
  const next = Object.assign({}, all[platform], clean);
  // Meta rotated away from one this browser remembered, and said so when it
  // was used. Dropped only if the stored value is still the one that failed --
  // a fresher id that arrived in between must survive.
  for (const op of Object.keys(forget)) {
    if (next[op] === forget[op]) delete next[op];
  }
  if (JSON.stringify(next) === before) return { ok: true, stored: names.length, changed: false };
  all[platform] = next;
  await setLocal('learnedDocIds', all);
  return { ok: true, stored: names.length, changed: true };
}

/**
 * Reports that have not reached the server yet.
 *
 * The backend can be unreachable for reasons that have nothing to do with the
 * person filing: it is rate limited, it is being restarted, or -- the case
 * this is really for -- a national ISP has decided it does not care for this
 * domain. Losing somebody's report to any of those would be the worst possible
 * response, because the report is the whole contribution they came to make and
 * they have no way of knowing it evaporated.
 *
 * So a report that cannot be sent is kept and retried. The user may be on
 * mobile data tomorrow, on a different carrier, or travelling; a report queued
 * today can leave next week. That turns a block into a delay rather than a
 * loss, which is the single most valuable thing in the reachability design
 * because it costs almost nothing.
 *
 * A refusal is kept too, which it did not used to be.
 *
 * The old rule was that anything the server refused on its merits was dropped
 * immediately, on the reasoning that a 400 is a report the server will never
 * accept and retrying it forever is a queue that never drains. The reasoning
 * was sound and the consequence was not: the 400s actually being seen were
 * OURS -- a malformed field this extension sent -- and every one of them
 * destroyed somebody's report silently, because a payload the server rejects
 * is exactly the payload nobody has a copy of any more.
 *
 * So a refusal is now kept, retried on the same ladder, and given up on after
 * OUTBOX_MAX_TRIES rather than after one. A queue that never drains is still
 * not acceptable, so the bound stays -- what changed is that reaching it is
 * SAID OUT LOUD, through the same alert channel and badge a failed block uses,
 * instead of the report simply ceasing to exist.
 */
const OUTBOX = 'reportOutbox';
const OUTBOX_MAX = 200;
const OUTBOX_LADDER_MS = [60000, 300000, 1800000, 3 * 3600000, 12 * 3600000];
// Six attempts spread across the ladder is a day and a half. Past that it is
// not a transient failure any more.
const OUTBOX_MAX_TRIES = 6;

async function outboxAdd(payload, why) {
  const box = await getLocal(OUTBOX, []);
  // reportKeyFor, not the id alone.
  //
  // The id alone was 'threads:' for EVERY target whose numeric id had not been
  // resolved -- one key shared by all of them -- so the de-duplication two
  // lines down threw away every id-less report after the first. That is a
  // second, independent way the same Threads profiles went missing, and it
  // would have survived fixing the first one. reportKeyFor already falls back
  // to the username, and is what reportStatus() looks up by.
  const key = reportKeyFor(payload.platform, payload.profileId, payload.username);
  if (box.some(e => e.key === key)) return;      // one attempt per target
  box.push({ key, payload, tries: 0, at: Date.now(), nextAt: Date.now() + OUTBOX_LADDER_MS[0], why });
  // Oldest first out, so a browser left open for a month does not grow without
  // limit. Losing the oldest is the least bad thing to lose.
  while (box.length > OUTBOX_MAX) box.shift();
  await setLocal(OUTBOX, box);
  await updateBadge();
}

/**
 * Try the outbox. Called on the refresh alarm, so it rides an existing wakeup
 * rather than holding one of its own.
 */
async function flushOutbox() {
  const box = await getLocal(OUTBOX, []);
  if (!box.length) return { ok: true, sent: 0, waiting: 0 };
  const now = Date.now();
  const keep = [];
  let sent = 0;
  for (const e of box) {
    if (e.nextAt > now) { keep.push(e); continue; }
    const out = await submitReport(e.payload, { noQueue: true });
    if (out.ok) { sent++; await clearAlert(e.key); continue; }
    e.tries++;
    // Given up on -- and said so. The person asked for this and it did not
    // happen, which is precisely what the alert channel and the red badge
    // exist for; dropping it quietly is what made the original bug invisible.
    if (e.tries >= OUTBOX_MAX_TRIES) {
      await noteAlert(e.key, out.error || T('sw_reportRefused'), 'report');
      continue;
    }
    e.nextAt = now + OUTBOX_LADDER_MS[Math.min(e.tries, OUTBOX_LADDER_MS.length - 1)];
    keep.push(e);
  }
  await setLocal(OUTBOX, keep);
  await updateBadge();
  return { ok: true, sent, waiting: keep.length };
}

async function submitReport(payload, opts) {
  const settings = await getSettings();
  const base = await apiBase(settings);
  if (!base) return { ok: false, error: T('sw_noServer') };
  if (!(await hasHostPermission(base + '/'))) {
    return { ok: false, needsPermission: true, error: T('sw_noReportPermission') };
  }

  // Refused here as well as at the server. Sending it anyway would only earn a
  // 401, and the person deserves to be told what is actually wrong.
  const reporter = reporterRef(payload.platform, payload.viewerId);
  if (!reporter) {
    return { ok: false, signedOut: true,
             error: T('sw_signInBefore', payload.platform === 'facebook' ? 'Facebook' : 'Threads') };
  }

  // HASHED HERE, and this is not optional.
  //
  // reporterRef() is `platform:accountId` -- the raw viewer id. It exists so
  // this browser can key its own local records by it. What leaves the machine
  // is an HMAC of it under a secret this install minted for itself and never
  // sends, so nothing outside this browser can compute this browser's
  // pseudonym, and a copy of the report store cannot be turned back into a
  // list of who reported whom. PRIVACY.md says exactly that; this line is
  // where it is either true or false.
  const pseudonym = await reporterPseudonym(reporter);

  // Nothing to file against. With the username fallback in targetIdFor() this
  // needs BOTH the id and the handle to be missing, which means the page never
  // identified the account at all -- so there is no report to send and no
  // amount of retrying will invent one. Refused here rather than sent to earn
  // a 400, and surfaced rather than returned into a void: the caller fires
  // this without awaiting it, so a return value nobody reads is the same as
  // silence, and silence is what this whole change is about.
  if (!targetIdFor(payload)) {
    await noteAlert(reportKeyFor(payload.platform, payload.profileId, payload.username),
                    T('sw_reportNoTarget'), 'report');
    return { ok: false, error: T('sw_reportNoTarget') };
  }

  const ctx = settings.shareRegion === false ? {} : clientContext();
  const body = {
    // The server's vocabulary, not the old store's. `pseudonym` is the same
    // HMAC under the same per-install secret it always was -- what changed is
    // that dedup is now the server's unique index rather than a document id
    // derived from it, which is what closes the existence oracle this used to
    // carry (docs/SECURITY-REVIEW.md 2.3).
    pseudonym,
    platform: payload.platform,
    targetId: targetIdFor(payload),
    // Normalised, not just clipped: '@Fake.Person' and 'fake.person' are the
    // same account, and two spellings of one target would otherwise be two
    // rows the moderator has to reconcile.
    targetUser: payload.username ? normUsername(payload.username).slice(0, 64) : undefined,
    // CLIPPED HERE, not just validated there. The server's schema rejects an
    // over-long field rather than trimming it, because a server that silently
    // rewrites what it was sent is a server nobody can reason about -- which
    // means an unusually long display name would cost the whole report if the
    // client sent it raw. The caps match the server's exactly.
    targetName: payload.displayName ? String(payload.displayName).slice(0, 120) : undefined,
    targetUrl: payload.url ? String(payload.url).slice(0, 400) : undefined,
    reason: payload.reason || 'clone',
    note: String(payload.note || '').slice(0, 2000),
    quote: payload.contentSummary
      ? String(payload.contentSummary).slice(0, 600) : undefined,
    evidence: [payload.postUrl].filter(Boolean).map(u => String(u).slice(0, 400)),
    // Coarse origin, optional, and governed by the same switch as before. The
    // server additionally records the country Cloudflare resolved at the edge,
    // which is not something this browser can decline -- PRIVACY.md says so
    // plainly rather than leaving it to be discovered.
    tz: ctx.region || undefined,
    lang: ctx.lang || undefined
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const headers = { 'content-type': 'application/json' };
  if (settings.submitToken) headers.authorization = 'Bearer ' + settings.submitToken;

  let res, json = null;
  try {
    res = await fetch(base + '/reports', { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 429 || res.status === 503) {
      // Rate limited or intake closed. Not a failure the person caused, and
      // not something to lose the report over.
      if (!(opts && opts.noQueue)) {
        await outboxAdd(payload, 'busy');
        return { ok: true, queued: true,
                 key: reportKeyFor(payload.platform, payload.profileId, payload.username),
                 status: 'queued', error: T('sw_reportBusy') };
      }
      return { ok: false, retryable: true, error: T('sw_reportBusy') };
    }
    json = await res.json();
  } catch (e) {
    // Unreachable rather than refused: keep it and say so.
    if (!(opts && opts.noQueue)) {
      // Unreachable is the signal the pointer exists for: try the next host
      // next time rather than the one that just failed.
      await demoteHost(base);
      await outboxAdd(payload, 'unreachable');
      return { ok: true, queued: true,
               key: reportKeyFor(payload.platform, payload.profileId, payload.username),
               status: 'queued', error: T('sw_reportQueued') };
    }
    return { ok: false, retryable: true, error: T('sw_serverUnreachable', (e && e.message) || e) };
  }
  if (!res.ok || !json || !json.ok) {
    if (json && json.error === 'signed-out') {
      return { ok: false, signedOut: true, error: json.message || T('sw_signInGeneric') };
    }
    // THIS is where every lost report went.
    //
    // It used to return here with the payload held nowhere: the sheet had
    // already said "Sent", the caller does not await the result, and the
    // outbox was only ever written on a 429/503 or a thrown fetch. A 400 --
    // which is what an empty targetId earned, on every Threads profile whose
    // numeric id had not been learned -- ended the report's existence.
    //
    // Now it is kept. Whether it is worth retrying is decided by the outbox,
    // which is the only place that can see how many times it has already
    // failed; what must not be decided here is that the report stops existing
    // because one response was not the one expected.
    const err = (json && json.error) || T('sw_serverHttp', res.status);
    if (!(opts && opts.noQueue)) {
      await outboxAdd(payload, 'refused:' + res.status);
      return { ok: true, queued: true,
               key: reportKeyFor(payload.platform, payload.profileId, payload.username),
               status: 'queued', error: err };
    }
    return { ok: false, status: res.status, error: err };
  }

  // The same key reportStatus() reads by.
  //
  // This was the id alone, so a report filed against a username was cached
  // under 'threads:' while the chip looked it up as 'threads:@handle' -- and
  // the profile a person had just reported went on saying nothing had
  // happened. One scheme, in one function, used by both.
  const key = reportKeyFor(payload.platform, payload.profileId, payload.username);
  const cache = await getLocal(KEYS.REPORTED, {});
  const prev = cache[key] || {};
  cache[key] = {
    status: json.held ? 'held' : 'pending',
    count: 1,
    // CARRIED, not reset. This was a hardcoded false, which downgraded a
    // known-blocked account to unblocked for the ten minutes this cache
    // lives -- so reporting an account that was already on the list made the
    // chip on that profile stop saying "Blocked", which reads as the report
    // having undone something.
    blocked: prev.blocked === true,
    // Whether THIS browser has filed against this target, kept apart from
    // `status` because status becomes 'approved' once the account is on the
    // list and that answers a different question. The sheet needs this one:
    // "is it blocked" and "did you report it" have different consequences for
    // whether sending again is worth anything.
    mine: true,
    // What the server actually did with it. The dedup rule is one report per
    // pseudonym per target, so a repeat comes back 200 with duplicate: true
    // and NOTHING IS WRITTEN. This flag was already on the wire and nothing
    // read it, so a discarded report was cached as an ordinary pending one --
    // which is how a report that never existed came to look exactly like a
    // report that landed.
    duplicate: !!json.duplicate,
    at: Date.now()
  };
  await setLocal(KEYS.REPORTED, cache);

  return { ok: true, key, status: json.held ? 'held' : 'pending',
           count: 1, mine: true, duplicate: !!json.duplicate };
}

const STATUS_TTL_MS = 10 * 60 * 1000;

async function reportStatus(q, force) {
  const key = reportKeyFor(q.platform, q.profileId, q.username);
  const cache = await getLocal(KEYS.REPORTED, {});
  const hit = cache[key];
  if (!force && hit && (Date.now() - hit.at) < STATUS_TTL_MS) {
    return { ok: true, key, cached: true, status: hit.status, count: hit.count,
             blocked: hit.blocked, mine: hit.mine === true,
             duplicate: hit.duplicate === true };
  }

  // Two different questions, answered from two different places, and neither
  // of them is "has anyone reported this account" -- that question was a
  // deanonymisation primitive when the old store could answer it, and nothing
  // here can any more.
  //
  //   BLOCKED  is membership of the published list, which this browser already
  //            holds. It needs no network, no server and no account: someone
  //            who is not signed in can still be told that an account is on
  //            the list, and making them sign in to learn a published fact
  //            would be absurd.
  //   PENDING  is what THIS browser reported and has not seen land. Local
  //            first; the server is asked only to refresh it, and only ever
  //            about our own pseudonym.
  const listRec = await getLocal(KEYS.BLOCKLIST, null);
  const pid = String(q.profileId || '');
  const uname = normUsername(q.username);
  const blocked = !!(listRec && (((listRec.ids || []).includes(pid)) ||
                                 (uname && (listRec.usernames || []).includes(uname))));

  const base = await apiBase();
  const reporter = reporterRef(q.platform, q.viewerId);
  const localStatus = blocked ? 'approved' : (hit ? hit.status || 'pending' : null);

  // Nothing to ask, or nobody to ask as: the local answer is the answer.
  if (!base || !reporter || !(await hasHostPermission(base + '/'))) {
    return { ok: true, key, status: localStatus, count: hit ? hit.count || 0 : 0,
             blocked, mine: !!(hit && hit.mine), duplicate: !!(hit && hit.duplicate) };
  }

  // The same hashed value the report was filed under -- asking with the raw
  // reference would put on the wire the one thing that is never supposed to
  // reach a server.
  const pseudonym = await reporterPseudonym(reporter);

  let json = null;
  try {
    const res = await fetch(base + '/reports/status?pseudonym=' + encodeURIComponent(pseudonym));
    json = await res.json();
  } catch (e) {
    // A lookup failure must never stop someone reporting, and must never
    // downgrade a fact we already hold.
    return { ok: true, key, status: localStatus, count: hit ? hit.count || 0 : 0,
             blocked, mine: !!(hit && hit.mine), duplicate: !!(hit && hit.duplicate),
             offline: true };
  }
  const mine = ((json && json.reports) || [])
    .find(r => r.platform === q.platform && String(r.id) === pid);
  const rec = { status: blocked ? 'approved' : (mine ? mine.status : localStatus),
                count: mine ? 1 : (hit ? hit.count || 0 : 0),
                blocked,
                // The server answering about our own pseudonym is proof this
                // browser reported it; so is a local record from a previous
                // submit. Either is enough, and neither may erase the other --
                // the server forgets a report once the case is decided, and
                // that must not turn into "you never reported this".
                mine: !!(mine || (hit && hit.mine)),
                duplicate: !!(hit && hit.duplicate),
                at: Date.now() };
  cache[key] = rec;
  await setLocal(KEYS.REPORTED, cache);
  return { ok: true, key, status: rec.status, count: rec.count, blocked: rec.blocked,
           mine: rec.mine, duplicate: rec.duplicate };
}

