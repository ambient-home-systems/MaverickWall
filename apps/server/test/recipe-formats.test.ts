import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { pollExternalModules } from '../src/modules/external/index.js';
import { createRecipeModule, readExternalModules, readModuleVariants } from '../src/api/external-modules.js';
import { readBody } from '../src/modules/external/source-formats.js';
import {
  houseBody,
  houseRequests,
  recipeFetchHost,
  recipeSchema,
  runRecipePanel,
  type Recipe,
} from '../src/modules/external/recipe.js';

/**
 * A recipe reading a news feed, any XML, and the house (plan item M7.9).
 *
 * The feeds are the real ones the news screen is tested on, captured unedited
 * (`fixtures/news/real/`), read both ways: as a feed, through the news
 * screen's own parser, and as a plain XML document. The house source is held
 * to values: it is built from a setting the household chose, and no entity id
 * reaches the body, the stored panel or a request. And the whole of it is held
 * end to end — the real job and the real fetcher at a loopback server serving
 * the feed under its own content type.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const real = (name: string): string => readFileSync(join(HERE, 'fixtures', 'news', 'real', name), 'utf8');

const base = { name: 'Reader', contract: 1, fetch: { url: 'https://example.com/feed' } };
const parse = (extra: Record<string, unknown>): ReturnType<typeof recipeSchema.safeParse> =>
  recipeSchema.safeParse({ ...base, ...extra });
const takes = (extra: Record<string, unknown>): boolean => parse(extra).success;
const recipe = (extra: Record<string, unknown>): Recipe => {
  const parsed = parse(extra);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
};
const body = (format: 'json' | 'feed' | 'xml', text: string): unknown => {
  const read = readBody(format, text);
  if (!read.ok) throw new Error(read.why);
  return read.body;
};
const labels = (r: Recipe, data: unknown, sources: Record<string, unknown> = {}): string[] => {
  const out = runRecipePanel(r, data, Date.now(), sources);
  if (!out.ok) throw new Error(out.error);
  return (out.panel as { items: { label: string }[] }).items.map((row) => row.label);
};

describe('what a recipe may say about its sources', () => {
  it('names what each address answers with, from three, and JSON when it says nothing', () => {
    const text = { panel: { kind: 'text', text: '{title}' } };
    expect(recipe(text).fetch.format).toBe('json');
    for (const format of ['json', 'feed', 'xml']) {
      expect(takes({ ...text, fetch: { ...base.fetch, format } })).toBe(true);
      expect(takes({ ...text, sources: { more: { url: 'https://x.example.com', format } } })).toBe(true);
    }
    expect(takes({ ...text, fetch: { ...base.fetch, format: 'html' } })).toBe(false);
    expect(takes({ ...text, sources: { more: { url: 'https://x.example.com', format: 'csv' } } })).toBe(false);
  });

  it('takes the house as a source naming its own reading settings, and nothing else', () => {
    const config = [
      { key: 'inside', label: 'Inside', type: 'ha_reading' },
      { key: 'outside', label: 'Outside', type: 'ha_reading' },
      { key: 'city', label: 'City' },
    ];
    const panel = { kind: 'text', text: '{@house[0].state}' };
    expect(takes({ config, panel, sources: { house: { ha: ['inside', 'outside'] } } })).toBe(true);
    // A setting that is not a reading, one the recipe does not declare, or an
    // entity typed in: the recipe would be choosing which of the house's things to read.
    expect(takes({ config, panel, sources: { house: { ha: ['city'] } } })).toBe(false);
    expect(takes({ config, panel, sources: { house: { ha: ['loft'] } } })).toBe(false);
    expect(takes({ config, panel, sources: { house: { ha: ['sensor.inside'] } } })).toBe(false);
    expect(takes({ config, panel, sources: { house: { ha: [] } } })).toBe(false);
    const nine = Array.from({ length: 9 }, () => 'inside');
    expect(takes({ config, panel, sources: { house: { ha: nine } } })).toBe(false);
    // A house source is the house and not an address: it carries neither.
    expect(takes({ config, panel, sources: { house: { ha: ['inside'], url: 'https://x.example.com' } } })).toBe(false);
    // And it asks no host, so the install page names none for it.
    expect(recipeFetchHost(recipe({ config, panel, sources: { house: { ha: ['inside'] } } }))).toBe('example.com');
  });
});

describe('a feed, read as a feed', () => {
  it('is the same shape whatever the feed is written in', () => {
    for (const file of ['bbc-news.rss.xml', 'github-releases.atom.xml', 'slashdot.rdf.xml']) {
      const feed = body('feed', real(file)) as { title?: string; items: { id: string; title: string; link?: string; published?: string }[] };
      expect(feed.items.length).toBeGreaterThan(3);
      for (const item of feed.items) {
        expect(item.title).not.toBe('');
        if (item.published !== undefined) expect(new Date(item.published).toISOString()).toBe(item.published);
      }
    }
    const bbc = body('feed', real('bbc-news.rss.xml')) as { title: string; items: { title: string; link: string }[] };
    expect(bbc.title).toBe('BBC News');
    expect(bbc.items[0]?.title).toBe('Watch: At the scene of student protests in Lille');
    expect(bbc.items[0]?.link).toContain('https://www.bbc.co.uk/news/videos/cwzd650e2jqdo');
    const releases = body('feed', real('github-releases.atom.xml')) as { items: { title: string; published: string }[] };
    expect(releases.items[0]).toMatchObject({ title: 'v0.84.0', published: '2026-10-06T18:16:04.000Z' });
  });

  it('with nothing in it is an empty list, and a web page is no feed', () => {
    const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>Quiet</title></channel></rss>';
    expect(body('feed', empty)).toEqual({ items: [] });
    const r = recipe({ panel: { kind: 'readings', items: { for: 'items', label: '{title}', value: '{link}', empty: 'No news' } } });
    expect(runRecipePanel(r, body('feed', empty), Date.now())).toEqual({ ok: true, panel: { kind: 'text', text: 'No news' } });
    expect(readBody('feed', '<!doctype html><html><body>Hello</body></html>').ok).toBe(false);
    expect(readBody('json', '<rss/>').ok).toBe(false);
  });
});

describe('any XML, read as a tree', () => {
  it('reaches an element by its name, its text plainly, and a repeated one as a list', () => {
    const tree = body('xml', real('bbc-news.rss.xml')) as {
      rss: { channel: { title: string; item: { title: string; guid: { _attr: { isPermaLink: string }; _text: string } }[] } };
    };
    expect(tree.rss.channel.title).toBe('BBC News');
    expect(Array.isArray(tree.rss.channel.item)).toBe(true);
    expect(tree.rss.channel.item[0]?.title).toBe('Watch: At the scene of student protests in Lille');
    expect(tree.rss.channel.item[0]?.guid._attr.isPermaLink).toBe('false');
    // A namespace's declaration is not an attribute anybody reads; a prefixed name keeps a selector's characters.
    const atom = body('xml', real('github-releases.atom.xml')) as {
      feed: { _attr: Record<string, string>; link: { _attr: { rel: string; href: string } }[] };
    };
    expect(atom.feed._attr).toEqual({ xml_lang: 'en-US' });
    expect(atom.feed.link.map((link) => link._attr.rel)).toEqual(['alternate', 'self']);
    const r = recipe({ panel: { kind: 'readings', items: { for: 'rss.channel.item', label: '{title | truncate:60}', value: '{guid._attr.isPermaLink}', limit: 2 } } });
    expect(labels(r, tree)).toEqual(['Watch: At the scene of student protests in Lille', expect.any(String)]);
  });

  it('reads one element where a list is asked for as a list of one, and JSON still not', () => {
    const one = body('xml', '<bins><next><kind>Recycling</kind><day>Tuesday</day></next></bins>');
    const r = recipe({ panel: { kind: 'readings', items: { for: 'bins.next', label: '{kind}', value: '{day}' } } });
    expect(labels(r, one)).toEqual(['Recycling']);
    const two = body('xml', '<bins><next><kind>Recycling</kind></next><next><kind>Garden</kind></next></bins>');
    expect(labels(r, two)).toEqual(['Recycling', 'Garden']);
    // The same shape as JSON is a feed that changed shape, as it has always been.
    expect(runRecipePanel(r, { bins: { next: { kind: 'Recycling', day: 'Tuesday' } } }, Date.now()).ok).toBe(false);
  });

  it('refuses a DTD, and an element named for a prototype is only a name', () => {
    expect(readBody('xml', '<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>').ok).toBe(false);
    expect(readBody('xml', '<x><y>').ok).toBe(false);
    const odd = body('xml', '<x><__proto__><polluted>yes</polluted></__proto__><constructor>c</constructor></x>') as {
      x: Record<string, unknown>;
    };
    expect(Object.keys(odd.x)).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(odd.x)).toBeNull();
  });
});

describe('the house, as a source', () => {
  const r = recipe({
    config: [
      { key: 'inside', label: 'Inside', type: 'ha_reading' },
      { key: 'loft', label: 'Loft', type: 'ha_reading' },
      { key: 'outside', label: 'Outside', type: 'ha_reading' },
    ],
    sources: { house: { ha: ['inside', 'loft', 'outside'] } },
    panel: { kind: 'readings', items: { for: '@house', label: '{name}', value: '{state} {unit}', where: ['state'] } },
  });

  it('is what the house said about each reading the settings chose, in their order, and never which entity', () => {
    const [house] = houseRequests(r, { inside: 'sensor.inside_temp', loft: '', outside: 'sensor.gone' });
    expect(house).toEqual({
      name: 'house',
      readings: [
        { key: 'inside', entityId: 'sensor.inside_temp' },
        { key: 'loft', entityId: '' },
        { key: 'outside', entityId: 'sensor.gone' },
      ],
    });
    const asked: string[] = [];
    const rows = houseBody(house!, (entity) => {
      asked.push(entity);
      return entity === 'sensor.inside_temp' ? { name: 'Living room', state: '21.5', unit: '°C' } : undefined;
    });
    // A setting left empty asks the house nothing.
    expect(asked).toEqual(['sensor.inside_temp', 'sensor.gone']);
    expect(rows).toEqual([{ key: 'inside', name: 'Living room', state: '21.5', unit: '°C' }, { key: 'loft' }, { key: 'outside' }]);
    expect(JSON.stringify(rows)).not.toContain('sensor.');
    expect(labels(r, {}, { house: rows })).toEqual(['Living room']);
  });
});

const MIGRATIONS = join(HERE, '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
});

describe('a recipe reading a feed, a document and the house, polled', () => {
  it('builds its panel from all three, and two widgets on different readings are two reads', async () => {
    const asked: string[] = [];
    const server = createServer((request, response) => {
      const path = request.url ?? '/';
      asked.push(path);
      if (path === '/news') {
        // A feed is served under its own type, not JSON's.
        response.setHeader('content-type', 'application/rss+xml; charset=utf-8');
        response.end(real('bbc-news.rss.xml'));
      } else if (path === '/bins') {
        response.setHeader('content-type', 'text/xml');
        response.end('<?xml version="1.0"?><council><next date="2026-10-14"><kind>Recycling</kind></next></council>');
      } else {
        response.statusCode = 404;
        response.end('');
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const host = `http://127.0.0.1:${address.port}`;

    const dataDir = mkdtempSync(join(tmpdir(), 'mw-recipe-formats-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const stamp = Date.now();
    db.prepare(
      `INSERT INTO ha_entity_cache (entity_id, friendly_name, label, state, unit_of_measurement, watched, fetched_at)
       VALUES ('sensor.kitchen_temp', 'Kitchen sensor', 'Kitchen', '20.0', '°C', 1, ?),
              ('sensor.hall_temp', 'Hall', NULL, '20.0', '°C', 1, ?),
              ('sensor.secret_temp', 'Not watched', NULL, '99', '°C', 0, ?)`,
    ).run(stamp, stamp, stamp);

    const manifest = {
      name: 'Morning',
      contract: 1,
      config: [{ key: 'room', label: 'Room', type: 'ha_reading' }],
      fetch: { url: `${host}/news`, allowLan: true, intervalSeconds: 60, format: 'feed' },
      sources: { bins: { url: `${host}/bins`, format: 'xml' }, house: { ha: ['room'] } },
      panel: {
        kind: 'readings',
        title: '{@bins.council.next.kind} on {@bins.council.next._attr.date} · {@house[0].name} {@house[0].state}{@house[0].unit}',
        items: { for: 'items', label: '{title | truncate:60}', value: '{published | date:short}', limit: 2 },
      },
    };
    createRecipeModule(db, { id: 'morning', name: 'Morning', url: manifest.fetch.url, recipe: manifest, config: { room: 'sensor.kitchen_temp' } });

    // Two widgets on readings that say the same thing are two reads all the same.
    const token = issueDisplayToken();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
       VALUES ('kitchen', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
    ).run(token.tokenHash, stamp, stamp, stamp);
    const place = (id: string, z: number, room: string): void => {
      db.prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, 'kitchen', 'portrait', 'external', 0, ?, 1, 0.25, ?, ?, ?, ?)`,
      ).run(id, z * 0.25, z, JSON.stringify({ module: 'morning', settings: { room } }), stamp, stamp);
    };
    place('a', 0, 'sensor.hall_temp');
    place('b', 1, 'sensor.secret_temp');

    await pollExternalModules(db, createFetcher(), createKeyring(randomBytes(32)));

    const row = readExternalModules(db)[0];
    expect(row?.lastError).toBeNull();
    const panel = row?.panel as { title: string; items: { label: string; value: string }[] };
    expect(panel.title).toBe('Recycling on 2026-10-14 · Kitchen 20.0°C');
    expect(panel.items.map((item) => item.label)).toEqual([
      'Watch: At the scene of student protests in Lille',
      expect.any(String),
    ]);
    expect(panel.items[0]?.value).not.toBe('');

    const variants = readModuleVariants(db, 'morning').map((variant) => (variant.panel as { title: string }).title).sort();
    expect(variants).toEqual(['Recycling on 2026-10-14 ·  ', 'Recycling on 2026-10-14 · Hall 20.0°C']);

    // The house costs no request, and no entity id goes anywhere it could be read.
    expect(asked.filter((path) => path === '/news')).toHaveLength(3);
    expect(asked.every((path) => path === '/news' || path === '/bins')).toBe(true);
    const stored = JSON.stringify([row?.panel, readModuleVariants(db, 'morning').map((variant) => variant.panel)]);
    expect(stored).not.toContain('sensor.');
    expect(stored).not.toContain('99');
  });

  it('says which source did not read, in the household’s words', async () => {
    const server = createServer((request, response) => {
      // The same page twice: under its own type, and mislabelled as JSON.
      response.setHeader('content-type', request.url === '/json' ? 'application/json' : 'text/html');
      response.end('<!doctype html><html><body>Our news</body></html>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const host = `http://127.0.0.1:${address.port}`;
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-recipe-formats-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const manifest = {
      name: 'News',
      contract: 1,
      fetch: { url: `${host}/json`, allowLan: true, format: 'xml' },
      sources: { news: { url: `${host}/page`, format: 'feed' } },
      panel: { kind: 'text', text: '{@news.title}' },
    };
    createRecipeModule(db, { id: 'news', name: 'News', url: manifest.fetch.url, recipe: manifest, config: {} });
    await pollExternalModules(db, createFetcher(), createKeyring(randomBytes(32)));
    // A web page is not XML a recipe can read: the main fetch fails first, by its own words.
    expect(readExternalModules(db)[0]?.lastError).toBe('The recipe’s source did not return XML a recipe can read.');
    db.prepare(`UPDATE external_modules SET recipe = ?, last_polled_at = 0`).run(
      JSON.stringify({ ...manifest, fetch: { ...manifest.fetch, format: 'json' } }),
    );
    await pollExternalModules(db, createFetcher(), createKeyring(randomBytes(32)));
    expect(readExternalModules(db)[0]?.lastError).toBe('The recipe’s source did not return JSON.');
  });
});
