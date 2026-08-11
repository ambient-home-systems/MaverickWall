import type { Fetcher } from '@maverick-wall/core';
import { FETCH_LIMITS } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { PanelModule } from '../registry.js';
import {
  readEnabledExternalModules,
  writeExternalModuleError,
  writeExternalModulePanel,
} from '../../api/external-modules.js';
import { panelDataSchema } from './panel-data.js';

/**
 * Third-party modules, as `PanelModule`s (docs/rfc-001-module-framework.md).
 *
 * Each enabled row becomes a module the *existing* `collectPanels` gathers — so
 * ordering, per-module error isolation and the manifest slice all come free from
 * the registry the first-party modules already use. They have no `job` of their
 * own: one shared job (`pollExternalModules`) refreshes every module and writes
 * the validated panel to the row this reads back.
 */
export function externalPanelModules(db: SqliteDatabase): PanelModule[] {
  return readEnabledExternalModules(db).map((row) => ({
    key: row.blockKey,
    label: row.name,
    // Only ready once a poll has stored something the wall can draw.
    ready: () => row.panel !== null && row.panel !== undefined,
    contribute: () => row.panel ?? null,
  }));
}

/*
 * The poll policy for an external module.
 *
 * Loopback, LAN and plain http are all permitted, because a module is almost
 * always a container the household runs on its own network — the friction of an
 * SSRF opt-in per module buys little when the household typed the address itself
 * and the response can only ever become sanitised, `textContent`-drawn strings.
 * The fetcher still DNS-pins, limits size and validates redirects; and a body
 * that is not valid Panel Data is rejected and never drawn.
 */
const POLICY = { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true } as const;

/** The shared poll: refresh every enabled module in turn. Never throws. */
export async function pollExternalModules(db: SqliteDatabase, fetcher: Fetcher): Promise<void> {
  for (const module of readEnabledExternalModules(db)) {
    try {
      const outcome = await pollOne(fetcher, module.url);
      if (outcome.ok) writeExternalModulePanel(db, module.id, outcome.panel);
      else writeExternalModuleError(db, module.id, outcome.error);
    } catch {
      // A module that cannot be polled is a stale panel and a note, not a dead
      // wall. Its own card shows the error.
      writeExternalModuleError(db, module.id, 'Could not reach the module.');
    }
  }
}

async function pollOne(
  fetcher: Fetcher,
  baseUrl: string,
): Promise<{ ok: true; panel: unknown } | { ok: false; error: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/panel`;
  const response = await fetcher.fetch({
    url,
    policy: POLICY,
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 10_000,
  });
  if (response.status !== 'ok') return { ok: false, error: 'The module did not answer.' };

  let raw: unknown;
  try {
    raw = JSON.parse(response.body);
  } catch {
    return { ok: false, error: 'The module did not return JSON.' };
  }
  const parsed = panelDataSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'The module returned something the wall cannot draw.' };
  }
  return { ok: true, panel: parsed.data };
}
