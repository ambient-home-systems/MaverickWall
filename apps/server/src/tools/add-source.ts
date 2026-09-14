import { openAndMigrate } from '../db/bootstrap.js';
import { addCalendarSource } from '../api/sources.js';
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
  console.error('');
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

const username = valueAfter('--user');
const consumed = new Set<number>();
{
  const at = argv.indexOf('--user');
  if (at >= 0 && username !== undefined) consumed.add(at + 1);
}
const positional = argv.filter(
  (arg, index) => !arg.startsWith('--') && !consumed.has(index),
);

const name = positional[0];
const url = positional[1];
if (!name || !url) usage();
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
