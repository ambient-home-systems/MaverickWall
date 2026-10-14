# Command-line tools

Almost everything is done from the settings in a browser. These are for the
few things that are not: finding out why a feed or a module is failing,
setting things up without a browser, writing a recipe, and getting back in
when two-step sign-in has locked the only admin out.

Every one prints the database it opened before it does anything. If two of
them disagree, `DATA_DIR` is pointing somewhere different for each, which is
the usual reason for "that pairing link is not valid".

## Running one

**In Docker**, inside the running container, as the user the server runs as
(so anything a tool writes is still the server's to read):

```bash
docker exec -it -u node maverick-wall node dist/tools/diagnose-source.js
```

**From a checkout**, after `pnpm --filter @maverick-wall/server build`, with
`DATA_DIR` set to an absolute path:

```bash
export DATA_DIR="$PWD/data"
node apps/server/dist/tools/diagnose-source.js
```

**On the Home Assistant add-on** there is no shell. Nothing here is needed
there: every one of these jobs has a screen, and the sidebar signs you in
without a password or a code.

## `diagnose-source`

```bash
node dist/tools/diagnose-source.js [source-id]
```

Why a calendar is failing, with the parser's own message: what came back,
from which host, and which line it could not read. With no id it reads every
calendar in turn. It prints hosts only — never an address, which
for a calendar is the password in effect, and never a stored password.

## `diagnose-module`

```bash
node dist/tools/diagnose-module.js [module-id]
```

Why a module draws what it draws, or nothing. It reads the module now, the way
the scheduled read does, and says which request answered, which did not, and
where the panel it built was refused. It names hosts only, and it writes
nothing back, so the module's card still says what the last scheduled read
found. See [Building a module](building-a-module.md#trying-a-recipe-before-it-is-on-a-wall).

## `test-recipe`

```bash
node dist/tools/test-recipe.js <directory>... [--update]
```

Checks a recipe against answers saved beside it, and lists what moved. It exits
0 when every directory passes, 1 when one does not, and 2 when one cannot be
read, so it can run in CI. `--update` records what the recipe builds now as the
expected result.

## `new-recipe`

```bash
node dist/tools/new-recipe.js <directory>
```

Writes a working recipe and its saved answers into an empty directory, as a
place to start. It passes `test-recipe` as written, and refuses a directory
with anything in it.

## `add-source`

```bash
node dist/tools/add-source.js "Family" "<ics-url>" [--user NAME] [--password-stdin] [--allow-lan] [--allow-loopback] [--allow-http]
node dist/tools/add-source.js --caldav <server-url> --user NAME --password-stdin [--calendar NAME]...
```

Adds a calendar without a browser, with the same checks the Calendars screen
makes. The password is read from standard input so it never appears in your
shell history. With `--caldav` and no `--calendar`, it lists the calendars it
found and adds nothing. The three `--allow` switches are the screen's
**Allow a local network address**, **Allow this machine itself** and
**Allow plain http**, and each is off unless named.

## `add-screen`

```bash
node dist/tools/add-screen.js "Kitchen" --theme panels
node dist/tools/add-screen.js --list
node dist/tools/add-screen.js --revoke <id>
```

Adds a browser wall and prints its pairing link, lists the walls, or revokes
one. A wall needs a theme; run it without `--theme` to see the choices. The
wall starts on the Classic layout, as one added from **Walls** does.

## `analyse-titles`

```bash
node dist/tools/analyse-titles.js [source-id]
```

Lists the event titles in a calendar that look like shifts — the same titles,
the same times, again and again — so you can see what a work rota looks like
before turning one on.

## `enable-shift`

```bash
node dist/tools/enable-shift.js --from-calendar <source-id> [--person Name]
node dist/tools/enable-shift.js --pattern <YYYY-MM-DD> [--person Name]
node dist/tools/enable-shift.js --off
```

Turns on a work rota for one person: read from a calendar their employer
publishes, or as a repeating pattern starting on the given date. A calendar
beats the pattern, so a published swap wins on its own. `--person` defaults to
"Me"; run it once for each person. **Work Schedule** does the same on screen.

## `reset-two-step`

```bash
node dist/tools/reset-two-step.js you@example.com
node dist/tools/reset-two-step.js --list
```

Turns off two-step sign-in for one account: the way back in when the only
admin has lost both their phone and their recovery codes. Their password still
stands, and they can turn two-step sign-in on again with a new phone. If
another admin can sign in, they can do this from **System → Accounts** instead.
