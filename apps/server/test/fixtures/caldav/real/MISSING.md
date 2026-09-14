# Nothing here yet, and this file names what

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
4. **`nextcloud-home-set.xml`** — a real SabreDAV answer, to check the
   synthetic one beside it is actually its shape.

1–3 need an Apple ID with an app-specific password. 4 needs a Nextcloud that can
be reached; a container is enough and it was the plan.

Deliberately **not** a placeholder fixture. A file here that no test reads is
harmless; a file here that a test reads and that nobody captured is a test
passing against somebody's guess, which is worse than the gap it hides.
