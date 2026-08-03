import type { Manifest } from './manifest.js';

/**
 * The last manifest that worked, kept on the device.
 *
 * Rule nine in its most literal form: a wall that has been unplugged, or whose
 * server is down while somebody reboots the router, must come back showing
 * yesterday's calendar with a note — not a waiting screen, and never a blank
 * rectangle. Everything the display needs to draw is in one document, so
 * keeping one document is the whole of the offline story.
 *
 * IndexedDB rather than localStorage because a forty-two day manifest with a
 * busy household in it is comfortably past what localStorage is safe for, and
 * because a synchronous read on a slow tablet is a stutter at exactly the
 * moment the wall is trying to paint.
 *
 * Every operation resolves rather than rejects. A kiosk browser in private
 * mode, or one with storage disabled by policy, must degrade to "no memory
 * between reloads" — which is where this started — and not to a broken wall.
 */

const DB_NAME = 'maverick-wall';
const DB_VERSION = 1;
const STORE = 'manifest';
/** One row. The manifest is the unit of consistency, so there is nothing else to key. */
const KEY = 'last-good';

export interface StoredManifest {
  readonly manifest: Manifest;
  /** When the server last confirmed this document, by the corrected clock. */
  readonly confirmedAt: number;
}

export interface ManifestStore {
  load(): Promise<StoredManifest | undefined>;
  save(entry: StoredManifest): Promise<void>;
  /** True when this device can actually remember anything. For diagnostics. */
  available(): boolean;
}

type Factory = IDBFactory | undefined;

/**
 * Open the database, or decide we have no storage.
 *
 * The `blocked` and `error` paths both resolve to undefined rather than
 * hanging: a wall waiting forever on a database that will never open is
 * indistinguishable from a wall that has crashed.
 */
function openDb(factory: IDBFactory): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: IDBDatabase | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      finish(undefined);
      return;
    }

    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = (): void => finish(request.result);
    request.onerror = (): void => finish(undefined);
    request.onblocked = (): void => finish(undefined);

    // Two seconds is far longer than a local database needs and far shorter
    // than a household will stand in front of a blank screen.
    setTimeout(() => finish(undefined), 2000);
  });
}

export function createManifestStore(factory: Factory = globalThis.indexedDB): ManifestStore {
  const usable = factory !== undefined && factory !== null;
  let opening: Promise<IDBDatabase | undefined> | undefined;

  const db = (): Promise<IDBDatabase | undefined> => {
    if (!usable) return Promise.resolve(undefined);
    // Opened once and reused. Reopening per call is a transaction's worth of
    // latency on every poll for no benefit.
    opening = opening ?? openDb(factory as IDBFactory);
    return opening;
  };

  return {
    available: () => usable,

    async load(): Promise<StoredManifest | undefined> {
      const database = await db();
      if (database === undefined) return undefined;

      return new Promise((resolve) => {
        try {
          const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
          request.onsuccess = (): void => {
            const value = request.result as StoredManifest | undefined;
            // Checked rather than trusted: this came off a disk that a
            // previous version of this bundle wrote, and a shape change
            // between versions must not throw at the first paint.
            resolve(
              value !== undefined &&
                typeof value === 'object' &&
                typeof value.confirmedAt === 'number' &&
                value.manifest !== undefined
                ? value
                : undefined,
            );
          };
          request.onerror = (): void => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
    },

    async save(entry: StoredManifest): Promise<void> {
      const database = await db();
      if (database === undefined) return;

      return new Promise((resolve) => {
        try {
          const transaction = database.transaction(STORE, 'readwrite');
          transaction.objectStore(STORE).put(entry, KEY);
          // Resolving on either outcome: a failed write means the wall shows
          // the waiting screen after the next reload, which is worse than
          // nothing but is not worth interrupting a working display over.
          transaction.oncomplete = (): void => resolve();
          transaction.onerror = (): void => resolve();
          transaction.onabort = (): void => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}
