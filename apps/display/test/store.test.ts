import { describe, expect, it } from 'vitest';
import { createManifestStore } from '../src/store.js';
import type { Manifest } from '../src/manifest.js';

/**
 * The offline store.
 *
 * Rule nine says a wall never shows a blank rectangle, so the interesting
 * cases here are all the ones where storage does not work: a kiosk in private
 * mode, storage disabled by policy, a database that will not open. Every one
 * of them has to degrade to "no memory between reloads" rather than to a
 * broken display.
 */

const MANIFEST = {
  manifestVersion: 1,
  appVersion: '0.1.0-test',
  generatedAt: 1_700_000_000_000,
  timezone: 'Europe/London',
  theme: { active: 'board' },
  window: { from: '2026-08-01', to: '2026-09-11' },
  days: [{ date: '2026-08-01', shifts: [], events: [] }],
  people: [],
  sources: [],
  notices: [],
  weather: null,
  interrupts: [],
} as unknown as Manifest;

describe('when the device has no storage at all', () => {
  it('reports itself unavailable rather than pretending', () => {
    const store = createManifestStore(undefined);
    expect(store.available()).toBe(false);
  });

  it('loads nothing and saves without complaint', async () => {
    // A kiosk in private mode must still draw. It simply will not remember.
    const store = createManifestStore(undefined);
    await expect(store.save({ manifest: MANIFEST, confirmedAt: 1 })).resolves.toBeUndefined();
    await expect(store.load()).resolves.toBeUndefined();
  });
});

describe('when the database refuses to open', () => {
  const brokenFactory = {
    open: () => {
      const request: Record<string, unknown> = { result: undefined };
      // The error path fires on the next tick, as a real one would.
      setTimeout(() => (request['onerror'] as () => void)?.(), 0);
      return request;
    },
  } as unknown as IDBFactory;

  it('gives up quietly instead of hanging the wall', async () => {
    const store = createManifestStore(brokenFactory);
    await expect(store.load()).resolves.toBeUndefined();
    await expect(store.save({ manifest: MANIFEST, confirmedAt: 1 })).resolves.toBeUndefined();
  });

  it('survives a factory that throws outright', async () => {
    const throwing = {
      open: () => {
        throw new Error('storage disabled by policy');
      },
    } as unknown as IDBFactory;
    const store = createManifestStore(throwing);
    await expect(store.load()).resolves.toBeUndefined();
  });
});
