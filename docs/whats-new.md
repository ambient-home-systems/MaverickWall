# What's new in 0.68.0

This walks through the household-facing features that shipped in 0.68.0 and
says exactly where to find each one in the admin. None of it needs a restart
or a fresh wall — it applies to every wall you already have.

The short version of each of these also ships as the release note beside the
Update button in Home Assistant's Add-on Store (see
`addon/maverick-wall/CHANGELOG.md`). This page is the longer version, with the
click path spelled out, because the changelog entry doesn't tell you where a
control lives and there's no other user-facing docs site yet — the rest of
`docs/` is install and operations material, not a feature guide.

## Wallpaper

A wall's canvas can carry a picture behind its widgets instead of a flat
colour.

**Where:** open a wall → **Layout** tab → click the **Layout** button in the
canvas toolbar (this opens a popover — it's easy to read "Layout" as just the
tab name and miss the button with the same label) → **Background** →
choose **Wallpaper**.

A grid of pictures appears, filtered to suit your wall's theme (dark
wallpapers for a dark theme, light ones for a light theme) — there's a toggle
to show the other tone too, with a note about what it costs to read. Picking
one applies it to both portrait and landscape unless you untick **Use for
both portrait and landscape**.

Three wallpapers ship in 0.68.0, with more planned. Each widget sits on a soft
ground of the theme's own card colour so its text stays legible over the
picture; **Widget ground**, on the same Layout popover, can make that ground
Solid or turn it off entirely. Turning on a widget's own **Card background**
(Style tab) now starts from the theme's card colour rather than a dark grey on
every theme.

An e-paper panel never draws a wallpaper — one bit of colour has no room for a
picture behind the widgets.

## New weather widget looks

Pick a look under **Look**, at the top of the weather widget's **Style** tab.
Nothing changes on a wall until you pick one.

- **Range** — a row per day: name, picture, chance of rain, then a bar from
  the day's low to its high, coloured cool to warm, with a dot on today's bar
  at the current temperature. A small box shows fewer days rather than
  smaller ones; a narrow one gives up the rain chance, then the picture,
  before it gives up the bar.
- **Colour** — the forecast strip you already have, with skies painted (grey
  clouds, blue rain, a yellow sun behind a cloud) and each temperature
  coloured by how warm it is.
- **Today** — a phone-style card: the current temperature in large type,
  today's high and low, the sky in words, how it feels, and the next few
  hours along the bottom (or the next few days, in a shorter box). The card
  is coloured by the sky — blue on a clear day, indigo at night, grey when
  overcast, slate in the rain — and the sky moves gently: sun glows, clouds
  drift, rain falls. With no recent reading it shows today's high and low
  instead, so it never shows a stale "now" temperature.
- **Playful** — the forecast strip with big day names and a picture per day
  that bobs gently, plus a line underneath when conditions call for it:
  "Umbrella day", "Coat weather", "Shorts weather", "Sunscreen", "Windy". The
  line can be switched off on the widget's **Content** tab.

An e-paper panel draws Range as plain black bars and Colour as the plain
strip — a panel has no colours to paint with.

## Each wall has a Motion switch

**Where:** the wall's settings → **Device and time** (same section as the
wall's size and timezone).

This decides whether the styles that move — Today and Playful above — are
allowed to animate on that wall. It's on for every wall you already have, and
off by default for walls sized as an e-ink panel (which redraw the whole
screen for every frame, so motion there is just flicker). A device set to
reduce motion stays still regardless of the switch. An animation resumes
smoothly through the wall's normal fifteen-second redraw rather than
restarting.

## Shift widget: two people now both show

No setting to change — this is a fix, not a control. If two people on the
rota are working the same day, the Shift widget used to draw only the first
person's badge and silently drop the second, because the box was sized for
one badge at full size. Now: when the box has room for a badge each, both get
one; when it doesn't, each person gets a compact line in their own colour
("Amy: Days", "Ben: Mids") — the same form an e-paper panel has always used
there.

## Home Assistant readings say which walls they're on

**Where:** **Home Assistant** → **Readings**.

Adding a reading here only makes it available to a **Home Assistant widget**
— it doesn't put anything on a wall by itself, and the default Classic
template has no such widget. The button is now **Add reading** (not "Add to
the wall"), the list is **Your readings**, and each entry says where it's
actually shown: "On: Kitchen, Hall" or "Not on any wall yet". If nothing has
the widget yet, a card at the top says so and links to each wall's Layout
tab. The Store's recipe button is **Install** for the same reason, and an
installed module says which walls show it.

Also fixed: renaming a reading used to silently drop it from every widget
that had picked it (widgets remembered it by name). Widgets now remember the
reading itself and keep working; they switch over the next time you save
that wall's layout.

## New Home Assistant device types

**Where:** **Home Assistant** → **Readings** → **Add reading**.

You can now add a light ("On · 60%"), a switch or helper toggle ("On"), a fan
("On · 40%"), a blind ("Open · 40%"), a lock ("Unlocked") and a thermostat
("Heating · 21°"), each with its own symbol, on both a wall and an e-paper
panel. This is read-only, same as every other Home Assistant reading — the
wall shows state and cannot switch a light on or unlock a door. Readings you
already had look exactly as they did.

## "Add" is in the same place everywhere

Calendars, People, Work Schedule, Shift types, Chores, Themes, Readings,
To-do lists, "Tell me when…" rules, and Walls each have one **Add …** button
at the top right of their list, which opens a page of its own rather than a
form buried at the bottom of the list.

A few worth knowing about specifically:

- **Add a calendar** now starts by asking where it comes from — an iCal
  address, an iCloud/CalDAV account, or Home Assistant — with the note about
  reaching Google, iCloud and Microsoft 365 through Home Assistant right on
  that page.
- **Add a wall** asks which kind first: **a browser wall** (tablet, monitor,
  television) or **an e-paper wall** (ESPHome or OpenDisplay panel).
  "Approve a pairing code," for a wall already showing one, is a link at the
  top of the Walls page and on the Add a wall page.
- **Add a rule** (Home Assistant → "Tell me when…") is where the ready-made
  templates ("Garage door open late", etc.) now live.

## Weather: current conditions and air quality

The wall now checks current conditions every fifteen minutes (National
Weather Service: your nearest station; Open-Meteo: its model), plus the next
24 hours, each day's rain chance, wind, sunrise/sunset, and — from
Open-Meteo — UV index and expected rainfall. **None of this is drawn on the
wall yet in 0.68.0** — it's the data the new weather looks above are built
from, and it underpins the Today card's "current temperature" reading. The
hourly forecast itself is still fetched once an hour, as before.

**Air quality** is a new opt-in: **Weather** page → **Show air quality**. It's
off by default because it queries a second service
(`air-quality-api.open-meteo.com`) once an hour; the switch says so before it
asks anything. Turning it off forgets the last reading.

The Weather page's "Forecast from" section now also explains what each
provider actually gives you (NWS: US-only, station-measured; Open-Meteo:
worldwide, modelled, adds UV and rainfall amounts).

## Quieter e-paper panels

Background change, no setting involved: an e-paper panel used to get a fresh
picture — a full redraw, a flash, a bit of battery — whenever *anything*
changed anywhere, even a Home Assistant reading or a to-do list it didn't
draw, or the new current-conditions poll above on a panel with no weather
widget. A panel is now only sent a new picture when something it actually
draws has changed.

---

## Also recently added (0.67.0)

Two layout-editor features from the previous release that are just as easy
to miss:

- **Grouping widgets** — select two or more boxes and press **Group**. The
  group gets a dashed outline and a **grip** (its name chip) you can drag to
  move every widget in it together. Tap any widget in the group to see its
  edge light up and get an **Ungroup** option right there. Choose **Free** on
  the group's own settings if you'd rather it just kept your boxes' existing
  positions without arranging them into a row or column.
- **Corners** (rounded corners) only appears on a widget's Style tab once
  there's something to round — turn on **Card background**, or give the
  widget its own colour under Colours and type. It's always available on a
  picture, where it now rounds the picture itself.
