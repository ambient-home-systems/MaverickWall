# Changelog

## 0.1.2

Makes the Home Assistant add-on start. Under 0.1.1 it installed and then
refused to start with "/data is not writable by this container".

- The supervisor creates the add-on's data directory itself, owned by root,
  and there is no setting anywhere that changes that. The image ran as a
  normal user and so could not write its own database — the one thing the
  add-on had no way around. The container now takes ownership of the directory
  at startup and then drops to that user before running anything, so it is
  still unprivileged the moment it touches a calendar feed.
- The "not writable" message, when it does still appear, now names the actual
  cause — a read-only mount, or a `--user` that cannot be helped — instead of
  advising a `chown` that does not apply under the supervisor.

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
