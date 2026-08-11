# Changelog

## 0.5.0

Weather is easier to set up, and shows that it is working.

- **Use your Home Assistant home location.** A button fills the forecast’s
  latitude and longitude from Home Assistant’s own home zone, so there are no
  coordinates to look up. It only reads the location — Maverick Wall never
  writes to Home Assistant.
- **See the forecast on the settings page.** The current five-day forecast and
  when it was last updated now show right where you turn it on, so you can tell
  it is working instead of guessing.
- A small fix: the “how much to show” numbers below the weather settings now
  save reliably.

The manual latitude and longitude are still there if you prefer them, and the
forecast remains United States only.

## 0.4.0

Choosing Home Assistant readings is far easier.

- The entity picker is now a **searchable, filterable list** instead of one long
  drop-down. Search by name, filter by kind (sensors, locks, people, covers, and
  so on), and see each entity’s **current value** as you browse.
- **Pick several at once** and add them together; the ones you have chosen show
  as removable tags. Adding a single reading can still give it your own name.

It works with no calendar-address hunting and reads Home Assistant only — the
wall still receives resolved values, never a way to reach back into your house.

## 0.3.0

Designing a wall is now one place, and each widget can be set up on its own.

- **Screens and Layout are joined into one “Displays” section.** Click a
  display and you get everything about it on a single page — whether it is
  online, its pairing, how it is hung, its theme, and its layout — instead of
  hopping between two screens.
- **Each widget on a free-form layout has its own settings.** A Calendar widget
  can show a month grid or an upcoming list, limited to the calendars you pick
  and a number of events. A Home Assistant widget can show just the readings you
  choose rather than every one. So ten sensors no longer means ten on the wall.
- **And its own look.** Give any widget a title, align its text, and put a
  background behind it — a colour, a transparency, rounded corners, a shadow.
- **Stack widgets front to back** with Send to back / Bring to front, and the
  order you set is the order the wall draws.
- **The layout preview is the wall.** It now shows exactly what the screen will
  draw — the stacked layout when the free-form layout is off, your arrangement
  when it is on — so there are no surprises after you save.

Every existing wall is untouched until you change it.

## 0.2.2

Fixes the buttons on the Screens page.

- **Unpair** and **Show pairing link** led to a "not found" page when the
  settings were opened through the Home Assistant sidebar or a reverse proxy.
  Both buttons work again wherever the settings are opened from.

## 0.2.1

Setting up a wall screen is far less fiddly.

- A screen with no camera — most **televisions** — can now be paired by
  **typing a short code**. Open Maverick Wall on the screen itself, enter the
  code shown on the Screens page, and it pairs. No more reading a long web
  address off one screen and thumbing it into another with a remote.
- The add-on now **works out its own address**. It asks Home Assistant which
  port your wall screens should connect on and fills the pairing address in for
  you, so there is far less to get exactly right by hand — and if the display
  port is turned off, the Screens page says so plainly instead of handing you a
  link that goes nowhere.
- The **wall display port is on by default**, so a fresh install already has
  somewhere for screens to connect without digging through the Network
  settings.

If a screen was already paired, nothing changes.

## 0.2.0

A new look for the settings.

- The admin has been redesigned around a fixed **sidebar** and an **Overview**
  dashboard: at-a-glance cards for your calendars, screens and shifts, and the
  status of Weather, Home Assistant and the system, so you can take in the whole
  wall from one page. Every screen now wears the wall's own dark, amber "Board"
  look, with clearer cards, headings and status pills throughout.
- The settings carry their own **typeface** instead of fetching one from the
  internet, so they read the same offline and nothing is loaded from anywhere
  outside the add-on.
- Nothing you have set up changes — the same calendars, screens, shifts and
  layouts, in a clearer place.

## 0.1.9

Each wall can now be set up on its own.

- The settings are grouped into **Modules** (Calendars, Shifts, Weather, Home
  Assistant), **Walls**, and **Settings**, instead of one long list — and the
  pages are wider, since they open in the full window.
- A **wall switcher** on the Layout page lets you design each screen
  separately: pick a wall and arrange its own layout, set its orientation,
  theme and how much it shows — all in one place, with a live preview of that
  wall. Leave a wall alone and it follows the shared default.
- The Screens page is now just for pairing a screen; its settings moved to the
  wall's own page.

Existing walls are unchanged: every setting is the shared default until you give
a wall its own.

## 0.1.8

A face for the project, and easier navigation.

- Maverick Wall now has an icon and a logo, so it shows up properly in the
  sidebar and the add-on store instead of a nameless placeholder. The same mark
  appears on the settings pages and in the browser tab.
- The settings gained a row of tabs — Calendars, Display, Layout, People,
  Shifts, Screens, Home Assistant, Weather, System — so you move straight from
  one section to the next instead of going back to a menu each time.

## 0.1.7

Explains the options on the Configuration page.

- `base_url` and `ingress_trust_source` now have a label and help text on the
  add-on's Configuration tab, instead of showing as bare keys. `base_url` says
  to give the full address — scheme and port, like `http://192.168.1.33:8080`.
  `ingress_trust_source` says to leave it blank unless the add-on log tells you
  otherwise.

## 0.1.6

Fixes a crash when `base_url` was set to a bare address.

- Setting `base_url` to just an IP — `192.168.1.33` rather than
  `http://192.168.1.33:8080` — stopped the add-on from starting. It now adds
  the missing `http://`, boots, and prints a line reminding you to include the
  host port the add-on was mapped to. A value it still cannot make sense of
  falls back to the default instead of refusing to start.
- Give `base_url` the full URL — scheme and port — for wall-screen pairing to
  hand out a link a tablet can reach.

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
