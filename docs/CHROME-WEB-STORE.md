# Publishing to the Chrome Web Store

What the store requires, what this extension already satisfies, what still has
to be decided, and the copy to paste into each field.

Researched against the live policy pages on **21 August 2026**. The policy set
that took effect on **1 August 2026** is three weeks old at the time of
writing, and it tightened exactly the areas this extension touches — data
collection and disclosure. Re-check before submitting if much time has passed.

---

## 1. Account, before anything else

| | |
|---|---|
| Developer account | One-time **US$5**, per account, not per extension. No renewal. |
| Email verification | Required before publishing. |
| **Trader / non-trader** | Required declaration for every developer, from the EU Digital Services Act. If you declare **trader**, the name, address, email and phone you give are **published at the bottom of the public listing**. |

Trader status is a legal question about you, not about the extension: it turns
on whether you are acting for purposes relating to a trade, business or
profession. A free hobby extension with no monetisation is normally
non-trader — but the declaration is yours to make, and getting it wrong is a
compliance problem rather than a store one. Verification is separate from the
$5 fee and costs nothing.

---

## 2. Image assets

All generated, all reproducible: `node tools/make-store-assets.js`.

| Asset | Size | Required | File |
|---|---|---|---|
| Store icon | 128×128, 96px artwork + 16px transparent frame | yes | `store/icon128.png` |
| Small promo tile | 440×280 | yes | `store/small-promo-440x280.png` |
| Marquee promo tile | 1400×560 | no — but needed to be eligible for featuring | `store/marquee-1400x560.png` |
| Screenshots | 1280×800, 1–5 of them, square corners, full bleed | at least 1 | `store/screenshot-1..2-1280x800.png` |
| Extension icons | 16/32/48/128 | yes | `icons/icon*.png` |

The store's guidance for tiles is *avoid text, stay legible at half size, fill
the region, saturated colour, don't just replicate a screenshot* — hence a
mark, a wordmark, and one line, rather than a shrunken UI.

**The mark**

A red cow wearing a livestock ear tag. *Bò đỏ* — red cow — is what Vietnamese
readers call the paid commenters who swarm a post to shout down whoever is
speaking, and the complaint about them is that they are a herd: one opinion, in
one set of words, from a hundred accounts that all look alike. Which is the
same thing this extension is for, so one mark carries both halves.

The joke is aimed at the herd and nothing else. A flag or a national symbol
with a line through it would be a different joke — one about a country rather
than about astroturfing — and both less funny and far more likely to get the
listing pulled. Reviewers have no obligation to work out which one you meant.

The tag replaced a slash across the cow's face and, before that, a prohibition
ring around it. The slash ran diagonally through the muzzle, so the face lost
half of itself exactly where pixels got scarce; the ring read as "blocked"
perfectly at 16px and shrank the cow to an unidentifiable smudge. The tag says
the same thing without spending any of the face, and being the only asymmetric
element in the mark, it is also what makes the silhouette recognisable small.

**The two screenshots**

1. **Poster** — the marquee again: same field, same herd, same yellow
   punchline. *Bò đỏ ơi, cỏ ở đằng kia.* — hey red cow, the grass is that way.
   A dismissal rather than an insult, which is both funnier and the honest
   description of the product: it does not argue with the herd, it sends them
   somewhere else.
2. **The product** — real captures of the options page with the popup in front
   of it, framed in the poster's clothes.

It was four. Two of them were drawn explainers standing in front of two real
captures, doing the captures' job — describing an interface that was sitting
right there — and the drawn ones went stale against the product twice. One
poster to land the joke and one photograph of the thing itself is the whole
listing.

Both captures are taken with the interface in **Vietnamese**, driven through
the options page's own language picker. A listing that makes its joke in
Vietnamese and then shows an English interface is quietly telling the reader
the translation is marketing. The picker's previous value is read back and
restored in a `finally`, so the dev browser it borrowed is left as it was
found.

Two other display-only corrections live in the generator, both because a dev
session is not a fresh install:

- The options page is captured with the paused note cleared in the DOM. A dev
  session forces blocking off for safety and the page honestly says so; that is
  the harness's state, not the product's. Nothing is written to settings.
- The popup is captured with blocking **on** and dry run **on**, and the queue
  emptied. On is what a fresh install ships with, and it has to agree with the
  options page in the same image — a picture where the popup says blocking is
  paused and the settings beside it say it is running contradicts itself, and
  the reader cannot tell which half is the product. Dry run stays armed
  regardless: that browser is signed in to real accounts, and no screenshot is
  worth arming live blocking to take. The previous values are read back and
  restored in a `finally`.

The popup capture goes to a temporary directory that is deleted afterwards. It
must not be committed: its Page capability panel prints **Signed in as
`<numeric account id>`**, so a copy in the repository would publish the real
account of whoever generated it.

**Worth adding before you submit:** a fifth screenshot of a clone actually
disappearing from a real feed. That one has to be yours — it can only be taken
against a signed-in account, and only you can consent to publishing what is on
that screen.

---

## 3. Listing copy

### Name (45 max) — 13 used

```
Clone Blocker
```

### Short description (132 max) — 117 used

Also the extension's own description; the store reads it from there. Since the
i18n phase that is `appDesc` in `_locales/en/messages.json` (and its Vietnamese
counterpart), reached from `manifest.json` as `__MSG_appDesc__` — the store
serves whichever one matches the shopper's language.

```
Report a clone once. When it is approved, everyone running Clone Blocker blocks that account on Facebook and Threads.
```

The Vietnamese the store serves to a Vietnamese shopper, from
`_locales/vi/messages.json`, at 124 characters:

```
Báo cáo một tài khoản giả mạo. Được duyệt xong, mọi người dùng Clone Blocker đều chặn tài khoản đó trên Facebook và Threads.
```

It used to lead with hiding, which ships switched off — so the first thing a
shopper read was the one feature that does nothing until they find a tick box.
It now leads with the shared list, which is the actual product: one person
reports, a human approves, and every installed copy blocks that account. Both
strings are `appDesc`, reached from the manifest as `__MSG_appDesc__`, so any
rewrite has to change both locales together and land under 132 characters in
each.

### Category

**Social & Communication.** (Not *Productivity* — the store dislikes category
mismatches, and this is not a productivity tool.)

### Detailed description

Paste into the dashboard as-is. The store does not render Markdown, so this is
plain text with blank lines and capitalised headings — which is the convention
the store's own listings use. Cut to ~1,700 characters on 22 August: the long
form read like a README, and a listing is skimmed, not read — anything that
matters past the hook lives on the site and in the privacy policy, both
linked.

The **short** description is not pasted anywhere: the store reads it from the
manifest, which reads it from `appDesc` in each locale, so a Vietnamese shopper
is served the Vietnamese one automatically.

```
Bò đỏ ơi, cỏ ở đằng kia.

"Bò đỏ" — red cow — is Vietnamese for the paid commenters who swarm a post to
shout down whoever is speaking: one opinion, in one set of words, from a
hundred accounts that all look alike. Clone Blocker is for them, and for the
impersonators who copy your photos and your name.

It does not argue with them. It blocks them — for real, through Facebook's and
Threads' own block, at a pace that keeps your own account out of trouble.

HOW IT WORKS

Report an account in two clicks; it is blocked for you straight away. A person
reads the report, and once it is approved the account joins the shared
blocklist — and everyone running Clone Blocker blocks it too. One report
protects everybody.

YOU STAY IN CONTROL

Two switches, both on by default: block listed accounts you run into, and work
through the list at a slow, capped pace. Blocking needs a Facebook or Threads
tab open — blocks go through the site's own code, in the page. Every cap is
yours to change, a pause switch stops everything, and dry run sends nothing.
Hiding, off by default, makes listed accounts' posts vanish in your browser.

PRIVATE BY DESIGN

Fetching the list sends nothing about you — no identifier, no location.
Filing a report sends only what is in the form, and your own account ID is
hashed before it leaves the browser. Nothing about you as a reporter is ever
published. No analytics, no ads, no third parties.
Full policy: https://cloneblocker.tree55.com/privacy

In English and Vietnamese, following your browser's language. Requires Chrome
120+ and a Facebook or Threads account. Free and open source:
https://github.com/nsc55/CloneBlocker

Not affiliated with, endorsed by, or connected to Meta, Facebook or Threads.
```

#### Vietnamese

The store localises a listing per language in the dashboard, and this listing's
audience reads Vietnamese. Paste this into the `vi` locale there.

```
Bò đỏ ơi, cỏ ở đằng kia.

"Bò đỏ" là những tài khoản được trả tiền để ùa vào bình luận, hùa nhau át
tiếng người đang nói: một ý kiến, một cách nói, từ hàng trăm tài khoản na ná
nhau. Clone Blocker sinh ra cho họ — và cho những nick giả mạo lấy ảnh, lấy
tên của bạn.

Nó không tranh cãi. Nó chặn — chặn thật, bằng chính chức năng chặn của Facebook
và Threads, với nhịp độ đủ chậm để tài khoản của bạn không gặp rắc rối.

CÁCH HOẠT ĐỘNG

Báo cáo một tài khoản trong hai cú bấm; nó bị chặn với bạn ngay lập tức. Một
người thật đọc báo cáo, và khi được duyệt, tài khoản đó vào danh sách chặn
chung — mọi người dùng Clone Blocker đều chặn theo. Một báo cáo bảo vệ tất cả.

BẠN NẮM QUYỀN

Hai công tắc, mặc định bật: chặn tài khoản trong danh sách mà bạn tình cờ gặp,
và xử lý dần cả danh sách với nhịp chậm, có trần theo giờ. Chặn cần một thẻ
Facebook hoặc Threads đang mở — lệnh chặn đi bằng chính mã của trang. Mọi giới
hạn do bạn chỉnh, có nút tạm dừng tất cả, và chế độ chạy thử không gửi gì.
Tính năng ẩn, mặc định tắt, làm bài viết của cả danh sách biến mất ngay trong
trình duyệt.

RIÊNG TƯ TỪ TRONG THIẾT KẾ

Tải danh sách không gửi gì về bạn — không định danh, không vị trí. Gửi báo cáo
chỉ gửi những gì trong biểu mẫu, và ID tài khoản của bạn được băm trước khi
rời trình duyệt. Không điều gì về bạn với tư cách người báo cáo từng được công
bố. Không thống kê, không quảng cáo, không bên thứ ba.
Chính sách đầy đủ: https://cloneblocker.tree55.com/privacy

Tiếng Việt và tiếng Anh, theo ngôn ngữ trình duyệt của bạn. Cần Chrome 120 trở
lên và một tài khoản Facebook hoặc Threads. Miễn phí, mã nguồn mở:
https://github.com/nsc55/CloneBlocker

Không liên kết, không được bảo trợ và không có quan hệ gì với Meta, Facebook
hay Threads.
```

**One sentence was held back until it was true.** "Nothing about you as a
reporter is ever published" was left out of the first draft because it was
false: `blocklist/current` is world-readable, and it carried per-target counts
of the timezones, languages and dates its reporters reported from
(the security review, §2.1, in the private backend repository) and the display name of every
approved account, without the publication opt-in the privacy policy promises
(§2.2). Both were closed on 22 August 2026 — the list now carries names without
counts, a week instead of a day, and a name only where the public page carries
one — and the sentence went in. It is a real selling point for this audience;
it is worth keeping true. `npm run security-probe` checks the live list for it.

**The Bò đỏ tag is named, deliberately.** It leads, in fact — it is the mark and
the headline. Naming a politically-charged category invites review attention and
coordinated user-reporting that "scam" does not; the reviewer notes in §4 should
say plainly what the phrase means, so nobody has to infer it from a cow.

### URLs

| Field | Value |
|---|---|
| Homepage | `https://github.com/nsc55/CloneBlocker` |
| Support | `https://github.com/nsc55/CloneBlocker/issues` |
| **Privacy policy** | `https://cloneblocker.tree55.com/privacy` — see §5 |

---

## 4. Privacy tab

Every field here is mandatory, and the store states plainly that a listing
whose privacy fields contradict the extension's actual behaviour may be
removed. These are written to match the code.

### Single purpose (1,000 max) — 963 used

The statement has to cover everything a reviewer can find in the product —
both switches, the report sheet, the tag boxes in Settings — and carry the
public-page disclosure, which must not first appear as a surprise. So it is
written to spend the field rather than fit a sentence into it; if the cap
turns out smaller than the researched 1,000, the first sentence (197) stands
alone. Paste it as the three paragraphs below.

```
Clone Blocker has one purpose: block — and optionally hide — fake and abusive
accounts on Facebook and Threads, working from one shared, human-reviewed
blocklist fetched from a compiled-in address.

Everything in it serves that purpose. Reporting is how an account gets onto
the list: the user files a report — optionally blocking it for themselves
right away — and nothing reaches the shared list until a moderator approves
it. Blocking and hiding are how the list is applied: blocks go through the
sites' own block mechanism, paced and capped by user-set limits; hiding (off
by default) happens locally and sends nothing. Listed accounts are tagged —
clone, impersonation, scam, harassment, spam, bò đỏ (state-aligned troll
accounts), other — and the user picks which kinds get blocked.

Some reported accounts are also named on a public page run by the same
project — only when a moderator opts that specific account in, never with
anything about the reporter.
```

Hiding, blocking and reporting are one purpose, not three, and the statement
is built in that shape: reporting is how an account gets onto the list,
blocking and hiding are how the list is applied. Nothing in the extension
serves any other end.

Two wordings are deliberate:

- **It names the tags, bò đỏ included.** §7 decided the listing leads with
  the red cow, so the shop window already says it: a purpose statement
  narrower than the listing would read as evasion, and the tag boxes sit in
  Settings under "Which kinds get blocked" for any reviewer to find. An
  earlier draft said only "accounts that impersonate the user", which stopped
  being the whole truth the moment the vocabulary grew past clones. The gloss
  is deliberately behavioural — *state-aligned troll accounts* — because the
  category is a posting behaviour, not a nationality, and this field is the
  first place a reviewer tests that.

- **The public page is disclosed in the field itself**, even though no
  extension code touches it. Some *reported* accounts are named at
  `https://cloneblocker.tree55.com/list`, and a reviewer who reads the privacy
  policy will find that page. The distinction that matters in a review
  dispute is that publication is about the **reported** account, never the
  **user of the extension**: a user who installs it and files reports has
  nothing published about them under any circumstances, and a user who files
  nothing sends nothing at all.

### Permission justifications

Three fields in the dashboard — one per API permission, plus a single field
covering every host pattern — each capped at 1,000 characters like the
purpose field. Written to match the code, and two claims from an earlier
draft died on that check: `alarms` does **not** pace blocks (the only alarm
is `cb-refresh-blocklist`; pacing is the gate in the service worker, held in
storage and driven by tab requests), and the list is **not** read from
Firestore any more (`LIST_URL` is the Hosting CDN snapshot; Firestore is
where reports are written). A justification the code contradicts is exactly
the mismatch the store says gets a version rejected.

**`storage` — 714 used**

```
Keeps the extension's working data in Chrome's extension storage: the user's
settings (blocking switches, pacing caps, tag filter, hiding, language); the
cached blocklist, so the list is not re-fetched on every page load; the
block queue, activity history and pacing timestamps that hold blocking to
its hourly ceilings; a local id-to-username cache, built from profiles that
appeared on pages the user visited, for matching listed accounts when a page
shows only one of the two; captured block-request templates, only if the
user enables that option; and the one-time flag that keeps the welcome page
from reopening. Nothing in storage is transmitted anywhere by the extension,
and uninstalling removes all of it.
```

**`alarms` — 356 used**

```
One repeating alarm, and nothing else: it refreshes the blocklist on an
hourly schedule, so moderator decisions — new approvals and removals — reach
every install. A Manifest V3 service worker is shut down between events, so
chrome.alarms is the supported way to make a periodic refresh fire. No other
alarm exists and no other feature uses the permission.
```

**Host permissions — 940 used**

```
facebook.com, threads.net, threads.com — the two sites the extension works
on (Threads has used both domains). Content scripts run here to find listed
accounts on the page, hide their content when the user turns hiding on, and
issue blocks through the site's own in-page block mechanism. Filing a report
reads the user's own numeric account id from the page, hashed in the browser
into the reporter pseudonym.

firestore.googleapis.com, cloneblocker.tree55.com — the backend. The
published, human-reviewed blocklist is fetched from the Hosting origin as a
CDN-cached static file; reports the user files are written to the project's
Firestore REST endpoint. Both addresses are compiled in, which is why they
are required rather than optional: nothing for the user to type, no
permission prompt anywhere in the product.

The whole manifest is two API permissions (storage, alarms) and these five
patterns — no tabs, no activeTab, no scripting.
```

The blocks are meant to be checked against `manifest.json` rather than
trusted: **two** API permissions, `storage` and `alarms`; **five** host
patterns, `*.facebook.com`, `*.threads.net`, `*.threads.com`,
`firestore.googleapis.com` and `cloneblocker.tree55.com`; and no
`optional_host_permissions` block at all, which is why there is no prompt
anywhere in the product. There is deliberately no `tabs` permission: the popup
and the activity page ask `chrome.tabs.query` whether a Facebook or Threads tab
is open, and the host permissions the extension already holds for those two
sites are what makes that answerable without a broader one.

### Data collection disclosures

Tick these, and be prepared to explain each:

| Category | Collected? | What, and why |
|---|---|---|
| Personally identifiable information | **Yes** | A pseudonym of the user's own Facebook/Threads numeric account ID, sent with a report only. Necessary so that reports can be weighted by the reporter's track record and so a single account cannot flood the queue. The ID is hashed in the browser (truncated SHA-256) before sending; the raw ID never leaves the machine, and the report store is readable only by the backend owner under Firestore security rules. |
| User activity | **Yes** | The reports the user chooses to file: the reported account, the reason (one of seven tags), an optional note, optional links to posts. |
| Website content | **Yes** | Only what the user attaches to a report — public post URLs and an optional short quote of the content they are reporting. If a moderator later opts the *reported* account in to the project's public page, those links and quotes can appear there; the user's note never does, and nothing identifying the reporter ever does. |
| Location | **Yes, coarse** | Two things, and only ever attached to a report — never to a list fetch. (1) IANA time zone and BCP-47 language from the browser, sent only when **Send my time zone and language** is on. (2) A two-letter **country**, resolved at the network edge from the address the request came from; this one is server-side, so no user setting declines it. No geolocation API and no geo database, and the IP address itself is never stored — rate limiting keeps only a hash of it under an hourly-rotating salt, in a counter table that expires. Shows the reviewer where a reported clone is active; the ranking of which clones to block is computed locally in the user's browser and sends nothing. |
| Authentication information | No | |
| Financial / health / personal communications | No | |

The country in the Location row is the one item here a user cannot switch off,
because it is derived from the connection rather than sent by the browser. It
is deliberately no finer than a country, it is never joined to an address, and
the address it came from is not kept. Say so plainly if asked: a reviewer who
finds a geolocation claim that the privacy policy does not match will be right
to reject the listing, and the honest version is not a hard sell.

None of it is sold, rented, or used for anything but review. The one route by
which any of it becomes public is the transparency page described under Single
purpose, and that route is closed to everything in the first and last rows of
this table: the reporter pseudonym, the time zone and the language are
admin-only by construction and are never published, not even in aggregate — the
page carries how many different people reported an account and nothing else
about them.

### Limited Use certification

You must certify that the data is used only for the disclosed single purpose.
That is true here — it goes to the one backend the extension is built against
and nowhere else, and there is no analytics, telemetry, ad network or
third-party endpoint anywhere in the code. Grep it: the only network
destinations are the two Meta origins and the `LIST_URL` constant in
`src/common/protocol.js`.

### Notes for the reviewer

This field matters because the extension's effect is only visible on Facebook
and Threads. Suggested text:

```
The extension works on install with no configuration: it ships pointed at
our Firebase project's public, read-only blocklist, and the backend origins
it needs are declared as required permissions, so there is no setup step and
no permission prompt anywhere in the product.

Please note that content hiding ships DISABLED. A fresh install blocks but
does not hide, so nothing visibly changes on the page until you turn hiding
on — Settings > Advanced > "Hide their content" > Enable hiding. With that
on, content from any listed account disappears on the next page load.

To exercise it end to end:
  1. Install it, then load Threads (threads.com) or Facebook.
  2. Switch hiding on as above to see the list applied to the page. Hiding
     runs entirely in the browser and sends nothing.
  3. The list is served read-only from Firestore's public REST endpoint at
     (retired) https://firestore.googleapis.com/v1/projects/clone-blocker2/databases/(default)/documents/blocklist/current
     — open it in a browser to see the exact bytes the extension fetches.
  4. Settings > "Dry run" resolves a real block and sends nothing, if you
     want to watch the blocking path without changing an account.

Real blocking is on by default but tightly paced, and the user picks where it
may look. Two independent tick boxes, both on by default: "Block clones I run
into" covers profiles that appeared on the page in front of them, at a human
rhythm; "Work through the list too" additionally blocks accounts from the
published list, paced 20-45s apart and held under the same overall ceiling of
15 blocks an hour. Either can be turned off
without the other. Blocking of any kind runs only while a Facebook or Threads
tab is open — the block is issued by the site's own code, from a content script
— and the pace is held by one gate in the service worker covering the whole
browser, so several open tabs do not block any faster than one. Settings also
carries a tick box per kind of account (clone, impersonation, scam, harassment,
spam, other), so a user can narrow what a block is ever spent on.

The extension is in English and Vietnamese and follows the browser's own UI
language; launching Chrome with --lang=vi shows the Vietnamese build of every
screen.

Our privacy policy mentions a public page that names some REPORTED accounts.
That page is served by our Firebase project, not by the extension: no code in
this upload reads it, links to it, or sends anything to it, and nothing about
a person who uses the extension is ever published on it.
```

That list of tags stops at "other" and does not name `redbull`, for the same
undecided reason §3 does not — and the reviewer-notes field is read by exactly
the audience the concern is about. If the owner decides the tag belongs in the
listing, it belongs here too, and both change together.

---

## 5. Privacy policy

Required, because the extension collects user data. It must be a live URL in
the dashboard field.

**Use `https://cloneblocker.tree55.com/privacy`.** The project's own Hosting
serves the policy in English and Vietnamese — the bare URL opens in English,
which is what a reviewer needs, and the toggle (or a choice remembered from
the register page) switches it. `PRIVACY.md` in the repository root stays the
policy of record: the page mirrors it, and `tools/check.js` fails the build
when the two "Last updated" dates disagree, so neither can move without the
other. Terms (`/tos`) and an FAQ (`/faq`) sit beside it, and the register
page links all three from its footer.

The page must actually be deployed before the URL goes into the dashboard —
`npm run deploy` — and the URL is worth opening in a clean browser first.
GitHub's render of `PRIVACY.md` remains a working fallback
(`https://github.com/nsc55/CloneBlocker/blob/main/PRIVACY.md`).

---

## 6. Where this could be rejected

Ordered by how likely it is to actually happen. None of these are fatal, but
pretending they are not there would waste a review cycle.

### a. A reviewer installs it and nothing happens — *most likely*

A fresh install fetches a real list, but hiding ships **off** and blocking is
silent and paced, so there is nothing on screen for a reviewer to point at in
the first minute. This is a common rejection reason and it is not really a
policy problem, just an unlucky first impression.

**What now answers it: `src/welcome/welcome.html`.** Installing opens it in a
tab, once. It teaches exactly one thing — find the profile, click the block
button, it is blocked — and then says what approval leads to, which is the
product. A reviewer who reads it knows what to try within thirty seconds, and
the two buttons on it open Facebook and Threads so they can try it without
typing an address.

It fires from `chrome.runtime.onInstalled` only when `reason === 'install'`,
and is additionally gated on a `welcomedAt` flag in `chrome.storage.local`.
The flag is what stops an unpacked reload — which reports itself as an install
— from opening a tab every time somebody saves a file. Local storage is wiped
on uninstall, so a genuine reinstall does show it again, which is right.
`chrome.tabs.create` needs no permission beyond what the manifest already
declares, so this added nothing to the permission list.

**One more `chrome.tabs.create`, and why a reviewer will not see it fire.**
The `experimentalOwnTab` option lets the extension keep one pinned background
tab on Facebook or Threads when it has approved accounts to block and nobody
is browsing — blocking runs through those sites' own code, which only exists
in an open tab, so without one the queue simply stalls. The tab is pinned and
persistent rather than opened and closed per batch, and closing it by hand is
respected: it reopens once after a minute, then backs off to five, thirty and
sixty as it is closed again, and after a fifth close it switches the option
off by itself. It ships **off**: the
setting is resolved from the manifest, and Chrome only omits `update_url`
for an unpacked build, so a store install answers "off" and a reviewer never
sees a tab open. It still costs no permission, and it is disclosed in the
privacy policy under *Performing a block* because a user can switch it on.

The reviewer-notes text in §4 still matters for the hide switch. If it gets
rejected on these grounds anyway, the cheapest answer is a listing screenshot
of a real feed with hiding on, not a change to the defaults.

### b. List-nominated blocks and "related user action"

Store policy is explicit that an extension must not send messages for the user
without a chance to confirm, and requires related user action before each
injected affiliate link. Blocking is neither of those things — but it is an
action taken on a third-party site on the user's behalf, and blocks that the
user never saw coming are the closest thing here to that pattern.

What argues for it: the cold ceiling defaults to 4/hour; the user sets every
cap; the two switches are the first thing on the options page, and unticking
**Work through the list too** turns list-nominated blocks off in one click while
leaving everything else working. Blocking itself is ON by default (an owner
decision, 2026-08-21), so the per-account pacing and that visible choice are
the whole defence in a review dispute.

What argues against it: **`blockFromList` ships ticked**, so the trending
metadata published with the list can put an account the user has never seen
into the queue, and it will be blocked without a per-account confirmation.
(The ranking itself runs locally in the extension, but the effect a reviewer
would care about is the same: the list's publisher chooses candidates the user
never looked at.)

**Worth considering before submitting:** ship `blockFromList` **unticked**,
leaving `blockSeen` on. Then every block in a default install traces to a
profile the user looked at, and working through the list becomes something they
opt into knowingly. It costs little — a user who wants the list worked through
is exactly the user who will find the switch, since it is the first control on
the page. This is a cleaner change than it was under the old mode picker: the
two switches are independent, so turning one default off does not quietly turn
anything else off with it.

### c. Meta's terms of service — *the risk that is not ours to fix*

Facebook and Threads terms prohibit automated interaction with their services.
This extension drives their own in-page block operation, which is a much
gentler thing than a scraper, and it exists to protect users from
impersonation — but it is still automation of a Meta account.

Store policy forbids infringing third-party rights and interfering with
third-party infrastructure. Google does not generally police a platform's ToS
on that platform's behalf, but it does act on complaints. If Meta complains,
the listing goes. That risk cannot be engineered away while the extension
blocks anything, and it is worth going in with eyes open rather than being
surprised by it.

### d. The public page, read as part of the product

The privacy policy discloses that the same backend names some reported accounts
on a public page. No code in the upload touches it — but a reviewer reads the
policy, and "this developer publishes a list of named people" is a sentence that
can attract questions the extension itself would never raise.

What answers them: publication requires a person to opt each account in
individually, and approving a report never publishes anyone; the page carries no
reporter identity of any kind; every published claim is backed by an `https`
link to the post it rests on, or it is not published at all; the page says in its
own words that it is one person's judgement rather than a ruling by Facebook or
Threads; and it prints a removal address. The disclosure is deliberately in the
policy rather than left to be discovered — a reviewer finding it themselves
after it was omitted is a much worse conversation.

### e. List-supplied `docIdOverrides`

The blocklist response may carry `docIdOverrides`, which changes which
persisted GraphQL operation the extension calls. This is configuration data,
not code, and MV3's rule is about executing remotely-hosted *logic*. But it
does let whoever publishes the list change what a request does, and a
thorough reviewer may ask.
The answer is that the operation is always one the page itself already
exposes, and the override only selects among them — say so if asked.

---

## 7. Pre-submission checklist

- [x] Manifest V3
- [x] `name` ≤ 45 (12)
- [x] `description` ≤ 132 (120 — it was 135 and would have been rejected at upload)
- [x] Icons 16/32/48/128 present and referenced
- [x] Store icon with the 96-in-128 transparent frame
- [x] Small promo tile 440×280
- [x] Marquee tile 1400×560
- [x] At least one 1280×800 screenshot (two)
- [x] First-run guide opens on install and says what a report leads to (§6a)
- [x] No real accounts, real names or real reports in any asset
- [x] Privacy policy written and in the repo
- [ ] Developer account registered, $5 paid, email verified
- [ ] Trader / non-trader declared
- [ ] Privacy policy URL pasted into the dashboard
- [ ] Single purpose, permission justifications, data disclosures filled in
- [ ] Limited Use certification ticked
- [ ] Reviewer notes pasted
- [ ] Confirm the defaults for the two switches: `blockSeen` and
      `blockFromList` both currently ship **on** (§6b)
- [x] Decide whether the `redbull` tag is named in the listing copy (§3) —
      **decided: yes, it leads.** The mark is a red cow, the tiles and both
      screenshots run the *bò đỏ* joke in Vietnamese, and the reviewer notes
      should say plainly what the word means: internet slang for paid
      pro-government commenters, aimed at a posting behaviour and not at any
      nationality. Reviewers should not have to work that out from a cow.
- [ ] Localise the listing itself into Vietnamese in the dashboard (§3); the
      in-extension strings are already there
- [x] `_locales/en` and `_locales/vi` at key parity, checked by `check.js`
- [x] Store assets regenerated — the drawn explainer that said "two modes" is
      gone entirely, and the listing is down to one poster and one real
      capture (§2)
- [ ] `npm test` green, then `npm run pack`

### Building the upload

```
npm run pack        # -> dist/clone-blocker-<version>.zip
```

**The store takes a ZIP, not a CRX.** A CRX is the self-hosting format: it
carries a signature made with a key you generate, and the extension id is
derived from that key. The store issues its own key and its own id, so a CRX
is rejected at upload — and generating one locally would only create a private
key somebody then has to keep safe, for no benefit. (If you ever want one for
sideloading, `chrome.exe --pack-extension=<dir>` makes it from the same files.)

`tools/pack.js` includes an **allowlist** — `manifest.json`, `src/`, `icons/`,
`_locales/` — rather than the tree minus exclusions. That is everything the
extension loads and nothing else. An exclusion list is the wrong way round for
this job: it ships whatever nobody thought to name, and the things nobody
thinks to name are exactly the `.env` files and the keys. The backend and the
tooling are for you, not for Chrome, and shipping them only widens what a
reviewer has to read. `_locales/` is not optional: a manifest declaring
`default_locale` without it is refused at load, so an upload that leaves it out
fails before anyone reads a line of it.

It refuses to write anything unless all of this holds:

- `tools/check.js` passes (pass `--skip-check` only if you know why)
- `manifest_version` is 3, the version is a store-legal dotted integer, and
  there is no `key` or `update_url` — both fight the id the store assigns
- every locale defines `appName` and `appDesc`, within 45 and 132 characters.
  The store reads the listing name and description straight off the manifest,
  so a `__MSG__` that does not resolve ships an empty listing in that language
- every path the manifest names is actually in the zip, and every
  `web_accessible_resources` glob matches something
- no shipped file contains a value read out of `.env`, a token or key shape, a
  `localhost`/`127.0.0.1` address, or the emulator project id
- the built-in list URL is `https` and points at production

The zip is deterministic — entries sorted, timestamps fixed — so the same tree
builds byte-identically and the printed sha256 is worth comparing.

`dist/` is gitignored. A stale zip in the tree is a zip somebody eventually
uploads by mistake.

---

## Sources

- [Supplying Images — Chrome for Developers](https://developer.chrome.com/docs/webstore/images)
- [Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Chrome Web Store Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Policy updates effective 1 August 2026](https://developer.chrome.com/blog/cws-policy-updates-2026)
- [Listing Requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements/)
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Privacy Policies](https://developer.chrome.com/docs/webstore/program-policies/privacy)
- [Disclosure Requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements)
- [Trader/Non-Trader identification and verification](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure)
- [Register your developer account](https://developer.chrome.com/docs/webstore/register)
- [Review process](https://developer.chrome.com/docs/webstore/review-process)
