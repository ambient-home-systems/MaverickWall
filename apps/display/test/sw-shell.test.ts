import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The offline shell must list every module the page actually loads.
 *
 * `sw.ts` caches a hand-written `SHELL` array so a reload works with the
 * server dead. The array is not what the browser loads, though — the browser
 * follows `main.js`'s own `import` graph, module by module, and any file in
 * that graph the array omits is simply absent on the reload it exists for.
 * That list has drifted three times already with nobody noticing, so this
 * derives the real graph from source and compares it against the array in
 * both directions — the same shape as `migration-upgrade.test.ts` comparing a
 * migrations directory against its journal.
 */

const SRC = dirname(fileURLToPath(import.meta.url)) + '/../src';
const SW_SOURCE = readFileSync(join(SRC, 'sw.ts'), 'utf8');

/** Every local module `main.ts` reaches, transitively, by its own name. */
function reachableFromMain(): Set<string> {
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const source = readFileSync(join(SRC, `${name}.ts`), 'utf8');
    for (const match of source.matchAll(/from '\.\/([\w-]+)\.js'/g)) {
      visit(match[1] as string);
    }
  };
  visit('main');
  return visited;
}

/** The `SHELL` array, as the compiled `.js` module names it lists. */
function shelledModules(): Set<string> {
  const match = /const SHELL = \[([\s\S]*?)\];/.exec(SW_SOURCE);
  if (match?.[1] === undefined) throw new Error('no SHELL array in sw.ts');
  const names = new Set<string>();
  for (const entry of match[1].matchAll(/'\/assets\/([\w-]+)\.js'/g)) {
    names.add(entry[1] as string);
  }
  return names;
}

describe('the offline shell', () => {
  it('reads sw.ts, so a rename fails loudly rather than comparing two empty lists', () => {
    expect(SW_SOURCE).toContain('const SHELL');
  });

  it('lists every module main.js actually imports, transitively', () => {
    // A module reachable from main.ts and missing from SHELL is exactly the
    // 1.1 bug: a wall reloaded before its first controlled online reload
    // draws nothing, because the browser cannot fetch that file from a dead
    // server and the worker never cached it either.
    const reachable = reachableFromMain();
    const shelled = shelledModules();
    const missing = [...reachable].filter((name) => !shelled.has(name));
    expect(missing).toEqual([]);
  });

  it('lists no module main.js does not reach', () => {
    // The other direction: an entry nothing imports any more is dead weight
    // that looks like coverage it is not providing.
    const reachable = reachableFromMain();
    const shelled = shelledModules();
    const stale = [...shelled].filter((name) => !reachable.has(name));
    expect(stale).toEqual([]);
  });
});
