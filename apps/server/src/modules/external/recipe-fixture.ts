import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { differences, readRecipe, runRecipeOnAnswers, type RecipeAnswers } from './recipe-tooling.js';

/**
 * A recipe's fixture: the recipe, answers captured from its feed, and what the
 * recipe should build from them (plan item M7.10).
 *
 * A directory, because what a recipe reads is one or more files of whatever
 * its feed speaks, and a JSON blob holding an XML document as a string is a
 * fixture nobody can read or diff:
 *
 *   recipe.json             the recipe, exactly as it would be pasted
 *   answer.json|.xml|.txt   what the main fetch answered (exactly one)
 *   sources/<name>.<ext>    what each named source answered; a house source's
 *                           is the JSON list of readings it would be
 *   fixture.json            optional: { "at": ISO instant, "timezone": zone }
 *   expected.json           optional: { "panel": …, "signals": […] }
 *
 * `at` matters because a recipe's `date:relative`, `time` and countdowns are
 * worked out from a clock, and a fixture checked against today would pass
 * today and fail tomorrow.
 */

const ANSWER_FILES = ['answer.json', 'answer.xml', 'answer.txt'] as const;

const fixtureFile = z
  .object({
    at: z.string().datetime({ offset: true }).optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

const expectedFile = z.object({ panel: z.unknown(), signals: z.array(z.unknown()) }).strict();

export interface Fixture {
  readonly dir: string;
  readonly recipeText: string;
  readonly answers: RecipeAnswers;
  readonly at: number;
  /** Whether `at` came from `fixture.json`, rather than the clock it was run by. */
  readonly pinned: boolean;
  readonly timezone?: string;
  readonly expected?: { readonly panel: unknown; readonly signals: readonly unknown[] };
}

/** Read a fixture directory, or say which file is missing or wrong. */
export function loadFixture(dir: string, now: number): { ok: true; fixture: Fixture } | { ok: false; error: string } {
  if (!existsSync(join(dir, 'recipe.json'))) return { ok: false, error: `There is no recipe.json in ${dir}.` };
  const recipeText = readFileSync(join(dir, 'recipe.json'), 'utf8');
  const answerFiles = ANSWER_FILES.filter((name) => existsSync(join(dir, name)));
  if (answerFiles.length !== 1) {
    return {
      ok: false,
      error:
        answerFiles.length === 0
          ? `There is no answer.json, answer.xml or answer.txt in ${dir}.`
          : `There is more than one answer file in ${dir}: ${answerFiles.join(', ')}.`,
    };
  }
  const main = readFileSync(join(dir, answerFiles[0] as string), 'utf8');

  const sources: Record<string, string> = {};
  const sourcesDir = join(dir, 'sources');
  if (existsSync(sourcesDir)) {
    for (const file of readdirSync(sourcesDir).sort()) {
      const match = /^([A-Za-z][A-Za-z0-9_]*)\.(json|xml|txt)$/.exec(file);
      if (match === null) continue;
      const name = match[1] as string;
      if (name in sources) return { ok: false, error: `There is more than one answer for the source “${name}”.` };
      sources[name] = readFileSync(join(sourcesDir, file), 'utf8');
    }
  }

  let at = now;
  let pinned = false;
  let timezone: string | undefined;
  if (existsSync(join(dir, 'fixture.json'))) {
    const read = readJson(join(dir, 'fixture.json'), fixtureFile);
    if (!read.ok) return { ok: false, error: `fixture.json ${read.error}` };
    if (read.value.at !== undefined) {
      at = Date.parse(read.value.at);
      pinned = true;
    }
    timezone = read.value.timezone;
  }

  let expected: Fixture['expected'];
  if (existsSync(join(dir, 'expected.json'))) {
    const read = readJson(join(dir, 'expected.json'), expectedFile);
    if (!read.ok) return { ok: false, error: `expected.json ${read.error}` };
    expected = { panel: read.value.panel, signals: read.value.signals };
  }

  return {
    ok: true,
    fixture: {
      dir,
      recipeText,
      answers: { main, sources },
      at,
      pinned,
      ...(timezone !== undefined ? { timezone } : {}),
      ...(expected !== undefined ? { expected } : {}),
    },
  };
}

function readJson<T>(path: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, error: 'is not valid JSON.' };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first !== undefined && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    return { ok: false, error: `is not valid — ${where}${first?.message ?? 'wrong shape'}.` };
  }
  return { ok: true, value: parsed.data };
}

/** How a fixture fared, and the lines to say so. */
export interface FixtureCheck {
  /** `pass` and `fail` against expected.json; `unrecorded` when there is none to check against. */
  readonly status: 'pass' | 'fail' | 'unrecorded' | 'error';
  readonly lines: readonly string[];
  readonly built?: { readonly panel: unknown; readonly signals: readonly unknown[] };
}

/** Run a fixture's recipe on its answers, and compare what it built with expected.json. */
export function checkFixture(fixture: Fixture): FixtureCheck {
  const recipe = readRecipe(fixture.recipeText);
  if (!recipe.ok) return { status: 'error', lines: [recipe.error] };
  const run = runRecipeOnAnswers(recipe.recipe, fixture.answers, {
    now: fixture.at,
    ...(fixture.timezone !== undefined ? { timezone: fixture.timezone } : {}),
  });
  if (!run.ok) {
    return { status: 'error', lines: [run.error, ...(run.detail !== undefined ? run.detail.split('\n') : [])] };
  }
  const built = { panel: run.panel, signals: run.signals };
  const clock = fixture.pinned
    ? []
    : ['Note: fixture.json names no "at", so anything worked out from the clock was worked out from now.'];
  if (fixture.expected === undefined) {
    return { status: 'unrecorded', lines: [...clock, 'No expected.json yet: run again with --update to record this.'], built };
  }
  const diff = differences({ panel: fixture.expected.panel, signals: fixture.expected.signals }, built);
  if (diff.length === 0) return { status: 'pass', lines: clock, built };
  const shown = diff.slice(0, 10);
  if (diff.length > 10) shown.push(`…and ${diff.length - 10} more`);
  return { status: 'fail', lines: [...clock, ...shown], built };
}

/** Write what a run built as the fixture's expected.json. */
export function recordFixture(dir: string, built: NonNullable<FixtureCheck['built']>): void {
  writeFileSync(join(dir, 'expected.json'), `${JSON.stringify(built, null, 2)}\n`);
}

/**
 * The starter a new recipe begins from: a recipe that uses a setting, a list
 * with `where`, `sort` and `limit`, a lookup that colours a row, and a fixture
 * that passes as written — so the first thing an author does is change
 * something and watch `test-recipe` say what moved.
 */
export const SCAFFOLD_RECIPE = {
  name: 'Next buses',
  contract: 1,
  config: [{ key: 'stop', label: 'Stop number', default: '1234' }],
  fetch: { url: 'https://api.example.com/stops/{stop}/departures', intervalSeconds: 300 },
  lookups: { words: { late: 'running late', on_time: 'on time', '*': 'due' } },
  panel: {
    kind: 'readings',
    title: '{stop_name}',
    items: {
      for: 'departures',
      label: '{route} to {destination}',
      value: '{minutes | plural:min,mins} · {status | map:words}',
      tone: { from: 'status', map: { late: 'alert', on_time: 'active' }, default: 'idle' },
      where: [{ path: 'cancelled', notEquals: true }],
      sort: { by: 'minutes', as: 'number' },
      limit: 3,
      empty: 'No more buses today',
    },
  },
} as const;

export const SCAFFOLD_ANSWER = {
  stop_name: 'High Street',
  departures: [
    { route: '12', destination: 'Station', minutes: 9, status: 'on_time', cancelled: false },
    { route: '7', destination: 'Hospital', minutes: 3, status: 'late', cancelled: false },
    { route: '12', destination: 'Station', minutes: 24, status: 'on_time', cancelled: true },
    { route: '31', destination: 'Park', minutes: 1, status: 'unknown', cancelled: false },
  ],
};

const SCAFFOLD_README = `# A recipe and its fixture

- \`recipe.json\` is the recipe, as you would paste it on Modules › Advanced › Build a recipe.
- \`answer.json\` is what its feed answered. Replace it with a real answer you saved.
- \`fixture.json\` pins the clock, so a time or a countdown reads the same every run.
- \`expected.json\` is what the recipe builds from the answer.

Check it, after any change to the recipe or the answer:

    node dist/tools/test-recipe.js <this directory>

Record what it builds now as the expected result:

    node dist/tools/test-recipe.js <this directory> --update

A named source's answer goes in \`sources/<name>.json\` (or \`.xml\`, \`.txt\`).
The recipe language is in docs/building-a-module.md.
`;

/** Write the starter into a directory that is new or empty, then record its expected result. */
export function scaffoldFixture(dir: string, at: number): { ok: true; files: string[] } | { ok: false; error: string } {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    return { ok: false, error: `${dir} is not empty, and a starter will not write over anything.` };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'recipe.json'), `${JSON.stringify(SCAFFOLD_RECIPE, null, 2)}\n`);
  writeFileSync(join(dir, 'answer.json'), `${JSON.stringify(SCAFFOLD_ANSWER, null, 2)}\n`);
  writeFileSync(join(dir, 'fixture.json'), `${JSON.stringify({ at: new Date(at).toISOString() }, null, 2)}\n`);
  writeFileSync(join(dir, 'README.md'), SCAFFOLD_README);
  const loaded = loadFixture(dir, at);
  if (!loaded.ok) return loaded;
  const check = checkFixture(loaded.fixture);
  if (check.built === undefined) return { ok: false, error: `The starter does not run: ${check.lines.join(' ')}` };
  recordFixture(dir, check.built);
  return { ok: true, files: ['recipe.json', 'answer.json', 'fixture.json', 'expected.json', 'README.md'] };
}
