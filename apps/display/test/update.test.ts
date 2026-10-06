import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHELL_CACHE_PREFIX,
  UPDATE_RELOAD_GAP_MS,
  UPDATE_STAGGER_MS,
  pageVersion,
  reloadAllowed,
  reloadFresh,
  staggerMs,
  updateDue,
} from '../src/update.js';

/**
 * A wall reloading itself after the server is updated (plan item M1.5): when,
 * how often, and that the reload reaches past the service worker's copy.
 */

const NOW = Date.UTC(2026, 9, 6, 9, 0, 0);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pageVersion', () => {
  it('reads the release the server stamped into this page, and nothing when it did not', () => {
    const doc = (content: string | null) => ({
      querySelector: (selector: string) =>
        selector === 'meta[name="mw-version"]' && content !== null ? { getAttribute: () => content } : null,
    });
    expect(pageVersion(doc('0.80.0'))).toBe('0.80.0');
    expect(pageVersion(doc(''))).toBeUndefined();
    expect(pageVersion(doc(null))).toBeUndefined();
  });
});

describe('updateDue', () => {
  it('is due only when both releases are known and differ', () => {
    expect(updateDue('0.80.0', '0.81.0')).toBe(true);
    expect(updateDue('0.80.0', '0.80.0')).toBe(false);
    // A page from before the stamp, or a server from before the header: nothing to compare.
    expect(updateDue(undefined, '0.81.0')).toBe(false);
    expect(updateDue('0.80.0', undefined)).toBe(false);
  });
});

describe('reloadAllowed', () => {
  it('allows one reload in ten minutes, and trusts no memory from the future', () => {
    expect(reloadAllowed(undefined, NOW)).toBe(true);
    expect(reloadAllowed(NOW - UPDATE_RELOAD_GAP_MS + 1, NOW)).toBe(false);
    expect(reloadAllowed(NOW - UPDATE_RELOAD_GAP_MS, NOW)).toBe(true);
    // A device clock put back after the last reload must not hold the wall for ever.
    expect(reloadAllowed(NOW + 60_000, NOW)).toBe(true);
    expect(reloadAllowed(Number.NaN, NOW)).toBe(true);
  });
});

describe('staggerMs', () => {
  it('waits somewhere in the first half-minute', () => {
    expect(staggerMs(() => 0)).toBe(0);
    expect(staggerMs(() => 0.5)).toBe(UPDATE_STAGGER_MS / 2);
    expect(staggerMs(() => 0.999999)).toBeLessThan(UPDATE_STAGGER_MS);
  });
});

describe('reloadFresh', () => {
  it('names the service worker’s own cache, which lives in another file', () => {
    // Two files that cannot import each other: if the worker's cache is renamed
    // and this is not, the reload would empty nothing and bring back old code.
    const worker = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sw.ts'), 'utf8');
    const name = /const CACHE = '([^']+)';/.exec(worker)?.[1];
    expect(name).toBeDefined();
    expect(name!.startsWith(SHELL_CACHE_PREFIX)).toBe(true);
  });

  it('empties the shell caches, and only those, before it reloads', async () => {
    const deleted: string[] = [];
    const order: string[] = [];
    vi.stubGlobal('caches', {
      keys: async () => [`${SHELL_CACHE_PREFIX}-v1`, 'someone-else'],
      delete: async (name: string) => {
        deleted.push(name);
        order.push('delete');
        return true;
      },
    });
    await reloadFresh({ reload: () => order.push('reload') });
    expect(deleted).toEqual([`${SHELL_CACHE_PREFIX}-v1`]);
    expect(order).toEqual(['delete', 'reload']);
  });

  it('still reloads where there are no caches, or they will not open', async () => {
    let reloads = 0;
    await reloadFresh({ reload: () => (reloads += 1) });
    vi.stubGlobal('caches', {
      keys: async () => {
        throw new Error('blocked');
      },
    });
    await reloadFresh({ reload: () => (reloads += 1) });
    expect(reloads).toBe(2);
  });
});
