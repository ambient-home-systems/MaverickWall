# Install

## Docker

```bash
docker run -d \
  --name maverick-wall \
  --restart unless-stopped \
  -v ./data:/data \
  -p 8080:8080 \
  ghcr.io/ambient-home-systems/maverick-wall:stable
```

That is the whole thing. There is no database to start, no configuration file
to write, and no account to create anywhere else.

`./data` is everything: the calendar, the settings, and the key that decrypts
your feed addresses. Back up that directory and you have backed up your
installation.

### Tags

- `:stable` — the latest release. What you want.
- `:latest` — the same, unless a pre-release is newer.
- `:1.2.3`, `:1.2` — pinned.

### If the container exits immediately

It is almost always the volume. The container runs as uid 1000 rather than
root, so a directory owned by somebody else is not writable by it — and it
says so on the way out, with the command to fix it. Or use a named volume and
let Docker deal with ownership:

```bash
docker run -d -v maverick-wall:/data -p 8080:8080 ghcr.io/ambient-home-systems/maverick-wall:stable
```

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
