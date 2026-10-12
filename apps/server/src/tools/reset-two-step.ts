import { openAndMigrate } from '../db/bootstrap.js';
import { clearTwoFactor } from '../api/accounts.js';

/**
 * Turn off an account's two-step sign-in from the command line (plan item
 * M8.2).
 *
 * The way back in for the one case the admin cannot help with: the only admin
 * has lost both their phone and their recovery codes, so nobody can sign in to
 * turn it off for them. On the add-on there is no shell and no need — Home
 * Assistant's sidebar signs in without our password or code — so this is for
 * a plain `docker run`, where whoever can reach a shell already owns the box.
 * Their password still stands; they turn two-step sign-in on again with a new
 * phone.
 *
 *   node dist/tools/reset-two-step.js you@example.com
 *   node dist/tools/reset-two-step.js --list
 */

const dataDir = process.env['DATA_DIR'] ?? '/data';

const { db, migration, dataDir: resolved } = openAndMigrate(dataDir);
if (migration.status === 'failed') {
  console.error('The database schema could not be prepared:');
  console.error(`  ${migration.error}`);
  process.exit(1);
}
console.log(`Using ${resolved}`);

const argv = process.argv.slice(2);
const accounts = db
  .prepare('SELECT id, email, role, two_factor_enabled AS on_ FROM user ORDER BY created_at')
  .all() as { id: string; email: string; role: string; on_: number }[];

if (argv.length === 0 || argv[0] === '--list') {
  if (accounts.length === 0) console.log('No accounts yet.');
  for (const account of accounts) {
    console.log(`${account.email}  ${account.role}  two-step ${account.on_ === 1 ? 'on' : 'off'}`);
  }
  if (argv.length === 0) console.log('\nUsage: reset-two-step <email>');
  process.exit(0);
}

const email = (argv[0] ?? '').trim().toLowerCase();
const account = accounts.find((candidate) => candidate.email.toLowerCase() === email);
if (account === undefined) {
  console.error(`No account signs in as ${email}. These do:`);
  for (const candidate of accounts) console.error(`  ${candidate.email}`);
  process.exit(1);
}
const cleared = clearTwoFactor(db, account.id);
if (!cleared.ok) {
  console.error(cleared.message);
  process.exit(1);
}
console.log(`Two-step sign-in is off for ${account.email}. Their password alone signs them in.`);
