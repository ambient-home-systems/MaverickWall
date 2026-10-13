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
import {
  recipeFetchHost,
  recipeSchema,
  requestKey,
  runRecipePanel,
  runRecipeSignals,
  type Recipe,
} from '../src/modules/external/recipe.js';

/**
 * A recipe's several fetches, and the rows it chooses (plan item M7.7).
 *
 * The schema is held at its edges, each refusal beside a shape it takes: a
 * filter or a sort that looks like an expression is refused by the selector's
 * own pattern, at parse. The choosing is held row by row. And the fetches are
 * held end to end — a real recipe polled by the real job through the real
 * fetcher at a loopback server, its panel built from two answers at once, and a
 * source that stops answering failing the read by name while the last good
 * panel stays.
 */

const base = {
  name: 'Trains',
  contract: 1,
  fetch: { url: 'https://example.com/departures' },
};
const parse = (extra: Record<string, unknown>): ReturnType<typeof recipeSchema.safeParse> =>
  recipeSchema.safeParse({ ...base, ...extra });
const takes = (extra: Record<string, unknown>): boolean => parse(extra).success;
const recipe = (extra: Record<string, unknown>): Recipe => {
  const parsed = parse(extra);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
};
const rows = (items: Record<string, unknown>) => ({
  panel: { kind: 'readings', items: { for: 'trains', label: '{to}', value: '{due}', ...items } },
});

describe('what a recipe may say about its rows', () => {
  it('takes conditions, a sort and a limit, and refuses any that looks like an expression', () => {
    expect(takes(rows({ where: ['live', { path: 'to', equals: 'Brighton' }, { path: 'late', above: 2 }] }))).toBe(true);
    expect(takes(rows({ where: [{ path: 'platform', notEquals: 3 }, { path: 'late', below: 10 }] }))).toBe(true);
    expect(takes(rows({ sort: { by: 'due', order: 'desc', as: 'time' }, limit: 5 }))).toBe(true);
    expect(takes(rows({ where: ['late > 3'] }))).toBe(false);
    expect(takes(rows({ where: [{ path: 'late * 2', above: 3 }] }))).toBe(false);
    expect(takes(rows({ sort: { by: 'a + b' } }))).toBe(false);
    expect(takes(rows({ sort: { by: 'due', order: 'sideways' } }))).toBe(false);
    // One comparison a condition, and only "all of them": no "or", nothing nested.
    expect(takes(rows({ where: [{ path: 'late', above: 2, below: 9 }] }))).toBe(false);
    expect(takes(rows({ where: [{ or: ['a', 'b'] }] }))).toBe(false);
    expect(takes(rows({ where: [] }))).toBe(false);
    expect(takes(rows({ where: ['a', 'b', 'c', 'd', 'e'] }))).toBe(false);
    expect(takes(rows({ limit: 0 }))).toBe(false);
    expect(takes(rows({ limit: 13 }))).toBe(false);
    // A timeline is always in time order, so it takes no sort of its own.
    const timeline = (items: Record<string, unknown>) => ({
      panel: { kind: 'timeline', items: { for: 'trains', at: '{at}', label: '{to}', ...items } },
    });
    expect(takes(timeline({ where: ['live'], limit: 3 }))).toBe(true);
    expect(takes(timeline({ sort: { by: 'at' } }))).toBe(false);
  });

  it('takes up to three named sources, checked as the main fetch is, and refuses a selector reaching for one it does not declare', () => {
    const sources = { status: { url: 'https://status.example.com/{line}', headers: { authorization: 'Bearer {secret:key}' } } };
    const config = [{ key: 'line', label: 'Line' }];
    const secrets = [{ key: 'key', label: 'Key' }];
    const panel = { kind: 'text', text: '{@status.summary} — {count}' };
    expect(takes({ sources, config, secrets, panel })).toBe(true);
    expect(takes({ sources, config, secrets, panel: { kind: 'text', text: '{@other.summary}' } })).toBe(false);
    expect(takes({ config, secrets, panel })).toBe(false);
    // Each source's address and headers are held to the main fetch's rules.
    expect(takes({ config, secrets, panel, sources: { status: { url: 'https://x.example.com/{nope}' } } })).toBe(false);
    expect(takes({ config, secrets, panel, sources: { status: { url: 'https://x.example.com/{secret:key}' } } })).toBe(false);
    expect(takes({ config, panel, sources: { status: { url: 'https://x.example.com', headers: { a: '{secret:key}' } } } })).toBe(false);
    const four = Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [n, { url: 'https://x.example.com' }]));
    expect(takes({ panel: { kind: 'text', text: 'x' }, sources: four })).toBe(false);
    const three = Object.fromEntries(['a', 'b', 'c'].map((n) => [n, { url: 'https://x.example.com' }]));
    expect(takes({ panel: { kind: 'text', text: 'x' }, sources: three })).toBe(true);
    expect(takes({ panel: { kind: 'text', text: 'x' }, sources: { Status: { url: 'https://x.example.com' } } })).toBe(false);
    // The install page names every host a setting or a secret goes to.
    expect(recipeFetchHost(recipe({ sources, config, secrets, panel }))).toBe('example.com and status.example.com');
  });
});

describe('the rows a recipe draws', () => {
  const body = {
    trains: [
      { to: 'Lewes', due: '08:31', late: 0, live: true, at: '2026-10-14T08:31:00+01:00' },
      { to: 'Brighton', due: '08:20', late: 4, live: true, at: '2026-10-14T08:20:00+01:00' },
      { to: 'London', due: '08:12', live: false, at: '2026-10-14T08:12:00+01:00' },
      { to: 'Hastings', due: '09:02', late: 12, live: true, at: '2026-10-14T09:02:00+01:00' },
      { to: 'Ore', due: '09:40', late: '2', live: '', at: '2026-10-14T09:40:00+01:00' },
    ],
  };
  const drawn = (items: Record<string, unknown>): string[] => {
    const out = runRecipePanel(recipe(rows(items)), body, Date.now());
    if (!out.ok) throw new Error(out.error);
    return (out.panel as { items: { label: string }[] }).items.map((row) => row.label);
  };

  it('keeps the rows every condition holds for', () => {
    expect(drawn({ where: ['live'] })).toEqual(['Lewes', 'Brighton', 'Hastings']);
    expect(drawn({ where: [{ path: 'to', equals: 'Brighton' }] })).toEqual(['Brighton']);
    expect(drawn({ where: [{ path: 'to', notEquals: 'Brighton' }] })).toEqual(['Lewes', 'London', 'Hastings', 'Ore']);
    // A number written as text compares as the number; a missing one fails every comparison.
    expect(drawn({ where: [{ path: 'late', above: 1 }] })).toEqual(['Brighton', 'Hastings', 'Ore']);
    expect(drawn({ where: [{ path: 'late', below: 5 }] })).toEqual(['Lewes', 'Brighton', 'Ore']);
    // All of them, never any of them.
    expect(drawn({ where: ['live', { path: 'late', above: 1 }] })).toEqual(['Brighton', 'Hastings']);
  });

  it('says so in words when its conditions leave no rows, rather than keeping the last ones', () => {
    const none = (extra: Record<string, unknown>) =>
      runRecipePanel(recipe(rows({ where: [{ path: 'to', equals: 'Nowhere' }], ...extra })), body, Date.now());
    expect(none({})).toEqual({ ok: true, panel: { kind: 'text', text: 'Nothing to show.' } });
    expect(none({ empty: 'No trains to {place}' })).toEqual({ ok: true, panel: { kind: 'text', text: 'No trains to ' } });
    // An empty array is an answer too; no array at all is a feed that changed shape, and is refused.
    expect(runRecipePanel(recipe(rows({})), { trains: [] }, Date.now())).toEqual({ ok: true, panel: { kind: 'text', text: 'Nothing to show.' } });
    expect(runRecipePanel(recipe(rows({})), { trains: 'gone' }, Date.now()).ok).toBe(false);
    expect(runRecipePanel(recipe(rows({ where: ['missing'], empty: 'All quiet' })), { ...body, place: 'x' }, Date.now())).toEqual({
      ok: true,
      panel: { kind: 'text', text: 'All quiet' },
    });
    const timeline = recipe({
      panel: { kind: 'timeline', title: 'Today', items: { for: 'trains', at: '{at}', label: '{to}', where: ['gone'], empty: 'Nothing today' } },
    });
    expect(runRecipePanel(timeline, body, Date.now())).toEqual({ ok: true, panel: { kind: 'text', title: 'Today', text: 'Nothing today' } });
  });

  it('puts them in order, with rows that have no value last whichever way it runs, and keeps ties in the source’s order', () => {
    expect(drawn({ sort: { by: 'late' } })).toEqual(['Lewes', 'Ore', 'Brighton', 'Hastings', 'London']);
    expect(drawn({ sort: { by: 'late', order: 'desc' } })).toEqual(['Hastings', 'Brighton', 'Ore', 'Lewes', 'London']);
    expect(drawn({ sort: { by: 'due' } })).toEqual(['London', 'Brighton', 'Lewes', 'Hastings', 'Ore']);
    expect(drawn({ sort: { by: 'to', order: 'desc' } })).toEqual(['Ore', 'London', 'Lewes', 'Hastings', 'Brighton']);
    expect(drawn({ sort: { by: 'at', as: 'time' } })).toEqual(['London', 'Brighton', 'Lewes', 'Hastings', 'Ore']);
  });

  it('takes the first so many after the order', () => {
    expect(drawn({ sort: { by: 'late', order: 'desc' }, limit: 2 })).toEqual(['Hastings', 'Brighton']);
    expect(drawn({ where: ['live'], limit: 1 })).toEqual(['Lewes']);
  });

  it('gives a timeline the next so many, in time order', () => {
    const timeline = recipe({
      panel: { kind: 'timeline', items: { for: 'trains', at: '{at}', label: '{to}', where: ['live'], limit: 2 } },
    });
    const out = runRecipePanel(timeline, body, Date.now());
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.panel as { items: { label: string }[] }).items.map((i) => i.label)).toEqual(['Brighton', 'Lewes']);
  });
});

describe('a recipe’s named sources', () => {
  it('are reached by @name, in a template, a row list and a signal', () => {
    const r = recipe({
      sources: { status: { url: 'https://status.example.com' } },
      panel: {
        kind: 'readings',
        title: '{@status.line}: {@status.summary}',
        items: { for: '@status.alerts', label: '{title}', value: '{@status.line}', where: [{ path: 'severity', above: 1 }] },
      },
      signals: [{ when: '@status.disrupted', key: 'line', title: '{@status.summary}' }],
    });
    const status = { line: 'Southern', summary: 'Minor delays', disrupted: true, alerts: [{ title: 'Signal fault', severity: 2 }, { title: 'Lift out', severity: 1 }] };
    expect(runRecipePanel(r, {}, Date.now(), { status })).toEqual({
      ok: true,
      panel: { kind: 'readings', title: 'Southern: Minor delays', items: [{ label: 'Signal fault', value: 'Southern' }] },
    });
    expect(runRecipeSignals(r, {}, Date.now(), { status })).toEqual({
      ok: true,
      signals: { signals: [{ key: 'line', title: 'Minor delays' }] },
    });
    expect(runRecipeSignals(r, {}, Date.now(), { status: { ...status, disrupted: false } })).toEqual({
      ok: true,
      signals: { signals: [] },
    });
  });

  it('are part of the request two widgets share, so settings that change a source are two fetches', () => {
    const r = recipe({
      config: [
        { key: 'line', label: 'Line' },
        { key: 'unused', label: 'Unused' },
      ],
      sources: { status: { url: 'https://status.example.com/{line}' } },
      panel: { kind: 'text', text: '{@status.summary}' },
    });
    expect(requestKey(r, { line: 'southern', unused: 'a' })).toBe(requestKey(r, { line: 'southern', unused: 'b' }));
    expect(requestKey(r, { line: 'southern', unused: 'a' })).not.toBe(requestKey(r, { line: 'thameslink', unused: 'a' }));
  });
});

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
});

describe('a recipe with sources, polled', () => {
  it('builds one panel from every answer, and a source that stops answering fails the read by name', async () => {
    const asked: string[] = [];
    let statusUp = true;
    const server = createServer((request, response) => {
      const path = request.url ?? '/';
      asked.push(path);
      response.setHeader('content-type', 'application/json');
      if (path === '/departures') {
        response.end(JSON.stringify({ trains: [{ to: 'Lewes', due: '08:31' }, { to: 'Brighton', due: '08:20' }] }));
      } else if (path === '/status/southern' && statusUp) {
        response.end(JSON.stringify({ summary: 'Good service' }));
      } else {
        response.statusCode = 503;
        response.end('{}');
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const host = `http://127.0.0.1:${address.port}`;

    const dataDir = mkdtempSync(join(tmpdir(), 'mw-recipe-sources-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const manifest = {
      name: 'Trains',
      contract: 1,
      config: [{ key: 'line', label: 'Line', default: 'southern' }],
      fetch: { url: `${host}/departures`, allowLan: true, intervalSeconds: 60 },
      sources: { status: { url: `${host}/status/{line}` } },
      panel: {
        kind: 'readings',
        title: '{@status.summary}',
        items: { for: 'trains', label: '{to}', value: '{due}', sort: { by: 'due' } },
      },
      signals: [{ when: '@status.summary', key: 'status', title: '{@status.summary}' }],
    };
    createRecipeModule(db, { id: 'trains', name: 'Trains', url: manifest.fetch.url, recipe: manifest, config: {} });
    const poll = (): Promise<void> => pollExternalModules(db, createFetcher(), createKeyring(randomBytes(32)));

    await poll();
    let row = readExternalModules(db)[0];
    expect(row?.lastError).toBeNull();
    expect(row?.panel).toEqual({
      kind: 'readings',
      title: 'Good service',
      items: [
        { label: 'Brighton', value: '08:20' },
        { label: 'Lewes', value: '08:31' },
      ],
    });
    expect(asked).toEqual(['/departures', '/status/southern']);
    // A signal reads a source too, on the same read.
    expect(row?.signals).toEqual({ signals: [{ key: 'status', title: 'Good service' }] });

    statusUp = false;
    db.prepare(`UPDATE external_modules SET last_polled_at = 0`).run();
    await poll();
    row = readExternalModules(db)[0];
    expect(row?.lastError).toBe('The recipe’s source “status” did not answer.');
    // The last good panel stays on the wall.
    expect((row?.panel as { title?: string } | undefined)?.title).toBe('Good service');
  });
});
