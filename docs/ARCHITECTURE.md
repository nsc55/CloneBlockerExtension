# Architecture

How the pieces fit together, where each file lives, and two design decisions
that took more than one attempt to get right.

*Part of [Clone Blocker](../README.md). See also: [how blocking works](BLOCKING.md) · [ranking](RANKING.md) · [architecture](ARCHITECTURE.md) · [development](DEVELOPMENT.md) · [research](RESEARCH.md)*

---

### Architecture

```
  signed v3 root + content-addressed objects
  (raw / jsDelivr / relay / origin — or a self-hosted list)
          │  (fetch: service worker only — page CSP blocks it anywhere else)
          ▼
┌─────────────────────┐
│   service worker    │  IndexedDB rows/chunks/meta · incremental sync · batched lookup · alarms
│                     │  block queue · leases · rate limiter
└──────────┬──────────┘
           │ chrome.runtime
┌──────────▼──────────┐
│  ISOLATED content   │  chrome.* APIs · DOM suppression · verdict cache
│    scripts          │
└──────────┬──────────┘
           │ window.postMessage  (worlds cannot share objects)
┌──────────▼──────────┐
│  MAIN world script  │  __d hook · require() · Relay env + store
│  (document_start)   │  React fibers · commitMutation · request capture
└─────────────────────┘
```

The split is forced by the platform: MAIN-world scripts get **no `chrome.*` APIs**, and
isolated-world scripts cannot see the page's `require`, its Relay store, or React's
expando properties on DOM nodes.

| File | Role |
|---|---|
| `src/common/i18n.js` | `CB_T` over `chrome.i18n`, and the `data-i18n` sweep every page runs |
| `src/main/inject.js` | Module-registry hook, tokens, Relay, block strategies, request capture |
| `src/content/bridge.js` | MAIN ↔ ISOLATED ↔ service-worker messaging |
| `src/content/identity.js` | Per-tab verdict cache + id↔username alias cache |
| `src/content/dom-blocker.js` | Selector engine + MutationObserver |
| `src/content/main.js` | Orchestration, Relay store sweep, block worker |
| `src/background/service-worker.js` | IndexedDB list store, chunk sync, local target ranking, queue, rate limiter, alarms |
| `src/background/list-store.js` | The list database: schema, per-bucket commit, batched lookup |
| `src/background/list-sync.js` | The v3 walk: root, plan, install, sweep, extras, commit |
| `src/background/envelope.js` | Signed-envelope verification against the compiled key, shared by the pointer, the legacy list and the v3 root |

---

### Layout

```
manifest.json
_locales/  en/ vi/         messages.json each; the store name and description too
src/  main/ content/ background/ popup/ options/ activity/ welcome/ common/ ui/
src/common/i18n.js        CB_T and the data-i18n sweep, loaded before everything
src/common/protocol.js    message names, storage keys, the compiled hosts and key, the list-database constants
src/common/listview.js    search, sort and paging for the activity page's two lists
src/background/service-worker.js  refresh, ranking, the queue and its pacing, the message handler
src/background/list-store.js      the list database in IndexedDB -- see below
src/background/list-sync.js       the chunked-list walk: root, plan, install, sweep, extras, commit
src/background/envelope.js        signed-envelope verification against the compiled key
tools/check.js            static checks, including locale parity and every doc link
tools/queue-test.js       the service worker against a mocked chrome.*, list sync included
tools/inject-test.js      the MAIN-world script in a vm, against a fake Relay
tools/list-sync-test.js   the walk against a synthetic v3 tree
tools/e2e-test.js         end-to-end browser test
tools/lib/                harness helpers: the Map-backed list store and the v3 fixture builder
tools/make-icons.js       dependency-free PNG generation
tools/make-store-assets.js  listing tiles and screenshots, at exact sizes
docs/BLOCKING.md          what a block is and how the site's own code is driven
docs/RANKING.md           whom to block first, and the published dials
docs/DEVELOPMENT.md       the tests, self-hosting a list, the release
docs/RESEARCH.md          internals findings, with what is and isn't verified
docs/CHROME-WEB-STORE.md  store requirements, listing copy, rejection risks
store/                    generated listing assets
PRIVACY.md                privacy policy (required by the store)
CHANGELOG.md              what changed, for people who use it
```

The backend — Fastify, SQLite, the publisher, the hosted pages and the
moderation dashboard — is a repository of its own, `CloneBlockerBackend`. Its
`docs/BACKEND.md` is the source of truth for the list format the worker reads;
`server/src/lib/publish-v3.js` there is the code that writes it.

### The list database

The blocklist was one JSON file. Every install downloaded it, verified the
signature over it and parsed it whole; `chrome.storage.local` held its arrays;
every open tab rebuilt a `Set` of every id and every username on load. That
stopped scaling at about 1,700 accounts — the Android client's bounded reader
refused the file first, and the whole-file design here was heading the same
way, where a list of millions would have meant a multi-megabyte download on
every change and a copy of it in every tab.

So the service worker keeps the list in a database of its own, `cb-blocklist`
in IndexedDB (`src/background/list-store.js`; the name and version are
constants in `src/common/protocol.js`, because the harnesses and the extension
pages open the same database):

| store | key | holds |
|---|---|---|
| `meta` | `root` · `extras` · `counts` | the last *fully committed* signed root; the verified extras object (targets metadata, manual entries), cached whole; the tallies every page prints |
| `groups` | `platform:j` | the verified group tables, content and all |
| `chunks` | `platform:k:bucket` | one record per *committed* bucket: its sha, row count, byte count |
| `rows` | `platform:id`, `platform:@username`, `*:…` for manual and legacy entries | one row per listed entry, with `byUname` and `byChunk` indexes |

The server publishes the list as a small signed root that names, per platform,
`2^g` group tables, each naming `2^(k-g)` chunks by the SHA-256 of their bytes.
A refresh (`src/background/list-sync.js`) fetches the root, verifies it against
the compiled key, and *plans*: a bucket whose sha in the chunks store already
equals the sha the root names is done; everything else is fetched, verified by
hash before it is parsed, and installed **one bucket per transaction** — delete
the bucket's old rows through the `byChunk` index, put the new rows, put the
chunk record. There is no staging store and no progress record on purpose: the
transaction either lands or it does not, so a worker Chrome kills mid-walk
leaves the previous bucket in place, and the next alarm plans from the chunks
store and continues, fetching nothing it already committed. The root itself is
written to `meta` last, so the anti-rollback and "unchanged" comparisons are
always against a complete list. Memory is bounded by one object and one
bucket's rows, never by the list. A self-hosted whole-file list goes into the
same store, wholesale, with its rows tagged `legacy`.

Tabs hold none of it. A content script batches the ids and usernames on screen
into one `sw:blocklist-lookup`; the worker answers from a single readonly
transaction with the positives only; the tab keeps a small verdict cache keyed
by the list's generation and drops it when `sw:blocklist-updated` says the
generation moved. The `id ↔ username` alias cache in `identity.js` is unchanged.

One rule is stated in the sync code because it is what the privacy policy
promises: the set of objects fetched is a pure function of the committed chunks
store and the new root. No lookup, no page and no profile ever causes a fetch,
so what a mirror sees is which parts of the list changed, never what anyone
looked at.

### English is not a structure

Two features were dead for anybody whose Facebook or Threads is not in English —
silently, and for the users this deployment is actually for.

- The in-post **report button** on Threads was anchored by finding the control whose
  `aria-label` reads "Share". On a Vietnamese account that label is "Chia sẻ", nothing
  matched, and `injectThreadButtons` added nothing at all. No error, no button.
- **Facebook comment hiding** matched `div[aria-label^="Comment by"]`. In Vietnamese that
  is "Bình luận của", so a blocked profile's comments stayed visible under everyone
  else's posts while their own posts vanished — which reads as a broken block.

Both now key on **structure**, which is the same in every language, and keep the English
forms only as a fast path. A comment is an article nested inside an article. An action row
is a run of three or more icon-only buttons with almost no text of its own; the report
control goes after the last of them, which is where matching "Share" would have put it.

Checked by running the shipped content scripts against synthetic English and Vietnamese
posts in a headless browser: the action row is found as "Share" and as "Chia sẻ", and the
comment selector matches 2 of 2 rather than 1 of 2.

### The invisible chip that ate clicks

Worth writing down, because the fault was invisible to every kind of test that
does not run in a browser.

The hover chip — the small "report this" pill that appears above a profile link — is
`position: fixed` at `z-index: 2147483647`, inside a shadow root in somebody else's page.
It was hidden by fading to `opacity: 0`. **Opacity 0 paints nothing and blocks
everything.** So from the first time it was ever shown, a 59×24 rectangle sat wherever
that chip had last been, on top of the entire page, for the life of the tab — swallowing
clicks and opening the report sheet for whichever profile had been hovered before.

On Threads that showed up as *clicking Like sometimes opens the report modal*. Measured in
a signed-in browser, hovering a profile link then moving away:

```
after moving away:  shown:false  opacity:"0"  pointerEvents:"auto"
                    rect 59x24 at (769,137)
                    element at that point: THE EXTENSION HOST
```

The cure is `pointer-events: none` on the hidden state and `auto` on `.show` — one line,
verified the same way (`element at that point: span`, the page's own content). Three other
things went with it: the chip now forgets its identity when it hides, so nothing can
report the previously-hovered account; its click handler ignores clicks that arrive while
it is hidden; and it hides on scroll, since its coordinates are measured once and a fixed
element drifts over unrelated controls the moment the page moves.

Guarded twice, because the markup, the handlers and the JavaScript were all correct while
this was broken: `tools/check.js` holds the two CSS declarations, and `npm run
test:browser` raises a real chip in a real page and asserts that the point at its centre
belongs to the page once it is hidden.
