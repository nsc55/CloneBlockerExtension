# Changelog

What changed, for people who use Clone Blocker rather than people who build it.
Dates are the day the work landed. Newest first.

The versions below are the extension's `manifest.json` version. Anything under
**Unreleased** is in the repository and not yet in a published build.

---

## Unreleased

### The backend is now a server of its own

Clone Blocker ran on Firebase. It does not any more. Almost none of this is
visible from inside the extension, which is the point — but two things are, and
one of them changes what the privacy policy says.

- **Reports are no longer lost when they cannot be sent.** If the server is
  busy, restarting, or unreachable — including because a network has decided it
  does not care for the address — your report is kept and sent later, and the
  extension says so rather than reporting a success that did not happen. You
  may be on a different connection tomorrow; a report saved today can leave
  next week.
- **Blocking keeps working even if the backend does not.** The blocklist is
  signed, so it can be published in more than one place and the extension will
  read whichever answers. It checks the signature against a key built into it,
  which is what makes a mirror safe: one that is stale, tampered with, or run
  by somebody else can do nothing worse than be ignored. A mirror can never
  give you an *older* list than the one you already have, either.
- **The address the extension talks to can now move without a new release.** A
  small signed document says where the backend is. It is signed, and the
  extension will only ever accept a hostname that was already compiled into the
  build, so nobody who takes over that document can redirect you somewhere new.

**A privacy change, stated plainly.** Reports now carry a two-letter country,
worked out at the network edge from the address the request came from. That is
an IP lookup, it is server-side, and no setting of yours declines it — which
the previous privacy policy said would never happen, so the policy has been
corrected rather than quietly left alone. The address itself is never stored:
rate limiting keeps only a hash of it under a salt that changes every hour, in
a table that expires. What you can still decline, as before, is the
finer-grained time zone your browser reports.

**Why it moved at all.** The old design used database security rules as its
entire gate. Rules can check what a request looks like but not who is sending
it or how often, so there was no way to limit abuse — and every fix for that
turned out to require a server. The details, including what was tried first and
why it did not work, are in `docs/BACKEND-PLAN.md`.

### For the moderator

- Sign-in is now a password **and a six-digit code**. That account approves what
  every installation blocks, so it should have had a second factor before.
- The queue is aggregated, filtered, sorted and paged on the server, and the
  publish preview is computed by the same code that does the publishing — so
  what you preview is what ships.

### Blocking works without waiting for the site to co-operate

- **Blocking no longer needs you to open a menu first.** Meta ships its block
  operation lazily and it cannot be fetched by name, so on most tabs the
  extension had nothing to call and said so. It now drives the site's own
  network layer with the operation's published id instead, which needs no menu
  and no interaction. Where that id comes from, best first: an operation the
  page happens to have loaded, one this browser has seen work before, or one
  published with the blocklist.
- **A block you ask for happens first.** Pressing *Block now*, or ticking
  *block this profile too* while reporting, used to append to the end of the
  queue and then sort behind everything already in it. It is served first now,
  it is exempt from the two job switches — pressing a button about one account
  is not the extension acting on its own initiative — and it wakes a tab that
  was asleep between blocks instead of waiting out the timer.
- **Asking again for an account you already blocked does something.** It used
  to be silently ignored while the interface said *Queued*, which was wrong for
  anybody who had unblocked someone by hand and wanted them blocked again.
- **The report sheet stopped saying "Blocked" when it meant "queued".** It now
  waits briefly for the block to actually land and says which of the two
  happened.

### It can work while you are not

- **Experimental: a tab of its own.** Blocking runs inside a Facebook or
  Threads page, so with no tab open the queue simply waited for you. With this
  on, the extension keeps one **pinned** tab for the job — opened when there is
  work and nobody is browsing, and then left alone rather than appearing and
  vanishing. Close it whenever you like: it comes back a minute later, waits
  longer each time you close it again, and after the fifth switches itself off.
  It ships **off** in the published extension and on only in development
  builds. Settings → *Open a tab of its own to get through the queue*.

### The activity page holds what it shows

- **The queue and the history are searchable, sortable and paged.** Both lists
  grow without limit and both used to be drawn with a hard cap and a
  "… and 43 more" line, which is a page admitting it cannot show what it holds.
  Search runs over names, ids and the reason text; the queue sorts by the order
  it will actually be worked through, by how long a row has waited, by name or
  by platform, and the history by recency, name, outcome or platform. What you
  type survives the page refreshing underneath you.
- **Retry, on every waiting row.** A row can be waiting out the half-hour
  cooldown after a dry run, a growing backoff after a failure, or nothing at
  all, and working out which before you are allowed to press a button means
  knowing how the queue is built. Retry clears the wait and wakes a tab for it;
  **Retry all** does the same for everything queued. Neither steps over the
  pacing, the leases or the hourly ceilings — those are what keep Meta from
  issuing a checkpoint, and a button that quietly ignored them would be a
  button that gets accounts flagged.

### Fixes

- **On Threads, clicking Like sometimes opened the report sheet.** The hover
  chip was hidden by fading it out, which paints nothing but still catches
  clicks — so an invisible chip sat wherever it was last shown, on top of the
  page, for the life of the tab.
- **The in-post report button was dead on any non-English Threads.** It looked
  for the control labelled "Share"; on a Vietnamese account that is "Chia sẻ",
  so the button was never added at all. It finds the row by its shape now.
- **Facebook comment hiding was dead on any non-English Facebook**, for the
  same reason — it matched the label "Comment by".
- **Switching off *Work through the list too* now stops the work.** Both
  switches only filtered what could enter the queue; anything already queued
  kept being blocked, while the popup said it was parked.
- **The moderation dashboard loads again** at `/admin` without a trailing
  slash.

### Settings

- The blocklist is refreshed **every 10 minutes** instead of every hour, so an
  approved clone reaches installations sooner. The list is a static file served
  with an ETag, so an unchanged one costs a few hundred bytes and no database
  read.
- Pacing delays are shown **in seconds** rather than milliseconds.
- **The language can be chosen on the first-run guide**, in the top corner,
  rather than only in Settings. The extension follows the browser's own
  language and is right for nearly everybody, which is exactly why the
  exception matters: on a page that is entirely prose, somebody reading the
  wrong one should not have to go hunting for the setting.
- `maxColdBlocksPerHour` was raised from **4** to **20**. Note that it does not
  bind at that value: `maxBlocksPerHour` (15) is checked first and counts warm
  and cold attempts together, so cold work is still limited to 15 an hour minus
  whatever warm work happened. Raising the cold ceiling alone changes the
  pacing not at all.
- The options page no longer contradicts itself: controls governed by a switch
  that is off are dimmed, and the two under *Pause blocking* — which are inert
  while paused rather than active, the opposite of every other indented control
  on the page — say so.

### Moderation dashboard

- The queue is a real queue: **search** across names, ids, notes and quoted
  evidence; **facets** for held, has evidence, named in public, reopened,
  reported since deciding and 2+ reporters, each carrying its count;
  **sorting** by score, reporters, dates or name in either direction, with held
  rows always last; and **pagination** with a page size, replacing a fixed row
  cap. Counts on every tab, stat tiles that filter when clicked, and the whole
  view carried in the URL so it can be bookmarked or reloaded.
- A **Block operation** card, where the block operation's published id is set —
  the one setting that decides whether a fresh install can block at all.

### Privacy

- **The published blocklist stopped describing the people who report.** It
  carried, per account, the reporters' trust score to two decimals, a per-day
  histogram of when they reported, and per-region and per-language counts —
  which for a single-reporter account read as "one person, this timezone, this
  language, this day" beside the account they reported. It now carries region
  and language *names* without counts, the week rather than the day, one capped
  count for the week, and a confidence in quarter steps.
- **Approving an account no longer names it in public.** A username or display
  name is published only for accounts a moderator also opted in to the public
  page.
- **The reporter pseudonym is keyed with a secret your browser makes for
  itself** and never sends. Nobody outside your browser can compute it, so a
  copy of the report store cannot be turned back into a list of who reported
  whom. Reinstalling gives you a new pseudonym.
- Reports filed after a decision no longer change what is published about that
  account.

---

## 1.0.1 — 22 August 2026

- Shorter, promotion-led store listing copy, in English and Vietnamese.
- MIT licence; repository links moved to `nsc55/CloneBlocker`.
- A release pipeline: signed CRX builds in CI alongside the store zip, both
  built from the same bytes.

## 1.0.0 — 22 August 2026

The first packaged build.

- **Two switches:** block the clones you run into, and work through the
  published list — independent, both on by default.
- **Tags.** Every listed account carries one: clone, impersonation, scam,
  harassment, spam, *bò đỏ*, or other. A tick box per tag decides which kinds
  get blocked.
- **Reporting from the page**: a report button in every Threads post's action
  row, and a hover chip on profile links anywhere else. Reports carry the
  evidence — a link to the post and a short quote — because a reviewer deciding
  whether an account is a clone needs more than a name.
- **Hiding**, off by default: suppress a listed account's posts and comments in
  your browser without touching your account.
- **A first-run guide**, and an activity page showing what was blocked, what is
  waiting, and why.
- **English and Vietnamese** throughout, following the browser's own language.
- **A public list** of accounts that were reported, reviewed and then
  deliberately published — separate from being blocked, and opt-in per account.
- **A moderation dashboard** for the project owner, with reputation-weighted
  ranking and tunable ranking weights.
