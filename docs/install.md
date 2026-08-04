# Install

## Docker

```bash
docker run -d \
  --name maverick-wall \
  --restart unless-stopped \
  -v maverick-wall:/data \
  -p 8080:8080 \
  ghcr.io/ambient-home-systems/maverick-wall:stable
```

That is the whole thing. There is no database to start, no configuration file
to write, and no account to create anywhere else.

`maverick-wall` there is a **named volume** — Docker creates it and owns it.
That is what lets this work with no setup at all, on Linux as well as on macOS.
It holds everything: the calendar, the settings, and the key that decrypts your
feed addresses.

```bash
docker volume inspect maverick-wall     # where it actually is on disk
```

## A folder instead of a volume

If you would rather keep the data somewhere you can see:

```bash
mkdir -p ./data
sudo chown -R 1000:1000 ./data
docker run -d -v ./data:/data -p 8080:8080 ghcr.io/ambient-home-systems/maverick-wall:stable
```

The `chown` is not optional on Linux. The container runs as uid 1000 rather
than root, and a folder you just created belongs to you — so the container
cannot write its own database in it. macOS hides this because Docker Desktop
maps ownership across its file sharing layer; a Raspberry Pi, a Synology and a
NAS do not, and those are most of the machines this runs on.

If you skip it, the container says so on the way out and tells you this exact
command. It does not fail with a stack trace.

### Tags

- `:stable` — the latest release. What you want.
- `:latest` — the same, unless a pre-release is newer.
- `:1.2.3`, `:1.2` — pinned.

### If the container exits immediately

It is almost always a bind mount that the container cannot write. See above —
it says so on the way out, with the command to fix it.

## Compose

Copy [`docker-compose.yml`](../docker-compose.yml) and
[`.env.example`](../.env.example) into a directory, then:

```bash
cp .env.example .env      # optional; every variable is optional
docker compose up -d
```

There is no database service in that file and there will not be one. SQLite
lives in the volume; adding Postgres would be a second thing to back up, a
second thing to upgrade, and a second thing to be down.

## Home Assistant add-on

[![Add repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fambient-home-systems%2FMaverickWall)

The button opens your own Home Assistant with the repository pre-filled; you
confirm, then install **Maverick Wall**, start it, and open it from the
sidebar.

It works by handing the URL to [My Home Assistant](https://my.home-assistant.io),
which is a redirector — it knows nothing about your instance and nothing is
sent anywhere. If you would rather not use it, or the button does nothing
because My Home Assistant has not been set up on your instance:

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add `https://github.com/ambient-home-systems/MaverickWall`
3. Install **Maverick Wall**, then **Start**
4. Open it from the sidebar

Your Home Assistant calendars are available immediately. The add-on reaches
Home Assistant through the supervisor, so there is no token to create.

**Two ways in, and they are not interchangeable.** The sidebar is the settings,
and Home Assistant authenticates you. The wall displays connect to the add-on's
port instead — a screen screwed to a wall has no Home Assistant session and
cannot get one.

## Verifying the image

Every release is signed. There is no way to patch a household remotely, so
being able to check that the image you pulled is the one this repository built
matters more here than it does for software somebody can push a fix to.

```bash
cosign verify ghcr.io/ambient-home-systems/maverick-wall:stable \
  --certificate-identity-regexp 'https://github.com/ambient-home-systems/MaverickWall/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A software bill of materials is published with each release.
