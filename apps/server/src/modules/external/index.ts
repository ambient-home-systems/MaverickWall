import type { Fetcher, Signal } from '@maverick-wall/core';
import { FETCH_LIMITS } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { ModuleContext, PanelModule } from '../registry.js';
import {
  clearExternalModuleSignals,
  pruneModuleVariants,
  readEnabledExternalModules,
  readModuleVariants,
  readModuleWidgetSettings,
  writeExternalModuleError,
  writeExternalModulePanel,
  writeExternalModuleSignals,
  writeModuleVariantError,
  writeModuleVariantPanel,
} from '../../api/external-modules.js';
import { panelDataSchema } from './panel-data.js';
import { signalDataSchema } from './signal-data.js';
import {
  normaliseConfig,
  recipePolicy,
  recipeSchema,
  requestKey,
  resolveFetchUrl,
  resolveHeaders,
  runRecipePanel,
  runRecipeSignals,
  widgetConfig,
  withReadingValues,
  type Recipe,
  type RecipeConfig,
  type RecipeSecrets,
} from './recipe.js';
import type { ExternalModuleRow } from '../../api/external-modules.js';
import { panelForWall } from '../../api/module-image-handle.js';
import type { Keyring } from '../../secrets/keyring.js';

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
    // A picture's address stays on the server; the wall is given its handle (M7.5).
    contribute: () => (row.panel === null || row.panel === undefined ? null : panelForWall(row.id, row.panel)),
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
export const POLICY = { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true } as const;

/** The shared poll: refresh every enabled module in turn. Never throws. */
export async function pollExternalModules(
  db: SqliteDatabase,
  fetcher: Fetcher,
  keyring: Keyring,
): Promise<void> {
  for (const module of readEnabledExternalModules(db)) {
    // A recipe has no service to poll: Maverick Wall runs its declared fetch and
    // transform itself. No `/signals` either — recipe signals are Phase B2.
    if (module.kind === 'recipe') {
      try {
        await pollRecipe(db, fetcher, keyring, module);
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
 * Run one recipe for its install and for every widget that sets its own
 * settings (plan item M7.6).
 *
 * Each set of settings resolves to a request — the address and the headers —
 * and the requests are read once each, however many widgets ask for them: two
 * widgets on the same city cost one fetch, and a widget whose settings come to
 * what the install already asks costs none. Each request keeps the recipe's own
 * interval, because the shared job runs more often than most recipes want and
 * hammering a stranger's API is our manners to keep, since we make the request.
 *
 * Signals come from the install's own request only. A rule is armed per
 * module, and one module raising the same alert once per widget would be a
 * wall telling a household the same thing several times.
 */
async function pollRecipe(
  db: SqliteDatabase,
  fetcher: Fetcher,
  keyring: Keyring,
  module: ExternalModuleRow,
): Promise<void> {
  const parsed = recipeSchema.safeParse(module.recipe);
  if (!parsed.success) {
    writeExternalModuleError(db, module.id, 'This recipe is not valid.');
    return;
  }
  const recipe = parsed.data;
  const now = Date.now();
  const due = (polledAt: number): boolean => polledAt === 0 || now >= polledAt + recipe.fetch.intervalSeconds * 1000;

  const install: RecipeConfig =
    module.config !== null && typeof module.config === 'object' ? (module.config as RecipeConfig) : {};
  // What a Home Assistant reading says now: its value, never its entity id,
  // and only a reading the household watches.
  const readingValue = (entityId: string): string | undefined => {
    const row = db
      .prepare(`SELECT state FROM ha_entity_cache WHERE entity_id = ? AND watched = 1`)
      .get(entityId) as { state: string | null } | undefined;
    return row?.state ?? undefined;
  };
  const resolved = (config: RecipeConfig): RecipeConfig => withReadingValues(recipe, config, readingValue);

  interface Request {
    readonly config: RecipeConfig;
    install: boolean;
    readonly variants: string[];
  }
  const requests = new Map<string, Request>();
  const join = (config: RecipeConfig, add: (request: Request) => void): void => {
    const key = requestKey(recipe, config);
    const request = requests.get(key) ?? { config, install: false, variants: [] };
    add(request);
    requests.set(key, request);
  };
  join(resolved(normaliseConfig(recipe, install)), (request) => {
    request.install = true;
  });
  const wanted = readModuleWidgetSettings(db, module.id);
  for (const [key, settings] of wanted) {
    join(resolved(widgetConfig(recipe, install, settings)), (request) => request.variants.push(key));
  }
  pruneModuleVariants(db, module.id, new Set(wanted.keys()));
  const polled = new Map(readModuleVariants(db, module.id).map((row) => [row.variantKey, row.lastPolledAt]));

  for (const request of requests.values()) {
    const isDue =
      (request.install && due(module.lastPolledAt)) || request.variants.some((key) => due(polled.get(key) ?? 0));
    if (!isDue) continue;
    const outcome = await readRequest(fetcher, keyring, module, recipe, request.config, now);
    if (request.install) {
      if (outcome.ok) writeExternalModulePanel(db, module.id, outcome.panel);
      else writeExternalModuleError(db, module.id, outcome.error);
      // Signals come from the same body, and go to the same column a service's
      // `/signals` fills — so arming, source scoping and dismissal are all the
      // unchanged Phase 2b path. An authoritative replace: a signal whose
      // `when` stopped holding drops out, and its interrupt clears.
      if (outcome.body !== undefined && recipe.signals.length > 0) {
        const signals = runRecipeSignals(recipe, outcome.body, now);
        if (signals.ok) writeExternalModuleSignals(db, module.id, signals.signals);
      }
    }
    for (const key of request.variants) {
      if (outcome.ok) writeModuleVariantPanel(db, module.id, key, outcome.panel, now);
      else writeModuleVariantError(db, module.id, key, outcome.error, now);
    }
  }
}

/**
 * One request: the address built from these settings, fetched through the SSRF
 * guard (public https only unless the recipe opted into the LAN), and the body
 * read into Panel Data validated against the schema a service answers with.
 */
async function readRequest(
  fetcher: Fetcher,
  keyring: Keyring,
  module: ExternalModuleRow,
  recipe: Recipe,
  config: RecipeConfig,
  now: number,
): Promise<{ ok: true; panel: unknown; body: unknown } | { ok: false; error: string; body?: unknown }> {
  const url = resolveFetchUrl(recipe, config);
  // Decrypt the recipe's secrets here and nowhere else — they exist in memory
  // only for the length of this request, and only inside the headers.
  const headers = resolveHeaders(recipe, config, decryptSecrets(keyring, module.secretsEnvelope));
  const response = await fetcher.fetch({
    url,
    policy: recipePolicy(recipe),
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 10_000,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
  if (response.status !== 'ok') return { ok: false, error: 'The recipe’s source did not answer.' };
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return { ok: false, error: 'The source did not return JSON.' };
  }
  const panel = runRecipePanel(recipe, body, now);
  return panel.ok ? { ok: true, panel: panel.panel, body } : { ok: false, error: panel.error, body };
}

/**
 * Decrypt a recipe's stored secrets envelope into `{key: value}`, or `{}`.
 *
 * A failure to decrypt (a rotated master key, a corrupt envelope) yields no
 * secrets rather than throwing — the recipe then fetches without the header and
 * its own upstream refuses it, which surfaces as the recipe's error, not a dead
 * wall. The plaintext lives only in the returned object, for the one request.
 */
function decryptSecrets(keyring: Keyring, envelope: string | null): RecipeSecrets {
  if (envelope === null) return {};
  const result = keyring.decrypt(envelope, 'recipe-secret');
  if (!result.ok) return {};
  try {
    const parsed: unknown = JSON.parse(result.value);
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: RecipeSecrets = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
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
