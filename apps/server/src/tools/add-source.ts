import { openAndMigrate } from '../db/bootstrap.js';
import { addCalendarSource } from '../api/sources.js';
import { addCaldavCalendar, createCaldavAccount } from '../api/caldav-accounts.js';
import { testCaldavAccount } from '../api/test-feed.js';
import { createFetcher } from '../net/fetcher.js';
import { createKeyring, loadOrCreateMasterKey } from '../secrets/keyring.js';

/**
 * Add a calendar source from the command line.
 *
 * A stopgap until the admin UI exists, and a useful one to keep afterwards: it
 * is the only way to add a feed without a browser, which matters when someone
 * is debugging over SSH.
 *
 *   node dist/tools/add-source.js "Family" "https://…/basic.ics" [--user NAME]
 *     [--password-stdin] [--allow-lan]
 *
 * The URL is validated through the same guard the fetcher uses and stored
 * encrypted, so nothing here is a shortcut around the real path.
 *
 * **A password is read from stdin and never taken as an argument.** `argv` is
 * readable by anything else running on the same machine — `ps` on most
 * systems, `/proc/<pid>/cmdline` on Linux whatever `ps` is configured to hide
 * — and on an interactive shell it also lands in the history file. That is a
 * worse leak than any log line, and it is a leak the household cannot undo
 * once it has happened, which is why there is no `--password` flag to forget
 * not to use:
 *
 *   printf '%s' "$APP_PASSWORD" | node dist/tools/add-source.js \
 *     "Nextcloud" "https://…?export" --user jo --password-stdin
 */

function usage(): never {
  console.error(
    'usage: add-source <name> <ics-url> [--user NAME] [--password-stdin] ' +
      '[--allow-lan] [--allow-loopback] [--allow-http]',
  );
  console.error(
    '       add-source --caldav <server-url> --user NAME --password-stdin ' +
      '[--calendar NAME]... [--allow-lan] [--allow-loopback] [--allow-http]',
  );
  console.error('');
  console.error('  --caldav URL      a CalDAV server: discovers and lists its calendars');
  console.error('  --calendar NAME   add this discovered calendar; repeat for several.');
  console.error('                    With none, it lists what it found and adds nothing.');
  console.error('  --user NAME       the account this feed signs in as');
  console.error('  --password-stdin  read its password from standard input (one line)');
  console.error('  --allow-lan       permit a private-network address for this source only');
  console.error('  --allow-loopback  permit 127.0.0.1, for a service on this machine');
  console.error('  --allow-http  permit plain http for this source only');
  console.error('');
  console.error('There is deliberately no --password: a password given as an argument is');
  console.error('readable by anything else on this machine and lands in your shell history.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));

/**
 * `--user NAME`, taken as the argument after the flag and removed from the
 * positionals — so the name and the URL keep their places whether or not it is
 * given.
 */
function valueAfter(flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/**
 * Every `--flag VALUE`, for a flag that may be repeated.
 *
 * `--calendar` is the one that needs it: a household picks three of the four
 * calendars on an account, and a single-valued reader would silently keep the
 * last. Repetition rather than a comma-separated list, because a calendar is
 * named by its `displayname` and those contain commas.
 */
function valuesAfter(flag: string): string[] {
  const out: string[] = [];
  argv.forEach((arg, index) => {
    if (arg !== flag) return;
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith('--')) out.push(value);
  });
  return out;
}

const username = valueAfter('--user');
const caldavServer = valueAfter('--caldav');
const wantedCalendars = valuesAfter('--calendar');

/*
 * Every value consumed by a flag, so the positionals keep their places
 * whichever flags are given.
 */
const consumed = new Set<number>();
argv.forEach((arg, index) => {
  if (arg !== '--user' && arg !== '--caldav' && arg !== '--calendar') return;
  const value = argv[index + 1];
  if (value !== undefined && !value.startsWith('--')) consumed.add(index + 1);
});
const positional = argv.filter(
  (arg, index) => !arg.startsWith('--') && !consumed.has(index),
);

const caldavMode = flags.has('--caldav');
const name = positional[0];
const url = positional[1];
// In CalDAV mode the server is the flag's own value and there are no
// positionals at all: a name would be a name for *what*, when the whole point
// is that the names come back from the server.
if (!caldavMode && (!name || !url)) usage();
if (caldavMode && caldavServer === undefined) {
  console.error('--caldav needs a server address after it.');
  process.exit(1);
}
if (argv.includes('--user') && username === undefined) {
  console.error('--user needs a name after it.');
  process.exit(1);
}

const allowPrivateNetwork = flags.has('--allow-lan');
const allowLoopback = flags.has('--allow-loopback');
const allowHttp = flags.has('--allow-http');

/**
 * One line from standard input, with the trailing newline removed and nothing
 * else touched.
 *
 * `printf '%s' "$PW" |` sends no newline at all and `echo "$PW" |` sends one,
 * and both are things somebody will type — so exactly one trailing `\n` (and
 * the `\r` a Windows pipe puts in front of it) comes off, and every other
 * character is kept. Trimming more than that would silently accept a password
 * with a trailing space and store a different one.
 */
async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const password = flags.has('--password-stdin') ? await readPasswordFromStdin() : undefined;

if (username !== undefined && password === undefined) {
  // Half a credential composes no header, so storing one would be a row that
  // reads as configured and signs in as nobody.
  console.error('--user needs a password. Pipe one in with --password-stdin.');
  process.exit(1);
}
if (caldavMode && (username === undefined || password === undefined)) {
  // Unlike an ICS feed, where both are optional: there is nothing to discover
  // on a CalDAV server anonymously, so this is a refusal rather than a default.
  console.error('--caldav needs --user and --password-stdin: a CalDAV server has nothing to');
  console.error('offer without signing in.');
  process.exit(1);
}
if (password !== undefined && username === undefined) {
  console.error('--password-stdin needs --user beside it.');
  process.exit(1);
}

const dataDir = process.env['DATA_DIR'] ?? '/data';

// Migrate first. A tool that assumes the server has already created the schema
// breaks the moment someone adds a source before the first boot, which is the
// order the setup instructions actually suggest.
const { db, migration, dataDir: resolved } = openAndMigrate(dataDir);
if (migration.status === 'failed') {
  console.error('The database schema could not be prepared:');
  console.error(`  ${migration.error}`);
  process.exit(1);
}

// Stated up front. If this is not the database you expected, nothing below is
// going to behave the way you expect either.
console.log(`Using ${resolved}`);

const master = loadOrCreateMasterKey(dataDir);
if (master.unusableKeyWarning) {
  // A silent regeneration here is worse than the crash this used to be: the
  // operator would add a source under a brand-new key with no idea every
  // source already stored is now permanently undecryptable.
  console.error(`Warning: ${master.unusableKeyWarning}`);
}
const keyring = createKeyring(master.key);

/**
 * The CalDAV path: discover, list, and add the ones that were named.
 *
 * Two shapes in one command rather than a second tool, because from a
 * household's point of view this is the same act — "put this calendar on the
 * wall" — and the difference is which kind of address they have. The listing
 * step is what makes it usable from a shell at all: nobody can name a calendar
 * they have not been shown, so running it with no `--calendar` prints what is
 * there and writes nothing.
 */
if (caldavMode) {
  const result = await testCaldavAccount(
    {
      serverUrl: caldavServer as string,
      username: username as string,
      password: password as string,
      allowPrivateNetwork,
      allowLoopback,
      allowHttp,
      /*
       * **The host is confirmed by being named on the command line**, and that
       * is the honest reading of §6.3.1 here rather than a way around it.
       *
       * The policy asks a household to look at a host and agree to it. On a
       * screen that is a second submission; on a shell there is a person
       * watching this run, so the equivalent is to stop, print the host, and
       * make them run it again — which is what happens below. Passing the
       * typed host as already-confirmed would be the bypass.
       */
    },
    createFetcher(),
  );

  if (!result.ok && result.needsConfirmation !== undefined) {
    console.error(`That server sent us on to ${result.needsConfirmation.host}.`);
    console.error('Your password has NOT been sent there.');
    console.error('');
    console.error('Apple does this: you give caldav.icloud.com and the calendars are on a');
    console.error('numbered server. If you expected that, run this again with:');
    console.error('');
    console.error(`  --caldav https://${result.needsConfirmation.host}`);
    console.error('');
    console.error('If you did not, check the address you gave.');
    process.exit(1);
  }
  if (!result.ok) {
    console.error(`Refused: ${result.message}`);
    if (result.suggestion !== undefined) console.error(`  ${result.suggestion}`);
    process.exit(1);
  }

  console.log(`Signed in to ${result.host}. It has ${result.calendars.length} calendar` +
    `${result.calendars.length === 1 ? '' : 's'}:`);
  for (const calendar of result.calendars) console.log(`  ${calendar.displayName}`);

  if (wantedCalendars.length === 0) {
    console.log('');
    console.log('Nothing added. Name the ones you want with --calendar:');
    console.log(`  --calendar ${JSON.stringify(result.calendars[0]?.displayName ?? 'Home')}`);
    db.close();
    process.exit(0);
  }

  /*
   * Matched by name, case-insensitively, and **every name has to match
   * something** before anything is written.
   *
   * A typo that silently adds three of four calendars is the fault this
   * project keeps finding one layer up: it looks like it worked, and the
   * missing one surfaces weeks later as "one of my calendars is not on the
   * wall". So the check runs first and the writes run second.
   */
  const chosen: { url: string; displayName: string; ctag?: string }[] = [];
  const missing: string[] = [];
  for (const wanted of wantedCalendars) {
    const found = result.calendars.find(
      (calendar) => calendar.displayName.toLowerCase() === wanted.toLowerCase(),
    );
    if (found === undefined) missing.push(wanted);
    else chosen.push(found);
  }
  if (missing.length > 0) {
    console.error('');
    console.error(`No calendar on that account is called ${missing.map((m) => JSON.stringify(m)).join(', ')}.`);
    console.error('Nothing was added. The names above are what it answers to.');
    process.exit(1);
  }

  const at = Date.now();
  const accountId = createCaldavAccount(
    db,
    keyring,
    {
      serverUrl: caldavServer as string,
      username: username as string,
      password: password as string,
      principalUrl: result.principalUrl,
      homeSetUrl: result.homeSetUrl,
      // Stored only when discovery actually moved. `result.host` is the host
      // the calendars are on, which for a server that never moved is the one
      // that was typed — and recording that as a "confirmed" exception would be
      // a stored answer to a question nobody was asked.
      ...(result.host === new URL(caldavServer as string).hostname
        ? {}
        : { confirmedHost: result.host }),
      allowPrivateNetwork,
      allowLoopback,
      allowHttp,
    },
    at,
  );
  for (const calendar of chosen) {
    addCaldavCalendar(
      db,
      keyring,
      {
        accountId,
        name: calendar.displayName,
        url: calendar.url,
        ctag: calendar.ctag ?? null,
      },
      at,
    );
  }

  console.log('');
  console.log(`Added ${chosen.length} calendar${chosen.length === 1 ? '' : 's'} for ${username}.`);
  console.log('They will sync within a few seconds of the server starting.');
  console.log('');
  console.log('The password is stored encrypted, once, for all of them. The username is');
  console.log('stored in clear, as a name.');
  db.close();
  process.exit(0);
}

/*
 * Past the CalDAV branch, so this is the ICS one and both positionals are
 * there — `usage()` above refused otherwise. Stated for the compiler, which
 * cannot connect "we got here" to "`caldavMode` was false", and stated as a
 * refusal rather than a cast so a future edit that reorders these blocks fails
 * loudly instead of writing a row called `undefined`.
 */
if (name === undefined || url === undefined) usage();

const added = addCalendarSource(
  db,
  keyring,
  {
    name,
    url,
    allowPrivateNetwork,
    allowLoopback,
    allowHttp,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  },
  // A one-shot command with no server around it, so the wall clock *is* this
  // process's clock. Stated rather than defaulted, which is the whole point:
  // the next caller has to think about which clock it is handing over.
  Date.now(),
);
if (!added.ok) {
  // Rejected before anything is stored, and the message is the same one the
  // admin UI shows.
  console.error(`Refused: ${added.message}`);
  console.error(`  (${added.code})`);
  process.exit(1);
}

console.log(`Added "${name}" (${added.id}) at ${added.host}`);
if (username !== undefined) console.log(`It signs in as ${username}.`);
console.log('It will sync within a few seconds of the server starting.');
console.log('');
console.log('The URL is stored encrypted. Only the host is recorded in clear.');
if (username !== undefined) {
  // The username is in clear on purpose — it is a name, and the settings row
  // has to show which account a feed uses. The password is not.
  console.log('So is the password. The username is stored in clear, as a name.');
}

db.close();
