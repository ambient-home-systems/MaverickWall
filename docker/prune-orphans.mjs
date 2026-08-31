/**
 * Remove the packages in a `pnpm deploy` tree that nothing can import.
 *
 * `pnpm deploy --prod` drops the dev *roots* — vitest and drizzle-kit are not
 * in the output — but it leaves their whole dependency closures behind as
 * orphans: vite, four copies of esbuild, rollup, tsx, postcss, nanoid, chai,
 * every `@vitest/*` package. They arrive because better-auth declares vitest
 * and drizzle-kit as (optional) peers and pnpm resolves peers into the tree.
 *
 * Nothing links to them. That is not a claim about which package names look
 * like dev tooling — it is a fact about the graph, and this script computes it
 * rather than carrying a list somebody has to maintain. A name list would go
 * stale the first time a dependency changed, and its failure mode is deleting
 * something the wall needs, which is rule nine.
 *
 * Why it is worth doing at all, given none of it is reachable: a vulnerability
 * scanner does not do reachability. Trivy, Grype and docker scout walk the
 * filesystem for `package.json` files, so an unreachable copy of vitest is
 * reported exactly as loudly as a linked one — and this product's audience
 * scans what they self-host. A CRITICAL on the published image is an install
 * blocker whether or not a line of it ever executes.
 *
 * The graph pnpm builds is the graph Node resolves. In an isolated layout a
 * package can only reach what is linked beside it in its own
 * `.pnpm/<key>/node_modules/`, plus what is hoisted into
 * `.pnpm/node_modules/` — so walking those symlinks is the resolution
 * algorithm, not an approximation of it. Both are roots here; missing the
 * hoisted set would sweep packages a sloppy `require` can still find.
 */
import { readdirSync, lstatSync, readlinkSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: prune-orphans.mjs <deployed-tree>');
  process.exit(2);
}

const nm = join(root, 'node_modules');
const store = join(nm, '.pnpm');
if (!existsSync(store)) {
  console.error(`[prune] ${store} is not there; nothing to do`);
  process.exit(0);
}

/** Every `.pnpm/<key>` directory, which is the unit this removes. */
const keys = new Set(
  readdirSync(store, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => e.name),
);

/**
 * The `.pnpm` key a link points into, or null when it leaves the store.
 *
 * Every intra-store link has the shape `.../.pnpm/<key>/node_modules/<name>`,
 * so the key is the segment before the last `node_modules`. Reading it out of
 * the resolved path rather than out of the link text handles the two spellings
 * pnpm uses — `../../<key>/node_modules/<name>` between packages and
 * `.pnpm/<key>/node_modules/<name>` from the top level.
 */
function keyOf(linkPath) {
  let target;
  try {
    target = resolve(join(linkPath, '..'), readlinkSync(linkPath));
  } catch {
    return null;
  }
  const parts = target.split(sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 1) return null;
  const key = parts[at - 1];
  return keys.has(key) ? key : null;
}

/**
 * The links directly under a `node_modules` directory, one level down into a
 * `@scope` folder. A scope is a real directory holding symlinks, so it needs
 * descending into rather than reading as a link.
 */
function linksIn(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.bin' || e.name === '.pnpm' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.name.startsWith('@') && lstatSync(p).isDirectory()) {
      for (const inner of readdirSync(p)) out.push(join(p, inner));
    } else {
      out.push(p);
    }
  }
  return out;
}

// Roots: what the application itself depends on (the top level of the deployed
// node_modules is exactly the prod dependency set), plus everything pnpm
// hoisted, which any package in the tree can resolve by walking up.
const queue = [];
for (const link of [...linksIn(nm), ...linksIn(join(store, 'node_modules'))]) {
  const key = keyOf(link);
  if (key) queue.push(key);
}

const reachable = new Set();
while (queue.length > 0) {
  const key = queue.pop();
  if (reachable.has(key)) continue;
  reachable.add(key);
  for (const link of linksIn(join(store, key, 'node_modules'))) {
    const next = keyOf(link);
    if (next && !reachable.has(next)) queue.push(next);
  }
}

const orphans = [...keys].filter((k) => !reachable.has(k)).sort();

// Removing the store directory leaves any `.bin` shim pointing at it dangling.
// Nothing runs those in this image, but a dangling symlink is the sort of
// thing that reads as a broken install to whoever looks next.
function bytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          /* raced or unreadable; it is a size report, not a checksum */
        }
      }
    }
  };
  walk(dir);
  return total;
}

let freed = 0;
for (const key of orphans) {
  const dir = join(store, key);
  freed += bytes(dir);
  rmSync(dir, { recursive: true, force: true });
}

let dangling = 0;
for (const dir of [nm, join(store, 'node_modules'), join(nm, '.bin'), join(store, 'node_modules', '.bin')]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (!e.isSymbolicLink()) continue;
    if (!existsSync(p)) {
      rmSync(p, { force: true });
      dangling += 1;
    }
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
console.log(
  `[prune] ${reachable.size} packages reachable, ${orphans.length} orphaned and removed (${mb(freed)})` +
    (dangling > 0 ? `, ${dangling} dangling links cleared` : ''),
);
if (orphans.length > 0) console.log(`[prune] removed: ${orphans.join(' ')}`);
