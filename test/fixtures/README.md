# Fixture corpus

Every fixture is either **synthetic** (authored here, in `synthetic/`) or **real**
(a scrubbed export from a live product, in `real/`). The distinction matters:
synthetic fixtures test what the RFC says, real fixtures test what producers
actually emit, and those are not the same thing. A parser that passes only the
first kind will still fail on a school district's calendar.

Every fixture is snapshot-tested. Snapshots are committed and are expected to be
**read** during review, not blindly updated. A diff in a snapshot means either a
bug was fixed or a bug was introduced, and telling those apart is the point.

## Synthetic fixtures

All authored by hand for this package. No provenance beyond that, no PII, safe
to publish.

| File | Exercises | Requirement |
| --- | --- | --- |
| `rrule-comprehensive.ics` | FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYSETPOS, COUNT, UNTIL, and both WKST examples from RFC 5545 §3.8.5.3 | 1 |
| `exdate.ics` | Single EXDATE, multi-value EXDATE on one line, EXDATE on an all-day series | 2 |
| `rdate.ics` | RDATE extending an RRULE, and RDATE with no RRULE at all | 3 |
| `recurrence-id-overrides.ics` | An instance moved, an instance retitled and lengthened, an instance cancelled | 4 |
| `vtimezone-custom.ics` | An embedded VTIMEZONE with DAYLIGHT/STANDARD blocks, referenced by TZID, sampled either side of the transition | 5 |
| `floating-times.ics` | DTSTART with no TZID and no `Z`, including a floating recurrence across a DST boundary, plus an explicit-UTC control | 6 |
| `dst-us.ics` | Weekly series across US spring-forward (2026-03-08) and fall-back (2026-11-01), plus a meeting spanning the gap | 7, 8 |
| `dst-europe.ics` | Weekly series across EU transitions (2026-03-29, 2026-10-25) in Berlin and London — three weeks earlier than the US, which is the whole point | 9 |
| `allday.ics` | Exclusive DTEND, omitted DTEND, month end (28th and 31st), year end, a multi-day span crossing a DST change, and a recurring all-day | 10, 11, 12 |
| `cancelled.ics` | Cancelled master, plus confirmed / tentative / status-absent neighbours that must survive | 13 |
| `line-folding.ics` | Continuation lines folded with a space, with a tab, and folded three times | 14 |
| `escaped-text.ics` | `\,` `\;` `\n` `\\` in SUMMARY, LOCATION and DESCRIPTION | 15 |
| `window-straddle.ics` | Events straddling the window start, the window end, both bounds, neither bound, and a zero-length instant | 16 |
| `empty-calendar.ics` | A valid VCALENDAR containing no VEVENTs | 18 |
| `windows-timezones.ics` | Outlook-style Windows zone names, a Mozilla-prefixed TZID, and an unresolvable TZID | 5 |
| `malformed-truncated.ics` | A file that stops mid-property, as a interrupted download would | 19 |
| `malformed-garbage.ics` | Plain text with an `.ics` extension | 19 |
| `malformed-html.ics` | An HTML 404 page, which is what a dead feed URL usually returns | 19 |
| `partial-damage.ics` | Missing UID, missing DTSTART, nonsense RRULE, and an orphan override alongside one healthy event that must still render | 19 |

The 5000-event feed for requirement 20 is **generated at test time** by
`test/support/generate-large.ts` rather than committed, because a multi-megabyte
fixture in git history is a tax on every future clone.

## Real fixtures

### `real/fcps-school-district.ics`

Frederick County Public Schools, Maryland. Public feed, no scrubbing required.

| | |
| --- | --- |
| Source | `https://www.fcps.org/ICalendarHandler?calendarId=74783647` |
| Producer | `-//ddaysoftware.com//NONSGML DDay.iCal 1.0//EN` |
| Retrieved | 2026-07-28 |
| Household timezone | `America/New_York` |
| Contents | Full feed as published, byte-for-byte, including CRLF, folding, and invisible characters. |

Frozen at the retrieval date on purpose: the district edits this calendar
continuously, so a live fetch would break the snapshot weekly.

**What it caught.** Two real bugs, neither of which the synthetic corpus would
ever have found:

1. **U+200B in `SUMMARY`.** Two titles begin with a zero-width space, pasted in
   from a web editor and invisible to whoever typed them. `String.trim()` does
   not remove it, so those titles sorted under the wrong letter and never
   compared equal to the identical-looking string beside them. Fixed in
   `readString`.
2. **`TZID:US Eastern`.** Neither an IANA name nor a Windows one — a bare form
   DDay.iCal emits. It resolved to *unknown* and fell back to the target zone.
   Harmless in this file, since no VEVENT references it, but the same producer
   is used by municipalities that do. Added to the alias table.

**What it confirmed.** Things designed for that turned out to matter:

- Almost every event is `VALUE=DATE` with exclusive `DTEND`. All-day handling is
  the dominant correctness concern for this audience, well ahead of recurrence.
- **The feed contains no `RRULE` at all.** Not one. A district publishes explicit
  one-off events, so the recurrence engine — the part that took the most care —
  is not what makes this feed render correctly.
- Reschedules are modelled as two unrelated events with different UIDs, one
  retitled `Postponed: …`, rather than as `RECURRENCE-ID` overrides.
- `DESCRIPTION` carries raw HTML: `<p>`, `<br>`, `&amp;`, `&nbsp;`. We leave it
  untouched; decoding would corrupt descriptions that legitimately contain those
  characters, and descriptions are stripped by default anyway.
- Some all-day events are entered as one-hour timed events in bare UTC at
  arbitrary minute offsets — a data-entry artefact, not a spec feature.

### Adding another feed

```bash
npm run fixture:add -- 'https://example.org/calendar.ics' acme-district
```

The script fetches the feed, refuses anything that is not iCalendar (a dead feed
URL usually answers with an HTML error page, not a 404), and prints a summary of
what it found — event count, all-day share, RRULE count, producer, and any TZIDs
in use. That summary is worth reading before anything else: it tells you what the
fixture is actually going to exercise.

Then two required steps, which the script reminds you about:

1. **Declare the household timezone** in `CONFIGS` in
   `test/fixtures.snapshot.test.ts`. This is enforced — a fixture under `real/`
   with no explicit `targetTimezone` fails the suite rather than quietly
   snapshotting against a wrong zone. A plausible-looking record of incorrect
   behaviour is worse than no record.
2. **Add a provenance row** below: source URL, producer, retrieval date,
   household timezone.

Run the suite. A new snapshot is written. **Read it before committing** — that
first read is the entire value of adding the fixture, because it is where you
find out what the producer actually does.

A note on refetching: most producers stamp `DTSTAMP` and similar with the fetch
time, so re-fetching an unchanged calendar still shows a diff in the `.ics`. The
snapshot will not move, because we ignore those fields. If the `.ics` changes and
the snapshot does not, nothing meaningful changed.

### Still wanted



`real/` is empty. These are the exports I'd like, in rough priority order. The
first four cover most households; the last five are where the interesting bugs
live.

| Source | Why it matters | What to export |
| --- | --- | --- |
| **Google Calendar** | The most common feed by far. Emits `X-WR-CALNAME`, its own VTIMEZONE blocks, and RECURRENCE-ID overrides liberally. | Settings → your calendar → "Secret address in iCal format", or Export calendar for a `.zip` |
| **Outlook / M365** | Windows zone names rather than IANA, `X-MICROSOFT-CDO-*` properties, and unusual folding. | Publish calendar → ICS link |
| **iCloud** | Apple's own VTIMEZONE style and its handling of all-day events. | Calendar → share → Public Calendar → webcal URL |
| **Home Assistant** | We ship as an HA add-on, so its local calendar output is a first-class input. | The `/api/calendars/<entity>` payload, or a local_calendar `.ics` from `.storage` |
| **Cozi** | Family-focused, heavy all-day and recurring use — the closest thing to our actual audience. | Settings → Calendar → iCal URL |
| **Nextcloud** | Self-hosters overlap heavily with our users. CalDAV round-tripping leaves distinctive artefacts. | Calendar app → ⋯ → Download |
| **Teamup** | Popular for clubs and teams. Sub-calendars and colour metadata. | Calendar settings → iCalendar feed |
| **School district** | The single most valuable fixture. Long all-day spans for breaks, half-days, and irregular one-offs — and getting a school holiday off by one day is exactly the failure that makes someone uninstall. | Whatever "subscribe to calendar" link the district site offers |
| **Sports schedule** | Timed events in a fixed zone consumed in another, frequent reschedules via RECURRENCE-ID. | Team or league "add to calendar" ICS |
| **Municipal trash pickup** | Nearly always all-day, nearly always recurring with awkward rules, often produced by ancient software. | City waste-services calendar subscription |

### Before you send them

These are real family calendars, so:

1. **Scrub in place, don't summarise.** Keep the structure — same property order,
   same folding, same producer quirks. Replace only the values that identify
   someone. The quirks are the fixture; the content is not.
2. **Replace, don't delete.** Swap SUMMARY and LOCATION for equivalents of
   roughly the same length and shape (`Dentist — Dr Alvarez` → `Dentist — Dr
   Smith`). Deleting properties changes the parse; replacing them does not.
3. **DESCRIPTION and ATTENDEE can go entirely.** We strip descriptions by default
   anyway, and attendee lists are pure PII with no parsing interest.
4. **Keep every UID and every TZID exactly as-is.** They are opaque and they are
   what we are testing.
5. **Say which zone the household is in**, so I can pick a sensible
   `targetTimezone` for the snapshot rather than guessing.

If scrubbing is a chore, the highest-value single file is the school district
one — it's usually public, so no scrubbing is needed at all.

Drop them in `real/<source>/<name>.ics` and add a row to a `real/README.md`
noting the producer, the export date, and the household timezone. I'll write the
snapshots.
