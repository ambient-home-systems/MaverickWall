# Maverick Wall

A family calendar for a wall display. It reads your Home Assistant calendars
and a few sensors. It writes back only what you allow: ticking an item off a
to-do list you chose to show, adding an item to such a list from a phone that
holds your companion token, and operating a light, a switch, a fan or a blind
you marked controllable, only from a wall you have turned that on for — see
**What it will not do**, below.

## Installing

[![Add repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fambient-home-systems%2FMaverickWall)

1. Press the button above — it opens your Home Assistant with this repository
   already filled in. Or add it by hand under **Settings → Add-ons → Add-on
   Store → ⋮ → Repositories**.
2. Install **Maverick Wall**, then **Start**.
3. Open it from the sidebar. The first-run wizard asks for an account, a
   timezone, and optionally a calendar.

Your Home Assistant calendars are available immediately — the add-on reaches
Home Assistant through the supervisor, so there is no token to create and
nothing to paste.

## Two ways in, and they are different

**The sidebar** is the settings. Home Assistant authenticates you and the
add-on appears inside the interface. Use this from a phone or a laptop.

**The port** is for the wall displays. A tablet screwed to a wall has no Home
Assistant session and cannot get one, so a screen connects directly:

```
http://<your-home-assistant>:8080/
```

Pair it from **Screens** in the settings — the pairing link and its QR code are
there. The token in that link is what the screen authenticates with; it is not
a Home Assistant credential and it only ever grants read access to the
calendar document.

If port 8080 is taken, change it in the add-on's **Configuration** tab and use
the new one in the pairing link.

## Options

**base_url** — the address the *wall displays* use, for example
`http://homeassistant.local:8080`. Set it if a pairing link comes out saying
`localhost`, which is nowhere from a tablet on a wall.

It has no effect on the sidebar: ingress handles that address itself.

**mdns** — whether Maverick Wall announces itself on your network, so a wall
screen can find it without anybody typing an address or hunting for a port. On
by default. The announcement never leaves your own network, and turning it off
costs discovery only: every screen can still be paired by address, and nothing
about the wall changes.

## Weather alerts

United States only, from the National Weather Service. No account and no API
key. On by default; the ladder of what each severity does is on the **Weather
alerts** screen and every rule can be changed or switched off.

> **Not a life-safety system.** Do not rely on it for emergency warnings. It is
> not a substitute for a NOAA Weather Radio, Wireless Emergency Alerts, or
> local warning sirens. Delivery depends on your internet connection, device,
> and power.

## Backup

The add-on's data lives in its own persistent storage and is included in a Home
Assistant backup automatically. The **System** screen also offers a manual export: the database and the
encryption key are offered as two separate downloads, because the database
alone restores everything except your calendar addresses — those are encrypted.

## What it will not do

It changes three kinds of thing in your house, and only once you ask: ticking
an item off a to-do list you chose to show on a wall, adding an item to such a
list from a phone or an automation, and operating lights,
switches, fans and blinds from a wall — switching them, dimming a light or
changing its colour, setting a fan's speed, opening, closing or moving a
blind, playing, pausing or skipping on a speaker and setting its volume, and
running a scene or a script, which a wall asks you to press and hold. A wall
operates something only when you
have marked it **Can be controlled from walls** on the Readings screen, turned on
**Allow operating things in the house** for that wall, and set the widget to
**Tap to operate** — all three off by default.

It can never unlock a door, disarm an alarm, change a thermostat, or open a
garage, gate, door or window. Those are not in its frozen table of permitted
actions, and a test holds the code to that table. A scene that sets any of them
is refused too, checked when you allow it and again at every press. A script
cannot be checked that way, and nor can a webhook button, which calls whatever
is behind its address: one you allow can do whatever it was written to do, and
the admin says so before you allow it.

Adding from a phone needs a companion token, which you make under **System ›
Phone and automations** and can replace or turn off there. It can add to the
lists you chose and do nothing else — it cannot read them, tick them off or sign
in — and a wall can never add at all.

Even the tick is off until you ask for it, wall by wall. Adding a list shows it
everywhere you have put a To-do widget; turning on **Allow ticking to-do items
off** on a particular wall's page is what puts a box beside each item there. It
is its own switch rather than a share of the chore one, because it changes
something outside this application — your phones see it. Switching a light is
its own switch again, **Allow operating things in the house**, for the same
reason and more so. An eInk panel shows the list and never offers a box at all.

The wall itself receives resolved values — "19.4 °C", "Open" — never an entity
id and never a way to ask Home Assistant a question of its own. If a tablet in
your hallway is ever compromised, the worst it can do is show somebody your
indoor temperature, tick an item off your shopping list and operate the
lights, fans, blinds and speakers, run the scenes and scripts and press the buttons you
allowed it to — and it can never open your garage, unless a script or a webhook
button you allowed does.
