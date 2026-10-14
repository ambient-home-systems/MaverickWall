# Troubleshooting

## The container will not start

Almost always the volume, and almost always a mount it cannot write to. The
container starts as root, takes ownership of `/data` and then drops to an
unprivileged user, so a named volume or a folder you just made needs nothing.
What it cannot fix is a mount that is read-only (`:ro`) or one you forced a
`--user` onto, and it says which on the way out.

## "That pairing link is not valid"

Two installations. `DATA_DIR` must be absolute — a relative path resolves
against the working directory, so a tool run from one place and a server
started from another open different databases. Every entry point prints the
database it opened on start; if two disagree, that is why.

## Sign-in says "Missing or null Origin"

`BASE_URL` does not match the address you are typing. It defaults to
`localhost`, and nobody browses to localhost from the sofa. Set it to what the
browser actually uses.

## The wall says "Pair this wall"

The wall has no pairing: the cookie was cleared, the wall was revoked, or this
browser was never paired. Open the wall's page under **Walls** and pair it
again. A wall that was unpaired stays folded away at the foot of that list,
kept for the record; it cannot be paired again, so add it afresh from **Add a
wall**.

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

For the parser's own message rather than a summary, run
[`diagnose-source`](command-line.md#diagnose-source).

## Home Assistant readings are blank

On the add-on there is nothing to set: it reaches Home Assistant through the
supervisor. Otherwise, on **Home Assistant → Connection and token**:

- The address may end with `/api` or not — either is accepted, but a *wrong
  host* is not. Check it in a browser first.
- Names ending in `.local` are resolved by the device you are browsing from,
  not by this server. Use the IP address.
- Turn on **Allow a local network address** — requests to a private address
  are refused unless you say so.
- Long-lived tokens are revoked when deleted in Home Assistant, and on some
  upgrades. The screen says when the token was refused.

A reading only appears on a wall that has a Home Assistant widget showing it:
adding it under **Home Assistant → Readings** says whether any wall does.

## A doorbell or an alert takes half a minute to appear

The server keeps a connection open to Home Assistant so a ring reaches the
wall in about a second. When that connection cannot open, the wall still
hears everything, but only on the thirty-second read. Look in the log for a
line starting `[ha-live]`:

- `listening to N entities` means it is working.
- `not listening:` or `stopped listening:` gives the reason, and it tries
  again on its own, waiting up to a minute between tries.

A wall that is not on the push channel also waits for its own one-minute
poll. A wall opened in a current browser joins it by itself.

## A WebRTC camera looks like the ordinary live picture

A Camera widget set to *Live, WebRTC* falls back to *Live* when WebRTC cannot
work, so the picture keeps coming. Two things cause it. Home Assistant may not
offer WebRTC for that camera: open the camera in Home Assistant, and if its
own dashboard does not play it over WebRTC, neither can the wall. Or the wall
cannot reach Home Assistant's camera server (go2rtc) on your network: the wall
asks no outside server to help it connect, so it has to be on the same
network as Home Assistant, and a firewall must let it reach go2rtc's port
(8555 by default). A wall on a guest network or a VPN is the usual case.

## Weather or alerts are empty

A forecast needs a location: type a town or postcode on **Weather**, or use Home
Assistant's home location. The forecast comes from the provider chosen there —
the National Weather Service covers the United States only, and Open-Meteo,
which needs no key, covers everywhere.

Weather **alerts** come from the National Weather Service, so they exist in the
United States only, and only once a location has been set: the zones to watch
are worked out from it. The Weather screen lists them as soon as there are any.

## The wall is showing an old calendar

That is deliberate when the server is unreachable — it draws the last good copy
and says how old it is, rather than going blank. If the server *is* reachable,
check the **Calendars** screen for a failing feed.

## I forgot the account password

There is no reset link — the email address is only a name to sign in with,
and nothing is ever sent to it. Three ways forward:

**Ask another admin.** An admin can set a new password for any account under
**System → Accounts**.

**Restore a backup taken before the password was lost.** It restores the
accounts along with everything else — see [Backup and restore](backup.md).
There is no default credential to fall back to.

**Or, on a Docker or Compose install with shell access, create a new account
without losing the calendar.** The add-on has no shell, so this is Docker
only. With the container stopped:

```bash
sqlite3 /path/to/wall.db <<'SQL'
DELETE FROM user;
UPDATE household_settings SET setup_completed_at = NULL WHERE id = 'singleton';
SQL
```

Deleting from `user` deletes every account, with its sessions, its two-step
sign-in and its phone token. Calendars, walls, chores and every setting are
untouched. Start the container again: with no account, boot prints a
fresh setup code to the log exactly as it did on a brand-new install, and
`/setup` opens straight to creating one. This is a manual, unsupported
procedure — back the database up first — but it is the one way to recover the
household's data rather than starting over.

## Nothing here helped

**System → Diagnostics** produces an export that is safe to attach to an issue:
hostnames, counts, job state and a log tail, with no personal data in it.
