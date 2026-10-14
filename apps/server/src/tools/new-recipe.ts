import { resolve } from 'node:path';
import { scaffoldFixture } from '../modules/external/recipe-fixture.js';

/**
 * Start a recipe from a working one (plan item M7.10).
 *
 *   node dist/tools/new-recipe.js <directory>
 *
 * Writes a recipe that uses a setting, chooses and sorts rows and colours them,
 * with a sample answer and the result it builds, into a directory that is new
 * or empty. `test-recipe` passes on it as written, so the first change an
 * author makes is the first thing it reports.
 */

const dir = process.argv[2];
if (dir === undefined || dir.startsWith('--') || process.argv.length > 3) {
  console.error('Usage: new-recipe <directory>');
  process.exit(2);
}
const made = scaffoldFixture(resolve(dir), Date.now());
if (!made.ok) {
  console.error(made.error);
  process.exit(1);
}
console.log(`Wrote ${made.files.join(', ')} to ${dir}.`);
console.log(`Check it with: node dist/tools/test-recipe.js ${dir}`);
