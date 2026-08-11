import type { SqliteDatabase } from '../db/open.js';
import { CATALOG, catalogEntry, catalogSchema, type CatalogEntry } from '../http/catalog.js';

/**
 * Remote catalogue sources (docs/rfc-002-module-catalog-and-recipes.md, A2).
 *
 * A source is a URL the household added that answers with a catalogue index.
 * Its validated entries are cached in the row; the Browse page shows the
 * built-in catalogue plus every enabled source's entries. Installing works the
 * same as a built-in entry — the only difference is where the entry was found.
 *
 * Remote entry ids are namespaced `<sourceId>~<entryId>` so two catalogues can
 * use the same entry id without colliding, and so an install can find its way
 * back to the source. `~` is URL-safe and cannot appear in an entry id (kebab)
 * or a source id (hex), so the split is unambiguous.
 */

export interface CatalogSourceRow {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly enabled: number;
  readonly entries: CatalogEntry[];
  readonly lastFetchedAt: number;
  readonly lastError: string | null;
}

interface RawRow {
  id: string;
  url: string;
  name: string;
  enabled: number;
  entries: string | null;
  last_fetched_at: number;
  last_error: string | null;
}

/** Cached entries, re-validated on read: a stored blob is still untrusted. */
function parseEntries(value: string | null): CatalogEntry[] {
  if (value === null) return [];
  try {
    const parsed = catalogSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data.modules : [];
  } catch {
    return [];
  }
}

function shape(row: RawRow): CatalogSourceRow {
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    enabled: row.enabled,
    entries: parseEntries(row.entries),
    lastFetchedAt: row.last_fetched_at,
    lastError: row.last_error,
  };
}

const SELECT = `SELECT id, url, name, enabled, entries, last_fetched_at, last_error
  FROM catalog_sources ORDER BY created_at`;

export function readCatalogSources(db: SqliteDatabase): CatalogSourceRow[] {
  return (db.prepare(SELECT).all() as RawRow[]).map(shape);
}

export function createCatalogSource(
  db: SqliteDatabase,
  input: { id: string; url: string; name: string },
): void {
  const at = Date.now();
  db.prepare(
    `INSERT INTO catalog_sources (id, url, name, enabled, last_fetched_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, 0, ?, ?)`,
  ).run(input.id, input.url, input.name, at, at);
}

export function deleteCatalogSource(db: SqliteDatabase, id: string): void {
  db.prepare(`DELETE FROM catalog_sources WHERE id = ?`).run(id);
}

export function setCatalogSourceEnabled(db: SqliteDatabase, id: string, enabled: boolean): void {
  db.prepare(`UPDATE catalog_sources SET enabled = ?, updated_at = ? WHERE id = ?`).run(
    enabled ? 1 : 0,
    Date.now(),
    id,
  );
}

/** A good fetch: store the validated entries and clear the error. */
export function writeCatalogSourceEntries(db: SqliteDatabase, id: string, entries: unknown): void {
  const at = Date.now();
  db.prepare(
    `UPDATE catalog_sources SET entries = ?, last_error = NULL, last_fetched_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(entries), at, at, id);
}

/** A failed fetch: record the error, keep the last-good entries. */
export function writeCatalogSourceError(db: SqliteDatabase, id: string, error: string): void {
  const at = Date.now();
  db.prepare(
    `UPDATE catalog_sources SET last_error = ?, last_fetched_at = ?, updated_at = ? WHERE id = ?`,
  ).run(error, at, at, id);
}

/** How an entry is addressed on the Browse page and in an install link. */
export interface BrowseEntry {
  /** `entry.id` for a built-in, `<sourceId>~<entry.id>` for a remote one. */
  readonly installId: string;
  readonly entry: CatalogEntry;
  /** The source's name, for a remote entry — so the card can say where it came from. */
  readonly sourceName?: string;
}

/** Everything the Browse page shows: the built-in catalogue, then each source's. */
export function browseEntries(db: SqliteDatabase): BrowseEntry[] {
  const list: BrowseEntry[] = CATALOG.modules.map((entry) => ({ installId: entry.id, entry }));
  for (const source of readCatalogSources(db)) {
    if (source.enabled !== 1) continue;
    for (const entry of source.entries) {
      list.push({ installId: `${source.id}~${entry.id}`, entry, sourceName: source.name });
    }
  }
  return list;
}

/** Resolve an install id back to its entry — built-in or from a source. */
export function resolveCatalogEntry(db: SqliteDatabase, installId: string): CatalogEntry | undefined {
  const tilde = installId.indexOf('~');
  if (tilde === -1) return catalogEntry(installId);
  const sourceId = installId.slice(0, tilde);
  const entryId = installId.slice(tilde + 1);
  const source = readCatalogSources(db).find((s) => s.id === sourceId && s.enabled === 1);
  return source?.entries.find((e) => e.id === entryId);
}
