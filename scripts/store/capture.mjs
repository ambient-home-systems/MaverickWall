#!/usr/bin/env node
/**
 * Captures what each store recipe's feed answers, as the fixture its test reads
 * (plan item M7.11).
 *
 *   pnpm --filter @maverick-wall/server build
 *   node scripts/store/capture.mjs [id...]
 *
 * For every recipe entry in the built store (or only the ids named), this asks
 * the recipe's own address, with every setting at its default, and writes
 * under apps/server/test/fixtures/store/<id>/:
 *
 *   recipe.json     the recipe, exactly as the store carries it
 *   answer.<ext>    what the address answered, byte for byte
 *   sources/…       what each named source answered
 *   fixture.json    when it was asked, so the test reads it at that instant
 *
 * Then `node apps/server/dist/tools/test-recipe.js <dir> --update` records
 * what the recipe builds from it as expected.json, and a person reads that
 * before committing it: the test holds the recipe to the answer, and only a
 * person can say the answer drew something true.
 *
 * It refuses an answer that is not a 200, so a fixture is never an error page.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { STORE_ENTRIES } = await import(join(root, 'apps/server/dist/catalog/index.js'));

const wanted = new Set(process.argv.slice(2));
const EXT = { json: 'json', feed: 'xml', xml: 'xml' };

/**
 * The household a fixture is read for: somewhere the feed's default settings
 * make sense, so a time in it reads as it would on that wall.
 */
const ZONES = {
  'outside-temperature': 'Europe/London',
  pollen: 'Europe/London',
  'flood-warnings': 'Europe/London',
  'public-holidays': 'Europe/London',
  'london-lines': 'Europe/London',
  'swiss-departures': 'Europe/Zurich',
  'fuel-prices-france': 'Europe/Paris',
  'rocket-launches': 'Europe/London',
};

function address(template, config) {
  return template.replace(/\{([^}]*)\}/g, (_all, key) => encodeURIComponent(config[key.trim()] ?? ''));
}

async function ask(url) {
  // A public service a whole data centre shares answers 429 now and then; it
  // is asked again a few times, and an answer that is not a 200 is refused.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: { 'user-agent': 'maverick-wall store fixture capture' } });
    if (response.status === 429 && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    if (response.status !== 200) throw new Error(`${new URL(url).host} answered ${response.status}`);
    return response.text();
  }
}

let failed = false;
for (const entry of STORE_ENTRIES) {
  if (entry.kind !== 'recipe' || (wanted.size > 0 && !wanted.has(entry.id))) continue;
  const recipe = entry.recipe;
  if ((recipe.secrets ?? []).length > 0) {
    console.log(`SKIP   ${entry.id}: it needs a key, which this script does not have`);
    continue;
  }
  const config = Object.fromEntries((recipe.config ?? []).map((field) => [field.key, field.default ?? '']));
  const dir = join(root, 'apps/server/test/fixtures/store', entry.id);
  try {
    const at = new Date().toISOString();
    const main = await ask(address(recipe.fetch.url, config));
    const sources = {};
    for (const [name, source] of Object.entries(recipe.sources ?? {})) {
      if ('ha' in source) throw new Error(`the source “${name}” is the house, which has no address to ask`);
      sources[name] = { text: await ask(address(source.url, config)), ext: EXT[source.format ?? 'json'] };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'recipe.json'), `${JSON.stringify(recipe, null, 2)}\n`);
    writeFileSync(join(dir, `answer.${EXT[recipe.fetch.format ?? 'json']}`), main);
    for (const [name, { text, ext }] of Object.entries(sources)) {
      mkdirSync(join(dir, 'sources'), { recursive: true });
      writeFileSync(join(dir, 'sources', `${name}.${ext}`), text);
    }
    writeFileSync(join(dir, 'fixture.json'), `${JSON.stringify({ at, timezone: ZONES[entry.id] ?? 'America/New_York' }, null, 2)}\n`);
    console.log(`SAVED  ${entry.id}`);
  } catch (error) {
    console.log(`FAILED ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
