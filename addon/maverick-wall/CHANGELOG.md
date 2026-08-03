# Changelog

## 0.1.1

Fixes the install. 0.1.0 could not be started by the command in its own
documentation.

- The container owns its data directory, so a named volume works with no
  setup. In 0.1.0 that directory belonged to root while the application runs
  as a normal user, and it stopped on the first line with a permission error.
- Home Assistant: the `base_url` option now does something. It sets the
  address wall displays are given when you pair them; left unset a pairing
  link says `localhost`, which is nowhere from a tablet on a wall.
- Removed the `log_level` option. It controlled nothing.

## 0.1.0

First release.

- The wall: today, the week ahead and a month grid, in portrait or landscape,
  with per-screen rotation for a panel mounted on its side.
- Calendars from ICS feeds and from Home Assistant calendar entities.
- Shift rotation, per person, from a pattern or derived from a calendar.
- A few Home Assistant readings beside the calendar. Read-only, always.
- National Weather Service alerts, with a shipped ladder from a banner to a
  full-screen takeover that can wake a dark screen.
- Draws from a stored copy when the server is unreachable, and says how old it
  is.
