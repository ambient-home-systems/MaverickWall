import { resolve } from 'node:path';
import { checkFixture, loadFixture, recordFixture } from '../modules/external/recipe-fixture.js';

/**
 * Run a recipe on answers it has already had, and say whether it still builds
 * what it built before (plan item M7.10).
 *
 *   node dist/tools/test-recipe.js <fixture directory>... [--update]
 *
 * Each directory is a fixture (`recipe-fixture.ts` says what goes in one). It
 * asks the network for nothing, so a recipe can be worked on against a feed's
 * real answer without the feed, and checked again after any change to either.
 * `--update` records what each recipe builds now as its expected.json.
 *
 * Exits 0 when every fixture passes (or was recorded), 1 when any does not,
 * and 2 when it was asked wrongly.
 */

const args = process.argv.slice(2);
const update = args.includes('--update');
const dirs = args.filter((arg) => arg !== '--update');
const unknown = dirs.find((arg) => arg.startsWith('--'));
if (dirs.length === 0 || unknown !== undefined) {
  if (unknown !== undefined) console.error(`There is no option ${unknown}.`);
  console.error('Usage: test-recipe <fixture directory>... [--update]');
  process.exit(2);
}

let failed = false;
for (const dir of dirs) {
  const loaded = loadFixture(resolve(dir), Date.now());
  if (!loaded.ok) {
    console.log(`ERROR  ${dir}`);
    console.log(`       ${loaded.error}`);
    failed = true;
    continue;
  }
  const check = checkFixture(loaded.fixture);
  if (update && check.built !== undefined && check.status !== 'pass') {
    recordFixture(loaded.fixture.dir, check.built);
    console.log(`SAVED  ${dir}`);
    console.log(JSON.stringify(check.built, null, 2).replace(/^/gm, '       '));
    continue;
  }
  const label = { pass: 'PASS ', fail: 'FAIL ', unrecorded: 'BUILT', error: 'ERROR' }[check.status];
  console.log(`${label}  ${dir}`);
  for (const line of check.lines) console.log(`       ${line}`);
  if (check.status === 'unrecorded' && check.built !== undefined) {
    console.log(JSON.stringify(check.built, null, 2).replace(/^/gm, '       '));
  }
  if (check.status === 'fail' || check.status === 'error') failed = true;
}
process.exit(failed ? 1 : 0);
