# Changelog

## 0.1.5

Adds a free-form layout: arrange widgets on the wall yourself.

- A new **Layout** screen lets you place widgets anywhere — add a Clock,
  Calendar, Weather, Home Assistant or Shift widget, drag it to move, pull the
  corner to resize. The preview shows the real wall as you arrange it, not a
  mock-up. Turn it on to use your layout instead of the stacked one; leave it
  off and nothing changes.
- Widgets are first-party only, by design: there is no web-page or video tile,
  because the wall does not run third-party content. A layout scales to any
  screen resolution of the shape you author it at, and works in a rotation.
- Every existing wall is untouched until you turn a layout on.

## 0.1.4

Stops asking you to sign in to the settings when you open them from the Home
Assistant sidebar — Home Assistant has already authenticated you there.

- The sidebar settings now accept your Home Assistant login. This is only
  granted when the request genuinely comes from the supervisor, checked by its
  network address and not by any header a device on your network could send, so
  it cannot be used to reach the settings from anywhere else. Every case of
  doubt falls back to the normal login.
- If the default is wrong for your install, the add-on log's first
  `[ingress] first request from …` line shows the address it saw and whether it
  was trusted. Set it with the new `ingress_trust_source` option if that line
  reads `trusted supervisor source: no`. A wrong or empty value only ever means
  you still sign in — it can never open the settings to anything it should not.
- Wall displays are unaffected: a screen on the port still pairs with its own
  token, and never uses a Home Assistant login.

## 0.1.3

Lets you pair a wall screen from the sidebar, with no shell.

- The Screens page now has an "Add a screen" button. Before this the only way
  to pair the first screen was a command-line tool, which an add-on has no way
  to run — a sidebar is not a shell.
- The pairing link now points at an address a screen can actually reach. When
  generated through the sidebar it uses the `base_url` you set, rather than
  Home Assistant's own internal address, which is reachable from inside Home
  Assistant and nowhere a tablet on the wall lives. If `base_url` is unset the
  page says so plainly instead of handing over a link to localhost.

  Set `base_url` in the Configuration tab to this box's address on your
  network — like `http://192.168.1.10:8080` — before you pair a screen.

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
