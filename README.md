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
## THIS IS UNDER ACTIVE DEVELOPMENT

<!--
  The mark, not the lockup: the wordmark would only repeat the heading under
  it. This is the add-on's own icon rather than a copy of it, because a second
  file that has to be kept in step is how this repository ended up with two
  identical licence files nobody could tell apart.

  It reads on both of GitHub's themes because the tile carries its own ground.
  A bare SVG would not: docs/brand's sources take their colours from CSS
  variables, and the fallback ink is near-white — invisible on the light theme.
-->
<img src="addon/maverick-wall/icon.png" alt="" width="84">

# Maverick Wall

A family calendar for a wall display. One container, one volume, no
subscription, no cloud.

Runs on your own hardware — a NAS, a Pi, a mini PC, or as a Home Assistant
add-on. Wall-mounted tablets and televisions point at it and run unattended for
months.

```bash
docker run -d -v maverick-wall:/data -p 8080:8080 ghcr.io/ambient-home-systems/maverick-wall
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
- **Arrange the wall yourself.** Drag the calendar, a clock, the forecast, a
  shift badge, Home Assistant readings, notes, a to-do list, a countdown or a
  photograph anywhere on the canvas — or start from a template and move things
  around. Portrait and landscape are arranged separately, and a screen either
  follows the household's arrangement or keeps its own.
- **eInk panels.** A wifi or battery e-paper panel can show the same wall in
  black and white. The server draws the frame, so the device only has to
  receive a picture — an ESPHome panel fetches it, a Home Assistant tag is sent
  it. A panel draws its own arrangement or **follows one of your walls**, in
  which case moving a box on the wall moves it on the panel; each widget can
  then say *less* on ink — three days of forecast instead of seven, a name and
  a time instead of a whole card — without changing the wall it follows. Built
  and not yet proven on real hardware; see limitations.
- **A small store of extras**, built into the image rather than fetched from
  anywhere, so it works on a wall with no internet. A module contributes a
  panel of readings and never code the wall runs; adding one to the store is
  [a pull request](docs/adding-to-the-store.md) against this repository.
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
  -v maverick-wall:/data \
  -p 8080:8080 \
  ghcr.io/ambient-home-systems/maverick-wall:stable
```

> **`maverick-wall` is a named volume, not a folder**, and it is what the
> wizard, the docs and the Home Assistant add-on all assume. A plain folder
> works too — see [bind mounts](docs/install.md#a-folder-instead-of-a-volume) —
> and needs no `chown`: the container takes ownership of its data directory at
> startup, then drops to an unprivileged user before it serves anything.

Or with compose — copy [`docker-compose.yml`](docker-compose.yml) and
[`.env.example`](.env.example), then `docker compose up -d`. Every variable is
optional.

Images are built for **amd64 and arm64**, signed with cosign, and published
with a software bill of materials.

```bash
cosign verify ghcr.io/ambient-home-systems/maverick-wall:stable \
  --certificate-identity-regexp 'https://github.com/ambient-home-systems/MaverickWall/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### Home Assistant add-on

[![Add repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fambient-home-systems%2FMaverickWall)

That button opens your own Home Assistant with this repository already filled
in — you just confirm. Then install **Maverick Wall**, start it, and open it
from the sidebar.

Or add it by hand: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**,
and paste `https://github.com/ambient-home-systems/MaverickWall`.

Your Home Assistant calendars are available immediately — there is no token to
create.

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
- **eInk panels are unproven on hardware.** The whole path is built and tested
  — the frame, the ESPHome and Home Assistant recipes, the editor — but no
  frame has been photographed on a real panel yet. Treat it as a glance
  display and not an alert one: a sleeping battery panel cannot show you a
  tornado warning.
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
