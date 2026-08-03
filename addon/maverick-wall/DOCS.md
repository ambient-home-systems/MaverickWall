# Maverick Wall

A family calendar for a wall display. It reads your Home Assistant calendars
and a few sensors, and it never writes anything back.

## Installing

1. Add this repository under **Settings → Add-ons → Add-on Store → ⋮ →
   Repositories**.
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

**base_url** — the address a browser actually uses to reach the add-on, for
example `http://homeassistant.local:8080`. Leave it empty unless sign-in
complains about an origin. It has no effect on ingress.

**log_level** — how much the add-on writes to its log. `info` is right.

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

It cannot control anything in Home Assistant. There are no service calls, no
switches and no scenes, and the wall receives resolved values — "19.4 °C",
"Open" — never an entity id and never a way to ask Home Assistant a question of
its own. If a tablet in your hallway is ever compromised, the worst it can give
away is your indoor temperature.
