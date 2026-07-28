import { hostname } from 'node:os';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A file lock guarding schema migrations.
 *
 * One container is the deployment model, so contention is rare — but rare is not
 * never. `docker restart` can overlap the old and new process, a Home Assistant
 * add-on update does the same, and an impatient user hitting restart twice does
 * it deliberately. Two processes applying forward-only migrations to one SQLite
 * file concurrently is how a calendar gets corrupted.
 *
 * The harder problem is the opposite one: a lock left behind by a process killed
 * mid-migration. A lock that never expires turns a single crash into a
 * permanently dead wall display, and there is nobody on site to delete a file.
 * So locks record who holds them and are reclaimed when the holder is provably
 * gone.
 */

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export interface LockRecord {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: number;
  readonly purpose: string;
}

export interface AcquireOptions {
  /** Reclaim a lock older than this. Default five minutes. */
  readonly staleAfterMs?: number;
  /** Give up waiting for a live holder after this. Default thirty seconds. */
  readonly waitTimeoutMs?: number;
  /** Recorded in the lock file so a stuck lock names its owner. */
  readonly purpose?: string;
}

export type AcquireResult =
  | { readonly ok: true; readonly release: () => void; readonly reclaimed: boolean }
  | { readonly ok: false; readonly reason: 'held'; readonly holder: LockRecord | undefined };

function readRecord(path: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const record = parsed as Partial<LockRecord>;
    if (typeof record.pid !== 'number' || typeof record.host !== 'string') return undefined;
    return {
      pid: record.pid,
      host: record.host,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
      purpose: typeof record.purpose === 'string' ? record.purpose : 'unknown',
    };
  } catch {
    // Unreadable or truncated, meaning a crash mid-write. Treat as no valid
    // holder and let the age check decide whether to reclaim.
    return undefined;
  }
}

/**
 * Is this lock definitely abandoned?
 *
 * Two independent signals. A dead PID is conclusive, but only meaningful when
 * the record was written on this machine and in this PID namespace — which for
 * a single container it always is. Age is the fallback that works regardless.
 */
function isAbandoned(path: string, record: LockRecord | undefined, staleAfterMs: number): boolean {
  if (record && record.host === hostname()) {
    try {
      // Signal 0 tests for existence without delivering anything.
      process.kill(record.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      // EPERM means the process exists and belongs to another user.
    }
  }

  try {
    return Date.now() - statSync(path).mtimeMs > staleAfterMs;
  } catch {
    // Vanished between checks; someone released it.
    return true;
  }
}

function writeLock(path: string, purpose: string): LockRecord {
  const record: LockRecord = { pid: process.pid, host: hostname(), startedAt: Date.now(), purpose };
  mkdirSync(dirname(path), { recursive: true });
  // Exclusive create: if two processes race here, exactly one wins.
  writeFileSync(path, JSON.stringify(record), { flag: 'wx' });
  return record;
}

function ownsLock(path: string, record: LockRecord): boolean {
  const current = readRecord(path);
  return (
    current !== undefined &&
    current.pid === record.pid &&
    current.host === record.host &&
    current.startedAt === record.startedAt
  );
}

function releaseIfOwned(path: string, record: LockRecord): void {
  // Only remove a lock we still hold. Without this check, a process whose lock
  // was reclaimed as stale would delete the *new* holder's lock on its way out,
  // and two migrations would run after all.
  if (ownsLock(path, record)) rmSync(path, { force: true });
}

function sleep(ms: number): void {
  // Deliberately synchronous. This runs during boot, before the HTTP server
  // exists, and blocking is correct: nothing should proceed while another
  // process is migrating the schema underneath us.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the lock, waiting for a live holder and reclaiming a dead one.
 *
 * Never throws for contention. A caller that cannot get the lock gets a result
 * saying so, and who holds it, so boot can report something useful on screen
 * rather than exiting.
 */
export function acquireLock(path: string, options: AcquireOptions = {}): AcquireResult {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const purpose = options.purpose ?? 'migrate';
  const deadline = Date.now() + waitTimeoutMs;

  let reclaimed = false;

  for (;;) {
    try {
      const record = writeLock(path, purpose);
      return { ok: true, reclaimed, release: () => releaseIfOwned(path, record) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const holder = readRecord(path);

    if (isAbandoned(path, holder, staleAfterMs)) {
      rmSync(path, { force: true });
      reclaimed = true;
      // Loop rather than assume the next create succeeds: another process may
      // have reached the same conclusion a microsecond earlier.
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: 'held', holder };

    // Never sleep past the deadline. Polling on a fixed interval would honour
    // waitTimeoutMs only to 250ms granularity, so a caller asking to wait 100ms
    // would wait 250 and a caller asking for 30s could overshoot by a quarter
    // second on every boot.
    sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

export type WithLockResult<T> =
  | { readonly ok: true; readonly value: T; readonly reclaimed: boolean }
  | { readonly ok: false; readonly holder: LockRecord | undefined };

/**
 * Run `work` while holding the lock, releasing it whatever happens.
 *
 * Returns a failure when the lock could not be taken, leaving the caller to
 * decide. For migrations that decision is to start anyway in a degraded state
 * and say so on screen: a wall display that refuses to boot is worse than one
 * showing yesterday's calendar with a warning.
 */
export function withLock<T>(
  path: string,
  work: () => T,
  options: AcquireOptions = {},
): WithLockResult<T> {
  const lock = acquireLock(path, options);
  if (!lock.ok) return { ok: false, holder: lock.holder };

  try {
    return { ok: true, value: work(), reclaimed: lock.reclaimed };
  } finally {
    lock.release();
  }
}

/** Inspect the current holder, for diagnostics. */
export function inspectLock(path: string): LockRecord | undefined {
  return readRecord(path);
}
