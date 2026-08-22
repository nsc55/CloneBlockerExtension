# How blocking actually works

The mechanics behind the two switches: what a block is, which identifier it
uses, how the site's own code is driven, and what happens when nobody is
browsing.

*Part of [Clone Blocker](../README.md). See also: [how blocking works](BLOCKING.md) · [ranking](RANKING.md) · [architecture](ARCHITECTURE.md) · [development](DEVELOPMENT.md) · [research](RESEARCH.md)*

---

### The lazily-loaded block module, and why it no longer stops anything

Meta ships the block mutation lazily, and it is genuinely unreachable by name. Measured
against a live signed-in page on 22 August 2026: `requireDeferred` and `JSResource` are
not globals at all, and `Bootloader.loadModules`, `requireLazy` and the
`SecuredActionBlockDialog` entrypoint's own `root.load()` each return without ever
defining it — the loader needs a resource map that only ships with the component that
renders it. Framing a profile in a hidden iframe is out too (`X-Frame-Options: DENY`).
Opening a profile's "..." menu loads the menu option and the *unblock* hook and nothing
else; the mutation arrives only with the confirmation dialog behind the menu's Block
item.

So the extension stopped needing it. **Relay's network layer takes plain request
parameters** — `{id, name, operationKind}`, where `id` is the persisted-query doc_id —
and composes the request itself: its endpoint, its `fb_dtsg` and `lsd`, its headers.
Verified twice against the live site: a real query executed from parameters built out of
nothing but a doc_id returned data, and the block mutation itself, aimed at `user_id: "0"`
(an id no account can have), was accepted and executed — it came back with the server's
own validation error, `blocked is None`, and the session survived. That is the whole
question answered: doc_id, parameters and session are accepted for the mutation, and the
only reason nobody was blocked is that there was nobody to block.

This is not the hand-built fallback, which composes the request itself, guesses headers,
and was observed invalidating the session. That one is still off by default. This one asks
the site's own code to compose the request, so it is on by default.

**Where the doc_id comes from**, best first:

| source | how it gets there |
|---|---|
| `module` | read off an operation node the page has loaded — verified this page load |
| `learned` | this browser saw the module once, or a block actually succeeded with it; remembered in `learnedDocIds` and replayed into every later page |
| `supplied` | published with the blocklist. **Dashboard → Block operation.** One save fixes every install, including ones that have never seen the site's block dialog |
| `captured` | watched leaving this browser in a real block request |

A doc_id the site rejects is forgotten rather than retried against every future target,
and one that carries a real block is pinned so it leads next time. The ids rotate: when
blocking stops working everywhere at once, the dashboard card is the first thing to check.

If nothing at all is available — a fresh install whose list carries no id, on a tab that
has never opened the dialog — the worker says so and stands aside for five minutes
without charging the target for it. Five ordinary failures abandon a target for good; a
tab parked on the feed for twenty minutes used to be enough to do that to a good one.

### Why IDs *and* usernames

Facebook rarely puts a numeric profile ID in the DOM — vanity URLs render as
`facebook.com/someone` with nothing else to key on.

The extension solves this by sweeping Meta's Relay store, which holds `id ↔ username`
pairs for everything on screen, and caching that mapping in `chrome.storage`. So a list
expressed purely in numeric IDs still matches a page that only shows usernames, and vice
versa. The mapping improves the more you browse.

Numeric IDs are still the better key: they survive a username change.

---

### Authorship, not mentions

A blocked profile appearing *inside* someone else's post — a comment, a tag, a
"X shared this" — does not take that post down. Only what they actually wrote is
hidden: their own posts, and their own comments wherever those appear.

This matters more than it sounds. Harvesting every link in a story is the easy
implementation, and it makes a blocker feel broken: one blocked person commenting
on a friend's photo would erase the friend's photo. Author extraction is scoped to
the byline (headings/`<strong>` next to the avatar) and excludes anything inside a
nested comment subtree, on both the DOM and Relay paths.

---

### Working the queue when nobody is browsing (experimental)

Blocking drives the sites' own code, and that code only exists inside an open tab. So an
approved account waits for the person to visit Facebook or Threads — which is exactly
what the queue exists to avoid.

The tempting fix is to send the block from the service worker. That works further than
you would expect: **the worker's `fetch` is authenticated**. Measured against a live
session — the same URL fetched from the page, the worker and an extension page came back
at 492,763 / 492,767 / 492,890 bytes, all three carrying the viewer's own account id — so
host permissions plus `credentials: 'include'` are enough, and one GET yields a fresh
`fb_dtsg` and `lsd` (they differ per response; `csrftoken` is the cookie and is stable).
Everything a block needs, with no tab and no user.

**It is still the wrong way to do it.** A POST built in the worker is a hand-built
request — no Relay, and none of the per-build `__dyn` / `__csr` / `__spin_r` / `hsi`
bookkeeping a real one carries — and hand-built requests to Meta were twice observed
invalidating the signed-in session. Being able to do a thing is not a reason to do it
that way.

So the extension does not forge a page. It **keeps** one: `experimentalOwnTab` has the
worker hold a **pinned** tab, opened when there is queued work and nobody is browsing,
running the ordinary ladder inside it.

The first version opened a tab, drained the queue and closed it again. That was worse
than it sounds — a tab appearing and vanishing in the strip several times an hour, which
is exactly the kind of thing that makes people uninstall something. A pinned tab is the
shape this wants: a favicon at the far left, which is what pinned tabs are for, and above
all it **holds still**. An empty queue no longer closes it; nothing does but the person.

**One record per platform**, and that is not incidental. Facebook work can only be done on
a facebook.com page and Threads work on a threads.com one, so a single "the tab" strands
whichever site it is not on. While the tab closed itself on an empty queue that recovered
by itself; once it stays open forever, the other platform starves for the whole browser
session — and the badge, which counts *any* Meta tab as somewhere for work to run, reports
that everything is fine. An adversarial review caught that, reproduced against the real
worker; the tabs are keyed by platform now, and opening them is serialised, because two
alarms coming due together could otherwise each create a tab while only the second was
remembered — leaving one that nothing owns and the off switch cannot reach.

Every gate is a reason not to have one — experiment off, blocking off, halted, a tab
already open on that platform (theirs does the job), one of ours already open, or nothing
queued. Turning the experiment off closes it immediately rather than at the next alarm,
because a tab that outlives the switch governing it reads as one you cannot get rid of.

**And it must never become a tab that cannot be closed.** Closing it by hand is answered
by opening it again a minute later — the common case really is a stray middle-click — but
a second close pushes that to five minutes, a third to thirty, a fourth to an hour, and
**the fifth switches the experiment off**: the box unticks itself, the tabs close, and the
setting now agrees with what you did. The ladder without that last step would only be the same problem more slowly, a
tab returning hourly forever. Reaching it takes five closes each within ten minutes of
opening — a tab that outlives that resets the count, so an accidental close next week is
the first one again — which is not mis-clicking, it is somebody saying no five times.
Switching itself off rather than remembering a private "we gave up" flag is deliberate,
and an adversarial review is why: the options page posts *every* checkbox on *every*
change, so a hidden flag was cleared by editing any unrelated option and the tab came
straight back. An unticked box is both the honest UI and the only state a bulk save
cannot undo by accident.

Unpinning it gets it quietly re-pinned; being pinned is what makes a permanent tab
bearable. And if Chrome **discards** it to reclaim memory — the tab stays in the strip
while the page inside it is thrown away, taking the content script with it — the next
check reloads it, because otherwise the queue would sit still behind a tab that looks
perfectly healthy.

It needs **no new permissions**: `chrome.tabs.create` requires none, and the tab queries
run off the host permissions already in the manifest.

**On by default in an unpacked build, off in a published one.** Chrome puts `update_url`
in the manifest of a store install and leaves it out of an unpacked one, which is the
only signal available without asking for the `management` permission; a build that cannot
tell answers "no", so the experiment is never on by accident in somebody's browser.
Ticking or unticking the box in options makes the choice explicit and the build stops
deciding.

Verified in the signed-in session with every Meta tab closed: the extension opened one,
and it resolved and logged a dry-run block. What Chrome says about that tab is worth
recording, because "background" means unfocused, not hidden — it is a real tab and you
can see it:

```
tab:    index 3, active: false, pinned: true, highlighted: false
window: state "maximized", focused: true, type "normal"
```

The extension also watches `fetch` and `XMLHttpRequest` and captures a real block request
if it sees one — including the generated Relay provider variables that cannot be
reconstructed by hand. That capture is only used when raw fallback is explicitly enabled;
it excludes the extension's own requests, so it cannot learn from its own failures.

---
