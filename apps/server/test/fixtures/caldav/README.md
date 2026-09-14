# CalDAV fixture corpus

The same split `packages/calendar/test/fixtures/README.md` makes, and it matters
here for the same reason: **synthetic fixtures test what the RFC says, real
fixtures test what producers actually emit**, and those are not the same thing.
RFC 013 §6.8 names the way this reader goes wrong — "a reader that handles one
server's prefixes and not another's works against Nextcloud and fails against
iCloud" — and only the second kind can catch that.

## `real/` holds a real SabreDAV, and that is half the gap closed

**What is there.** Five files captured from a real **SabreDAV 4.7.1** — the
library Nextcloud's own calendar app is built on — stood up locally over PHP's
built-in server with three calendars on one credential and two real events on
them. Byte for byte, and not authored: `sabredav-principal.xml`,
`sabredav-home-set-href.xml`, `sabredav-home-set.xml`, `sabredav-ctag.xml` and
`sabredav-report.xml`, read by `caldav-real-fixtures.test.ts`.

They earned their place on the first run. This server writes the CalDAV
namespace as **`cal:`** where every synthetic fixture in this corpus writes
`C:`, which is exactly the class of difference §6.8 says is how this reader
goes wrong. It also confirms the two-`propstat` 200/404 shape the synthetic
Nextcloud fixture below only *claims* is SabreDAV's — and adds a case nobody
had modelled, which is that SabreDAV's scheduling inbox and outbox come back in
the same `Depth: 1` listing as the calendars and must not be offered as
calendars.

**What is still missing, and it is the half that matters most.** SabreDAV is
not Nextcloud (which mounts it behind its own routing, its own principals and
its own trailing-slash redirect) and it is emphatically not iCloud. In
particular the **partition-host hop** — the one §6.3.1's whole policy exists
for — is still modelled by a second loopback server rather than seen, and
whether Apple's `calendar-data` parses is exactly as open as it was.

- **Nextcloud.** The plan was a container (`nextcloud:30-apache`, SQLite, an app
  password). No Docker daemon is available in this environment at all, so the
  image could not be pulled or run. SabreDAV over `php -S` is what was reachable
  and is a real producer, which is why it is here rather than nothing.
- **iCloud.** Needs an Apple ID and an app-specific password. There is no
  substitute and no fixture that stands in for one — §11 says so and it is
  right.

So `synthetic/` below is still **authored from the documented shapes**, not
captured. Read that as the limit it is: those files prove the reader does what
it claims about namespaces, entities and depth, and they cannot prove it reads
what Apple actually sends.

### What is missing, specifically

| File wanted | From | What only it can answer |
|---|---|---|
| `real/icloud-home-set.xml` | A real Apple ID, `PROPFIND Depth: 1` on the calendar home set | Apple's own prefixes and namespace habits; whether `getctag` is present; what a partition host's hrefs look like |
| `real/icloud-principal.xml` | The same account, `PROPFIND Depth: 0` on `/` | The `calendar-home-set` href that names `pNN-caldav.icloud.com` — the hop §6.3.1's whole policy exists for, which no local fake proves |
| `real/icloud-calendar-data.xml` | A `REPORT` against one of that account's calendars | Whether Apple's `calendar-data` parses. HA carries an open issue about Apple serving iCal that strict parsers reject, and §11 calls a hostile fixture copied from a real iCloud resource "the first thing to write, before any of the transport" |
| `real/nextcloud-home-set.xml` | A real Nextcloud, app password | The redirect Nextcloud issues when the trailing slash is wrong, and whether its own routing changes the hrefs. The `404` propstat shape is no longer open — `real/sabredav-home-set.xml` settles that half |

## `synthetic/`

| File | Exercises |
|---|---|
| `nextcloud-home-set.xml` | A home set with five collections: a plain collection that is not a calendar, three calendars, and one that supports only `VTODO`. The two-`propstat` shape (200 for what exists, 404 for what does not) is SabreDAV's, and it is the case a reader gets wrong by reading every `prop` regardless of the `status` beside it |
| `prefix-lowercase-d.xml` | `d:` — Nextcloud/SabreDAV's habit |
| `prefix-uppercase-d.xml` | `D:` — the spelling RFC 4918's own examples use |
| `prefix-literal-dav.xml` | A prefix literally named `DAV`, which is legal and reads like a namespace URI |
| `prefix-default-namespace.xml` | `xmlns="DAV:"` with no prefix at all, plus `C:`/`CS:` for the others |
| `hostile-xxe-external-entity.xml` | A `DOCTYPE` declaring `file:///data/.secret` and the cloud metadata endpoint. Refused at the document |
| `hostile-billion-laughs.xml` | Nine levels of nested entity expansion. Refused at the document, **not** expanded and not ignored |
| `hostile-entity-no-doctype.xml` | `&xxe;` with no `DOCTYPE` above it, so a reader that only checks for the `DOCTYPE` passes it through as literal text |
| `hostile-doctype-in-comment.xml` | A `DOCTYPE` inside a comment, where it is inert. Refused anyway — the claim is that the feature is absent, and a reader that starts deciding which `DOCTYPE`s are inert has a parser for them |
| `hostile-deeply-nested.xml` | Forty levels, well-formed, nothing else wrong with it |
| `truncated-mid-document.xml` | The first 620 bytes of `nextcloud-home-set.xml` — what an interrupted download looks like. Must fail without throwing |
| `report-calendar-query.xml` | A `REPORT` answer carrying three whole `VCALENDAR` bodies as `calendar-data`, escaped as character data |
| `report-one-bad-resource.xml` | The same, with a truncated `VCALENDAR` between two good ones (§6.5) |
| `same-events-whole-feed.ics` | The identical three events as one feed, so per-resource expansion can be compared against whole-feed expansion row for row (§6.4, §11 "recurrence parity across kinds") |

The weekly series in the last three crosses **US spring-forward on 2026-03-08**,
which is the whole point of it: RFC 5545 defines recurrence over local clock
readings, so a 09:00 weekly event is a promise about what the kitchen clock
says, and a provider that expands it server-side is a provider that may disagree
with us about one instant a year. §6.4 refuses `<C:expand>` for exactly that, and
the parity assertion is what goes red if somebody later turns it on as an
optimisation.

## Adding a real one

Hrefs are redacted — a username in a CalDAV path is not a credential, but it is
somebody's name, and the shape is what the fixture is for. Replace the account
segment with `REDACTED` and keep everything else byte for byte: property order,
prefixes, whitespace, the `propstat` split, and the exact `getctag` format. Those
are the fixture; the content is not.

A `calendar-data` body is a real calendar and gets `packages/calendar`'s own
scrubber rules — same lengths, same folding, same CRLF — for the reason that
README gives: summarising changes the thing under test.
