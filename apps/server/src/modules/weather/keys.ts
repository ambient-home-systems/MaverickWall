import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import type { KeyedProvider } from './providers.js';

/**
 * A weather service's key, as this application keeps it (plan item M5.8).
 *
 * Sealed under its own keyring purpose, one row per provider, opened for one
 * request at a time. Nothing here writes a key into a page, a log, a message
 * or the manifest: the Weather screen says only whether one is saved.
 */

/** A key is letters, digits and a few separators; anything else is a paste gone wrong. */
export const WEATHER_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function hasWeatherKey(db: SqliteDatabase, provider: KeyedProvider): boolean {
  const row = db.prepare(`SELECT count(*) AS n FROM weather_keys WHERE provider = ?`).get(provider) as { n: number };
  return row.n > 0;
}

/** Which providers have a key saved, for the Weather screen. */
export function savedWeatherKeys(db: SqliteDatabase): ReadonlySet<string> {
  const rows = db.prepare(`SELECT provider FROM weather_keys`).all() as { provider: string }[];
  return new Set(rows.map((row) => row.provider));
}

export function saveWeatherKey(
  db: SqliteDatabase,
  keyring: Keyring,
  provider: KeyedProvider,
  key: string,
  at: number,
): void {
  db.prepare(
    `INSERT INTO weather_keys (provider, key_encrypted, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET key_encrypted = excluded.key_encrypted, updated_at = excluded.updated_at`,
  ).run(provider, keyring.encrypt(key, 'weather-key'), at);
}

export function forgetWeatherKey(db: SqliteDatabase, provider: KeyedProvider): boolean {
  return db.prepare(`DELETE FROM weather_keys WHERE provider = ?`).run(provider).changes > 0;
}

export type OpenedKey = { readonly ok: true; readonly key: string } | { readonly ok: false; readonly message: string };

/** The key, opened for one request — or why there is none, in a sentence. */
export function openWeatherKey(db: SqliteDatabase, keyring: Keyring, provider: KeyedProvider, name: string): OpenedKey {
  const row = db.prepare(`SELECT key_encrypted AS sealed FROM weather_keys WHERE provider = ?`).get(provider) as
    | { sealed: string }
    | undefined;
  if (row === undefined) {
    return { ok: false, message: `${name} needs a key. Paste one on the Weather screen.` };
  }
  const opened = keyring.decrypt(row.sealed, 'weather-key');
  if (!opened.ok) {
    return { ok: false, message: `The ${name} key could not be opened. Paste it again on the Weather screen.` };
  }
  return { ok: true, key: opened.value };
}
