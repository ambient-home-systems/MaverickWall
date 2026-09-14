# What is still missing, and this file names it

A real **SabreDAV** is here now (`sabredav-*.xml`, five files, read by
`caldav-real-fixtures.test.ts`) — the library Nextcloud's calendar is built on,
captured byte for byte from a local instance with three calendars on one
credential. That closed item 4 below by most of the way and found a real
difference doing it: SabreDAV writes the CalDAV namespace as `cal:` where every
synthetic fixture here writes `C:`.

What it does **not** close is the whole Apple side, which is the half §11 calls
the one with no substitute.

`../README.md` has the detail. In one line each, and in the order they matter:

1. **`icloud-principal.xml`** — the `calendar-home-set` that points at
   `pNN-caldav.icloud.com`. The partition-host hop is the only reason
   `caldav/discover.ts` has a host policy at all, and no local fake proves an
   Apple ID password actually has to cross it.
2. **`icloud-calendar-data.xml`** — a `REPORT` answer from a real Apple
   calendar. Home Assistant carries an open issue about Apple serving iCal that
   strict parsers reject, and `packages/calendar` is a strict parser.
3. **`icloud-home-set.xml`** — Apple's prefixes and whether it answers
   `getctag`.
4. **`nextcloud-home-set.xml`** — *mostly closed.* `sabredav-home-set.xml` is a
   real answer from the same library and confirms the two-`propstat` 200/404
   shape. What is left is Nextcloud's own routing on top of it, and the redirect
   it issues when the trailing slash is wrong.

1–3 need an Apple ID with an app-specific password. 4 needs a Nextcloud that can
be reached; a container is enough and was the plan, but this environment has no
Docker daemon at all.

Deliberately **not** a placeholder fixture. A file here that no test reads is
harmless; a file here that a test reads and that nobody captured is a test
passing against somebody's guess, which is worse than the gap it hides.
