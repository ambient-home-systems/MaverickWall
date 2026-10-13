import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { pollExternalModules } from '../src/modules/external/index.js';
import { createRecipeModule, readExternalModules } from '../src/api/external-modules.js';
import { recipeSchema, runRecipePanel, runRecipeSignals, type Recipe } from '../src/modules/external/recipe.js';

/**
 * A recipe's lookup tables and its four new formatters (plan item M7.8).
 *
 * The schema is held at its edges: a lookup into a table the recipe does not
 * declare is a rejected recipe, and a tone map can name only the three tones.
 * Each formatter is held to the words it writes, and the clock time to the
 * household's own zone end to end — a real recipe polled by the real job,
 * through the real fetcher, at a loopback feed that speaks UTC.
 */

const base = { name: 'Plant', contract: 1, fetch: { url: 'https://example.com/plant' } };
const parse = (extra: Record<string, unknown>): ReturnType<typeof recipeSchema.safeParse> =>
  recipeSchema.safeParse({ ...base, ...extra });
const takes = (extra: Record<string, unknown>): boolean => parse(extra).success;
const recipe = (extra: Record<string, unknown>): Recipe => {
  const parsed = parse(extra);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
};
const NOW = Date.parse('2026-07-01T12:00:00Z');

/** The words one template writes against a body, in a zone. */
function says(template: string, body: unknown, extra: Record<string, unknown> = {}, timezone?: string): string {
  const built = runRecipePanel(recipe({ panel: { kind: 'text', text: template }, ...extra }), body, NOW, {}, timezone);
  if (!built.ok) throw new Error(built.error);
  return (built.panel as { text: string }).text;
}

const statusTable = { lookups: { status: { on: 'Running', off: 'Stopped' } } };

describe('what a recipe may say about its lookups', () => {
  it('takes tables it names, and refuses a lookup into one it does not declare', () => {
    expect(takes({ ...statusTable, panel: { kind: 'text', text: '{state | map:status}' } })).toBe(true);
    expect(takes({ panel: { kind: 'text', text: '{state | map:status}' } })).toBe(false);
    expect(takes({ ...statusTable, panel: { kind: 'text', text: '{state | map:colour}' } })).toBe(false);
    expect(takes({ ...statusTable, panel: { kind: 'text', text: '{state | map}' } })).toBe(false);
    // A signal's words are checked too.
    expect(
      takes({ panel: { kind: 'text', text: 'x' }, signals: [{ when: 'state', key: 'k', title: '{state | map:status}' }] }),
    ).toBe(false);
    expect(
      takes({ ...statusTable, panel: { kind: 'text', text: 'x' }, signals: [{ when: 'state', key: 'k', title: '{state | map:status}' }] }),
    ).toBe(true);
  });

  it('caps the tables, and a table holds words and never a template', () => {
    expect(takes({ lookups: { status: {} }, panel: { kind: 'text', text: 'x' } })).toBe(false);
    expect(takes({ lookups: { Status: { on: 'Running' } }, panel: { kind: 'text', text: 'x' } })).toBe(false);
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`t${i}`, { a: 'b' }]));
    expect(takes({ lookups: nine, panel: { kind: 'text', text: 'x' } })).toBe(false);
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v']));
    expect(takes({ lookups: { status: fifty }, panel: { kind: 'text', text: 'x' } })).toBe(true);
    expect(takes({ lookups: { status: { ...fifty, k50: 'v' } }, panel: { kind: 'text', text: 'x' } })).toBe(false);
    expect(takes({ lookups: { status: { on: 42 } }, panel: { kind: 'text', text: 'x' } })).toBe(false);
  });

  it('takes a tone map of the three tones only', () => {
    const rows = (tone: unknown) => ({
      panel: { kind: 'readings', items: { for: 'plants', label: '{name}', value: '{state}', tone } },
    });
    expect(takes(rows({ from: 'state', map: { on: 'active', fault: 'alert' }, default: 'idle' }))).toBe(true);
    expect(takes(rows({ from: 'state', map: { on: 'green' } }))).toBe(false);
    expect(takes(rows({ from: 'state', map: {} }))).toBe(false);
    expect(takes(rows({ from: 'state', map: { on: 'active' }, default: 'red' }))).toBe(false);
    expect(takes(rows({ from: 'state > 3', map: { on: 'active' } }))).toBe(false);
    expect(takes(rows({ from: 'state', map: { on: 'active' }, colour: 'red' }))).toBe(false);
    expect(
      takes({ panel: { kind: 'timeline', items: { for: 'jobs', at: '{at}', label: '{name}', tone: { from: 'state', map: { late: 'alert' } } } } }),
    ).toBe(true);
  });

  it('still refuses a formatter it does not know', () => {
    expect(takes({ panel: { kind: 'text', text: '{n | numbr:2}' } })).toBe(false);
    for (const name of ['number', 'duration', 'time', 'plural']) {
      expect(takes({ panel: { kind: 'text', text: `{n | ${name}}` } })).toBe(true);
    }
  });
});

describe('the formatters', () => {
  it('number groups thousands to the places asked', () => {
    expect(says('{n | number:2}', { n: 12345.6 })).toBe('12,345.60');
    expect(says('{n | number}', { n: '1234567.8' })).toBe('1,234,568');
    expect(says('{n | number:9}', { n: 1.5 })).toBe('1.500000');
    expect(says('{n | number:2}', { n: 'n/a' })).toBe('n/a');
  });

  it('duration says a length in the wall’s own words, from the unit the feed counts in', () => {
    expect(says('{n | duration}', { n: 45 })).toBe('45 s');
    expect(says('{n | duration:s}', { n: 754 })).toBe('12 min');
    expect(says('{n | duration:ms}', { n: 4_800_000 })).toBe('1 h 20 min');
    expect(says('{n | duration:min}', { n: 120 })).toBe('2 h');
    expect(says('{n | duration:h}', { n: 80 })).toBe('3 days');
    expect(says('{n | duration:s}', { n: -754 })).toBe('12 min');
    expect(says('{n | duration:fortnight}', { n: 45 })).toBe('45 s');
    expect(says('{n | duration}', { n: 'soon' })).toBe('soon');
  });

  it('time says the clock time in the household’s own zone', () => {
    const at = { at: '2026-07-01T13:05:00Z' };
    expect(says('{at | time:24}', at, {}, 'Europe/London')).toBe('14:05');
    expect(says('{at | time}', at, {}, 'Asia/Tokyo')).toBe('22:05');
    expect(says('{at | time:12}', at, {}, 'Europe/London')).toBe('2:05 pm');
    expect(says('{at | time}', at)).toBe('13:05');
    expect(says('{at | time}', { at: 1782911100 }, {}, 'Europe/London')).toBe('14:05');
    expect(says('{at | time}', at, {}, 'Not/AZone')).toBe('13:05');
    expect(says('{at | time}', { at: 'later' })).toBe('later');
  });

  it('plural writes a count with its noun', () => {
    expect(says('{n | plural:train}', { n: 1 })).toBe('1 train');
    expect(says('{n | plural:train}', { n: 3 })).toBe('3 trains');
    expect(says('{n | plural:train}', { n: 0 })).toBe('0 trains');
    expect(says('{n | plural:child,children}', { n: 2 })).toBe('2 children');
    expect(says('{n | plural:child,children}', { n: -1 })).toBe('-1 child');
    expect(says('{n | plural}', { n: 4 })).toBe('4');
    expect(says('{n | plural:train}', { n: 'many' })).toBe('many');
  });

  it('map turns a value into the recipe’s words, its * entry standing for one it does not name', () => {
    expect(says('{state | map:status}', { state: 'on' }, statusTable)).toBe('Running');
    expect(says('{state | map:status}', { state: 'off' }, statusTable)).toBe('Stopped');
    expect(says('{state | map:status}', { state: 'paused' }, statusTable)).toBe('paused');
    const withStar = { lookups: { status: { on: 'Running', '*': 'Unknown' } } };
    expect(says('{state | map:status}', { state: 'paused' }, withStar)).toBe('Unknown');
    // An inherited name is not an entry.
    expect(says('{state | map:status}', { state: 'toString' }, statusTable)).toBe('toString');
  });

  it('works in a signal’s words too', () => {
    const r = recipe({
      ...statusTable,
      panel: { kind: 'text', text: 'x' },
      signals: [{ when: 'state', key: 'k', title: 'Pump {state | map:status} since {at | time}' }],
    });
    const built = runRecipeSignals(r, { state: 'off', at: '2026-07-01T13:05:00Z' }, NOW, {}, 'Europe/London');
    expect(built).toEqual({ ok: true, signals: { signals: [{ key: 'k', title: 'Pump Stopped since 14:05' }] } });
  });
});

describe('a row’s tone, from its feed', () => {
  const plants = {
    plants: [
      { name: 'Pump', state: 'on' },
      { name: 'Boiler', state: 'fault' },
      { name: 'Fan', state: 'off' },
      { name: 'Valve', state: 'weird' },
    ],
  };
  it('looks the value up, falls back to the default, and gives a value neither names no tone', () => {
    const panel = (tone: Record<string, unknown>) => {
      const built = runRecipePanel(
        recipe({ panel: { kind: 'readings', items: { for: 'plants', label: '{name}', value: '{state}', tone } } }),
        plants,
        NOW,
      );
      if (!built.ok) throw new Error(built.error);
      return (built.panel as { items: { label: string; tone?: string }[] }).items.map((row) => [row.label, row.tone]);
    };
    expect(panel({ from: 'state', map: { on: 'active', fault: 'alert', off: 'idle' } })).toEqual([
      ['Pump', 'active'],
      ['Boiler', 'alert'],
      ['Fan', 'idle'],
      ['Valve', undefined],
    ]);
    expect(panel({ from: 'state', map: { fault: 'alert' }, default: 'idle' })).toEqual([
      ['Pump', 'idle'],
      ['Boiler', 'alert'],
      ['Fan', 'idle'],
      ['Valve', 'idle'],
    ]);
  });

  it('colours a tile and a timeline item the same way', () => {
    const tiles = runRecipePanel(
      recipe({ panel: { kind: 'tiles', items: { for: 'plants', label: '{name}', value: '{state}', tone: { from: 'state', map: { fault: 'alert' } } } } }),
      plants,
      NOW,
    );
    expect(tiles.ok && (tiles.panel as { items: { tone?: string }[] }).items.map((row) => row.tone)).toEqual([
      undefined,
      'alert',
      undefined,
      undefined,
    ]);
    const timeline = runRecipePanel(
      recipe({
        panel: {
          kind: 'timeline',
          items: { for: 'jobs', at: '{at}', label: '{name}', tone: { from: 'late', map: { true: 'alert' } } },
        },
      }),
      { jobs: [{ at: '2026-07-01T14:00:00Z', name: 'Bins', late: true }, { at: '2026-07-01T15:00:00Z', name: 'Post', late: false }] },
      NOW,
    );
    expect(timeline.ok && (timeline.panel as { items: { tone?: string }[] }).items.map((row) => row.tone)).toEqual([
      'alert',
      undefined,
    ]);
  });
});

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
});

describe('a recipe polled', () => {
  it('says a feed’s UTC time in the household’s zone, and colours its rows', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          plants: [
            { name: 'Pump', state: 'on', since: '2026-07-01T13:05:00Z', runtime: 5400 },
            { name: 'Boiler', state: 'fault', since: '2026-07-01T06:30:00Z', runtime: 60 },
          ],
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const dataDir = mkdtempSync(join(tmpdir(), 'mw-recipe-formatters-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const stamp = Date.now();
    db.prepare(`INSERT INTO household_settings (id, created_at, updated_at, timezone) VALUES ('singleton', ?, ?, ?)`).run(
      stamp,
      stamp,
      'Europe/London',
    );
    const manifest = {
      name: 'Plant',
      contract: 1,
      fetch: { url: `http://127.0.0.1:${address.port}/plant`, allowLan: true, intervalSeconds: 60 },
      lookups: { status: { on: 'Running', '*': 'Needs a look' } },
      panel: {
        kind: 'readings',
        items: {
          for: 'plants',
          label: '{name}',
          value: '{state | map:status} since {since | time} ({runtime | duration})',
          tone: { from: 'state', map: { on: 'active', fault: 'alert' } },
        },
      },
    };
    createRecipeModule(db, { id: 'plant', name: 'Plant', url: manifest.fetch.url, recipe: manifest, config: {} });
    await pollExternalModules(db, createFetcher(), createKeyring(randomBytes(32)));
    const row = readExternalModules(db)[0];
    expect(row?.lastError).toBeNull();
    expect(row?.panel).toEqual({
      kind: 'readings',
      items: [
        { label: 'Pump', value: 'Running since 14:05 (1 h 30 min)', tone: 'active' },
        { label: 'Boiler', value: 'Needs a look since 07:30 (1 min)', tone: 'alert' },
      ],
    });
  });
});
