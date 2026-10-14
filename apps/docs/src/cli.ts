import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, repositoryRoot } from './build.js';

/**
 * `pnpm --filter @maverick-wall/docs build`: the site into `apps/docs/dist/site`,
 * or nothing and a list of what is wrong. A site with a problem in it is never
 * written, so a deploy can only ever publish one that passed.
 */
const root = repositoryRoot(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(root, 'apps/docs/dist/site');
const site = buildSite(root);

if (site.problems.length > 0) {
  console.error(`The docs site was not built: ${site.problems.length} ${site.problems.length === 1 ? 'problem' : 'problems'}.\n`);
  for (const problem of site.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
for (const file of site.files) {
  const path = join(out, file.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file.content);
}
console.log(`Built ${site.files.filter((file) => file.path.endsWith('.html')).length} pages into ${out}.`);
