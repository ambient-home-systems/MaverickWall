import { validateOutboundUrl } from '@maverick-wall/core';
import { randomBytes } from 'node:crypto';
import { openAndMigrate } from '../db/bootstrap.js';
import { createKeyring, loadOrCreateMasterKey } from '../secrets/keyring.js';

/**
 * Add a calendar source from the command line.
 *
 * A stopgap until the admin UI exists, and a useful one to keep afterwards: it
 * is the only way to add a feed without a browser, which matters when someone
 * is debugging over SSH.
 *
 *   node dist/tools/add-source.js "Family" "https://…/basic.ics" [--allow-lan]
 *
 * The URL is validated through the same guard the fetcher uses and stored
 * encrypted, so nothing here is a shortcut around the real path.
 */

function usage(): never {
  console.error('usage: add-source <name> <ics-url> [--allow-lan] [--allow-http]');
  console.error('');
  console.error('  --allow-lan       permit a private-network address for this source only');
  console.error('  --allow-loopback  permit 127.0.0.1, for a service on this machine');
  console.error('  --allow-http  permit plain http for this source only');
  process.exit(1);
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const positional = argv.filter((arg) => !arg.startsWith('--'));

const name = positional[0];
const url = positional[1];
if (!name || !url) usage();

const allowPrivateNetwork = flags.has('--allow-lan');
const allowLoopback = flags.has('--allow-loopback');
const allowHttp = flags.has('--allow-http');

const validated = validateOutboundUrl(url, { allowPrivateNetwork, allowLoopback, allowHttp });
if (!validated.ok) {
  // Rejected before anything is stored, and the message is the same one the
  // admin UI will show.
  console.error(`Refused: ${validated.error.message}`);
  console.error(`  (${validated.error.code})`);
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

const keyring = createKeyring(loadOrCreateMasterKey(dataDir).key);

const id = randomBytes(8).toString('hex');
const now = Date.now();

db.prepare(
  `INSERT INTO calendar_sources
     (id, name, url_encrypted, url_host, allow_private_network, allow_loopback,
      allow_http, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  id,
  name,
  keyring.encrypt(url, 'calendar-source-url'),
  validated.value.hostname,
  allowPrivateNetwork ? 1 : 0,
  allowLoopback ? 1 : 0,
  allowHttp ? 1 : 0,
  now,
  now,
);

// Scheduled a few seconds out rather than immediately, so adding several in a
// row does not fire them all at once.
db.prepare(
  `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
   VALUES (?, 'ics-sync', ?, 0, ?, ?) ON CONFLICT(key) DO NOTHING`,
).run(`ics-sync:${id}`, now + 3_000, now, now);

console.log(`Added "${name}" (${id}) at ${validated.value.hostname}`);
console.log('It will sync within a few seconds of the server starting.');
console.log('');
console.log('The URL is stored encrypted. Only the host is recorded in clear.');

db.close();
