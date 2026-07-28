import { afterAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireLock, inspectLock, withLock } from '../src/db/lock.js';

// One scratch root for the whole file, removed afterwards. A suite that leaves
// directories in /tmp on every run is a suite people stop trusting.
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'mw-lock-'));
  roots.push(root);
  // A nested path on purpose: the lock must create its own parent directories,
  // because on first run /data exists but nothing inside it does.
  return join(root, 'nested', '.migrate.lock');
}

/**
 * Plant a lock file directly, as a crashed process would leave behind.
 *
 * Creates the parent first: only acquireLock does that itself, and these tests
 * are simulating a lock that already exists.
 */
function plant(path: string, record: object): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
  return path;
}

describe('acquire and release', () => {
  it('takes a free lock and records who holds it', () => {
    const path = lockPath();
    const lock = acquireLock(path);
    expect(lock.ok).toBe(true);
    expect(lock.ok && lock.reclaimed).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(inspectLock(path)?.pid).toBe(process.pid);
    expect(inspectLock(path)?.purpose).toBe('migrate');
    if (lock.ok) lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a second acquire while held, and names the holder', () => {
    const path = lockPath();
    const first = acquireLock(path);
    const second = acquireLock(path, { waitTimeoutMs: 100 });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.holder?.pid).toBe(process.pid);
    if (first.ok) first.release();
    expect(acquireLock(path).ok).toBe(true);
  });
});

describe('reclaiming abandoned locks', () => {
  // The failure that matters most: a process killed mid-migration leaves a lock
  // behind. If it never expires, one crash kills the wall display permanently
  // and there is nobody on site to delete a file.

  it('reclaims a lock whose process is gone', () => {
    const path = lockPath();
    plant(path, { pid: 999999, host: hostname(), startedAt: Date.now(), purpose: 'migrate' });
    const lock = acquireLock(path, { waitTimeoutMs: 100 });
    expect(lock.ok).toBe(true);
    expect(lock.ok && lock.reclaimed).toBe(true);
  });

  it('reclaims by age when the holder is on another host', () => {
    // A PID check is meaningless across hosts, so age is the fallback.
    const path = lockPath();
    plant(path, { pid: process.pid, host: 'elsewhere', startedAt: 0, purpose: 'migrate' });
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);
    const lock = acquireLock(path, { waitTimeoutMs: 100 });
    expect(lock.ok && lock.reclaimed).toBe(true);
  });

  it('does not reclaim a fresh lock from another host', () => {
    const path = lockPath();
    plant(path, {
      pid: process.pid,
      host: 'elsewhere',
      startedAt: Date.now(),
      purpose: 'migrate',
    });
    expect(acquireLock(path, { waitTimeoutMs: 100 }).ok).toBe(false);
  });

  it('reclaims an unparseable lock file', () => {
    // A crash between open and write leaves a truncated file.
    const path = lockPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json');
    expect(acquireLock(path, { waitTimeoutMs: 100, staleAfterMs: 0 }).ok).toBe(true);
  });
});

describe('release safety', () => {
  it('never deletes a lock it no longer owns', () => {
    // Without an ownership check, a process whose lock was reclaimed as stale
    // would delete the new holder's lock on its way out, and two migrations
    // would run concurrently after all.
    const path = lockPath();
    const mine = acquireLock(path);
    const theirs = JSON.stringify({
      pid: 424242,
      host: 'someone-else',
      startedAt: Date.now(),
      purpose: 'migrate',
    });
    writeFileSync(path, theirs);
    if (mine.ok) mine.release();
    expect(readFileSync(path, 'utf8')).toBe(theirs);
  });
});

describe('withLock', () => {
  it('runs the work while holding the lock and releases afterwards', () => {
    const path = lockPath();
    let held = false;
    const result = withLock(path, () => {
      held = existsSync(path);
      return 42;
    });
    expect(held).toBe(true);
    expect(result.ok && result.value).toBe(42);
    expect(existsSync(path)).toBe(false);
  });

  it('releases the lock even when the work throws', () => {
    // A migration that fails must not leave the lock behind, or the next boot
    // waits out the full stale timeout before it can even try.
    const path = lockPath();
    expect(() =>
      withLock(path, () => {
        throw new Error('migration blew up');
      }),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('reports contention rather than throwing', () => {
    const path = lockPath();
    const held = acquireLock(path);
    const denied = withLock(path, () => 'should not run', { waitTimeoutMs: 100 });
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.holder?.pid).toBe(process.pid);
    if (held.ok) held.release();
  });
});

describe('diagnostics', () => {
  it('reports no holder when the lock is free', () => {
    expect(inspectLock(lockPath())).toBeUndefined();
  });
});
