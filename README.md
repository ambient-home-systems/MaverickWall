# @maverick-wall/calendar

Parse an ICS feed and expand it into concrete, timezone-correct events.

One function. No I/O, no framework, no database, no clock of its own. It takes a
string and gives back a sorted array of instances with recurrence already
expanded, so nothing downstream ever has to understand an RRULE.

```
npm install @maverick-wall/calendar
```

```ts
import { expandCalendar } from '@maverick-wall/calendar';

const result = expandCalendar({
  icsText,
  targetTimezone: 'America/Chicago',
  windowStart: new Date('2026-03-01T00:00:00Z'),
  windowEnd: new Date('2026-04-01T00:00:00Z'),
});

if (!result.ok) {
  showBanner(result.error.message);
} else {
  render(result.value);
  if (result.meta.truncated) showBanner('Showing part of this range.');
}
```

## It never throws

Every failure is a value. Bad input, an unknown timezone, a feed that turns out
to be an HTML 404 page — all come back as a typed `CalendarError`:

```ts
type Result<T, E> =
  | { ok: true; value: T; meta: ExpansionMeta }
  | { ok: false; error: E };
```

`CalendarError.code` is one of `EMPTY_INPUT`, `INVALID_TIMEZONE`,
`INVALID_WINDOW`, `INVALID_OPTION`, `PARSE_FAILED`, `TOO_LARGE`, `INTERNAL`.

A feed that is damaged in part does **not** fail. Events that parse are
returned, and the rest are explained in `meta.warnings`. A display showing four
of five events beats one showing an error page.

Warnings and errors are safe to log: a code, a UID, and a message. Never event
titles, never descriptions, never feed credentials.

## What you get back

```ts
interface NormalizedEvent {
  uid: string;
  recurrenceId?: string;      // '20260315T090000' — the slot this instance fills
  title: string;
  startUtc: Date;
  endUtc: Date;               // exclusive
  allDay: boolean;
  sourceTzid: string;
  location?: string;
  status: 'CONFIRMED' | 'TENTATIVE';
  isRecurringInstance: boolean;
  description?: string;       // only with includeDescription: true
}
```

Sorted by `startUtc`, with deterministic tie-breaking so the output is stable
enough to snapshot.

`uid` + `recurrenceId` is a stable identity across re-fetches and restarts. It
is safe as a React key, and safe as a foreign key for per-instance state such as
"dismissed". When an instance is rescheduled by a `RECURRENCE-ID` override, the
`recurrenceId` stays pinned to the **original** slot, so that state survives the
reschedule.

### Descriptions are stripped by default

`DESCRIPTION` routinely contains meeting links, dial-in PINs, door codes and home
addresses. Pass `includeDescription: true` if you need it and have somewhere
appropriate to put it.

### `STATUS:CANCELLED` never comes back

Cancelled series and cancelled individual instances are filtered out, so `status`
is only ever `CONFIRMED` or `TENTATIVE`.

---

## Caveat: daylight saving time

**Recurrence is computed on the wall clock, then anchored to the timeline.**

RFC 5545 defines recurrence over local clock readings, not instants. A weekly
09:00 event is a promise about what the kitchen clock says, and that promise has
to survive a DST transition. So expansion iterates over bare
`{year, month, day, hour, minute, second}` tuples with no zone attached, and only
at the end is each instance resolved to a real instant.

A weekly 09:00 series in `America/New_York` therefore looks like this:

| Instance | `startUtc` | Local |
| --- | --- | --- |
| 2026-03-04 | `14:00Z` | 09:00 EST |
| 2026-03-11 | `13:00Z` | 09:00 EDT |

The UTC value moves. The wall clock does not. That is correct, and it is what
every mainstream calendar client does.

**Zones come from `Intl`, not from the feed's VTIMEZONE.** An embedded VTIMEZONE
is whatever the producer shipped — often years stale, often absent, and Outlook
names zones in Windows rather than IANA terms. `Intl.DateTimeFormat` gives the
platform's live IANA database, which the OS keeps updated. `TZID` values are
matched against IANA, with Windows names (`Eastern Standard Time`) and
producer-prefixed forms (`/mozilla.org/20050126_1/America/Chicago`) mapped on the
way through. An unresolvable `TZID` falls back to `targetTimezone` and raises a
warning rather than dropping the event.

**Two local readings are pathological, and both happen twice a year in most of
the world.** Neither throws:

| Reading | Cause | Behaviour |
| --- | --- | --- |
| Ambiguous | Clocks go back; 01:30 happens twice | Resolves to the **first** instant |
| Nonexistent | Clocks go forward; 02:30 never happens | Shifts **forward** by the gap |

So a 02:30 alarm on a spring-forward morning fires at 03:30 rather than
vanishing. Some zones — Chile, for instance — transition at midnight, which means
even an all-day event's anchor can land in a gap. It resolves to 01:00 and stays
on the correct date.

**Durations are wall-clock, not elapsed.** A 09:00–10:00 event is one hour on the
wall on every instance. An event running 01:00–04:00 across a spring-forward
morning is three wall-clock hours but only two real ones, and `endUtc - startUtc`
will show two. Again, this matches mainstream clients.

---

## Caveat: all-day events

All-day events are calendar dates, not instants, and `DTEND` is **exclusive**.

A one-day all-day event on 2026-03-15 has `DTEND` of 2026-03-16. This library
returns:

```
startUtc: 2026-03-15T05:00:00Z   // local midnight in targetTimezone
endUtc:   2026-03-16T05:00:00Z   // local midnight the following day
```

**The event belongs on the 15th only.** If you render every day between
`startUtc` and `endUtc` inclusive, you will put it on the 16th as well. Treat
`endUtc` as exclusive:

```ts
// Right
const lastDay = localDateOf(event.endUtc.getTime() - 1, targetTimezone);

// Wrong — off by one, every time
const lastDay = localDateOf(event.endUtc.getTime(), targetTimezone);
```

This is the single most common ICS bug, and the way it shows up is a birthday
appearing on the wrong day.

All-day events are anchored to local midnight in `targetTimezone`, so the same
feed rendered in Auckland and in Los Angeles puts a date on the same calendar
square. Do not anchor them to UTC.

---

## Limits and truncation

| Option | Default | Effect |
| --- | --- | --- |
| `maxEvents` | `2000` | Cap on returned instances |
| `maxBytes` | 16 MiB | Feeds above this are rejected unparsed |

Sorting happens **before** capping, so a capped result is the earliest events in
the window, not an arbitrary slice.

Individual recurrence rules are additionally capped at 20,000 iterations, which
stops `FREQ=SECONDLY` with no `COUNT` from hanging the process.

Whenever any ceiling is hit, `meta.truncated` is `true` and a warning explains
it. **Surface this.** Silently showing 2000 of 9000 events tells someone their
afternoon is free when it is not.

## Performance

Roughly 5000 source events expanding to about 25,000 instances completes well
inside a 2.5 second budget on modest hardware; `test/performance.test.ts`
enforces it and prints the actual figure. The hot path is wall-clock-to-instant
resolution, memoised on the exact instant so the cache cannot go stale.

## Development

```
pnpm test          # full suite
pnpm bench         # the 5000-event budget test
pnpm typecheck
```

The suite runs under `TZ=Pacific/Chatham` (UTC+12:45/+13:45) so that any
accidental dependence on the host's local zone fails loudly rather than passing
on a CI box that happens to run UTC.

`test/fixtures/` holds the corpus, with its own README describing each file's
provenance. Fixtures are snapshot-tested and the snapshots are committed; a
snapshot diff means a bug was either fixed or introduced, and reading the diff is
how you tell which.

`pnpm verify:expectations` cross-checks the suite's hardcoded UTC values against
real ICU data. It needs no `node_modules`, so it is a useful first move when
something looks wrong.

## Licence

MIT.
