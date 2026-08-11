import type { Fetcher } from '@maverick-wall/core';
import { FETCH_LIMITS } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';
import {
  readCatalogSources,
  writeCatalogSourceEntries,
  writeCatalogSourceError,
} from '../api/catalog-sources.js';
import { remoteCatalogSchema } from '../http/catalog.js';

/**
 * Refresh remote catalogue sources (docs/rfc-002-module-catalog-and-recipes.md).
 *
 * Each source is a URL the household added. Its index is fetched through the
 * SSRF-guarded fetcher — the same policy a module or calendar gets, since a
 * catalogue may be public or self-hosted on the LAN, and the response is only
 * ever *validated* catalogue data, never reflected. The safety that matters is
 * `remoteCatalogSchema`: it rejects the whole source if any recipe in it asks
 * to reach the LAN, so a stranger's catalogue can never point a recipe at
 * `192.168.x.x`. A bad body keeps the last-good entries, like a module poll.
 */
const POLICY = { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true } as const;

export async function pollCatalogSources(db: SqliteDatabase, fetcher: Fetcher): Promise<void> {
  for (const source of readCatalogSources(db)) {
    if (source.enabled !== 1) continue;
    try {
      await pollOne(db, fetcher, source.id, source.url);
    } catch {
      writeCatalogSourceError(db, source.id, 'Could not reach the catalogue.');
    }
  }
}

async function pollOne(
  db: SqliteDatabase,
  fetcher: Fetcher,
  id: string,
  url: string,
): Promise<void> {
  const response = await fetcher.fetch({
    url,
    policy: POLICY,
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 10_000,
  });
  if (response.status !== 'ok') {
    writeCatalogSourceError(db, id, 'The catalogue did not answer.');
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(response.body);
  } catch {
    writeCatalogSourceError(db, id, 'The catalogue did not return JSON.');
    return;
  }

  const parsed = remoteCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    // The refinement's message names the one refusal a household most needs to
    // understand (a recipe reaching the LAN); a plainer line covers the rest.
    const lan = parsed.error.issues.some((i) => i.message.includes('local network'));
    writeCatalogSourceError(
      db,
      id,
      lan
        ? 'This catalogue asks a recipe to reach your local network, which a remote catalogue may not.'
        : 'The catalogue is not in a form Maverick Wall can read.',
    );
    return;
  }
  // Store the whole validated catalogue object — the same shape `parseEntries`
  // re-validates on read, so write and read are held to one schema.
  writeCatalogSourceEntries(db, id, parsed.data);
}
