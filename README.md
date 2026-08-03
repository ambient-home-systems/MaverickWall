<!--
  SCREENSHOTS GO HERE, and they are the most important thing on this page.

  Full-bleed photographs of the wall in your kitchen, in real light, on the
  real screen. Not a browser mockup and not a rendering — a photograph of the
  thing on a wall, with a mug in shot if there is one. Nothing on this page
  will convince anybody the way one honest install photo does.

  Three, in this order:
    1. The wall in portrait, in daylight, from about where somebody stands.
    2. The same wall at night on the dark theme, from the doorway.
    3. A weather alert taking the screen, or the shift colours across a month.

  Left as a comment rather than filled with a placeholder, because a stock
  photo or a mockup here would be a claim about the product that is not true.
-->

# Maverick Wall

A family calendar for a wall display. One container, one volume, no
subscription, no cloud.

Runs on your own hardware — a NAS, a Pi, a mini PC, or as a Home Assistant
add-on. Wall-mounted tablets and televisions point at it and run unattended for
months.

```bash
docker run -d -v ./data:/data -p 8080:8080 ghcr.io/ambient-home-systems/maverick-wall
```

Open `http://<that-machine>:8080` and the first-run wizard is there. Nothing to
configure first, no account to create anywhere else, no key to paste.

---

## What it does

**The calendar is the product.** Everything else is extra.

- **A wall you can read from the doorway.** Today in full, the next few days
  that have anything on them, then six weeks as colour. Portrait and landscape
  are different layouts rather than one squashed into the other, and a screen
  mounted on its side can be rotated per screen.
- **Real calendars.** Any ICS feed — Google, Apple, Nextcloud, a school
  district — expanded server-side so the display never sees an RRULE. Home
  Assistant calendar entities work too, with no address to find.
- **Shift rotation.** Per person, from a repeating pattern or derived from a
  work calendar, with colours that separate at ten feet. A rest day is drawn as
  a rest day, not as a blank.
- **Home Assistant, read-only.** A few readings beside the calendar. It cannot
  control anything, and that is deliberate — see below.
- **Weather alerts.** National Weather Service, United States only. A banner
  for an advisory, the whole screen for a severe warning, and for an Extreme
  warning it can light a screen that has gone dark.
- **It keeps drawing when the server does not.** The last good calendar is kept
  on the device and painted before the first request is even sent, labelled
  with how old it is. A power cut is a few seconds, not a blank rectangle.
- **Four themes**, with a light one scheduled for daylight hours.

## Install

### Docker

```bash
docker run -d \
  --name maverick-wall \
  --restart unless-stopped \
  -v ./data:/data \
  -p 8080:8080 \
  ghcr.io/ambient-home-systems/maverick-wall:stable
```

Or with compose — copy [`docker-compose.yml`](docker-compose.yml) and
[`.env.example`](.env.example), then `docker compose up -d`. Every variable is
optional.

Images are built for **amd64 and arm64**, signed with cosign, and published
with a software bill of materials.

> **v0.1.0 is published, and the package is currently private.** Until it is
> made public in the repository's package settings, the commands above return
> `403 Forbidden` for everybody, including you. In the meantime:
> `docker build -t maverick-wall .`

```bash
cosign verify ghcr.io/ambient-home-systems/maverick-wall:stable \
  --certificate-identity-regexp 'https://github.com/ambient-home-systems/MaverickWall/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### Home Assistant add-on

Add this repository under **Settings → Add-ons → Add-on Store → ⋮ →
Repositories**, install **Maverick Wall**, start it, and open it from the
sidebar. Your Home Assistant calendars are available immediately — there is no
token to create.

Two ways in, and they are different: **the sidebar is the settings** (Home
Assistant does the authentication), and **the port is for the wall displays** (a
screen screwed to a wall has no Home Assistant session and connects directly).
Full detail in [the add-on docs](addon/maverick-wall/DOCS.md).

## Home Assistant: read-only, permanently

It reads. It cannot control anything.

A Home Assistant long-lived access token has full control of a home and cannot
be limited to reading, so the limit lives on this side instead:

- Nothing in this repository sends a write of any kind to Home Assistant. No
  service calls, no scenes, no switches.
- Your wall receives **resolved values** — "19.4 °C", "Open". Never the token,
  never an entity name, and never an endpoint it could ask its own questions
  through. There is a test asserting exactly that.
- The token is stored encrypted and never appears in a log, an error message,
  or the diagnostics export.

If a tablet in your hallway is ever compromised, the worst it can give away is
your indoor temperature.

## Weather alerts

Optional, United States only, from the National Weather Service. No account and
no API key.

> **Not a life-safety system.**
>
> Maverick Wall is not a life-safety system. Do not rely on it for emergency
> warnings. It is not a substitute for a NOAA Weather Radio, Wireless Emergency
> Alerts, or local warning sirens. Delivery depends on your internet connection,
> device, and power.

That is not boilerplate. A household internet connection, a tablet that may
have crashed hours ago, mains power, and a public API that degrades under load
during exactly the events that matter are all links in this chain, and a
weather radio depends on none of them.

## Honest limitations

- **Weather and alerts are United States only.** NWS is the only provider and a
  second one has not been built. Everything else works anywhere.
- **The wall needs a browser.** Any tablet, television or Pi that runs a
  reasonably modern one. There is no native app yet.
- **One household per container.** There is no multi-tenancy and there will not
  be. If you need a second wall, run a second container.
- **No push yet.** The display polls. A WebSocket channel is specified and not
  built, so an alert appears within a poll interval rather than instantly.
- **Alerts wake a screen only where the platform allows it.** A browser cannot
  turn a screen on; that needs the Android app, which does not exist yet.
- **Backups are yours.** There is an export on the System screen and the data
  is one directory, but nothing is uploaded anywhere, by design.
- **Nobody can reach your machine to fix it**, including us. That constraint
  shapes the whole thing: every failure is meant to degrade to a wall that
  still shows yesterday's calendar and says what went wrong.

## Running from a checkout

```bash
pnpm install
pnpm test

export DATA_DIR="$PWD/data"          # must be absolute
pnpm -r build
node apps/server/dist/main.js
```

The setup code is printed to the log on first start.

## Licence

**AGPL-3.0-or-later** for the application. **MIT** for `packages/calendar`, the
ICS parsing and recurrence engine, so anybody can use it for anything —
correct RFC 5545 handling is scarce enough that keeping it behind a copyleft
licence would help nobody.

See [NOTICE](NOTICE) for why it is split that way. Running this unmodified for
your own household carries no obligation at all.

---

`CLAUDE.md` is the operating document — the rules this is built to, and a list
of every real bug found so far and what found it. It is worth more than this
README if you intend to work on the code.
