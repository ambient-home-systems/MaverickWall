import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Rewrites `dist/sw.js`'s `SHELL` array from the compiled `import` graph.
 *
 * `sw.ts`'s own `SHELL` constant is a reasonable list for the source tree —
 * `test/sw-shell.test.ts` holds it to that — but this is the version that
 * actually ships: it walks the *compiled* graph starting at `dist/main.js`,
 * so a module `main.ts` no longer imports drops out and one it gained is
 * added, with nobody needing to touch this file or `sw.ts` by hand. The list
 * has drifted three times already without anybody noticing; the only way to
 * stop a fourth is to stop hand-maintaining it.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');

function importedNames(file) {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/from ['"]\.\/([\w-]+)\.js['"]/g)].map((m) => m[1]);
}

const visited = new Set();
function visit(name) {
  if (visited.has(name)) return;
  visited.add(name);
  for (const dep of importedNames(join(distDir, `${name}.js`))) visit(dep);
}
visit('main');

const modules = [...visited].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
const shell = ['/', '/assets/display.css', ...modules.map((name) => `/assets/${name}.js`)];

const swFile = join(distDir, 'sw.js');
const swSource = readFileSync(swFile, 'utf8');
const generated = `const SHELL = ${JSON.stringify(shell, null, 2)};`;
const updated = swSource.replace(/const SHELL = \[[\s\S]*?\];/, generated);
if (updated === swSource) {
  throw new Error('generate-shell: no `const SHELL = [...]` found in dist/sw.js to replace');
}
writeFileSync(swFile, updated);
