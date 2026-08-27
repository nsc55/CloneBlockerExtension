# Privacy policy — Clone Blocker

*Last updated: 27 August 2026*

*Also served, with a Vietnamese translation, at
<https://cloneblocker.tree55.com/privacy>. This file is the policy of record;
`tools/check.js` holds the two "Last updated" dates equal, so change them
together.*

Clone Blocker is a browser extension that blocks accounts impersonating you on
Facebook and Threads, and can optionally hide their content as well. This
policy describes every piece of data it handles and where that data goes.

The short version: the extension talks to **one backend and nowhere else** — a
server whose address is compiled into the extension rather than
configured by you. There is no analytics, no telemetry, no advertising and no
crash reporting. Fetching the blocklist sends nothing about you at all, so the
only thing that ever leaves your machine is a report you deliberately file.
Those reports land in a database on a server the project runs itself: the
hosting provider and the network in front of it are infrastructure, in the
same way a rented server's datacenter would be, and reports are readable by
the project's admin accounts — the maintainer of whichever backend the copy you
installed points at — and by nobody else at all.

One thing that backend does with reports is public, and it is described in full
below: some of the **reported** accounts are named on a public web page. Nothing
about the **reporter** ever appears there, in any form. If you file reports,
nothing you send is published. If you are the account someone reported, read
[The public list](#the-public-list) — it says exactly what can be published
about a profile, what never is, and how to ask to be taken down.

---

## What stays on your device

Held in Chrome's extension storage, and never transmitted:

- **Your settings** — which of the two blocking switches you ticked, which
  kinds of account you allow blocks for, whether blocking is paused, whether
  you switched hiding on (it ships **off**), and every pacing and cap value.
- **The cached blocklist** — so it does not have to be re-fetched on every page.
- **The block queue** — which accounts are pending, which have been done, and
  the timestamps used to keep within your own hourly and daily caps.
- **Captured request templates** — the shape of a block request the site
  itself made, remembered so the same block can be reissued on the same site.
  Captured always; used only if you enable the raw-request fallback in the
  advanced settings (it ships off). They never leave the device.
- **Your own activity** — the log of blocks this browser attempted, with the
  profile ID and the name it had at the time, and the list of reports this
  browser filed (so the page can say "you already reported this"). Both stay
  on the device.
- **Names of listed accounts** — a small cache of display names and usernames
  for accounts this browser has seen on the page or on the list, so the
  Activity page can show a name beside an ID.
- **The reporter secret** — a random key this installation generates for
  itself, used only to derive the pseudonym described below. It is never sent.
- **The interface language.** The extension is available in English and
  Vietnamese and simply follows the language Chrome is already running in. It
  asks nothing, stores nothing extra, and sends nothing about it.
- **Your time zone and language, as used for ranking.** When working through
  the list is switched on, the extension decides which listed accounts are most
  active near you by comparing your browser's own time zone and language
  against metadata published with the list — a comparison that happens entirely
  on your machine.

Uninstalling the extension removes all of it.

## What the blocklist request tells us

Nothing about you, on purpose.

The list is a static file on a CDN and is fetched with no query string: no
timezone, no language, no identifier, no budget hint. Two installations in
different countries send byte-identical requests. The ranking that decides
which accounts to work through first is computed inside your browser, from
metadata the file already carries — it never leaves the machine.

**Your IP address, and what is done with it.** Any web server sees the address
a request came from; that is how a reply gets back to you. **Fetching the
blocklist** still does nothing with yours beyond answering: the file is static,
the request carries no identifier, and nothing about that fetch is written down.

**Filing a report is different, and this has changed.** When you submit a
report, the address it came from is **stored on that report**, along with the
**city** the network in front of the server resolves it to and the two-letter
country it already recorded. A moderator reviewing the report can see all
three, and can see what else has been reported from the same address.

- **Rate limiting is unchanged and still forgets.** For counting requests the
  address is combined with a secret and a salt that changes every hour, and
  only the resulting hash is kept, in a table of counters that expires. Once
  the hour turns, that hash cannot be recomputed from an address, so a copy of
  the counters cannot be checked against a list of suspects.
- **The report itself does not forget.** It carries the address in full, and
  the report has no expiry.
- **A city and a country.** The network in front of the server resolves the
  address to both, and both are attached to the report. They help somebody
  deciding whether an account is a clone to know where it is being reported
  from.

**Why, and what it costs you.** The pseudonym a report is filed under is cheap
to replace — reinstalling the extension mints a new one — so a queue that sees
only pseudonyms cannot tell one person filing under twenty of them from twenty
people, and the hourly salt above is specifically designed so that the counters
cannot answer that question afterwards either. The address is what answers it.
The cost is stated here rather than buried: **a copy of the report database now
identifies the people who filed the reports.** The pseudonym was defence in
depth behind that database; an address has nothing behind it. If that is not a
trade you want to make, do not file reports — fetching the list and blocking
from it still tell the server nothing about you at all, and that is the larger
half of what the extension does.

**This is a change, and it is worth being plain about it.** An earlier version
of this document said the hosting provider's view of your address was joined to
nothing, and that location came only from your browser and only if you allowed
it. The country above is derived at the network edge from the address your
connection came from, so no switch of yours can decline it. What you can still
decline, with **Send my time zone and language**, is the finer-grained time
zone the browser reports.

**Accounts other people have reported are not published.** The list names only
accounts a person has reviewed and approved. It used to also carry the keys of
reports still awaiting review, so the in-page chip could say "already reported"
about somebody else's report — but anyone can file a report, with no account
and no review, so that let a stranger have any profile they chose named on a
world-readable document. The chip now only knows about reports this browser
filed.

**What the list says about each listed account** is deliberately coarse, so
that it describes the account and not the people who reported it: the numeric
ID and the kind of account it was judged to be; a confidence score in quarter
steps; how many different people reported it; the week (not the day) it was
last reported; how many reports arrived in the latest week, capped; and the
names of up to three time zones and three languages its reports came from —
names only, never counts, for the reason given under [The public
list](#the-public-list). A username or display name is carried only for
accounts the moderator has also opted in to the public page, so the list names
exactly what the page names and nothing else.

## What leaves your device, and to where

The project runs one backend, at `cloneblocker.tree55.com` — its address is
built into the extension (visible in `src/common/protocol.js` and
`manifest.json`), and a build pointed anywhere else is a different copy.
Because Vietnamese ISPs block that address, the paths the extension uses **by
default** are the ones that survive the block, and each is approved by a signed
pointer document whose permitted hostnames also ship inside the extension:

- **Reading the list.** By default your blocklist is fetched from a public,
  signed copy on `raw.githubusercontent.com`, with `cdn.jsdelivr.net` and the
  origin as fallbacks. GitHub and jsDelivr see an ordinary anonymous file
  request that carries nothing about you. Every copy is signed and verified
  against a key built into the extension, so a mirror that is stale, tampered
  with, or hostile can only fail to verify — it can never hand you a different
  list.
- **Filing a report.** By default your report goes to a relay we run on AWS in
  Singapore (`h0w1lwun39.execute-api.ap-southeast-1.amazonaws.com`), which
  forwards it to the backend. The relay sees exactly what the backend would
  have seen — the report you typed, and your IP address, which it passes along
  so the backend's rate limits treat you as one person rather than lumping
  everyone together. It stores nothing and adds nothing. This does mean your
  report **transits AWS infrastructure by default**; if the relay cannot be
  reached the extension sends the report to the origin directly. Either way it
  reaches the same backend and the same moderators, and this policy says so
  plainly rather than leaving it to be discovered.

### Fetching the list

A periodic HTTPS request for your blocklist. **It carries no personal data —
no time zone, no language, nothing about you at all.** Earlier versions sent
your time zone, language and remaining block budget with this request so the
server could rank suggestions; that ranking now happens locally, so the fetch
is anonymous by construction. This is an improvement worth stating plainly:
nothing about you is sent to anyone when the list is fetched.

### Filing a report

Sent only when you deliberately submit a report, and only what is in the form:

- the reported account's profile ID and/or username, and its display name;
- the reason you selected;
- any note you typed and any post links you attached, plus an optional short
  quote of the content you are reporting;
- the **IP address** the report was sent from, and the **city** and **country**
  the network in front of the server resolves it to. None of these three is
  sent by the extension and no setting declines them — they are properties of
  the connection itself. See *Your IP address, and what is done with it* above
  for what they are for and what they cost;
- the **browser identification string** your browser sends with every request
  it makes to any website — the one naming your browser, its version and your
  operating system. It is stored on the report and the moderator can see it. It
  is there to tell a report filed by the extension from one posted to the
  server by a script, which is what a flood looks like; combined with the
  address it also makes two reports from the same person easier to recognise.
  No setting declines it either;
- your **time zone** (for example `Asia/Ho_Chi_Minh`) and **language** (for
  example `vi-VN`) — both values your browser already hands to every site you
  visit, used to show the reviewer where a clone is currently active. This is
  controlled by the **Send my time zone and language** switch in options; turn
  it off and a report carries neither;
- a **pseudonym derived from your own Facebook or Threads account ID**.

That last item deserves an explanation. Your numeric account ID is read from
the page you are already signed in to, so that reports can be weighed against
the reporter's track record and one account cannot flood the queue. The ID
itself is never sent: the extension hashes it in your browser (a keyed hash,
truncated) and only the pseudonym leaves your machine. A report cannot be
filed while signed out.

Two of those items can end up in public, if a moderator later opts that reported
account in to the public list: the post links you attached and their short
summaries. Your note is not published, and nothing that identifies you as the
reporter is published — not the pseudonym, not a count of your own reports, not
your time zone or language as yours (the list and the page carry the *names* of
the regions and languages an account was reported from, never counts — see
below). The full rules are in [The public list](#the-public-list).

Be clear about what that pseudonym does and does not do. It is an HMAC of your
account ID keyed with a random secret this installation generated for itself
and keeps only in the extension's own storage — so **nobody who does not hold
that secret can compute your pseudonym**, not from a copy of the report store
and not by guessing account IDs. (An earlier version used an unkeyed hash,
which someone holding the store could have checked a guess against; the key
closes that.) The report store is in any case readable only by the project
owner under the security rules; the pseudonym is defence in depth behind that
barrier, not the barrier itself. The trade is continuity: reinstalling the
extension, or clearing its storage, creates a new secret and therefore a new
pseudonym with a fresh track record.

### Performing a block

**One experimental option changes when this happens** — *Open a tab of its own
to get through the queue*, in options. Blocking only works inside an open
Facebook or Threads tab, because it drives those sites' own code; with the
option on, the extension keeps one **pinned** tab of its own for the job. It
opens when there are approved accounts to block and you are not browsing, and
then stays open rather than appearing and disappearing. You can close it
whenever you like — it reopens a minute later, waits longer each time you close
it again, and after the fifth it switches the option off for you. While it is open the site sees an ordinary page visit, the
same as if you had opened it yourself, and it stays signed in as you are. It
ships **off** in the published extension and is on only in unpacked
development builds.

Unless you pause blocking in settings, the extension issues blocks through
Facebook's or Threads' own in-page mechanism, exactly as pressing their Block
button does. That request goes to Facebook or Threads, contains only the target
account, and carries no data from this extension. Which accounts it acts on is
the pair of switches you control: one covers profiles that appeared on the page
in front of you, the other works through the published list as well.

## The public list

The backend that receives reports also runs a **public web page** that names
some of the reported accounts: <https://cloneblocker.tree55.com/list>. This is the
one place where data handled by this project is visible to anyone at all, so it
is worth reading carefully — particularly if you have found this policy because
you believe you are on that page.

**Nothing reaches that page automatically.** Two separate decisions have to be
made by a person, in this order: a moderator approves a report, which puts the
account on the blocklist the extension applies; and the moderator then opts
that specific account in to publication. Most blocked accounts are never
published there, and the page shows both counts side by side so that is
visible rather than claimed.

**The blocklist itself is a separate matter, and this changed.** The blocklist
is the file every installation downloads, and anyone who requests it can read
it — it has to be that way, because it is served from a CDN with no account
behind it. It used to carry only numeric profile IDs, so being on it did not
name you. It now also carries the **username and display name** of every
account on it. The reason is mundane: without a name, somebody's own record of
what they had blocked was a column of numbers they could not recognise. The
consequence is not mundane, and is written here rather than left to be
discovered: **an approved account is now named to anyone who fetches that
file**, whether or not a moderator opted it in to the public page.

What the opt-in still controls is the *page*: the tag, the report count, the
dates, the regions and the evidence links are published only for accounts a
person chose to publish. Approving an account puts its id and its name on the
blocklist; it does not put the case against it in public.

**What can be published about an opted-in profile:** its display name, its
username, its numeric profile ID, its tag (clone, impersonation, scam,
harassment, spam, red bull, other), how many different people reported it, the
date it was first reported and the date it was last reported active, up to three
coarse regions (IANA time-zone names such as `Asia/Ho_Chi_Minh`), and links to
the posts submitted as evidence, each with the short summary that accompanied
it.

**What is never published, by construction:**

- **The identity of anyone who reported it, in any form.** Not the truncated
  `acct_` pseudonyms, not per-reporter counts, not reputation weights — only a
  headcount of how many different people reported. The pseudonyms are stable
  across accounts, so publishing even one would let a reader start
  reconstructing who reported whom.
- **Reporters' free-text notes**, and any moderator note. Only evidence
  summaries attached to a post link are published.
- **Evidence with no link behind it.** An entry without an `https` post URL is
  dropped rather than published: a quotation with nothing to check it against is
  an unverifiable claim about a named person.
- **Per-region counts.** The region *names* are published; the number of reports
  from each is not, because "two reports from `Asia/Ho_Chi_Minh`" narrows down a
  reporter in a way the bare name does not.

**If you believe you are listed there wrongly**, write to the issue tracker —
<https://github.com/nsc55/CloneBlocker/issues> — which is the address
printed on the page itself. Being listed is one person's judgement, not a ruling
by Facebook or Threads; that judgement can be wrong, and a profile whose case
does not hold up is taken down. Removal takes effect the next time the list is
published, and a copy may persist briefly in a CDN cache and indefinitely in
third-party archives and search-engine caches that this project does not
control.

## What is never collected

Browsing history, page content beyond what you attach to a report, passwords,
cookies, session tokens, messages, contacts, payment information, device
fingerprints, or anything at all from sites other than facebook.com,
threads.net and threads.com.

Note what is *not* in that list any more: the address a report was filed from,
the city it resolves to, and the browser identification string it was sent
with are all collected and kept. They are described under *Filing a report*
and *Your IP address, and what is done with it*.

## Who else sees it

The data is not sold, rented, or shared. Three parties can see some of it:

- **The owner of the backend this build points at.** For the published
  extension that is this project's maintainer, who can read the reports you
  file (the server makes them readable only by the project's admin accounts —
  today one person, who can sign in two ways — and the reporter identity is
  only a truncated hash, see above). A
  build you compile against your own server sends them to you
  instead. This policy can only speak for the code, not for what any backend
  operator does with what they receive.
- **Anyone at all**, for the narrow slice the operator has opted in to the
  public list: the reported profile's own details and the evidence links, never
  anything about who reported it. See [The public list](#the-public-list).
- **The hosting provider and the network in front of it**, as the
  infrastructure the server runs on. The data sits in a database file on that
  server, subject to the provider's own
  terms and privacy commitments, the same way any hosting provider holds the
  disks your data is on. The extension sends them nothing itself; they host
  what the project stores.

No analytics service, ad network, or other third party appears anywhere.

## Retention and deletion

Retention is the backend owner's business, since the backend holds the data.
Reports persist until an admin deletes them — from the moderation dashboard,
or directly in the database,
which the project owner can always do regardless of what any tooling offers.
There is no automatic expiry.

**That now includes the address a report was filed from.** It is kept for as
long as the report is, it is copied into every backup the server takes, and
nothing deletes it on a schedule. Account IDs are still the exception and are
still only ever truncated hashes; the raw account ID is never stored anywhere.

A profile removed from the public list, or taken off the blocklist entirely,
disappears from the page when the list is next published — the published
documents are recomputed from scratch each time rather than edited, so nothing
lingers in them. What this project cannot undo is a copy someone else already
took: CDN caches expire on their own, but search engines and archive sites keep
what they have crawled.

On your device, clearing the extension's storage or uninstalling it removes
everything it holds.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | Keep your settings and the cached blocklist. |
| `alarms` | Refresh the blocklist on schedule. The extension's background worker is stopped between events, so a repeating alarm is what makes the periodic refresh fire. |
| Access to facebook.com, threads.net, threads.com | The only two sites the extension works on: it reads the page to find listed accounts, and issues blocks unless you have paused that. |
| Access to cloneblocker.tree55.com | The backend: the blocklist is read from it, and reports you file are written to it. |

Every one of them is declared in the manifest and granted when you install. The
extension asks for **no permissions at runtime** — there is no prompt to
accept, because there is no address for you to supply.

## Children

Not directed at children under 13 and collects nothing about them.

## Changes

Material changes will be reflected here with a new date, and — as the Chrome
Web Store requires — disclosed to users rather than applied quietly.

## Contact

Issues and questions: https://github.com/nsc55/CloneBlocker/issues

The extension is open source. Every claim in this policy can be checked against
the code rather than taken on trust.
