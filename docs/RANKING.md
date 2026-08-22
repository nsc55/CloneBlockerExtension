# Choosing whom to block first

There are always more clones than a single account can safely block in a day.
This is how the extension decides the order, entirely inside your own
browser.

*Part of [Clone Blocker](../README.md). See also: [how blocking works](BLOCKING.md) · [ranking](RANKING.md) · [architecture](ARCHITECTURE.md) · [development](DEVELOPMENT.md) · [research](RESEARCH.md)*

---

### Too many clones for one account

A blocklist of a few thousand cannot be worked through by one account. The
platforms checkpoint an account that blocks at volume — which is the failure
this whole thing exists to avoid, arriving by a different road.

So the list is served as **two lists, because the two things you can do with a
clone cost completely different amounts.**

| | what it covers | cost | rationed? |
|---|---|---|---|
| **Hiding** (off by default) | everything on the list | nothing | no |
| **Blocking** | a ranked, budgeted slice | your account | yes, tightly |

Hiding a clone is free and carries no risk, so there is no reason to ration
it — it is off by default because it is not what the extension is *for*, not
because it is expensive. A real block is what gets an account checkpointed, so
it has to be spent on the few clones that are active *now* and operating
*where you are*.

#### Warm and cold — what the two switches are underneath

Not all blocks look the same to the platform. Blocking someone whose profile is
on your screen is what an ordinary person does all day. Working through a list of
accounts you have never encountered is not, and it is the pattern that draws a
checkpoint.

So the queue tracks how each target got there:

- **warm** — resolved from the page you are looking at. Paced normally (4–11s),
  limited only by the overall hourly cap.
- **cold** — nominated by the trending metadata published with the list, never
  seen in this browser. Paced slowly (20–45s) and held to a ceiling of its own
  (`maxColdBlocksPerHour`, default 20).

<a id="the-two-ceilings"></a>
**The two ceilings, and which one actually stops you.** `maxBlocksPerHour`
(default **15**) is checked first and counts *every* attempt, warm and cold
together; `maxColdBlocksPerHour` (default **20**) is checked afterwards and
counts only the cold ones. At those two values the cold ceiling is inert: 15
attempts of any kind are spent before 20 cold ones can be, so cold work is in
practice limited to 15 an hour minus whatever warm work happened. Raising the
cold ceiling on its own therefore changes nothing — the overall one has to move
with it. This is deliberate: 15 an hour is the number chosen against the
checkpoint risk, and it is the one worth thinking hard about before changing.
The cold ceiling remains useful *below* 15, where it does bind, and at **0**,
which is the way to say "never block anyone I have not seen".

**`blockSeen` is the warm half; `blockFromList` is the cold half.** That is all
the two switches are underneath, and it is why there are two of them rather
than one dial: the halves carry genuinely different risk, so they get different
pacing, different ceilings, and either can be declined without giving up the
other. Every block runs inside a Facebook or Threads tab, so warm work has one
by definition; cold work is the half that can sit waiting for one, which is
what the badge counts.

**The pacing is per browser, not per tab.** Each open tab runs its own worker
loop, and a loop that paced itself would be fine with one tab and wrong with
five: leases stop two tabs blocking the *same* profile, but nothing stopped
five tabs blocking five *different* ones in the same second — five times the
rate these ceilings were chosen for. So the pace is held in the service worker
instead. One gate for the whole browser: shut while a block is in flight,
bounded by the lease so a tab that dies mid-block cannot wedge the queue, and
shut again for the randomised delay after the result lands. Whichever tab asks
first gets the next target; the rest are told when to come back. It spans both
sites as well as both tabs, because Facebook and Threads are one Meta account
and the account is what gets checkpointed.

Warm is claimed first — it is both the safer and the more relevant signal, so the
two orderings agree far more often than they conflict. Reaching the cold ceiling
never stops warm work: rationing the ordinary case to protect against a risk it
does not carry would just make the extension feel broken.

**Seeing a cold target on screen promotes it to warm.** The same block is
unremarkable now and conspicuous later, so it is taken while it is cheap.

Set `maxColdBlocksPerHour` to **0** to never block anyone who has not appeared
on your screen — the same end as unticking **Work through the list too**, reached by
the ceiling rather than by the switch. The switch is the honest way to say it:
with the ceiling at zero the list still seeds a queue nobody will ever spend.

#### The trending matrix

Reports carry a coarse origin: the reporter's IANA time zone and language tag.
Both are things the browser already hands to every site it loads, and neither
needs an IP lookup, a geo database, or a third-party service. Turn it off with
**Send my time zone and language** in options.

The published list carries 14 daily buckets and a region tally per approved
account, and the **extension ranks them locally**:

```
rank = trust × recency × (1 + velocityWeight × velocity7d) × locality × boost

  trust      trust-weighted report score (see "Who filed the report")
  recency    0.5 ^ (days since last report / halfLifeDays)
  velocity   reports in the last 7 days
  locality   localityFloor + (1 − localityFloor) × how much of this clone's
             activity is near you
  boost      1 + uniqueReporterBoost × log2(1 + unique reporters)
```

**The dials are published, not compiled in.** `rankWeights` rides in the list —
`halfLifeDays` 7, `velocityWeight` 1, `localityFloor` 0.25,
`localityLangFactor` 0.8 (language counts a little less than region),
`uniqueReporterBoost` 0 — so the owner can retune ranking from the dashboard
without shipping an extension update, and the dashboard's preview ranks with
exactly the numbers clients will. Those defaults are today's ranking, term for
term: `uniqueReporterBoost` at 0 makes its factor exactly 1, so the formula is
byte-identical to the one that predates the dials. A list published before they
existed carries none, and a single nonsensical value falls back on its own
rather than dragging the tuned ones down with it.

The unique-reporter term is the one worth explaining. Trust is linear, so two
reporters at 0.75 outrank one at 1.5 by nothing at all; raise the boost and four
independent people saying the same thing start to outweigh one reporter with a
long record. Which is right is an empirical question, which is exactly why it is
a dial rather than a decision baked into a release.

"Near you" is your own browser's time zone and language, compared against the
published tallies **on your machine**. The fetch itself carries nothing about
you — the old server did this ranking per-request, which meant telling it your
region and remaining budget on every poll; now nobody learns either. Turn
**Send my time zone and language** off and locality is simply 1 for every
target: the ranking degrades gracefully instead of leaking.

Locality never zeroes a target out — a clone that is merely hot elsewhere
stays reachable, just lower. Everything is quantised to whole days on purpose:
a continuously-decaying score would reorder the queue on every poll, and a
ranking that cannot be reproduced an hour later cannot be inspected either.

The extension takes the top of its own ranking up to what its rate limiter
still has room for, so the slice it acts on is one it can actually spend.

The dashboard shows the matrix — regions down the side, days across, with what
is driving each region underneath — computed in the admin's browser from the
same reports, so the ranking can be inspected before it is trusted.

#### Who filed the report

Reports carry the platform account behind them — `facebook:100000000000001`,
read from the page the extension is already running in. A report with no account
is refused with `signed-out`, and the sheet says so before you type rather than
after you submit.

**This is not verified, and it cannot be.** `fb_dtsg`, `lsd` and the session
cookies are opaque artifacts that only Meta can validate, and validating them
means Meta's API — excluded here by design. A patched extension can send any
number it likes. What the binding buys is *cost*: the previous scheme keyed the
reporter on a UUID the extension minted for itself, so clearing extension storage
produced a brand new reporter and one person could raise any report's count
without limit. Inflating a count now takes real accounts, and — more importantly
— it gives reputation something stable to attach to.

The raw account id is never stored. The extension hashes it before it leaves
the browser — HMAC-SHA256 of `platform:id` under a secret the install minted
for itself, truncated to a stable pseudonym (`acct_0f8df7554dc15a7f9be22c31`)
— which is everything reputation needs, *is this the same person as last
time*, without keeping the number itself. A persistent bad actor is still
bannable: you ban the pseudonym. Because the key never leaves the browser,
nobody else can compute the pseudonym, not even from a copy of the store; the
trade, a fresh pseudonym on reinstall, is spelled out in "What changed vs the
old server" above.

#### Reputation

Every decision teaches the system something. Approving a report credits everyone
who filed it; rejecting one debits them. A reporter's weight is
`(approved + 0.5) / (approved + rejected + 1)` — a Jeffreys prior, so an unknown
reporter sits at `0.50`, one bad call does not ruin a good history, and one lucky
call does not buy trust.

Reputation is **recomputed from the decided reports** on every dashboard
refresh, never accumulated. A running tally has to be un-done when a decision is revoked, and
every bug in that path is a reporter whose score is quietly wrong forever.
Revoking an approval takes its credit back automatically.

The queue is ranked by **trust-weighted score**, not raw count: ten reports from
accounts that have never been right about anything should not outrank two from
people who consistently are. A report whose every reporter sits below the trust
floor (`0.25`) is marked **held** and sinks to the bottom — still recorded, still
visible, just not able to jump the queue. Each row shows who stands behind it and
their record (`5✓ 0✗`).

#### What this does not stop

Someone with several genuine Meta accounts, patient enough to build a record with
each, can still push a false report through. That is the honest ceiling of any
scheme that does not have Meta vouching for identities. What it costs them is
real accounts and real time, and the moment a decision goes against them, every
account involved loses weight — including on reports they filed earlier.

---
