import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { differences, readRecipe, runRecipeOnAnswers } from '../src/modules/external/recipe-tooling.js';
import { PREVIEW_BOXES } from '../src/http/admin-modules.js';
import {
  SCAFFOLD_ANSWER,
  checkFixture,
  loadFixture,
  recordFixture,
  scaffoldFixture,
} from '../src/modules/external/recipe-fixture.js';

/**
 * The recipe tooling's harness, fixtures and commands (plan item M7.10).
 *
 * The commands are run as the built files a household or an author runs, so a
 * fixture's exit code is the one a script or a CI step would read.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, '..', 'dist', 'tools');
const AT = Date.parse('2026-10-14T08:00:00Z');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mw-recipe-tooling-'));
  roots.push(dir);
  return dir;
};

const RECIPE = {
  name: 'Pairs',
  contract: 1,
  fetch: { url: 'https://api.example.com/pairs' },
  sources: { news: { url: 'https://api.example.com/news', format: 'feed' } },
  panel: {
    kind: 'readings',
    title: '{@news.title}',
    items: { for: 'pairs', label: '{name}', value: '{value}' },
  },
  signals: [{ when: 'alarm', key: 'alarm', title: 'The alarm says {alarm}' }],
};
const RSS = '<rss version="2.0"><channel><title>Village news</title><item><title>Fete</title></item></channel></rss>';

const run = (main: unknown, sources: Record<string, string> = { news: RSS }): ReturnType<typeof runRecipeOnAnswers> => {
  const read = readRecipe(JSON.stringify(RECIPE));
  if (!read.ok) throw new Error(read.error);
  return runRecipeOnAnswers(read.recipe, { main: JSON.stringify(main), sources }, { now: AT });
};

describe('running a recipe on answers in hand', () => {
  it('builds the panel and the signals the poll would, from text', () => {
    const outcome = run({ pairs: [{ name: 'Gate', value: 'Shut' }], alarm: 'on' });
    expect(outcome).toEqual({
      ok: true,
      recipe: expect.any(Object),
      panel: { kind: 'readings', title: 'Village news', items: [{ label: 'Gate', value: 'Shut' }] },
      signals: [{ key: 'alarm', title: 'The alarm says on' }],
    });
  });

  it('names the step that stopped it', () => {
    expect(readRecipe('{ "name": ')).toEqual({ ok: false, error: 'That recipe is not valid JSON.' });
    const bad = readRecipe(JSON.stringify({ ...RECIPE, contract: 2 }));
    expect(bad.ok === false && bad.error).toMatch(/^This recipe is not valid — contract: /);

    const read = readRecipe(JSON.stringify(RECIPE));
    if (!read.ok) throw new Error(read.error);
    expect(runRecipeOnAnswers(read.recipe, { main: 'not json', sources: { news: RSS } }, { now: AT })).toEqual({
      ok: false,
      stage: 'answer',
      error: 'The main answer did not return JSON.',
    });
    expect(runRecipeOnAnswers(read.recipe, { main: '{}' }, { now: AT })).toEqual({
      ok: false,
      stage: 'answer',
      error: 'There is no answer for the source “news”.',
    });
    expect(run({ pairs: [] }, { news: '<html><body>not a feed</body></html>' })).toEqual({
      ok: false,
      stage: 'answer',
      error: 'The answer for the source “news” did not return a feed.',
    });
  });

  it('says where in the panel the wall’s schema refused it, and never what the feed said', () => {
    const long = 'A label well over the sixty characters a row’s label may have, said once';
    const outcome = run({ pairs: [{ name: 'Gate', value: 'Shut' }, { name: long, value: 'Open' }] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe('panel');
    expect(outcome.error).toBe('The recipe produced something the wall cannot draw.');
    expect(outcome.detail).toMatch(/^panel\.items\.1\.label: /);
    expect(outcome.detail).not.toContain('sixty characters');
  });

  it('reads the main answer in the recipe’s own format', () => {
    const recipe = readRecipe(
      JSON.stringify({
        name: 'News',
        contract: 1,
        fetch: { url: 'https://news.example.com/rss', format: 'feed' },
        panel: { kind: 'text', text: '{title}: {items[0].title}' },
      }),
    );
    if (!recipe.ok) throw new Error(recipe.error);
    const built = runRecipeOnAnswers(recipe.recipe, { main: RSS }, { now: AT });
    expect(built.ok && built.panel).toEqual({ kind: 'text', text: 'Village news: Fete' });
  });

  it('reads a house source’s answer as the list of readings it would be', () => {
    const recipe = readRecipe(
      JSON.stringify({
        name: 'Room',
        contract: 1,
        config: [{ key: 'room', label: 'Room', type: 'ha_reading' }],
        fetch: { url: 'https://api.example.com/x' },
        sources: { house: { ha: ['room'] } },
        panel: { kind: 'text', text: '{@house[0].name} {@house[0].state}' },
      }),
    );
    if (!recipe.ok) throw new Error(recipe.error);
    const answers = (house: string): ReturnType<typeof runRecipeOnAnswers> =>
      runRecipeOnAnswers(recipe.recipe, { main: '{}', sources: { house } }, { now: AT });
    const built = answers('[{ "key": "room", "name": "Kitchen", "state": "21" }]');
    expect(built.ok && built.panel).toEqual({ kind: 'text', text: 'Kitchen 21' });
    expect(answers('{ "key": "room" }')).toEqual({
      ok: false,
      stage: 'answer',
      error: 'The answer for the house source “house” is not a JSON list of readings.',
    });
  });

  it('lists the places two results differ, with both values', () => {
    expect(differences({ a: [1, 2], b: 'x' }, { a: [1, 2], b: 'x' })).toEqual([]);
    expect(differences({ a: [1, 2], b: 'x' }, { a: [1, 3], c: true })).toEqual([
      'a.1: expected 2, got 3',
      'b: expected "x", got (nothing)',
      'c: expected (nothing), got true',
    ]);
  });
});

describe('a fixture directory', () => {
  it('starts from a starter that passes as written, and fails on the first change', () => {
    const dir = join(scratch(), 'buses');
    const made = scaffoldFixture(dir, AT);
    expect(made).toEqual({ ok: true, files: ['recipe.json', 'answer.json', 'fixture.json', 'expected.json', 'README.md'] });
    // The starter's own recipe is one the add form takes.
    expect(readRecipe(readFileSync(join(dir, 'recipe.json'), 'utf8')).ok).toBe(true);
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { panel: { items: unknown[] } };
    // Sorted, limited and with the cancelled bus left out.
    expect(expected.panel.items).toEqual([
      { label: '31 to Park', value: '1 min · due', tone: 'idle' },
      { label: '7 to Hospital', value: '3 mins · running late', tone: 'alert' },
      { label: '12 to Station', value: '9 mins · on time', tone: 'active' },
    ]);

    const loaded = loadFixture(dir, Date.now());
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.fixture.pinned).toBe(true);
    expect(loaded.fixture.at).toBe(AT);
    expect(checkFixture(loaded.fixture).status).toBe('pass');

    const changed = { ...SCAFFOLD_ANSWER, stop_name: 'Market Square' };
    writeFileSync(join(dir, 'answer.json'), JSON.stringify(changed));
    const reloaded = loadFixture(dir, Date.now());
    if (!reloaded.ok) throw new Error(reloaded.error);
    const check = checkFixture(reloaded.fixture);
    expect(check.status).toBe('fail');
    expect(check.lines).toEqual(['panel.title: expected "High Street", got "Market Square"']);

    // Recording it makes the change the expected result.
    if (check.built === undefined) throw new Error('nothing built');
    recordFixture(dir, check.built);
    const again = loadFixture(dir, Date.now());
    expect(again.ok && checkFixture(again.fixture).status).toBe('pass');

    expect(scaffoldFixture(dir, AT)).toEqual({
      ok: false,
      error: `${dir} is not empty, and a starter will not write over anything.`,
    });
  });

  it('says which file is missing or wrong, and when the clock was not pinned', () => {
    const dir = scratch();
    expect(loadFixture(dir, AT)).toEqual({ ok: false, error: `There is no recipe.json in ${dir}.` });
    writeFileSync(join(dir, 'recipe.json'), JSON.stringify(RECIPE));
    expect(loadFixture(dir, AT)).toEqual({ ok: false, error: `There is no answer.json, answer.xml or answer.txt in ${dir}.` });
    writeFileSync(join(dir, 'answer.json'), JSON.stringify({ pairs: [{ name: 'Gate', value: 'Shut' }] }));
    writeFileSync(join(dir, 'answer.xml'), '<x/>');
    expect(loadFixture(dir, AT)).toEqual({
      ok: false,
      error: `There is more than one answer file in ${dir}: answer.json, answer.xml.`,
    });
    rmSync(join(dir, 'answer.xml'));
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ at: 'tomorrow' }));
    const refused = loadFixture(dir, AT);
    expect(refused.ok === false && refused.error).toMatch(/^fixture\.json is not valid — at: /);
    rmSync(join(dir, 'fixture.json'));

    // The source's answer is read from sources/, by name.
    const missing = loadFixture(dir, AT);
    if (!missing.ok) throw new Error(missing.error);
    expect(checkFixture(missing.fixture)).toEqual({ status: 'error', lines: ['There is no answer for the source “news”.'] });
    mkdirSync(join(dir, 'sources'));
    writeFileSync(join(dir, 'sources', 'news.xml'), RSS);
    const loaded = loadFixture(dir, AT);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.fixture.pinned).toBe(false);
    const check = checkFixture(loaded.fixture);
    expect(check.status).toBe('unrecorded');
    expect(check.lines[0]).toMatch(/names no "at"/);
  });
});

describe('the commands', () => {
  const node = (tool: string, ...args: string[]): { status: number | null; out: string } => {
    const result = spawnSync(process.execPath, [join(TOOLS, tool), ...args], { encoding: 'utf8' });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };

  it('new-recipe writes a starter test-recipe passes, and test-recipe fails a changed one', () => {
    const dir = join(scratch(), 'starter');
    const made = node('new-recipe.js', dir);
    expect(made.status).toBe(0);
    expect(made.out).toContain('Wrote recipe.json, answer.json, fixture.json, expected.json, README.md');
    expect(node('new-recipe.js', dir).status).toBe(1);

    const passed = node('test-recipe.js', dir);
    expect(passed).toEqual({ status: 0, out: `PASS   ${dir}\n` });

    writeFileSync(join(dir, 'answer.json'), JSON.stringify({ ...SCAFFOLD_ANSWER, departures: [] }));
    const failed = node('test-recipe.js', dir);
    expect(failed.status).toBe(1);
    expect(failed.out).toContain(`FAIL   ${dir}`);
    expect(failed.out).toContain('panel.kind: expected "readings", got "text"');

    const saved = node('test-recipe.js', dir, '--update');
    expect(saved.status).toBe(0);
    expect(saved.out).toContain('"text": "No more buses today"');
    expect(node('test-recipe.js', dir).status).toBe(0);
  });

  it('says how it is used when it is asked wrongly', () => {
    expect(node('test-recipe.js').status).toBe(2);
    expect(node('test-recipe.js', '--verbose').out).toContain('There is no option --verbose.');
    expect(node('new-recipe.js').status).toBe(2);
  });
});

describe('the preview’s boxes', () => {
  it('are the same two on the page and in the script that draws them', () => {
    // The display bundle cannot be imported here, so its table is read as text.
    const source = readFileSync(join(HERE, '..', '..', 'display', 'src', 'recipe-preview.ts'), 'utf8');
    const drawn = Array.from(
      source.matchAll(
        /\{ key: '(\w+)', aspect: (\d+) \/ (\d+), box: \{ x: [\d.]+, y: [\d.]+, w: ([\d.]+), h: ([\d.]+) \} \}/g,
      ),
    ).map((match) => ({
      key: match[1],
      ratio: (Number(match[4]) * (Number(match[2]) / Number(match[3]))) / Number(match[5]),
    }));
    expect(drawn.map((box) => box.key)).toEqual(PREVIEW_BOXES.map((box) => box.key));
    for (const [index, box] of PREVIEW_BOXES.entries()) expect(box.ratio).toBeCloseTo(drawn[index]?.ratio ?? 0, 6);
  });
});
