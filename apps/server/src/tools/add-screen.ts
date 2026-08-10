import { randomBytes } from 'node:crypto';
import { openAndMigrate } from '../db/bootstrap.js';
import { formatShortCode, hashShortCode, issueDisplayToken, PAIRING_CODE_TTL_MS } from '../auth/tokens.js';
import { createScreen } from '../api/queries.js';

/**
 * Pair a screen from the command line.
 *
 * The admin UI will do this with a QR code, but this stays useful: it is the
 * only way to pair a display over SSH, and the only way to do it at all before
 * an account exists.
 *
 *   node dist/tools/add-screen.js "Kitchen"
 *   node dist/tools/add-screen.js --list
 *   node dist/tools/add-screen.js --revoke <id>
 *
 * The token is printed once and then only its hash is stored. There is no way
 * to recover it afterwards, which is the point — pair again to get a new one.
 */

const dataDir = process.env['DATA_DIR'] ?? '/data';

// See add-source: the schema is this tool's responsibility too, because it may
// well be the first thing anyone runs.
const { db, migration, dataDir: resolved } = openAndMigrate(dataDir);
if (migration.status === 'failed') {
  console.error('The database schema could not be prepared:');
  console.error(`  ${migration.error}`);
  process.exit(1);
}

// Stated up front. If this is not the database you expected, nothing below is
// going to behave the way you expect either.
console.log(`Using ${resolved}`);

const argv = process.argv.slice(2);

if (argv[0] === '--list') {
  const screens = db
    .prepare(
      `SELECT id, name, last_seen_at AS lastSeen, revoked_at AS revoked
         FROM screens ORDER BY created_at`,
    )
    .all() as { id: string; name: string; lastSeen: number | null; revoked: number | null }[];

  if (screens.length === 0) {
    console.log('No screens paired yet.');
  }
  for (const screen of screens) {
    const seen = screen.lastSeen === null ? 'never seen' : new Date(screen.lastSeen).toISOString();
    const state = screen.revoked === null ? '' : ' (revoked)';
    console.log(`${screen.id}  ${screen.name.padEnd(20)} ${seen}${state}`);
  }
  db.close();
  process.exit(0);
}

if (argv[0] === '--revoke') {
  const id = argv[1];
  if (!id) {
    console.error('usage: add-screen --revoke <id>');
    process.exit(1);
  }
  const changes = db
    .prepare('UPDATE screens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), id).changes;
  console.log(changes === 1 ? `Revoked ${id}.` : `No active screen with id ${id}.`);
  db.close();
  process.exit(0);
}

const name = argv[0];
if (!name) {
  console.error('usage: add-screen <name> | --list | --revoke <id>');
  process.exit(1);
}

const issued = issueDisplayToken();
const id = randomBytes(6).toString('hex');

// Through the same writer the admin uses, so a CLI-paired screen carries the
// same short code — the code entry on the display works whichever door made it.
createScreen(db, id, name, {
  tokenHash: issued.tokenHash,
  pairingCodeHash: hashShortCode(issued.shortCode),
  pairingCodeExpiresAt: Date.now() + PAIRING_CODE_TTL_MS,
});

const port = process.env['PORT'] ?? '8080';

console.log(`Paired "${name}" as ${id}.`);
console.log('');
console.log('  Point the display at:');
console.log(`    http://<this-host>:${port}/pair?token=${issued.token}`);
console.log('');
console.log(`  Or enter code:  ${formatShortCode(issued.shortCode)}`);
console.log('');
console.log('  For curl:');
console.log(`    curl -H "Authorization: Bearer ${issued.token}" \\`);
console.log(`      http://localhost:${port}/d/manifest`);
console.log('');
console.log('This token is shown once. Only its hash is stored.');

db.close();
