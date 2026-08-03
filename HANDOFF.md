# Handoff notes

Context from the chat sessions that built this, which the code alone does not
carry. `CLAUDE.md` is the operating document; this is the reasoning behind it.

---

## Decisions and why

**Shifts are a feature, not a package.** It ships in the same container either
way, so a package boundary buys nothing at deploy time while costing a build
target. What was taken from the "make it an add-on" instinct is the *seam*:
`packages/core/src/domain/shift/` imports nothing from core but civil dates, and
nothing in core imports it. Extracting it later is a `git mv`.

**Shifts are identified by the titles a feed actually contains.** Asking someone
to describe their rota in the abstract gets guesses. Listing the titles in their
calendar and asking which are work gets the truth — including variants nobody
would type. One real feed writes both `"Daddy - Working Day Shift"` and
`"Daddy Working - Day Shift"`.

`analyseTitles()` grades each title **likely / possible / unlikely**. Three tiers
rather than a yes-or-no because `"Work"` at 09:00 every weekday and a martial
arts class at 18:00 every Monday are *identical from the data*. Excluding the
second necessarily excludes the first. Offer both, let the person decide.

The signals, in order of strength:
- Wording (`night shift` → night; `break day` → off; `working` → work, type
  unknown)
- **Block count** — how many separate runs of consecutive days. This replaced
  coverage, which could not tell a rota from a holiday: ten Break Days across 70
  days is 14%, a nine-day Disney trip is 13%. Break Day is 3 blocks; Disney is 1.
- **Start-time variance** for timed entries. An appointment keeps its slot; a
  shift moves around the clock. `"Mommy working"` has four start times.

**A matched shift event is consumed out of the agenda.** A feed marking every
single day would otherwise bury the dentist appointment under the same fact the
day's colour already carries. Scoped to the named source, so a school calendar
containing "day shift photos" isn't silently swallowed.

**Display auth is proportionate.** One long random token per screen, stored
hashed, shown once, revocable. No rotation ceremony. This is a LAN service for
one household. The short code alphabet excludes `0/O 1/I/L 5/S 8/B` because
reading a code off a wall and typing it on a TV remote are the two worst
conditions imaginable.

**`allowPrivateNetwork` and `allowLoopback` are separate flags, and neither
opens link-local.** 169.254.0.0/16 holds APIPA addresses *and* the cloud
metadata endpoint. Nobody self-hosts Nextcloud there.

**The manifest is one document per poll.** A display assembling its own view
from four endpoints can render half-updated state. The ETag deliberately
excludes `generatedAt`, or every poll would transfer the whole body; server time
also goes in a header so a 304 still carries it.

---

## Fixtures

`packages/calendar/test/fixtures/` — synthetic ones cover what the RFC says,
real ones cover what producers actually emit. Both matter; the second kind found
more bugs.

**Real fixtures are frozen at fetch time.** Producers edit their calendars
continuously, so a live fetch would break snapshots weekly and turn a real
regression signal into noise.

**Private feeds are scrubbed locally**, never pasted anywhere.
`scripts/scrub-fixture.mjs` replaces letters with `x` and digits with `9`,
preserving everything else byte for byte. Because value lengths are preserved
exactly, RFC 5545 folding lands on identical octet boundaries and the fixture
still exercises unfolding the way the original did. Verified: 4694 bytes in,
4694 out, zero lines differing in length.

Preserved verbatim because they *are* the test: `UID`, `RRULE`, `EXDATE`,
`RDATE`, `RECURRENCE-ID`, `DTSTART`, `TZID`, `VTIMEZONE`, folding, CRLF.

**Snapshots are committed and meant to be read.** A snapshot diff means a bug
was fixed or introduced, and the diff is how you tell which. One bug — warnings
emitted twice per event — was found purely by reading one, with nothing failing.

---

## Things that will bite

**`pnpm --filter` changes the working directory** to the package. With a
relative `DATA_DIR` this creates a second database. Use absolute paths.

**Rebuilding does not restart a running server.** A live process keeps executing
the old code. Several confusing sessions came from this.

**`ical.js` and `better-sqlite3` both export a constructor merged with a
namespace.** The imported name is not usable as a type. Use
`InstanceType<typeof X>`, which works regardless of how the declarations are
shaped — and that shape differs between bundled types and `@types/*`.

**The offline type shims in `test/offline-types/` were written without the real
packages installed.** They were wrong about `ical.js` and `better-sqlite3`.
`better-auth.d.ts` turned out to be right about everything the adapter uses.
All the real packages are now installed and the build uses genuine types, so
the shims and `tsconfig.offline.json` are dead weight and can be deleted.

**`pnpm test` typechecks the tests as well**, via `tsconfig.test.json`. It did
not until avatars, and the gap had already let four harnesses call `createApp`
without a required argument. Turning it on found seven errors in one go,
including a test asserting a `dns-failed` outcome with the wrong status — that
code is a *rejection*, not a failure.

**The scheduler persists `next_run_at`.** After repeated failures a job may be
15 minutes out, and restarting will not hurry it. To force a sync:

```sql
UPDATE job_state SET next_run_at = 0, consecutive_failures = 0,
                     running_since = NULL WHERE kind = 'ics-sync';
```

---

## Verification technique

Most of this was written where `npm install` was impossible, which forced two
habits worth keeping:

**Offline type shims** (`test/offline-types/`, `tsconfig.offline.json`) declare
the exact API surface each dependency is used through. They doubled as
documentation of the dependency surface — useful for auditing what a major
version bump can break.

**A minimal test runner** was used to execute test files before shipping them.
That caught several bugs typechecking could not: a stale assertion, tests
planting files in a directory that did not exist, and both auth deadlocks.

With Claude Code able to run `pnpm test` directly, neither is needed for new
work. The shims are still worth keeping until the corresponding packages are
confirmed installed and working.

---

## Immediate next steps

1. ~~**Verify `better-auth.ts` against the real library.**~~ Done. The config
   shape, `auth.api.getSession` and the drizzle adapter mapping were all
   correct as written — the expectation that they would need fixing was wrong.
   The column names in `schema.ts` match what 1.6.25 wants.
2. ~~**Wire auth into `main.ts` and `app.ts`.**~~ Done, with one deliberate
   departure: `resolveBaseUrl` is **not** called per request. See below.
3. ~~**First-run wizard.**~~ Done, with `requireSetupComplete` mounted in the
   same change. Completion criteria decided: **account + timezone**. The
   calendar step is offered and skippable, for the reason in CLAUDE.md.
4. ~~**Calendars screen.**~~ Done. `testFeed()` runs on add rather than behind
   a separate TEST FEED button: a feed that cannot be fetched and parsed is
   never stored, so the list cannot contain a row that has never worked. Also
   has "sync now", which automates the `job_state` SQL above, and a two-step
   remove that clears the scheduler row the cascade does not reach.
5. **Shifts screen** — the title-tagging flow. `analyseTitles()` is built and
   tested. Decide first whether it is another server-rendered screen or the
   thing that finally starts `apps/admin`; four screens now exist without it.

6. **Prompt 3.** CALENDARS, PEOPLE, SHIFT ROTATION, SCREENS and SYSTEM are
   done. Two pieces of it are not:

   - ~~**The opt-in update check.**~~ Done, off by default, with the
     disclosure written to be read rather than agreed to.
   - ~~**Avatars on People.**~~ Done. Uploaded, sniffed, stored by content
     hash, served behind both gates, and drawn beside the name in the shift
     badge — the design file predates avatars and says nothing about where one
     goes, so that placement is a choice worth revisiting.

7. **Home Assistant ingress** — the one piece of step 2 never finished, and the
   only reason `resolveBaseUrl` still exists. Three things have to move
   together, and none can be verified without a real add-on to test against:
   the dynamic `baseURL`, the `x-ingress-path` prefix, and the app-wide
   cross-origin guard in `app.ts`, which compares the browser's `Origin`
   against the address the request arrived on and would refuse every
   supervisor-proxied POST.

### Zod is in the rules but not in the project

Rule five says "Zod at every boundary", and it is in the stack list. It is not
a dependency of any package and is not imported anywhere — the wizard forms,
the tools and the HTTP layer all hand-validate. That is not an argument for
either side; it is a discrepancy between the rules and the code that somebody
should settle deliberately. Adding it would be a real improvement at the form
boundaries, where the current checks are correct but easy to forget to repeat.

### Why `resolveBaseUrl` is not wired in

It cannot be "called per request" as step 2 assumed. Better Auth resolves
`baseURL` when the instance is built, so honouring a per-request value would
mean constructing an auth instance per request — which would also throw away
the rate-limit counters on every call.

It does not need to be. 1.6.25 supports this natively: `baseURL` accepts
`{ allowedHosts, fallback }` and resolves per request internally, and there is
a `trustedProxyHeaders` flag. That is a supported path; `resolveBaseUrl` is a
hand-rolled one that would have to be kept correct forever.

So it stays as a tested pure function and nothing calls it. When the HA add-on
is built — and it can be tested against a real ingress path — use the
library's dynamic `baseURL` with the ingress host in `allowedHosts`, and
delete `resolveBaseUrl`. Shipping unverifiable ingress handling now is the
exact trap this session was opened to clean up.

The display now draws real data, and that order held up: two layout faults were
found by looking at it and then measuring, and neither was reachable by any test
that existed. The advice stands for what is left.

**Next on the display**, in this order:

1. ~~**The offline store.**~~ Done. IndexedDB holds the last good manifest and
   it is drawn before the first request is sent; a service worker caches the
   shell so the reload itself works; a watchdog reloads a renderer that has
   stopped drawing. Note the platform limit: **a service worker will not
   register over plain http**, so on a LAN address the shell is not cached and
   only the stored-manifest half applies.
2. **Density, with a person looking at it.** The household now sets the counts
   on `/admin/display`, but the *defaults* in `viewmodel.ts` are still opinions
   written at a desk, and `NEXT_EVENT_LIMIT` is still a constant nobody can
   change. They want a real wall at a real distance.

**Break days are coloured.** `shiftFor()` in `api/manifest.ts` emits a
synthetic `break` shift when the rotation resolved to "not working" with a
source other than `none`, so the display can tint it (`--s-break`). A day no
plan covers still produces nothing, which is the distinction that was missing:
the two used to arrive at the display identically.

**Density is configurable**, on `/admin/display`. **Orientation and rotation
are configurable per screen**, on `/admin/screens`, which also renames and
unpairs. Unpairing revokes rather than deletes: the row is what makes a token
stop working, and somebody auditing what is still on their wall wants the
history.

Block order and visibility are configurable too. What is still fixed: the
*landscape* column assignment — the month always takes the right-hand column
rather than following the chosen order literally. That is deliberate and
documented in CLAUDE.md, but it is the next thing somebody will ask for.
