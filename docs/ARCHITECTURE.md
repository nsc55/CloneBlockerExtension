# Architecture

How the pieces fit together, where each file lives, and two design decisions
that took more than one attempt to get right.

*Part of [Clone Blocker](../README.md). See also: [how blocking works](BLOCKING.md) · [ranking](RANKING.md) · [architecture](ARCHITECTURE.md) · [development](DEVELOPMENT.md) · [research](RESEARCH.md)*

---

### Architecture

```
  blocklist.json (or any JSON URL)
          │  (fetch: service worker only — page CSP blocks it anywhere else)
          ▼
┌─────────────────────┐
│   service worker    │  blocklist cache · ETag · alarms
│                     │  block queue · leases · rate limiter
└──────────┬──────────┘
           │ chrome.runtime
┌──────────▼──────────┐
│  ISOLATED content   │  chrome.* APIs · DOM suppression · id index
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
| `src/content/identity.js` | Blocklist index, id↔username alias cache |
| `src/content/dom-blocker.js` | Selector engine + MutationObserver |
| `src/content/main.js` | Orchestration, Relay store sweep, block worker |
| `src/background/service-worker.js` | List fetch, local target ranking, queue, rate limiter, alarms |

---

### Layout

```
manifest.json
_locales/  en/ vi/         messages.json each; the store name and description too
src/  main/ content/ background/ popup/ options/ activity/ common/ ui/
src/common/i18n.js        CB_T and the data-i18n sweep, loaded before everything
server/                   the backend: Fastify, SQLite, migrations, tests
server/src/ratelimit.js   the abuse layer -- read the header comment first
server/src/lib/ip.js      real client IP, /64 bucketing, the rotating salt
server/src/lib/pointer.js the signed backend pointer, and its keygen
server/src/routes/        reports (public), admin, static artifacts, the site
shared/logic.js           pure compute shared by the server, the dashboard and the tests
deploy/                   Dockerfile, compose, the nginx vhost, deploy.sh
hosting/index.html        the product landing page (the site root, vi/en)
hosting/list.html         the public transparency page, served at /list
hosting/privacy.html      the served privacy policy, /privacy — with tos.html and faq.html beside it
hosting/docs.js           the static pages' language toggle; docs.css their typography
hosting/public.js         the register's fetch and rendering — textContent only, no strings
hosting/public.css
hosting/i18n.js           CB_T again, over a plain dictionary, for the hosted pages
hosting/admin/            the moderation dashboard, served at /admin/ (English)
tools/check.js            static checks, including locale parity
tools/e2e-test.js         end-to-end browser test
tools/dashboard-visual.js the dashboard, driven against a real server instance
tools/make-icons.js       dependency-free PNG generation
tools/make-store-assets.js  listing tiles and screenshots, at exact sizes
docs/RESEARCH.md          internals findings, with what is and isn't verified
docs/FIREBASE-SPEC.md     the migration contract, formula by formula
docs/PHASE23-SPEC.md      tags and the ranking dials, normative
docs/PHASE45-SPEC.md      the public page and Google sign-in, normative
docs/PHASE6-SPEC.md       English and Vietnamese, normative
docs/CHROME-WEB-STORE.md  store requirements, listing copy, rejection risks
docs/ROADMAP.md           what was built, phase by phase, and what is still open
store/                    generated listing assets
PRIVACY.md                privacy policy (required by the store)
```

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
