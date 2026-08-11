# Documentation

Written for somebody who has just found this and wants a calendar on a wall by
the end of the afternoon.

- [Install](install.md) — Docker, compose, and the Home Assistant add-on
- [First run](first-run.md) — the wizard, and pairing your first screen
- [Kiosk devices](kiosk.md) — Google TV, Fire tablet, Raspberry Pi
- [Exposing this safely](exposing-safely.md) — read before you port-forward
- [Backup and restore](backup.md)
- [Environment variables](environment.md)
- [Troubleshooting](troubleshooting.md)

The [add-on documentation](../addon/maverick-wall/DOCS.md) covers the Home
Assistant path in more detail.

**Building an add-on module.** A module is a small HTTP service that puts an
extra panel on the wall — data, never code.

- [Building a module](building-a-module.md) — the contract and the panel shapes
- [`examples/example-module`](../examples/example-module) — a complete, runnable one
- [RFC 001](rfc-001-module-framework.md) — the design and its trade-offs

> **A note on the docs site.** These are plain Markdown in the repository. A
> published site (Cloudflare Pages) is not set up — that is a deployment with
> its own domain and build, and shipping a half-configured one would be worse
> than a directory that renders perfectly well on GitHub.
