# Troubleshooting

## The container will not start

Almost always the volume. It runs as uid 1000 rather than root, and says so on
the way out with the command to fix it:

```bash
sudo chown -R 1000:1000 ./data
```

Or let Docker own it: `-v maverick-wall:/data`.

## "That pairing link is not valid"

Two installations. `DATA_DIR` must be absolute — a relative path resolves
against the working directory, so a tool run from one place and a server
started from another open different databases. Every entry point prints the
database it opened on start; if two disagree, that is why.

## Sign-in says "Missing or null Origin"

`BASE_URL` does not match the address you are typing. It defaults to
`localhost`, and nobody browses to localhost from the sofa. Set it to what the
browser actually uses.

## The wall says "This screen is not paired"

The token was revoked, or the cookie was cleared. Open the pairing link again
from **Screens**.

## The wall shows "the bundle is missing"

The display assets were not found. The log says which directory it looked in;
set `DISPLAY_DIR` to where `index.html` and `assets/` actually are. This should
never happen with the published image.

## A calendar stopped updating

**Calendars** shows the last error against the feed. The commonest causes:

- The address was rotated. Google invalidates the secret iCal address if you
  ever click "reset".
- A backup was restored without `.secret`, so the address cannot be decrypted.
  The wall says exactly that.
- The feed is behind something that needs a login. It has to be a link that
  works in a private browser window.

Use **Diagnose** on the calendar for the parser's own message rather than a
summary.

## Home Assistant readings are blank

- The address must include neither `/api` nor a trailing slash — either is
  accepted, but a *wrong host* is not. Check it in a browser first.
- Names ending in `.local` are resolved by the device you are browsing from,
  not by this server. Use the IP address.
- Tick "Home Assistant is on my local network" — outbound requests to private
  addresses are refused by default.
- Long-lived tokens are revoked when deleted in Home Assistant, and on some
  upgrades. The screen says when the token was refused.

## Weather or alerts are empty

The National Weather Service covers the United States only. Anywhere else,
there is no provider yet and the settings page says so.

## The wall is showing an old calendar

That is deliberate when the server is unreachable — it draws the last good copy
and says how old it is, rather than going blank. If the server *is* reachable,
check the **Calendars** screen for a failing feed.

## Nothing here helped

**System → Diagnostics** produces an export that is safe to attach to an issue:
hostnames, counts, job state and a log tail, with no personal data in it.
