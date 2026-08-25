# RFC 009 — Finishing the last mile

Status: **Phases 0, 1, 2 and 3.1–3.2 built; 3.3 and 4 to 6 proposed** · Owner: — ·
First drafted 2026-08-24 ·
Arises from a full audit of the running application (built from a checkout,
paired to a real screen, measured in a browser at six widths) rather than from
a new feature

## Summary

The hard parts of this product are done. Correct RFC 5545 handling, a
DNS-pinned SSRF guard, secrets at rest, a read-only integration boundary,
signed reproducible multi-arch images, offline degradation — all of it is built
and most of it is better than the category norm. What is missing is the last
mile: **a default that works before it is configured, one word per thing, an
admin that answers back, and an editor that is safe to touch.**

This RFC turns thirty-eight audited findings into seven phases, each
independently shippable. It is deliberately not a redesign. The visual language
is right, the architecture is right, and the writing — the error messages, the
empty states, the helper text — is the product's most underrated asset. None of
that is on the table.

The ordering has one rule behind it: **Phase 0 exists because every finding in
this RFC came from a region of the codebase no test can reach.** Fixing the bugs
without fixing that guarantees the next audit finds the same class again.

---

## What the audit actually found

Three sentences, because the detail is in the phases.

**The first impression is broken in four small, independent ways** — an
unreadable agenda, two placeholder widgets, a timezone from West Africa, and a
wall that draws black if it is reloaded before it has ever been reloaded.
**One object has five names** — Display, Screen, Wall, Canvas, Panel — mixed on
a single page, and one name covers two objects. **And the admin cannot tell you
what happened**: no save confirmation anywhere, no dirty state outside the
editor, no undo, and a navigation guard that stands down on exactly the event it
exists for.

Everything else is smaller than those three.

One correction worth carrying forward, because it changes how the offline work
is scoped. The audit first filed the black wall as permanent. It is not: the
fetch handler back-fills the cache with any successful response
(`sw.ts:118-131`), so the first reload the worker *controls* repairs it.
Measured against a real killed server — after load 1, eleven cached entries and
a black screen; after load 2, fifteen and a correct wall with the offline banner.
The window is real, recurring on every new screen, and bounded.

---

## Phase 0 — A test that opens a browser

**Goal: make the next fault findable by something other than a person looking
at a wall.**

There is no DOM environment anywhere in this repository. No Playwright, no
Puppeteer, no jsdom, no happy-dom, and neither package configures a vitest
environment. The display's tests import only its pure modules, which leaves
**6,727 lines imported by zero test**: `render.ts` (2,086), `layout-editor.ts`
(3,016), `main.ts` (505), `display-editor.ts` (377), `ha-entity-picker.ts`
(263), `theme-editor.ts` (214), `template-gallery.ts` (133), `sw.ts` (133).

That is the region every finding in this document came from, and `CLAUDE.md`
already says so in its own way — sixty-two bugs, and the sharpest ones found by
*looking*, by *measuring the DOM*, by *killing the server*, by *decoding a QR
with a real detector*. The project knows the lesson. It has never had the
harness.

**Not a suite. Five tests.**

1. **The offline wall.** Boot, pair a screen, load it, reload it once online,
   block the network, reload again, assert `#wall` is non-empty. Then do the
   same with only one online load — that is the failing case today, and it is
   the regression test for 0.1.
2. **The first-run wall.** Complete the wizard with a single feed and nothing
   else, render at 1080×1920, 1920×1080 and 1280×720, and assert two things:
   nothing overflows the viewport, and **no text renders below a floor
   proportional to the canvas**. The second assertion is the one that would have
   caught the 4.7px agenda, and it is the shape of the check `density.ts`
   already argues for in prose.
3. **The wizard, clicked through.** Enter the code, create an account, accept
   every default, skip the calendar — then assert the stored timezone is not
   whatever happens to sort first.
4. **The editor, driven.** Select a widget, drag it, save, reload, assert it
   moved. Then drag one and navigate away, and assert the guard fired.
5. **A phone.** 390px, tap the hamburger, assert the drawer opens and the first
   content control is above the fold.

**Where it lives.** `apps/display` gains a dev-only DOM environment. jsdom is
enough for structure, focus and tab order; the measurement tests need real
layout, so they need headless Chromium. Both of the faults `CLAUDE.md` records
in the editor redesign — `visibility` computing `hidden` at transition progress
zero, and a canvas sitting behind a sheet — are real-layout faults that jsdom
would sail past. Use Chromium for the measuring tests and do not pretend
otherwise.

**Verification bar.** Break each of the five deliberately and watch it go red.
That is the standard `migration-upgrade.test.ts` and `epaper-ladder-parity.test.ts`
were both held to, and both earned it.

**Risk:** low, and entirely in CI time. The performance budget already failed
once on a machine that was not the author's; a browser in CI is the same class
of exposure and worth the same care.

---

## Phase 1 — Correctness

**Goal: nothing the product does is silently wrong.**

Ten changes, all small, all independent, none of them a design decision. They
are grouped only because they should ship together.

### 1.1 Derive the offline shell from the build

`sw.ts:49` lists eleven URLs by hand. `render.js` imports `density.js`,
`ladder.js` and `widget-options.js`, none of which are in the list, so a wall
reloaded before its first controlled online reload draws nothing.

Adding the three names fixes today and not the next module that gets split out.
**Generate `SHELL` at build time by walking the `import` graph from
`dist/main.js`**, and add a parity test asserting every reachable module appears
in it — both directions, the way the migration journal check works. The list has
drifted three times already without anybody noticing; a list nothing derives will
drift a fourth.

### 1.2 The timezone select must never render with nothing selected

`Intl.DateTimeFormat().resolvedOptions().timeZone` returns `'UTC'` in a
container with no `TZ` — which is what `docker run` does, as written in our own
README. `Intl.supportedValuesOf('timeZone')` returns 418 canonical zones and
**neither `UTC` nor `Etc/UTC` is among them**. So `zone === selected` never
matches, no option carries `selected`, and the browser picks the first
alphabetically. A household who clicks straight through gets `Africa/Abidjan`
stored, and every event on the wall lands four hours out.

Two changes. Normalise before comparing, and **treat an unmatched detection as a
bug rather than a default**: if nothing matched, select `Etc/UTC` explicitly.
Then put the detection in a hint above the control — "Detected: UTC. Change it
if this wall is somewhere else." — because a preselected value with no
explanation is a value nobody checks.

### 1.3 The calendar gets a legibility floor

`minScaleFor` (`render.ts:1869`) protects a note at 0.3, a weather reading at
0.4 and a chore board at 0.62, and drops the calendar through to `default: 0.2`
— the lowest floor in the system, on the one thing the product exists to show.
Measured on the seeded default layout: 7.2px event times on a 1080p television,
**4.7px on a 720p one**, uniformly 2.5× smaller than everything else on the same
wall. `render.ts:1739` already calls `minScaleFor('calendar')` against a switch
with no `'calendar'` case, which is somebody's intent left unfinished.

One caveat, stated because the obvious argument for this fix is wrong.
`display.css:92-95` explicitly exempts "the compact widget renderings that
`fitToBox` already scales" from the `--t-micro` floor, naming the function. So
this is *not* a violation of the type floor; the floor never claimed to survive
the transform. What it is: `minScaleFor` is the thing that bounds how far the
exemption goes, and `MIN_CHORE_SCALE` already settles what the right bound looks
like — 0.62 rather than 0.3, with a measurement table, because 0.3 produced
8.1px chore names and the verdict was *"that is not small, it is gone"*. A 4.7px
event time is the same judgement one widget along.

**Add `case 'calendar'` with its own measured constant in `density.ts`, beside
the others, with its table** — and teach the agenda to trim to whole days and
re-fit, which is exactly what the chore week board does. Fewer days drawn larger
beats every day drawn invisibly. This changes every wall already hanging, so it
is the one item in Phase 1 that needs the Phase 0 measurement test in front of it.

### 1.4 Dismissals are scoped to their source

`pruneDismissals` (`api/rules.ts:401`) reads **every** row in
`interrupt_dismissals` and deletes any key not in the list it was handed. Its
only caller is the NWS alerts job (`alert-job.ts:144`), which knows only its own
CAP keys, and runs every sixty seconds.

So acknowledging a Home Assistant interrupt, a calendar interrupt or a module
signal is undone within the minute. The garage-open rule is the flagship example
in our own documentation and it is the one this breaks. It is also the same bug
`CLAUDE.md` records finding once already — *"Acknowledging a warning just
promoted the next rule · Pressing OK on a wall and watching nothing happen"* —
arriving through a different door.

Pass the source alongside the keys and delete only that source's dismissals. The
auto-rule id is already colon-free for exactly this kind of reason. Add the test
that dismisses a non-weather interrupt, runs the alerts job, and asserts the
dismissal survives.

### 1.5 A wrong-length key must not exit the process

`loadOrCreateMasterKey` throws when `.secret` is not exactly 32 bytes.
`main.ts:201` calls it unguarded, the throw reaches `main().catch`, and the
process prints a stack trace and exits 1. Under `restart: unless-stopped` or the
supervisor that is an endless loop and a black wall with no message anywhere a
household can read.

The trigger is our own backup: System → Backup hands over a raw 32-byte binary
blob, and a text editor, `echo`, a copy-paste or a sync tool adds a trailing
newline. 33 bytes is the ordinary outcome of following the instructions slightly
imperfectly.

The adjacent case — a *missing* key — is already handled gracefully. Handle this
one the same way: **trim trailing whitespace before the length check**, and on a
key that is still unusable, rename it aside as `.secret.unusable.<ts>`, generate
a fresh one, and push an error-level `ManifestNotice`. The wall then boots, draws
its calendar, and says the feed addresses need re-entering — which is true and
recoverable. Rule nine has no grace period in it.

### 1.6 Restore must accept the key

Backup is two downloads. Restore has one upload, for the database. **No endpoint
anywhere takes the key back.** The key downloads as `maverick-wall.key` while the
keyring reads `.secret` (`keyring.ts:75`), so even a household with filesystem
access must guess the rename, and nothing says so. On the add-on there is no
shell, no editor for `/data` and no Samba share of it, so the documented
procedure is not awkward — it is impossible, and a restore there loses every feed
address permanently with the encrypted column sitting there intact.

Add a key upload beside the database upload, staged identically: write
`restore.secret`, adopt it at boot alongside `restore.db`, keep the old one
aside. Validate 32 bytes before staging, which also closes 1.5 for the commonest
path. Rename the download to `.secret` or state the rename on the page and in
`docs/backup.md`.

A single combined archive would be better than either, and is the thing to build
if this is touched twice. Two files a household has to keep together is a backup
format that fails on the day it is needed.

### 1.7 The unsaved-changes guard must fire on links

`display-editor.ts:350` sets `navigating = true` on **any** link click, and never
sets it back. So the guard only ever protects against closing the tab, and one
stray click disarms it permanently. Observed: drag a widget, click Calendars,
navigate, edit gone, no warning.

Set the flag only in the Save and Discard handlers, which already do. Delete both
document-level listeners. Then, once Phase 5 exists, replace the browser's generic
dialog with a three-way Save / Discard / Stay.

### 1.8 A read action must not perform a write

The eInk list's only control that reveals a panel's frame URL is labelled
"Show URL & recipes" and POSTs to `/regenerate`, which mints a new token and
rotates it (`admin.ts:1755`, handler at `:1856`). It invalidates the URL already
flashed into the household's ESP32. The button beside it, "Remove", is the one
that asks for confirmation.

The cause is that there is no read-only view: the token is only in memory at mint
time, so the only page that can show it is the one that mints a new one. Store
enough to re-render the config page without minting, reach it by GET, show the
token once at creation exactly as wall pairing already does, and put
"Regenerate URL (the panel will need re-flashing)" behind its own confirmation.

### 1.9 The manifest must survive a degraded schema

Boot deliberately continues when migrations fail or cannot take the lock, pushes
a `ManifestNotice`, and carries on — correct. But `requireScreen` then calls
`readScreens` unguarded, every query is written against the newest schema with no
tolerance, and `app.onError` turns the throw into a JSON 500. So the notice
written specifically to explain this can never reach the wall.

A wall already loaded keeps its cached calendar and shows "not reaching the
server", which is the wrong sentence for a database that could not be upgraded. A
freshly loaded one gets 1.1's black screen.

Wrap the screen read and the manifest build, and on failure return a **200
carrying only `notices`**. The wall already knows how to draw one.

**Built, and then corrected — the 200 is for one cause, not for every
exception.** As first written both catches answered the degraded manifest for
*anything* that threw. That body passes `isRenderableManifest`, so the display
takes it as `fresh`, draws it, and then `await store.save(...)` overwrites the
IndexedDB last-good copy: one bug in manifest assembly blanked the wall and
destroyed its cache, and a reload could not get the calendar back. The 200 is
correct only when the **database could not be read** — persistent, no better
data anywhere, and on a never-cached wall the only thing between the household
and 1.1's black screen. Anything else answers 503, which the display's `failed`
branch already handles by keeping the last manifest and saying how old it is.
The class is read off the error's SQLite `code` rather than its message, so
corruption and `SQLITE_NOTADB` are inside it and `SQLITE_BUSY`/`SQLITE_LOCKED`
— the two that clear on their own — are outside, matched as prefixes because
better-sqlite3 reports SQLite's extended code (`SQLITE_BUSY_SNAPSHOT` is what a
CLI tool holding a lock actually raises). One further correction belongs to this
section rather than to the narrowing: the fallback token lookup answered **401**
when it too could not read, and a display reads 401 as `unpaired` and draws the
code-entry form — so a corrupt database put a pairing form on every screen in
the house. A check that could not run may not say "not paired"; it says "not
now". And `degradedManifest` itself
is wrapped: it calls `now()`, so a failure systemic enough to reach it took the
safety net down too and produced the bare 500 this section exists to remove.

### 1.10 Documentation that is false

Three, all small, all corrosive because they sit in the places written to be
trusted.

- **`TRUSTED_PROXY_SOURCE` and `INGRESS_TRUST_SOURCE` are in no document.**
  `docs/environment.md` lists six variables and opens with "Every one is
  optional", implying completeness. `forwarded.ts` is correct — trusting a
  forgeable header on a LAN-exposed port would be the bug — but its one required
  input never reached the docs, so the Caddy recipe in
  `docs/exposing-safely.md` produces cookies without `Secure` on a site
  deliberately put behind TLS. The same page tells the household to add
  `header_up X-Forwarded-For {remote_host}` "so rate limiting counts callers
  separately"; **`X-Forwarded-For` is never read anywhere in the codebase**, so
  that line achieves nothing and every caller behind the proxy shares one bucket.
  Document both variables; delete the dead line or honour it from a trusted
  source. Better: log once when a proxy header arrives from an untrusted source,
  naming the address to add.
- **The README's "Honest limitations" is false in three places.** "There is no
  native app yet" and "that needs the Android app, which does not exist yet" —
  `apps/android/` is a full Gradle project and `release.yml` attaches a signed
  APK to every release. "A WebSocket channel is specified and not built" —
  `net/push-hub.ts` is a real server, wired into boot and tested; it is the
  browser display's client half that is unbuilt. A section whose entire value is
  being trustworthy has to be true.
- **`docker-compose.yml`'s healthcheck uses `wget`**, which is not in
  `node:22-bookworm-slim` — the Dockerfile says so twice and probes with `node`
  for exactly that reason. Compose users get a permanently unhealthy container
  serving every request correctly, under a comment claiming it matches the
  image. Delete the block; compose inherits the image's own.

### Verification bar for Phase 1

Every item gets a test, and each test is checked by breaking the fix. The two
that need more than a unit test: 1.1 needs the Phase 0 offline test, and 1.3
needs the Phase 0 measurement test. 1.6 should be exercised end to end — back up,
wipe, restore both files, assert a feed still syncs.

---

## Phase 2 — The first five minutes

**Goal: a wall that is worth looking at before anybody configures it.**

This is the phase that matters most and the one with the least code in it.

A fresh install seeds a five-widget canvas — Clock, Shift, Weather, and two
Calendars — while `weather_enabled` and `alerts_enabled` default to `1` and
`latitude`/`longitude` default to `NULL`, and the wizard never asks for a
location or a person. So two of the five widgets, occupying **24% of the portrait
canvas**, render "Nothing to show yet." forever. With 1.3 fixed the agenda
becomes readable; the wall is still 60% empty.

**Three changes, in this order.**

1. **A widget with no data and no configuration yields its space.** Have
   `buildManifest` omit it rather than emit a placeholder. An unconfigured
   Weather widget should not be a sentence on a wall; it should be absent, and
   the Walls screen is where a household finds out why. The placeholder stays
   for a widget that *is* configured and has no data right now — "the feed is
   empty today" is information, "you never set this up" is not.
2. **The Overview must not claim to be working.** `admin.ts:632` reports zero
   zones as *"on, working out your zones"*. Nothing is being worked out and
   nothing ever will be. Read the location and say "On — needs your location",
   linked. This is a two-line change and it is the difference between a status
   line and a lie.
3. **The wizard gains a fourth step, skippable: where and who — decided.** A
   location for weather, and the household's first person. Both are
   prerequisites for widgets the default wall already contains, and today the
   product ships them armed and silent. Skipping is fine — the wall then omits
   those widgets per (1) rather than showing placeholders. Four steps is more
   than three, and the alternative considered was defaulting weather and alerts
   to off until a location exists; that was rejected because it leaves a US
   household to discover a screen nothing points them at, for the one feature
   with a life-safety disclaimer attached to it.

**Do not ship weather alerts armed with no zones.** The fourth step is how that
is answered; a household who skips it gets no armed rules until a location
exists. Five interrupt rules
enabled against zero zones is a safety-adjacent feature reporting itself as
working while inert, and that is worse than off.

**Verification bar.** The Phase 0 first-run test, extended: complete the wizard
with one feed and nothing else, and assert the rendered wall has no
"Nothing to show yet." in it and no region larger than a quarter of the canvas
with no ink in it. The second half of that is harder to write than it sounds and
is worth the argument.

---

## Phase 3 — The admin answers back

**Goal: the household always knows what happened, and destructive things look
destructive.**

Three primitives. Together they answer the three questions this admin cannot
currently answer: *did that save?*, *can I undo this?*, *is this button
dangerous?*

### 3.1 One confirmation strip — **built**

There are 79 `c.redirect(...)` calls across the admin and no flash mechanism
anywhere. Every successful POST redirects and says nothing, so the only evidence
a save worked is that the fields happen to show the new value — which is also
exactly what a *discarded* save looks like. The Weather screen proves it: two
independent forms, two buttons both labelled "Save" 350px apart, and the lower
one sits directly beneath the hint telling you to fill in the upper one. Typing
coordinates and pressing the wrong Save loses them silently.

Redirect to `?saved=<field>` and have `page()` render a dismissible strip in an
`aria-live="polite"` region. One helper, one CSS role, applied at every 302, no
script. While in there: **the Weather screen becomes one form with one Save.**
Two forms on one page is an implementation detail the household is being asked
to model.

**Built.** `http/saved.ts` holds the mechanism: `savedRedirect(c, path, key)` is
the drop-in for `c.redirect(path, 302)`, `readSaved(c)` reads it back, and
`page()` gained a `saved` option that draws the strip. Three properties are what
make it a one-token change at the remaining call sites, and worth keeping:

- **The token is a key, never a message.** Nothing a caller passes is echoed —
  the strip draws a literal out of `SAVED_MESSAGES` — so there is no escaping
  question to get wrong and a crafted `?saved=` can say one of those sentences
  and nothing else. Rule five is satisfied by the shape rather than by a
  validator.
- **The key is a TypeScript union**, so a typo is a compile error rather than a
  302 that silently confirms nothing, which is the failure mode this exists to
  end.
- **Dismissing is a link** back to the same URL without the parameter, keeping
  whatever else the query held. It is relative, like everything else the admin
  emits, because the single `<base>` is what carries it through ingress — an
  absolute `/…` would land a sidebar household in Home Assistant's own UI.

The Weather screen is one form. The data loss was reproduced first, in a real
browser (`browser-admin.test.ts`), because it is a *browser* fault and not a
handler one: every handler did exactly what it was asked, and what lost the
coordinates was that a browser sends the fields of the form whose button was
pressed and no others. `app.fetch` with a hand-built body cannot see that,
because the body is the thing under test. **"Use my Home Assistant home
location" is now a second submit inside the one form** (`formaction`) rather
than a form of its own, so it carries the unsaved fields and puts them back —
a separate form there would have been the same bug in a quieter costume.

**And the 400 path was the same loss one error message along.** The screen
re-rendered from the stored row, so a mistyped latitude came back as an empty
field — and once the alerts switch shares the form, it would have taken that
with it. Every failure now echoes the raw body back (`WeatherEcho`), the way
`calendarsPage` already did, so the only thing a refusal costs is the number
that was wrong.

Three faults came out of merging the two forms, and all three are the same
shape — a property the *browser* has that neither handler can see:

- **Enter in Latitude filled the location instead of saving it.** Implicit
  submission activates the first submit button in tree order, and the Home
  Assistant button is a submit now — so pressing Enter after typing a number
  replaced it with `zone.home` and reported it as saved. `defaultSubmit()` is a
  clipped, untabbable, `aria-hidden` submit rendered first: it is what "press
  Enter" means, and it is the spec's own answer rather than a workaround.
- **An unticked checkbox is not sent**, so an empty body and a form with every
  switch off are byte-identical. Harmless while the alerts switch had its own
  endpoint; not harmless once it shares this one, because a page cached from
  before the merge posts a body with no `alerts_enabled` in it. A hidden
  `weather_form` marker is how the form says "this is me, and everything I do
  not mention is off"; `POST /admin/weather` refuses a body without it, and
  `use-ha-location` falls back to the stored row — which is the answer it
  always gave.
- **A form re-rendered at 400 is already dirty**, and only the server knows.
  Booting the script clean disabled Save on the one page where pressing it
  again is the point, hid Cancel, and disarmed the leave guard over unsaved
  edits — worst on an error the household cannot fix by editing a field. The
  form tag carries `data-dirty="dirty"` (`dirtyForm(true)`) when it is handed
  back with an echo.

A second review found five more, and the first is the sharpest thing in this
phase because it was on the *default install*:

- **A fresh household could not touch its alerts switch at all.**
  `weather_enabled` defaults to 1 and a new install has no coordinates, so
  "the forecast is on, therefore demand a location" refused every submission
  with a 400 — and the alerts switch now shares that form. Blank is "not set
  yet" and saves; only a *typed* coordinate that is not one, or one of a pair,
  is refused. Merging two forms merges their validation, and that is the thing
  to check before merging any others in 3b.
- **`use-ha-location` reads a narrower schema than Save.** It replaces the
  coordinates, so a coordinate it cannot parse must not be able to fail it — a
  pasted "51.5074, -0.1278 London" is longer than the field allows, and falling
  back to the stored row would have discarded the edits the button was pressed
  to carry, then redirected saying it had saved them.
- **`POST /admin/alerts` still answers.** Deleting it left a stale page's alerts
  Save getting a bare 404 while the other Save on the same page got the
  considered "out of date, reload". It is not re-honoured — honouring half a
  stale page is how a household comes to believe the stale page works — but it
  says the same thing the other one does.
- **Calendars had the Weather screen's 400 loss too**, and the dirty state made
  it worse: a row redrawn from the database has nothing unsaved and correctly
  greys Save, so an error came with a dead button. `SourceEcho` is the same
  shape as `WeatherEcho`, keyed on the source because one page draws every
  calendar. Driven as a POST rather than in a browser, because `name` is
  `required` and a browser will not submit it empty — the handler is reachable
  from a stale page and the person-is-gone race, not from the form.
- **The clipped default submit is marked `data-dirty-save` too**, so it is
  disabled with the visible Save. Otherwise Enter on an untouched form saved
  and announced it while the Save button sat greyed out beside it.

A third review found two more, one of which had shipped long before this phase:

- **Every "Turn off" in the alert ladder re-enabled its rule.** The card sends
  a *hidden* input (`1` on, the empty string off) and the handler read
  presence-of-key, which is the right reading for a checkbox and the wrong one
  here. 302, no error, and the card came back saying "Turn off" again. Fixed
  here because it is in this file, it is one line, and a household cannot turn
  a level off without it; found by *running* the endpoint, not by reading it.
- **The leave guard latched.** `navigating` was set by a submit and cleared by
  nothing, so on a page with two settings forms — the System screen has two —
  saving one while the other was dirty prompted, and "Stay" left the first
  form's guard dead for the life of the page. It is cleared inside
  `beforeunload` now. Its test asserts on the **URL**, because a prompt count
  cannot tell two forms apart; the first version of it passed with the bug in
  place for exactly that reason.

And a fourth found three places where the strip *lied*, which is the failure
this phase is about rather than a detail of it. **A confirmation that is not
true is worse than no confirmation**, because it is the thing a household will
believe:

- "Sync now" said "Syncing now" for a calendar whose sync switch is off, where
  `ics-sync` skips it outright. It says why instead.
- A failed update check drew the ok-coloured "Checked for a newer version."
  directly above the danger box saying it had failed. It claims nothing now.
- "Calendar removed." was drawn for an id that never existed — a stale tab, a
  second press.
- And a rejected *row* save rendered its reason at the foot of the page under
  "Add a calendar", which was right when that was the only way to fail and
  became a fault the moment the row was echoed back at the top with Save live:
  edits, an enabled Save, and the reason 2,000px below under the wrong heading
  reads as a save that worked.

The generalisation for 3b is worth carrying: **a token is a claim, so check the
branch it is on.** A handler with an early return, a skip, or a "nothing to do"
path needs a different token or none.

And a fifth review closed the loop on that: the first fix for "Sync now" on a
disabled calendar was a *sentence* — "Sync is off for that calendar" — drawn in
the same green strip, in the same shape, as "Syncing now". Every sentence the
strip carries is a confirmation, and there is deliberately no second tone: **the
answer to a control that can do nothing is not to explain it afterwards, it is
not to draw the control.** The button is not rendered while sync is off; the
endpoint keeps the guard for a stale page and claims nothing. It also caught
`writeAll` pulling the NWS zone poll forward on *every* weather save rather than
on the transition to on, which throws away the job's failure backoff — so
changing the units would hammer `api.weather.gov` while it was having a bad
morning.

A sixth found the last two, and both are about a guard or a claim being too
narrow. **The leave guard is one listener for the document**, asking every
form, rather than one each: with a listener each, pressing Save on one of the
System screen's two forms raised the other one's "Changes you made may not be
saved", and answering "Stay" cancelled the save. Pressing Save is not leaving
without saving. And **blank coordinates are "not set yet", not a delete**:
clearing a *stored* location makes `writeWeatherSettings` treat it as a move
and retire every NWS alert zone, un-arming every weather rule — so an empty
pair saves only while nothing depends on it (the fresh install the deadlock fix
is for) and otherwise says what it would cost.

And a seventh caught the echo being applied where it does not belong. **An echo
is the right answer for a text field and the wrong one for a closed list**: a
rejected timezone reaches that branch *because* it is not in
`offeredTimezones()`, so echoing it selects nothing and the browser preselects
whatever sorts first — `Africa/Abidjan`, with a live Save over it, one press
from silently moving the household to west Africa. That is `setup.ts`'s
`detectedTimezoneOption` rule ("never 'nothing'") on a second screen. The
select keeps the stored zone, and the form is then honestly clean.

An eighth found the same two rules under-applied. The leave guard was armed only
by the wired forms' own submits, so **a button beside the form tripped it** — a
settings form rarely has a page to itself (Weather carries five rule cards,
Calendars a Sync now and a Remove per row, every page the sidebar's Sign out),
and changing Units then pressing "Turn off" asked "Changes you made may not be
saved" and cancelled the POST when answered. It arms on a document-level
*submit* now, never a click: 1.7's lesson was a listener on `a[href]` clicks,
and a submit is unambiguous where a click is not (and native validation blocks
the event entirely, so a submission the browser refuses never arms it). And the
Weather form echoed `weather_provider`/`weather_units` raw into two closed
lists — the timezone defect above, latent, since only a body that is not this
form can carry a value that is not an option. Both selects now show what a save
would store.

A ninth reported a third: the submit listener would latch on a *download*,
since a response served as an attachment navigates without unloading. **It does
not**, and the reason is worth more than the fix would have been: `beforeunload`
fires when the navigation *starts*, before the response headers can say
`Content-Disposition`, so the guard re-arms on the way past — and the download
also stops prompting, which it did before the listener existed. A
`data-download` marker was built and then deleted. `browser-admin.test.ts` keeps
the measurement, because the property is real and nothing else pinned it.

A tenth found the last one, and it is the phase's own thesis turned on the fix:
**the dirty flag cannot come from the server alone.** A browser may put edits
back on screen without telling anyone — form-state restoration on a reload, and
on a back/forward that does not come out of the back-forward cache, where the
script's own state would have survived with it. The control then reads "on"
over a database that says off, with Save disabled and the guard down, which is
the "fields show the new value" ambiguity this phase set out to remove.
`looksEdited` measures every control against `defaultValue` / `defaultChecked` /
`defaultSelected` — the DOM's words for what the markup declared, which is the
server's copy — rather than taking the attribute's word for it. Restoration is
*simulated* in the test, and honestly: Chromium under Playwright restores
nothing on a reload (a first version mistook the server's own value for a
restored one; its guard clause caught that), while Firefox does and the spec
permits it, so the switch is flipped from an init script the moment the element
parses — where a restoring browser writes it, before the deferred module boots.
A second test pins the hazard that comes with measuring: a freshly served form
must read as clean, or every settings page arrives claiming edits nobody made —
and that guard earned itself immediately. An **eleventh** review found the false
positive it was written for: `<input type="color">` *lowercases* the value it is
given while `defaultValue` hands back the attribute as written, and the calendar
rows ship `#4C7FD1`, so every unowned row booted dirty. The test had visited
only the two pages with no colour input; it visits Calendars now. The same round
found the merge had made a pre-existing bug reachable — `writeWeatherSettings`
adds the forecast strip to `display_blocks` on `if (settings.enabled)` where the
comment beside it says "enabling is the moment they asked for it", so any later
save with the switch on put the block back on a wall the household had taken it
off, and toggling alerts now routes through there. And the disabled-Save colour assertion was sampling
mid-transition and failing about one run in three; it polls.

A **twelfth** caught the fix for that being wrong in the other direction, and
the pair is the lesson. Gated on the switch's off→on *transition*, the block
would have been inserted on almost no install at all: `weather_enabled` ships
as 1 while `display_blocks` ships without `weather`, so `previous` is already
enabled the first time anybody saves and the strip would never have appeared.
The moment is when weather becomes **usable** — on *and* located — because with
no coordinates there is nothing to draw and the wall omits the widget anyway
(Phase 2). So typing a location is what asks for the strip, and every save after
that leaves the household's order alone. The test pins both directions, because
each wrong answer looks right from one side.

A **thirteenth** found where measuring the DOM turns a cosmetic fault into a
dangerous one. The System page listed only `offeredTimezones()`, so a stored
zone this build's `Intl` has never heard of — a database restored from an image
with different tzdata, or the ten-zone fallback used when `supportedValuesOf` is
missing — left *nothing* selected. Before `looksEdited` that was a wrong-looking
select; after it, the form boots dirty with a live Save, and one press
re-anchors every all-day event and the whole shift rotation to `Africa/Abidjan`.
The household's own zone is **added** to the list rather than replaced, because
it is a fact about them and not a suggestion — which is where this differs from
`setup.ts`'s `detectedTimezoneOption`, right to fall back to UTC because nothing
is stored yet and it is guessing. A **fourteenth** closed the other half of that
one: the handler still validated against `offeredTimezones()` alone, so the page
drew an option the endpoint refused — "Choose a timezone from the list" about
something that is on the list. It accepts the stored zone too, which is the same
rule read from the other end.

And a **fifteenth** the clipped default submit: it carried `data-dirty-save` for
a while, so the script greyed it out with the visible Save and Enter on an
untouched form did nothing. Tidier, and wrong — the spec says implicit
submission does nothing when the first submit is disabled, engines have not
always agreed, and one that walks on to the first *enabled* submit reaches "Use
my Home Assistant home location" and overwrites the coordinates. **Enter must
mean Save on every engine**, so it stays live: on a clean form that saves
unchanged values and says so, which is a shade talkative and is exactly what
Enter does with script off. A talkative confirmation is a smaller fault than an
engine-dependent one.

A **sixteenth** found the fifth closed list and the one with the sharpest
consequence: the *per-screen* Timezone in the wall editor's Device panel. A
screen zone outside `offeredTimezones()` leaves nothing selected, the browser
preselects the first option — "Household default" — and the next save of that
panel silently clears an override the household set. Same fix. It also re-raised
the download latch as an argument about *engines* rather than about Chromium,
which is fair: the measurement holds and the reasoning behind it should hold
everywhere, but one engine is not everywhere. The belt is three lines — any
pointer or key on the page means the household is still here, so the last submit
took them nowhere and the guard re-arms. No timers, and it cannot fire between a
submit and its own unload, because the interaction that caused the submit
precedes it.

A **seventeenth** caught that fix shipping half-done, the same way the household
one had: the *handler* still checked `offeredTimezones()` alone, so the panel
preselected a value its own endpoint answered 400 to — and that 400 re-renders
from the database, so the whole Wall settings panel was unsavable and every
other edit in it went with the refusal. Both halves now, and the test posts the
value back rather than only reading the markup, which is exactly how the
asymmetry survived twice. **A list and the handler that reads it are one
decision**; asserting only the render checks half of it.

An **eighteenth** found three that matter to 3b more than to this phase.
`writeWeatherSettings` brought the *forecast* job forward on any save through
it, which now includes an alerts toggle — the same backoff hazard the
`alerts-sync` bring-forward beside it is careful about; it is the cache being
wrong or the household asking to see it at all. `savedRedirect` split on `?`
alone, so a path with a `#fragment` produced `…#frag?saved=key`, where the token
is inside the anchor and never reaches the server — latent here and not for
long, since the wall editor's `layoutUrl()` already redirects to fragment paths.
And `withoutSaved` rebuilt the query from `c.req.query()`, which keeps only the
first value of a repeated parameter, so dismissing quietly dropped the rest —
against the docstring's own promise. `queries()` is the reader that keeps them.

A **nineteenth** took the belt back out, and the pair is worth keeping as a
worked example of the RFC's own bar. It guarded a download latch this box cannot
demonstrate and the reasoning says should not exist; its cost is demonstrable
and on a real path — `POST /admin/weather/use-ha-location` waits on a request to
Home Assistant, so a household clicking anything while it is in flight re-armed
the guard and was asked "Changes you made may not be saved" about a save they
had just made, with Stay cancelling the navigation after the write had
committed. There is no way to tell a pending navigation from an abandoned one
without a timer, and a timer on a Raspberry Pi is the same bug wearing a delay.
**Machinery for an unmeasured fault has to be cheaper than the fault**, and this
was not.

A **twentieth** settled the question the two previous rounds had been circling
from opposite sides, and the answer is neither of them. **The guard asks about
work, not about buttons.** Armed by a form's own submit only, pressing "Turn
off" on a rule card beside a dirty Weather form raised that form's prompt, read
as a question about the button just pressed. Armed by *any* submit it never
asked and the edits went silently — the loss this phase exists to remove. What
matters is whose unsaved work the navigation takes with it: saving *this* form
is not leaving without saving; submitting anything else on the page is, for
every other dirty form — including a sibling settings form, where the warning is
exactly right and lets the household save that one first. So `navigating`
became `leaving: HTMLFormElement | null`, and the guard prompts when anything
dirty is not the form being submitted.

`data-download` came back with that, and with a justification it did not have
the first time: a browser fires `beforeunload` when the navigation *starts*, so
at the moment the guard decides, a download is indistinguishable from a
departure — and pressing Download diagnostics with an unsaved timezone would ask
about a navigation that abandons nothing. Measured, not assumed: the browser
test counts prompts from *before* the download, which the first version did not
and so could not see it at all.

The same round found the flag was **one-way**: type "Paris", type "London"
again, and Save stayed live over a form with nothing to save. `looksEdited`
already answered that; it is called on every edit now, both ways. The server's
`data-dirty="dirty"` stays sticky, because there the markup itself is the
unsaved thing.

A **twenty-first** collapsed the two flags into one — `leaving` already names
the form, so asking whether *it* is a download needs no second piece of state —
and made the comment honest about the bound it had been claiming away: on an
engine that does not fire `beforeunload` for an attachment at all, the next
departure sees a stale `leaving` and one warning is swallowed, after which the
guard is armed again. Bounded, and it costs a warning rather than the data. The
alternative is a timer deciding when a navigation was abandoned, which is a bug
wearing a delay.

It also raised a third: `leaving` is consumed at navigation start, so clicking a
link while a slow save is in flight prompts. That one is left alone
deliberately. The save has not completed, the prompt is about leaving a form
whose write is still in the air, and "Stay" cancels the *link* rather than the
POST — so it is a true warning and nothing is lost by heeding it.

Adopted on Calendars, System and Weather as proof. The remaining ~70 redirects
are 3b's mechanical work: add a token to the table, swap `c.redirect` for
`savedRedirect`, and pass `saved: readSaved(c)` at the screen's `page({…})`.

### 3.2 Dirty state on settings forms — **built**

Save is always enabled and there is no Cancel, on every settings form in the
product — except the wall editor, which gets it exactly right: Save disabled
until dirty, Discard hidden until there is something to discard, and a flag that
says so. Lift that to the other forms. It is the same three lines of script the
editor already ships, on pages that currently have none, so it needs a decision
about whether those pages may carry script at all (see Open questions).

**Built**, and the decision was already taken above: a settings page may carry
script. `apps/display/src/settings-form.ts` is the lift — `form[data-dirty]`,
one `[data-dirty-save]`, one `[data-dirty-cancel]`, one `[data-dirty-flag]`, and
the editor's own leave guard including the part that made it a bug: `navigating`
is set by the submit and by Cancel and by nothing else, never by a
document-level click listener.

Five things it does not share with the editor's bar, each for a reason:

- **`page()` ships the script**, keyed on a `<form>` tag carrying `data-dirty`,
  so marking a form is the whole of adopting it. A screen emitting its own
  `<script src>` beside its own markup is how the e-paper editor silently lost
  its editor once — the mount stayed and the tag moved. The match is a regex
  and not `includes('data-dirty')`, which the wall editor's own
  `data-dirty-flag` span satisfies too: that would download and run the module
  on the two heaviest pages in the admin, where it selects nothing.
- **Save's state is set on boot, never in the HTML.** The server renders Save
  enabled and Cancel and the flag `hidden`, so a household who blocks script
  gets exactly today's form. That is the degradation promise, and it is a
  property of the markup rather than of any care taken in the script.
- **Cancel's destination is stated in the attribute**, not derived. A form
  re-rendered at 400 leaves the browser on the POST URL, so `reload()` would
  re-submit the very edits Cancel is meant to discard and `location.pathname`
  would ask for a route that only answers POST.
- **The guard hangs off `submit`, not the Save button's click** — Enter in a
  text field and the `formaction` button both leave without pressing Save.
- **Only the control marked `data-dirty-save` is disabled.** Weather's Home
  Assistant button is a second submit in the same form, and disabling it would
  be a control whose whole job is to fill a field in refusing to work until a
  field has been filled in.

One fault came out of it and only by looking: `.saverow` shipped with no
disabled treatment, so a disabled Save was pixel-identical to an enabled one —
"Save is off until you change something" reading as a button that silently does
nothing, which is strictly worse than the always-enabled Save it replaced. The
editor's `.savebar button:disabled` rule is shared now, and the assertion is on
the **computed background**, never on the `disabled` property.

### 3.3 One convention for destroying things — proposed

Today there are four mechanisms and three visual weights, decided by which file
the button lives in:

| Action | Confirms | Style |
|---|---|---|
| Remove calendar / person / chore | interstitial page | `secondary` / `btn-danger` |
| **Remove shift rotation** | **nothing** | `secondary` |
| **Remove HA entity / rule / Disconnect** | **nothing** | `secondary` |
| Remove eInk screen | inline `onsubmit="confirm()"` | `btn-danger` |
| Remove widget | `window.confirm()` | inspector link |

Disconnect Home Assistant is the sharpest: its own helper text, printed directly
beneath it, says it deletes the token, the readings and every rule about the
house — and it is one unconfirmed click on a neutral outlined button. Recovering
means minting a new long-lived token and re-adding every entity and rule by hand.

And on Calendars, "Remove" and "Sync now" are rendered as **visually identical
buttons side by side**.

**One rule: anything that destroys stored data gets the interstitial
`GET …/delete` page that already exists, naming exactly what is lost.** The
chores page is the model — it names the history it destroys and offers Pause as
the non-destructive alternative. Every destructive control in a list gets
`btn-danger`. Delete the `onsubmit="confirm()"` at `admin.ts:1757`, which is the
only inline script in the server-rendered admin and will otherwise have to be
exempted from Phase 6's CSP.

---

## Phase 4 — One vocabulary

**Goal: one word per thing, everywhere.**

On a single page — `/admin/displays/default` — the same object is called
**Walls** (breadcrumb), **Default display** (H1), **Wall settings** (tab),
**wall** (sub-label), **Canvas** (toolbar), **Save wall** (button), and
**Displays** (nav). On its sibling list it is a **screen** four times. The route
is `/admin/displays`, and also `/admin/screens`, and also `/admin/display`, and
also `/admin/layout`. The table is `screens`. The Weather screen calls a widget a
**block**.

The same disease is in the extras: nav **Store**, breadcrumb **Modules**, H1
**Store**, H2 **Store** again, body **modules** — and the nav *group* holding
Calendars is also **MODULES**, which is accurate to the code (`app.ts:261`
registers Calendars, Chores, Weather and Home Assistant as `PanelModule`s) and is
exactly why it fails: it is an engineering word used as a nav label, with a Store
nested inside it that installs things also called modules.

**The vocabulary, three words — decided:**

- A **Wall** is the physical thing you hang up. **One list, one nav item**, with
  a kind chip on each row. Two top-level nav entries for one object with two
  kinds is the split that started this.
- A **Layout** is the arrangement a wall draws.
- A **Widget** is a thing on a layout.

Retire *display*, *canvas*, *screen* and *block* from user-facing text entirely.

**Wall rather than Display, and the reason is the product's own name.** The
first draft of this RFC proposed *Display*, because it matches the current nav
item and every route. That is an argument about the code. *Wall* is the word the
README, the docs and the product's own name already use with households, and the
admin's group label is already `WALLS` — so the household-facing half of the
split is the half that is already right, and it was the code's word that was
losing.

**The e-paper wrinkle, stated rather than glossed.** A tag stuck to a fridge is
a stretch as a "wall", and that is the one real cost of this choice. The kind
chip carries it: each row in the list says **Browser** or **E-paper**, and the
e-paper pages can say "e-paper wall" where a sentence needs the distinction.
This is better than the status quo, where the same object is a *Display* in one
nav row and an *eInk Display* in the one below it, and no chip explains either.

**Routes.** `/admin/walls` becomes canonical and `/admin/displays`,
`/admin/display`, `/admin/screens` and `/admin/layout` all keep working as
redirects, which they already do. Slightly more route churn than *Display* would
have cost, and it is only aliases.

**`screens` stays as the table name.** Nobody reads it, and renaming it is a
migration with no user-visible benefit — the one thing this repository's own
history says never to do casually.

**And regroup the nav**, since it is the same sweep:

```
CALENDAR     Overview · Calendars · People · Work Schedule · Chores
WALLS        Walls · Themes
EXTRAS       Weather · Home Assistant · Store
SYSTEM       System
```

Calendars leaves the "modules" bucket for the group it is actually about. Themes
move next to the thing they theme. "Extras" is honest about what those three are.

**Two smaller things belong in this sweep** because they are the same act:
`/admin/screens/approve` is reachable from nothing (`admin.ts:1397`, with two
docstrings describing a manual entry point nobody built) — give it a form on the
Walls page. And "Over SSH instead: `add-screen "Kitchen"`" is a CLI instruction
on a household settings page, for a shell the add-on does not have; the pairing
form added in that same fix is the replacement. Keep `add-screen` working and
add `add-wall` beside it — a tool name is not user-facing copy, but somebody
reading the docs should not have to translate.

**Risk:** touches many files, changes no behaviour. Keep every old route as a
redirect — they all already are, and that is why this is safe.

---

## Phase 5 — The editor becomes safe

**Goal: the product's most differentiated surface stops being its most hostile
one.**

The editor's central decision is right and is not on the table: **the preview is
the wall**, rendered through the real `renderFreeform` in a shadow root carrying
the display's own stylesheet. Two renderers disagreeing is the class of bug that
avoids.

What is wrong is everything around it.

- **No undo, no duplicate, no clipboard.** The delete confirmation nominates a
  substitute — "Discard changes brings it back" — and Discard is
  `window.location.reload()`, which also throws away every other edit since the
  page loaded. An accidental drag after twenty minutes of arranging has exactly
  one recovery: lose the twenty minutes.
- **Pointer-only.** The only keydown bound to a widget is Enter/Space to select.
  No arrow nudges, no resize keys, no numeric x/y/w/h anywhere in the inspector.
  Arrow keys scroll the page.
- **A 12×12px resize handle**, in an editor this project explicitly redesigned
  for phones. At 375px the canvas is about 210px wide and the widget label chips
  overlap their own content — the Clock reads "00:8".
- **The Style tab and the ink lane cannot be reached by keyboard at all.** A
  roving `tabindex` is set with no arrow-key handler, so the inactive tab leaves
  the tab order and has no other route in. `display-editor.ts:74` already
  contains a correct `wireTabs()`; the layout editor does not use it.
- **Switching orientation performs a hidden save**, discards the result, and
  clears the dirty flag regardless — so a failed save is reported as a success.
  The other canvas is already in `state.stash`; no write is needed on tab switch
  at all.
- **Two widgets both labelled "Calendar"**, on the canvas and in Layers, with
  nothing distinguishing the agenda from the month.

**The work, in order of value:**

1. **An undo stack.** Cheap here, because the canvas is small and already
   serialisable: push `JSON.stringify(widgetsForSave(state.widgets))` before each
   mutation, cap at ~30, bind Ctrl/Cmd+Z, add a toolbar Undo. Duplicate is then
   three lines. Once undo exists the delete confirmation can go, which is a net
   reduction in dialogs.
2. **Keyboard placement.** Arrows nudge 1%, Shift+arrows resize, on the box that
   is already focusable. Add four numeric fields to the Style tab — they cost
   almost nothing and are also the only way to align two widgets exactly.
3. **`.le-handle::before { inset: -16px }`.** The 12px visual stays, the target
   becomes 44px, nothing moves. This is the idiom the chore tick already uses.
4. **Share `wireTabs`** between the two editors rather than reimplementing it.
5. **Stop writing on orientation switch**, and keep a dirty flag per canvas.
6. **Label the widgets by their view** — "Calendar — month", "Calendar —
   upcoming".
7. **Consolidate the toolbar.** Four control clusters today: a Layout/Wall-settings
   tablist, a chip plus overflow, Portrait/Landscape + Add widget + Templates, and
   Canvas + Layers — in three visual treatments, with an overflow menu whose two
   items include a duplicate of a button two rows above it. One row: orientation
   segmented, `+ Add widget` filled, `Layers`; everything else in the overflow.
8. **A phone layout that gives the canvas more than half the screen.** Content
   currently starts 370px down an 844px viewport.

`boot()` is a 2,843-line function holding all editor state as closure variables.
That is not a style complaint: it is why selection rebuilds the whole overlay
instead of toggling two classes, which is in turn why keyboard focus is destroyed
on select. **Do not rewrite it.** Extract the decision logic the way this package
already extracts `widget-options.ts`, `ink.ts` and `ladder.ts`, and make
`selectWidget` toggle classes in place. That is enough.

---

## Phase 6 — The design system becomes a constraint

**Goal: stop the drift permanently, without a sweep.**

The correlation in this codebase is exact, and it is the whole finding: **every
dimension with a test is respected; every dimension without one has drifted.**

| Dimension | Test? | State |
|---|---|---|
| Colour | `design-tokens.test.ts`, `admin-design-system.test.ts` | 4 raw hex values outside the token file. Works. |
| Button states | `admin-button-states.test.ts` | Derived from the stylesheet. Works. |
| Shadows | `admin-design-system.test.ts` | Two tokens, seven uses, no elevation ladder. Works. |
| Mobile nav | `admin-mobile-nav.test.ts` | Pins the absences. Works. |
| **Spacing** | **none** | 5 token uses out of 356 declarations |
| **Type scale** | **none** | ~50% of call sites; 12 sizes on one page, incl. `13.3333px` |
| **Wall theme contrast** | one theme only | three of five fail |

**Five assertions, landed with an allow-list of current offenders, burned down as
files are touched.**

1. Every `font-size` in the admin stylesheet is `var(--mw-t-*)` or a scale
   literal. (~60 failures.)
2. Every spacing value is on the 4px scale. (~30 failures. Freeze the vocabulary
   at what exists today rather than shrinking it in one go.)
3. Every declared token has at least one reference. (~8 failures — including
   `--mw-touch: 44px`, which has zero references while the code hardcodes 48px
   and is therefore *stricter* than its own stale token. Delete it or raise it;
   either way it should not sit there disagreeing with the code.)
4. `design-tokens.test.ts` derives its pairs **from the stylesheet** rather than
   a hand-written list. This is what would have caught `--mw-ink-3`: certified as
   a border colour at 3.73:1, where 3:1 is the bar — and then used as the colour
   of every `.hint` in the admin, where 4.5:1 is.
5. `theme.test.ts`'s `describe('the Swiss theme')` becomes `describe.each` over
   all five, against both `--bg` and `--panel`. It will fail immediately, which
   is the point.

**Two token changes ship with it.** Repoint `.hint` at `--mw-ink-2` — 3.73:1
becomes 6.27:1 for every block of explanatory copy in the admin, and
`.field-hint` already uses it, so the two supporting-text treatments converge.
And darken the light themes' shift hues: `--s-day` is at **1.90:1 on Household,
2.63 on Blueprint and 2.78 on Almanac**, painted as *text* on the element
`display.css:375` calls "the single most important element on the wall". Almanac
is the theme we schedule for daylight, so that ratio is what a household reads
all day.

Also in this phase, because it is one route and one hash: **serve the admin
stylesheet as a cached file.** Every page inlines 110,224 bytes of identical CSS,
36% of it developer commentary, in an application that is page-per-navigation by
design — about 1.3MB of byte-identical CSS across a twelve-page session. Keep the
inline `<style>` for the wizard and sign-in, which `wizard-noscript.test.ts`
already fences off and which genuinely must work before anything else does. For
the authenticated shell, emit `<link rel="stylesheet" href="/assets/admin.css?v=<hash>">`
with a long `Cache-Control` and an ETag. Strip comments from the served copy;
they belong in the TypeScript, where a maintainer reads them.

While in `static.ts`: every asset is served `cache-control: no-cache` with **no
ETag and no Last-Modified**, so the browser must revalidate on every load and can
never serve one from its own cache. That is also why the Phase 1.1 gap is fatal
rather than merely slow.

---

## Phase 7 — Polish

Held together because none of it blocks anything else, and any of it can ride
along with a phase above.

- **Conditional fields.** Chores renders all nine field groups at once, including
  all five mutually-exclusive schedule fields, and admits it: *"Pick how it
  repeats, then fill in only the boxes that belong to it."* eInk does the same
  with Width/Height. Either split the choice into a first step that posts — the
  wizard already proves the pattern — or allow a ~30-line inline script on these
  two screens. Both beat asking the household to filter a form.
- **Touch targets.** Every form field is 40px, every `btn-sm` is 32px, the chore
  weekday checkboxes are 18×18, and inline links used as navigation are 15–21px
  tall. Set `min-height: 44px` below 900px; the visual size can stay.
- **The alert rules become a table** with a state chip and an overflow action. Five
  cards of ~180px each, holding three short lines and one small button, is 900px
  of a 2,400px page — and the on/off state is communicated *only* by the button
  label, so a household scanning four "Turn off" buttons has to invert each one.
- **The `.error` surface stops carrying non-errors.** Two pink danger blocks on
  the Weather screen hold an informational note and the life-safety disclaimer.
  Neither is an error. The disclaimer needs prominence, not alarm.
- **Placeholders that look like values.** Latitude and Longitude show the
  geographic centre of the United States as grey placeholder text. The fields
  look filled and are empty.
- **The SSRF opt-ins.** Three bare checkboxes on the add form with no
  explanation; one of the three on the edit form, as a switch, with a different
  label and the only security wording in the product; and two of them
  unchangeable afterwards. One `<details>`, one control type, the same labels on
  both forms, and widen the settings handler.
- **`ago()` is written four times.** `admin-alerts.ts:407` never pluralises the
  hour bucket, so any age from 60 to 89 minutes ships as **"1 hours ago"** on the
  Weather page. `admin-ha.ts:611` has no day bucket, so three days reads
  "72 hours ago". Import the complete one from `admin.ts` and delete both copies.
- **Two zero-byte files**, `pnpm` and `maverick-wall@`, are tracked at the
  repository root. `addon-repository.test.ts` already forbids a tracked file
  ending in a number after two duplicate licence files shipped; it should forbid
  tracked empty files too.
- **`.invalid`, `.test` and `.example`** are RFC-reserved names that never
  resolve, and `url.ts:102` describes them as local-network names and suggests a
  fix ("turn on allow local network") that would not help. Blocking them is
  right; split the list and give them their own message.
- **`ok:false` is served with HTTP 200**, so no container healthcheck can observe
  the one failure `/healthz` knows how to report. Return 503. (Feed failure is
  *not* part of this: `healthNotices` already puts it on the wall after three
  consecutive failures, which is the right surface.)
- **Source maps ship in the display bundle** (~200KB) and are served publicly.
  Harmless on an AGPL project; dead weight in the image.
- **Documentation gaps:** no upgrade procedure, no password-recovery path, no
  "move to a new machine". The middle one is the real hole — one account, no
  email delivery, no reset flow, so a forgotten password today means restoring a
  backup or losing the install.

---

## Decisions taken

- **No framework in the admin.** Server-rendered HTML with no build step is a
  real robustness property — there is no bundle that can fail to load — and it is
  right for the wizard, which must work before anything else does. Every
  consequence in this RFC is solvable without one.
- **No sweep of the 351 hand-placed spacing values.** Freeze the vocabulary,
  convert opportunistically. A large diff for an invisible gain is how a
  refactor eats a quarter.
- **No rewrite of `admin.ts` or `boot()`.** Both are large and both work. Extract
  the one duplicated settings form (`defaultsForm` at `admin.ts:3851` and
  `wallSettingsForm` at `:3123` render the same tab from two hand-written
  implementations 700 lines apart, and have drifted), and pass `deps` as an
  argument for new screens the way `admin-chores.ts` already does. That is the
  whole structural ask.
- **The default layout stays stored data.** The fix for the empty wall is
  omitting widgets with nothing to say, not reviving a responsive layout mode
  that was deliberately retired.
- **Keep `screens` as the table name.** The vocabulary sweep is user-facing text
  and routes only.
- **A settings page may carry script.** Decided rather than assumed: the
  no-script fence covers the wizard and sign-in — the screens that must work
  before anything else does, and the two `wizard-noscript.test.ts` already
  guards — and nothing else. Everything past them may carry progressive
  enhancement. This was never really a product-wide promise: the Home Assistant,
  Themes and wall pages all ship script today (`admin-ha.ts:719`,
  `admin-themes.ts:311`, `admin.ts:2166`). It unblocks the dirty-state work in
  3.2 and the conditional fields in Phase 7, and both should still degrade to
  today's behaviour with script off, because a household who blocks it is not a
  household who should lose a form.
- **The wall is a Wall.** Not a Display. The reasoning is in Phase 4; the short
  version is that the product's own name and its documentation already agree
  with households, and it was the code's word that was out of step.
- **The first-run wizard gains a fourth step.** Skippable. See Phase 2.
- **Phase 1.3 and Phase 2 apply to walls that are already hanging.** This
  repository is careful about not re-typesetting a kitchen wall under somebody —
  the pills, the ladder and the temperature pairing all carry that reasoning —
  and the exception is deliberate. A wall rendering a 4.7px agenda, or a
  permanent "Nothing to show yet." where a widget will never have anything to
  say, is not an arrangement somebody chose; it is a defect that happens to be
  on their wall too. Both ship everywhere, and the release notes say so in the
  household's terms: what will look different, and why.

## Non-goals

- The browser WebSocket client. Polling works, the fallback is proven, and the
  server half and the Android client already exist. This is an optimisation with
  a working fallback and it is not what is wrong with the product.
- The 482MB image. The `better-auth` peer-dependency question deserves its own
  investigation; note that `pnpm audit --prod`'s 13 advisories are misleading
  here — running the Dockerfile's own `pnpm deploy --prod` shows `vitest` and
  `drizzle-kit` are not in the deployed tree.
- Multi-tenancy, a cloud version, or a second household per container. Still no.
- Repainting the admin. The visual language is right; it is unenforced, which is
  Phase 6.

## Open questions

These are the ones left. Nothing here blocks a phase; each can be settled by
whoever implements the phase it belongs to.

- **Is "Extras" the right group name?** It is honest and slightly dismissive of
  work that is not slight. "Add-ons" collides with Home Assistant's own word.
  "More" says nothing.
- **How far does the vocabulary sweep go into the display bundle?** `renderMessage`
  and the pairing screens carry user-facing strings too, and they are the ones a
  household reads on a television with a remote in their hand. Probably all the
  way, which makes Phase 4 slightly larger than it looks.
- **Should the calendar's scale floor be one constant or two?** The month grid
  and the agenda have genuinely different failure modes — a grid degrades by
  showing fewer events per cell, an agenda by showing fewer days. `trimSwissCells`
  already does the first. One floor with two trim strategies is probably right,
  but the measurement table should be built before that is asserted.
