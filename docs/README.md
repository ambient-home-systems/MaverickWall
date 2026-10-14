# Maverick Wall

A family calendar for a wall. One household runs it on their own hardware — a
Docker container, or a Home Assistant add-on — and tablets, televisions and
e-paper panels point at it and run unattended for months. There is no cloud
version and no account anywhere else.

These pages are written for somebody who has just found it and wants a
calendar on a wall by the end of the afternoon.

## Start here

1. [Install](install.md) — one `docker run`, Docker Compose, or the Home
   Assistant add-on.
2. [First run](first-run.md) — the setup code, the wizard, adding your
   calendars and pairing your first wall.
3. [Walls and designs](walls.md) — layouts, backgrounds, themes, timed
   layouts and e-paper panels.
4. [Kiosk devices](kiosk.md) — keeping a Fire tablet, a Google TV or a
   Raspberry Pi on the wall.

Running it as a Home Assistant add-on? [The add-on](../addon/maverick-wall/DOCS.md)
covers the sidebar, the port the walls use, and exactly what it may and may not
do in your house.

## Keeping it running

- [Exposing it safely](exposing-safely.md) — read this before you port-forward
  anything.
- [Backup and restore](backup.md) — what to keep, and why the key is a
  separate download.
- [Environment variables](environment.md) and
  [command-line tools](command-line.md).
- [Troubleshooting](troubleshooting.md) — what a message means and what to do
  about it.
- [Release notes](../addon/maverick-wall/CHANGELOG.md) — what changed, release
  by release.

## Adding your own panels

A module puts a panel on the wall — bins, buses, tides, anything with a feed —
and it is data, never code. Most need no server at all: a recipe says where to
fetch and what to draw.

- [Building a module](building-a-module.md) — recipes, service modules, the
  panel shapes, and the tools to test one.
- [Adding to the Store](adding-to-the-store.md) — sharing one with every
  household, by pull request.
- [`examples/example-module`](../examples/example-module) — a complete,
  runnable service module.

## About these pages

They are the Markdown in [the repository](../docs), published, and checked
against the code on every change: a page that names an environment variable
the server does not read, a command-line tool that does not exist, a screen
the admin no longer has, or a link that goes nowhere stops the site from
building. The prose itself cannot be checked that way, so if a page says one
thing and the wall does another, the wall is right — please
[open an issue](https://github.com/ambient-home-systems/MaverickWall/issues).

The design reasoning behind each feature lives in the RFCs in the repository,
for anybody who wants the why.
