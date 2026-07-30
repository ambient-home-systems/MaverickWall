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
packages installed.** They were wrong about `ical.js` and `better-sqlite3`, and
`better-auth.d.ts` is very likely wrong too. Once the real packages are present,
those shims are only used by `tsconfig.offline.json` and can be deleted — the
build uses the genuine types.

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

1. **Verify `better-auth.ts` against the real library.** The one unexecuted
   file. Expect the config shape, `auth.api.getSession`, and the drizzle adapter
   mapping to need correcting.
2. **Wire auth into `main.ts` and `app.ts`.** `protectPrefix` exists; the
   Better Auth handler needs mounting at `/api/auth/*` and `resolveBaseUrl`
   needs calling per request for HA ingress.
3. **First-run wizard.** `/setup` currently answers 501. Completion criteria
   still undecided — see CLAUDE.md.
4. **Calendars screen**, with `testFeed()` behind the TEST FEED button. That
   endpoint is built and tested; it needs a route and a form.
5. **Shifts screen** — the title-tagging flow. `analyseTitles()` is built and
   tested.

After that: the display. Suggested order is **inverted from the original spec** —
get the zoom pyramid drawing real data first, then add IndexedDB, the service
worker, and the watchdog. Resilience protecting a layout nobody has looked at is
effort on the wrong risk, and the display is the first work where a human eye is
a better instrument than a test suite.
