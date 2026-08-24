# Backup and restore

## What to keep

Everything is in the data directory. Two files matter:

- `wall.db` — the calendar, settings, people, shifts, screens.
- `.secret` — the encryption key.

**They are not interchangeable and you need both.** The database alone restores
everything except your calendar addresses: those are encrypted, and without the
key they cannot be read. You would be re-pasting every feed URL.

Copying the directory while the container is running is not safe — SQLite is in
WAL mode and you would get a torn copy. Either stop the container first, or use
the export below, which takes a consistent snapshot while everything is
running.

## The export

**System → Backup.** Two separate downloads, deliberately: the database and the
key. Keeping the credential visibly apart from the data is the point — you can
hand somebody the database for troubleshooting knowing it reveals no feed
addresses.

## Restore

**System → Restore**, upload the database and — if you have it — the key,
then restart.

The database is checked for the SQLite magic bytes and written aside as
`restore.db`; the key, if you upload one, is checked for length and written
aside as `restore.secret`. Both swaps happen at boot, before anything opens the
database, and whatever they replace is renamed rather than deleted. Swapping a
file under a running process, mid-sync, with WAL readers attached is how a
restore becomes a corruption.

Restoring the database without the key leaves your calendar addresses there
and unreadable — the wall will say so rather than failing quietly — so upload
both if you have both. On the Home Assistant add-on this is the only way to
restore the key at all: there is no shell and no way to place `.secret` in the
data directory by hand.

If you ever need to place the key file directly instead — copying the data
directory to a fresh machine, say — the download is named `maverick-wall.key`
and needs renaming to `.secret` once it is in the data directory. The keyring
only ever reads the file named `.secret`.

## Diagnostics

**System → Diagnostics** is the one that is safe to hand to somebody else.
Hostnames, counts, job state and a log tail — no email addresses, no event
titles, no feed names. There is a test that stuffs a database with all three
and asserts none of them appear; that test is the feature.

## Home Assistant add-on

The add-on's storage is included in a Home Assistant backup automatically. The
manual export is still there if you want a copy outside it.
