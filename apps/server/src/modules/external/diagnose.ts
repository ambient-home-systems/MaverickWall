import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import { readModuleVariants, readModuleWidgetSettings, type ExternalModuleRow } from '../../api/external-modules.js';
import type { Keyring } from '../../secrets/keyring.js';
import { POLICY, decryptSecrets, householdTimezone, houseValueReader, readingValueReader } from './index.js';
import { panelDataSchema } from './panel-data.js';
import { signalDataSchema } from './signal-data.js';
import {
  describeIssues,
  houseBody,
  houseRequests,
  normaliseConfig,
  recipePolicy,
  recipeSchema,
  resolveFetchUrl,
  resolveHeaders,
  resolveSources,
  withReadingValues,
} from './recipe.js';
import { runRecipeOnAnswers } from './recipe-tooling.js';
import type { SourceFormat } from './source-formats.js';

/**
 * Why a module draws what it draws, or nothing (plan item M7.10).
 *
 * The module's card says one sentence for a household — "The recipe produced
 * something the wall cannot draw." — because that is all a household can act
 * on. Whoever wrote the recipe needs the rest: which request did not answer,
 * which source, and where in the built panel the schema refused it. This reads
 * the module the way the poll does, through the same fetcher and policy, and
 * says so, line by line.
 *
 * It writes nothing: a diagnosis that refreshed the panel as a side effect
 * would make the card disagree with the diagnosis that explained it.
 *
 * Addresses are named by their host and never their path, which is where a
 * feed's key lives. Settings are named by key and never by value, because a
 * reading setting's value is an entity id and an address's can be a
 * credential. Secrets are counted, never printed.
 */
export async function diagnoseModule(
  db: SqliteDatabase,
  fetcher: Fetcher,
  keyring: Keyring,
  module: ExternalModuleRow,
  now: number,
): Promise<string[]> {
  const lines: string[] = [];
  const say = (label: string, value: string): void => {
    lines.push(`  ${`${label}:`.padEnd(13)}${value}`);
  };
  say('kind', module.kind === 'recipe' ? 'recipe' : 'service');
  say('state', module.enabled === 1 ? 'on' : 'off — walls do not draw it');
  say('last read', module.lastPolledAt === 0 ? 'never' : new Date(module.lastPolledAt).toISOString());
  say('last error', module.lastError ?? 'none');
  say('panel', module.panel === null ? 'none stored' : describePanel(module.panel));

  if (module.kind !== 'recipe') {
    lines.push('', '  Reading it now:');
    await diagnoseService(fetcher, module.url, lines);
    return lines;
  }

  const parsed = recipeSchema.safeParse(module.recipe);
  if (!parsed.success) {
    say('recipe', 'not valid any more');
    for (const line of describeIssues(parsed.error.issues, '').split('\n')) lines.push(`    ${line}`);
    return lines;
  }
  const recipe = parsed.data;
  say('every', describeInterval(recipe.fetch.intervalSeconds));
  if (recipe.config.length > 0) say('settings', recipe.config.map((field) => field.key).join(', '));
  if (recipe.secrets.length > 0) {
    const stored = Object.keys(decryptSecrets(keyring, module.secretsEnvelope)).length;
    say('secrets', `${stored} of ${recipe.secrets.length} stored`);
  }

  const widgets = readModuleWidgetSettings(db, module.id);
  if (widgets.size > 0) {
    const variants = readModuleVariants(db, module.id);
    const failing = variants.filter((variant) => variant.lastError !== null).length;
    say('widgets', `${widgets.size} with settings of their own${failing > 0 ? `, ${failing} of them failing` : ''}`);
  }

  lines.push('', '  Reading it now, with the settings it was installed with:');
  const stored = normaliseConfig(
    recipe,
    module.config !== null && typeof module.config === 'object' ? (module.config as Record<string, string>) : {},
  );
  const config = withReadingValues(recipe, stored, readingValueReader(db));
  const secrets = decryptSecrets(keyring, module.secretsEnvelope);
  const read = async (
    label: string,
    url: string,
    headers: Record<string, string>,
    format: SourceFormat,
  ): Promise<string | undefined> => {
    const response = await fetcher.fetch({
      url,
      policy: recipePolicy(recipe),
      maxBytes: format === 'json' ? FETCH_LIMITS.json : FETCH_LIMITS.feed,
      ...(format === 'json' ? { acceptContentTypes: ['application/json'] } : {}),
      timeoutMs: 10_000,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (response.status === 'ok') {
      say(label, `${hostOf(url)} answered ${response.byteSize} bytes of ${response.contentType || 'no stated type'}`);
      return response.body;
    }
    say(label, `${hostOf(url)} did not answer: ${describeFailure(response)}`);
    return undefined;
  };

  const main = await read('fetch', resolveFetchUrl(recipe, config), resolveHeaders(recipe, config, secrets), recipe.fetch.format);
  const answers: Record<string, string> = {};
  let missing = main === undefined;
  for (const source of resolveSources(recipe, config, secrets)) {
    const body = await read(`@${source.name}`, source.url, source.headers, source.format);
    if (body === undefined) missing = true;
    else answers[source.name] = body;
  }
  for (const house of houseRequests(recipe, stored)) {
    const body = houseBody(house, houseValueReader(db));
    const known = body.filter((row) => Object.keys(row as object).length > 1).length;
    say(`@${house.name}`, `the house: ${known} of ${body.length} readings watched and known`);
    answers[house.name] = JSON.stringify(body);
  }
  if (missing || main === undefined) {
    lines.push('', '  The panel was not built: a request did not answer, and the wall keeps its last good panel.');
    return lines;
  }

  const run = runRecipeOnAnswers(recipe, { main, sources: answers }, { now, timezone: householdTimezone(db) });
  if (!run.ok) {
    say('builds', `nothing — ${run.error}`);
    if (run.detail !== undefined) for (const line of run.detail.split('\n')) lines.push(`    ${line}`);
    return lines;
  }
  say('builds', describePanel(run.panel));
  lines.push(...JSON.stringify(run.panel, null, 2).split('\n').map((line) => `    ${line}`));
  say('signals', run.signals.length === 0 ? 'none raised' : `${run.signals.length} raised`);
  for (const signal of run.signals) lines.push(`    ${JSON.stringify(signal)}`);
  return lines;
}

/** A service module's `/panel` and `/signals`, read as the poll reads them. */
async function diagnoseService(fetcher: Fetcher, baseUrl: string, lines: string[]): Promise<void> {
  const say = (label: string, value: string): void => {
    lines.push(`  ${`${label}:`.padEnd(13)}${value}`);
  };
  for (const part of ['panel', 'signals'] as const) {
    const url = `${baseUrl.replace(/\/+$/, '')}/${part}`;
    const response = await fetcher.fetch({
      url,
      policy: POLICY,
      maxBytes: FETCH_LIMITS.json,
      acceptContentTypes: ['application/json'],
      timeoutMs: 10_000,
    });
    if (response.status !== 'ok') {
      const optional = part === 'signals' && response.status === 'failed' && response.httpStatus === 404;
      say(`/${part}`, optional ? 'not offered (404), which is fine' : `${hostOf(url)} did not answer: ${describeFailure(response)}`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.body);
    } catch {
      say(`/${part}`, `${hostOf(url)} answered something that is not JSON`);
      continue;
    }
    const parsed = (part === 'panel' ? panelDataSchema : signalDataSchema).safeParse(raw);
    if (!parsed.success) {
      say(`/${part}`, 'answered, and the wall cannot use it');
      for (const line of describeIssues(parsed.error.issues, part).split('\n')) lines.push(`    ${line}`);
      continue;
    }
    say(`/${part}`, part === 'panel' ? describePanel(parsed.data) : 'answered, and the wall can use it');
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'an address that does not parse';
  }
}

function describeFailure(response: { status: string; code?: string; httpStatus?: number; message?: string }): string {
  const code = [response.code, response.httpStatus].filter((part) => part !== undefined).join(' ');
  return [code, response.message].filter((part) => part !== undefined && part !== '').join(' — ') || response.status;
}

function describeInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** A panel by its kind and how much is in it, rather than its words. */
function describePanel(panel: unknown): string {
  if (panel === null || typeof panel !== 'object') return 'not a panel';
  const kind = (panel as { kind?: unknown }).kind;
  const items = (panel as { items?: unknown; rows?: unknown }).items ?? (panel as { rows?: unknown }).rows;
  const count = Array.isArray(items) ? `, ${items.length} ${items.length === 1 ? 'row' : 'rows'}` : '';
  return `${typeof kind === 'string' ? kind : 'unknown kind'}${count}`;
}
