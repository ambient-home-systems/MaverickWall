import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `docker/prune-orphans.mjs`, against a real pnpm-shaped tree on disk.
 *
 * The script deletes directories out of the image, so its failure mode is
 * rule nine — a container that exits on its first import because something
 * the wall needed was swept. That is not a thing to check by reading, and it
 * is not a thing a mocked filesystem proves either: what makes the sweep
 * correct is that pnpm's symlinks *are* Node's resolution graph, so the test
 * builds the symlinks.
 *
 * The two traps are the ones a first version gets wrong. A package pnpm
 * *hoisted* into `.pnpm/node_modules` is reachable by anything in the tree
 * walking up, and nothing links to it directly — sweeping it is how a sloppy
 * `require` breaks in production and nowhere else. And a scoped package is a
 * real directory holding symlinks rather than a symlink, so reading it as one
 * loses every dependency underneath it.
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docker',
  'prune-orphans.mjs',
);

let root: string;

/** A `.pnpm/<key>/node_modules/<name>` package, as pnpm lays one out. */
function pkg(key: string, name: string): string {
  const dir = join(root, 'node_modules', '.pnpm', key, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(join(dir, 'index.js'), '');
  return dir;
}

/** A dependency link from one store key to another, spelled the way pnpm spells it. */
function dep(fromKey: string, toKey: string, name: string): void {
  const at = join(root, 'node_modules', '.pnpm', fromKey, 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  const target = join(root, 'node_modules', '.pnpm', toKey, 'node_modules', name);
  symlinkSync(relative(dirname(at), target), at);
}

/** A top-level entry, which in a deployed tree is exactly the prod dependency set. */
function top(key: string, name: string): void {
  const at = join(root, 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(relative(dirname(at), join(root, 'node_modules', '.pnpm', key, 'node_modules', name)), at);
}

/** A hoisted entry: reachable by walking up, linked to by nothing. */
function hoist(key: string, name: string): void {
  const at = join(root, 'node_modules', '.pnpm', 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(relative(dirname(at), join(root, 'node_modules', '.pnpm', key, 'node_modules', name)), at);
}

function stored(key: string): boolean {
  return existsSync(join(root, 'node_modules', '.pnpm', key));
}

function run(): string {
  return execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mw-prune-'));
  mkdirSync(join(root, 'node_modules', '.pnpm'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));

  // What the application actually depends on.
  pkg('keeper@1.0.0', 'keeper');
  top('keeper@1.0.0', 'keeper');

  // Its own dependency, one hop down.
  pkg('kept-dep@1.0.0', 'kept-dep');
  dep('keeper@1.0.0', 'kept-dep@1.0.0', 'kept-dep');

  // A scoped dependency of that one, two hops down.
  pkg('@scope+deep@1.0.0', '@scope/deep');
  dep('kept-dep@1.0.0', '@scope+deep@1.0.0', '@scope/deep');

  // Hoisted, and linked to by nothing.
  pkg('hoisted@1.0.0', 'hoisted');
  hoist('hoisted@1.0.0', 'hoisted');
  pkg('hoisted-dep@1.0.0', 'hoisted-dep');
  dep('hoisted@1.0.0', 'hoisted-dep@1.0.0', 'hoisted-dep');

  // The orphan the whole script exists for: a dev root's closure, left behind
  // by `deploy --prod` with nothing pointing at it.
  pkg('orphan@1.0.0', 'orphan');
  pkg('orphan-dep@1.0.0', 'orphan-dep');
  dep('orphan@1.0.0', 'orphan-dep@1.0.0', 'orphan-dep');
  pkg('@orphan+scoped@1.0.0', '@orphan/scoped');
  dep('orphan@1.0.0', '@orphan+scoped@1.0.0', '@orphan/scoped');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the deployed-tree orphan sweep', () => {
  it('keeps everything the application can import, however many hops away', () => {
    run();
    expect(stored('keeper@1.0.0')).toBe(true);
    expect(stored('kept-dep@1.0.0')).toBe(true);
    // Two hops down and behind a scope directory, which is the half a sweep
    // that reads `@scope` as a symlink silently loses.
    expect(stored('@scope+deep@1.0.0')).toBe(true);
  });

  it('keeps what pnpm hoisted, which nothing links to and anything can reach', () => {
    run();
    // Reachable only by walking up out of `.pnpm/<key>/node_modules`. A sweep
    // rooted on the top level alone deletes both of these and breaks nothing
    // until a package resolves one at runtime.
    expect(stored('hoisted@1.0.0')).toBe(true);
    expect(stored('hoisted-dep@1.0.0')).toBe(true);
  });

  it('removes an orphaned closure entire, not just its root', () => {
    run();
    expect(stored('orphan@1.0.0')).toBe(false);
    // The reason a name list is not enough: the advisory that survived the
    // obvious fix was on a package three hops below the name anybody would
    // have written down.
    expect(stored('orphan-dep@1.0.0')).toBe(false);
    expect(stored('@orphan+scoped@1.0.0')).toBe(false);
  });

  it('says what it removed, so a build log records it', () => {
    const out = run();
    expect(out).toMatch(/5 packages reachable, 3 orphaned and removed/);
    expect(out).toContain('orphan@1.0.0');
    expect(out).not.toContain('keeper@1.0.0');
  });

  it('keeps a package that is only reachable through an orphan’s sibling', () => {
    // A package the orphan depends on *and* the application depends on must
    // survive: reachability is a union, not a subtraction. Written because the
    // tempting implementation — remove the orphan's closure — gets this wrong.
    dep('keeper@1.0.0', 'orphan-dep@1.0.0', 'orphan-dep');
    run();
    expect(stored('orphan@1.0.0')).toBe(false);
    expect(stored('orphan-dep@1.0.0')).toBe(true);
  });

  it('clears the dangling links it leaves behind', () => {
    const bin = join(root, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(
      relative(bin, join(root, 'node_modules', '.pnpm', 'orphan@1.0.0', 'node_modules', 'orphan', 'index.js')),
      join(bin, 'orphan'),
    );
    symlinkSync(
      relative(bin, join(root, 'node_modules', '.pnpm', 'keeper@1.0.0', 'node_modules', 'keeper', 'index.js')),
      join(bin, 'keeper'),
    );
    run();
    expect(readdirSync(bin)).toEqual(['keeper']);
  });

  it('leaves a tree with no store alone rather than failing the build', () => {
    // Rule nine reaches the build too: if `pnpm deploy` ever stops producing
    // a `.pnpm` directory, the right answer is to do nothing, not to take the
    // image down with a stack trace.
    const empty = mkdtempSync(join(tmpdir(), 'mw-prune-empty-'));
    try {
      expect(() => execFileSync(process.execPath, [SCRIPT, empty], { encoding: 'utf8' })).not.toThrow();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
