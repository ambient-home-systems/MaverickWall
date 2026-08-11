import type { Fetcher, Signal } from '@maverick-wall/core';
import { FETCH_LIMITS } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { ModuleContext, PanelModule } from '../registry.js';
import {
  clearExternalModuleSignals,
  readEnabledExternalModules,
  writeExternalModuleError,
  writeExternalModulePanel,
  writeExternalModuleSignals,
} from '../../api/external-modules.js';
import { panelDataSchema } from './panel-data.js';
import { signalDataSchema } from './signal-data.js';
import {
  normaliseConfig,
  recipePolicy,
  recipeSchema,
  resolveFetchUrl,
  runRecipePanel,
  type RecipeConfig,
} from './recipe.js';
import type { ExternalModuleRow } from '../../api/external-modules.js';

/**
 * Third-party modules, as `PanelModule`s (docs/rfc-001-module-framework.md).
 *
 * Each enabled row becomes a module the *existing* `collectPanels` gathers — so
 * ordering, per-module error isolation and the manifest slice all come free from
 * the registry the first-party modules already use. They have no `job` of their
 * own: one shared job (`pollExternalModules`) refreshes every module and writes
 * the validated panel to the row this reads back.
 *
 * A module may also offer *signals* — facts the interrupt rules can match on.
 * That is the one place a third-party module can reach past its own block and
 * draw over the whole wall, so it is fenced on every side: the signals carry a
 * `source` of `ext:<id>` this adapter stamps (the module never sets it), and
 * core's evaluator only matches a signal against a rule of the *same* source
 * (`evaluate.ts`: `signal.source !== rule.source`). So a module's signals can
 * never trip a built-in weather rule, nor another module's rule; and no signal
 * does anything at all until the household arms the module and a source-scoped
 * rule exists to act on it (`ensureModuleAlertRule` in api/rules.ts).
 */
export function externalPanelModules(db: SqliteDatabase): PanelModule[] {
  return readEnabledExternalModules(db).map((row) => ({
    key: row.blockKey,
    label: row.name,
    // Only ready once a poll has stored something the wall can draw.
    ready: () => row.panel !== null && row.panel !== undefined,
    contribute: () => row.panel ?? null,
    signals: (ctx: ModuleContext) => moduleSignals(row.id, row.signals, ctx.now),
  }));
}

/**
 * The cached signals, re-validated and stamped with this module's source.
 *
 * Re-validated on read even though it was validated on write: this is the value
 * that can raise a takeover, so a second pass costs nothing and closes the gap
 * where a stored blob was written by an older, looser schema. The `source` is
 * set here and only here — a module has no say in which rules its signals can
 * reach.
 */
function moduleSignals(id: string, stored: unknown, now: number): Signal[] {
  const parsed = signalDataSchema.safeParse(stored);
  if (!parsed.success) return [];
  const source = `ext:${id}` as const;
  return parsed.data.signals.map((sig) => ({
    source,
    key: sig.key,
    title: sig.title,
    ...(sig.severity !== undefined ? { severity: sig.severity } : {}),
    // Relative time anchored to our clock, never the module's.
    ...(sig.startsInSec !== undefined ? { startsAt: now + sig.startsInSec * 1000 } : {}),
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
    // A recipe has no service to poll: Maverick Wall runs its declared fetch and
    // transform itself. No `/signals` either — recipe signals are Phase B2.
    if (module.kind === 'recipe') {
      try {
        await pollRecipe(db, fetcher, module);
      } catch {
        writeExternalModuleError(db, module.id, 'The recipe could not run.');
      }
      continue;
    }

    try {
      const outcome = await pollOne(fetcher, module.url);
      if (outcome.ok) writeExternalModulePanel(db, module.id, outcome.panel);
      else writeExternalModuleError(db, module.id, outcome.error);
    } catch {
      // A module that cannot be polled is a stale panel and a note, not a dead
      // wall. Its own card shows the error.
      writeExternalModuleError(db, module.id, 'Could not reach the module.');
    }
    // Signals are polled separately and never affect the panel's health line: a
    // module that serves only `/panel` returns 404 here, which is not an error.
    try {
      await pollSignals(db, fetcher, module.id, module.url);
    } catch {
      // Keep the last-good signals; a blip must not drop a real alert.
    }
  }
}

/**
 * Run one recipe: resolve its URL from config, fetch through the SSRF guard
 * (public https only unless the recipe opted into the LAN), and interpret the
 * body into Panel Data validated against the same schema a service answers with.
 */
async function pollRecipe(
  db: SqliteDatabase,
  fetcher: Fetcher,
  module: ExternalModuleRow,
): Promise<void> {
  const parsed = recipeSchema.safeParse(module.recipe);
  if (!parsed.success) {
    writeExternalModuleError(db, module.id, 'This recipe is not valid.');
    return;
  }
  const recipe = parsed.data;
  const now = Date.now();
  // Honour the recipe's own polling interval — the shared job runs more often
  // than most recipes want, and hammering a stranger's API is our manners to
  // keep, since we make the request.
  if (module.lastPolledAt !== 0 && now < module.lastPolledAt + recipe.fetch.intervalSeconds * 1000) {
    return;
  }

  const supplied =
    module.config !== null && typeof module.config === 'object'
      ? (module.config as RecipeConfig)
      : {};
  const url = resolveFetchUrl(recipe, normaliseConfig(recipe, supplied));

  const response = await fetcher.fetch({
    url,
    policy: recipePolicy(recipe),
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 10_000,
  });
  if (response.status !== 'ok') {
    writeExternalModuleError(db, module.id, 'The recipe’s source did not answer.');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    writeExternalModuleError(db, module.id, 'The source did not return JSON.');
    return;
  }

  const outcome = runRecipePanel(recipe, body, now);
  if (outcome.ok) writeExternalModulePanel(db, module.id, outcome.panel);
  else writeExternalModuleError(db, module.id, outcome.error);
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

/**
 * Refresh a module's signals, if it offers any.
 *
 * Three outcomes, and the distinction is the whole safety story:
 *   - a valid `/signals` body **replaces** the cache — the module is
 *     authoritative, so a signal it stops listing is one that has cleared;
 *   - a **404** means the module offers no signals at all, and the cache is
 *     emptied so a module that dropped the feature stops alerting;
 *   - anything else — unreachable, a 5xx, malformed — **keeps** the last good
 *     set, because a transient failure must not silently clear a live alert.
 */
async function pollSignals(
  db: SqliteDatabase,
  fetcher: Fetcher,
  id: string,
  baseUrl: string,
): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, '')}/signals`;
  const response = await fetcher.fetch({
    url,
    policy: POLICY,
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 10_000,
  });

  if (response.status === 'ok') {
    let raw: unknown;
    try {
      raw = JSON.parse(response.body);
    } catch {
      return; // Malformed: keep last good.
    }
    const parsed = signalDataSchema.safeParse(raw);
    if (parsed.success) writeExternalModuleSignals(db, id, parsed.data);
    return; // Invalid schema: keep last good.
  }

  if (response.status === 'failed' && response.httpStatus === 404) {
    clearExternalModuleSignals(db, id);
  }
  // Every other outcome keeps the last-good set.
}
