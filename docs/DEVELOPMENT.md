# Development

Running the tests, what each one covers, and how a release is built.

*Part of [Clone Blocker](../README.md). See also: [how blocking works](BLOCKING.md) · [ranking](RANKING.md) · [architecture](ARCHITECTURE.md) · [development](DEVELOPMENT.md) · [research](RESEARCH.md)*

---

### Testing

```bash
node tools/check.js            # static: syntax, manifest refs, MV3 CSP, locales
node tools/queue-test.js       # block queue + rate limiter (mocked chrome.*)
node tools/firebase-test.js    # security-rules matrix + ported logic, emulator
node tools/e2e-test.js         # hiding + Relay discovery, browser
node tools/dashboard-visual.js # the dashboard, rendered against fixtures
npm test                       # the first four
```

`check.js` also holds the rules that keep vocabulary from drifting back: the
retired "Layer 1 / Layer 2" framing fails the build if it reappears in anything
a user can read; so does the `mode` setting the two switches replaced — nothing
under `src/` may read it, compare against `'passive'` or `'active'` or call
`CB_MODE_OF` except the two back-compat readers that keep old installs working,
and no page may hardcode either word or keep the radio buttons that wrote it.
The locale checks fail the build if the two message files disagree. Those are key parity in both directions, a non-empty message and a
non-empty description on every key, matching `$1` placeholders across languages,
every key the UI asks for existing in `en` — and no user-visible text anywhere in
a page's markup outside a `data-i18n` element, so a string added later cannot
quietly skip translation.

`npm --prefix server test` runs the backend's own suite against a throwaway
SQLite file — no network and no container. The tests that matter there are
about abuse: that one address cannot mint unlimited pseudonyms, that
`X-Forwarded-For` is never believed, that IPv6 buckets to a `/64`, that no
column and no value in a report row can hold an address, and that a tampered
pointer does not verify.

It also holds the public view to its promises against the **serialised bytes**
rather than the intent: that nothing unapproved or un-opted-in appears, that a
search of the whole published JSON finds no `acct_` anywhere, that evidence
without an https link is dropped while a summary behind one survives, that notes
never appear and regions appear without their counts — and that `current` and
`publicView` move together.

`queue-test.js` drives the real service-worker message handler against a mocked
`chrome.*`, covering the block queue, leases and rate limiter — logic the
browser test deliberately never exercises, because it must never block anyone for
real. It verifies that a failing target backs off instead of starving the queue,
that failed *attempts* (not just successes) count toward the caps, that dry runs
rotate without consuming the limit, and that two tabs cannot claim the same
target. It also covers the tag filter — that `blockTags` gates both cold seeding
and warm enqueue, that an unticked tag is skipped in both, that an
untagged id counts as `other`, and that the popup's user-initiated **Block now**
goes through regardless — and that both rankers read the published weights the
same way, at the defaults and at tuned values.

The two switches get all four combinations, driven end to end through a real
refresh for the cold side and a real enqueue for the warm one: `blockSeen` off
with `blockFromList` on (the pair the old radio could not express), the
converse, both, and neither — with **Block now** still going through when
neither is ticked, because pressing a button is a decision rather than a sweep.
Installs written before the pair existed are held to their old behaviour: `mode:
'passive'`, and the older `acceptServerTargets: false`, each still refuse cold
work while still blocking what turns up on screen. The pacing gate gets the
cases a single tab cannot show: five simultaneous claims yield one block, a
block in flight on Threads holds a Facebook tab back too, the pause after a
result is the warm delay rather than the lease, and a tab that dies mid-block
wedges the queue only until its lease expires.

`e2e-test.js` loads the extension into real Chrome and exercises it against live
`threads.com` and `facebook.com`: manifest load, service-worker boot, a list
fetch from a seeded Firestore emulator, bridge handshake, module hook, Relay
discovery, that content from a listed profile is genuinely hidden, and that the
service worker derives its ranked targets locally from the published metadata.
It asserts that **no real block is attempted**.

Current status — **26/26 browser · 90/90 queue · 132/132 firebase · static
clean**, and `dashboard-visual.js` green. A sample of the browser run:

```
PASS  extension service worker started
PASS  blocklist fetched + parsed by service worker      — 1 ids, 1 usernames
PASS  MAIN world hooked Meta module registry            — 4869 modules, 578 graphql
PASS  live Relay environment discovered                 — BarcelonaRelayEnvironment, 593 records
PASS  Relay commitMutation available
PASS  MAIN world request/response round-trip resolves   — 1ms
PASS  content from blocklisted profile is hidden        — 20 hidden, 0 visible
PASS  judged by authorship, not by being mentioned      — mention post stays visible
PASS  the blocked profile's own nested comment is hidden
PASS  placeholder hide mode applies after settings change — 20 placeholders
PASS  disabling hiding restores all content              — 0 hidden, 0 leftover
PASS  no real block was attempted (safety)
PASS  facebook: MAIN world hooked module registry       — 2728 modules, 33 graphql
PASS  facebook: Relay environment reachable             — CometRelayEnvironment
```

Note: current Chrome builds ignore the `--load-extension` switch, so the harness loads the
extension over CDP (`Extensions.loadUnpacked`). Loading unpacked via `chrome://extensions`
in normal use is unaffected.

---

### Verified against a live signed-in account

Real blocking was tested end to end on a real Threads account:

- **Blocking works** via `RelayModern.commitMutation` driven with Threads' own
  operation node (`useTHUserBlockMutation`, `POST /api/graphql`). The block took
  effect and the session survived.
- **Raw request fallbacks are off by default and should stay off.** Hand-built
  CSRF-bearing POSTs to the Instagram REST paths 404 on threads.com *and*
  coincided with Meta invalidating the signed-in session, twice. Driving the
  site's own code never did. See [`docs/RESEARCH.md`](RESEARCH.md).
- **One constraint:** the block module is lazily loaded, so it is only reachable
  after the block UI has been opened once in that page load. `Bootloader` and
  `requireLazy` cannot force it.

---

### Publishing to the Chrome Web Store

Everything the listing needs is generated and reproducible:

```
npm run store-assets       # icons, promo tiles, marquee, screenshots -> store/
```

The icons are drawn from distance fields with no dependencies, so they stay
crisp at 16px instead of being a downscaled bitmap. The promo tiles and
screenshots are laid out in HTML and captured at their exact pixel size, and
the screenshots of the extension's own pages are genuine captures from a
browser with it loaded rather than mockups.

**[docs/CHROME-WEB-STORE.md](CHROME-WEB-STORE.md)** has the rest: the
current requirements with sources, the listing copy ready to paste, permission
justifications, the data-collection disclosures, reviewer notes, a
pre-submission checklist — and an honest read on where this could be rejected,
including the parts that cannot be engineered away.

[PRIVACY.md](../PRIVACY.md) is the privacy policy the store requires, and its
claims are checkable against the source: the only outbound requests in the
extension go to the two Meta origins and the one baked-in list address.

---
