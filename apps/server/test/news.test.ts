import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring, type Keyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import type { Manifest } from '../src/api/manifest.js';
import { networkAccessLabel } from '../src/http/html.js';
import { NEWS_REFRESH_MS, newsHeadlines, syncNewsFeeds } from '../src/modules/news/index.js';

/**
 * News feeds (plan item M5.5) against the real app, a real database, the real
 * SSRF-guarded fetcher and a real HTTP server on loopback serving real feeds
 * captured from BBC News and NPR.
 *
 * What is held here is the path a feed's address takes and the paths it
 * never takes: it is read before it is stored, it is sealed when it is, the
 * admin shows its host and never its path, a log line names the host and
 * nothing else, and the wall is handed headlines and links but no address. And
 * a feed that fails keeps the headlines it had.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const FIXTURES = join(HERE, 'fixtures', 'news', 'real');
const roots: string[] = [];
const servers: Server[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

interface Site {
  base: string;
  /** What each path answers: a fixture's bytes, or a status. */
  readonly routes: Map<string, { status: number; body?: string; type?: string }>;
  readonly requests: { path: string; ifNoneMatch: string | undefined }[];
}

/** A news site: answers each path as it is told, with an ETag a re-read can send back. */
async function site(): Promise<Site> {
  const state: Site = { base: '', routes: new Map(), requests: [] };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '';
    const ifNoneMatch = request.headers['if-none-match'] as string | undefined;
    state.requests.push({ path, ifNoneMatch });
    const route = state.routes.get(path);
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not here');
      return;
    }
    const etag = `"${route.body === undefined ? 0 : route.body.length}"`;
    if (route.status === 200 && ifNoneMatch === etag) {
      response.writeHead(304, { etag });
      response.end();
      return;
    }
    response.writeHead(route.status, { 'content-type': route.type ?? 'application/rss+xml; charset=utf-8', etag });
    response.end(route.body ?? '');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  state.base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return state;
}

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly get: (path: string) => Promise<Response>;
  readonly manifest: () => Promise<{ body: Manifest; text: string }>;
  readonly place: (config: Record<string, unknown>) => void;
}

async function harness(): Promise<Harness> {
  const address = `10.23.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-news-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const setupToken = createSetupTokenHolder(() => {});
  const keyring = createKeyring(randomBytes(32));
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'n'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });
  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: `news${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('wall', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);
  return {
    db,
    keyring,
    form,
    get: (path) => call(path),
    manifest: async () => {
      const response = await app.fetch(
        new Request('http://localhost/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } }),
      );
      const text = await response.text();
      return { body: JSON.parse(text) as Manifest, text };
    },
    // A clock beside it, because a canvas whose every widget is left out
    // draws them all anyway (rule nine) and could not show the omission.
    place: (config) => {
      db.prepare(`DELETE FROM layout_widgets WHERE screen_id = 'wall'`).run();
      db.prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES ('w-news', 'wall', 'portrait', 'news', 0, 0, 1, 0.5, 0, ?, ?, ?),
                ('w-clock', 'wall', 'portrait', 'clock', 0, 0.5, 1, 0.5, 0, '{}', ?, ?)`,
      ).run(JSON.stringify(config), stamp, stamp, stamp, stamp);
    },
  };
}

const FEED_PATH = '/private/feeds/abcdef123456/bbc.xml';

describe('adding a feed', () => {
  it('reads it first, seals its address, and shows its host and never its path', async () => {
    const news = await site();
    news.routes.set(FEED_PATH, { status: 200, body: fixture('bbc-news.rss.xml') });
    const h = await harness();
    const url = `${news.base}${FEED_PATH}`;
    const added = await h.form('/admin/news', { url, allow_lan: 'on', allow_http: 'on' });
    expect(added.status).toBe(302);
    expect(added.headers.get('location')).toContain('saved=news-feed-added');
    const row = h.db.prepare('SELECT * FROM news_feeds').get() as Record<string, unknown>;
    // Named after the feed itself when the household gives it no name.
    expect(row['name']).toBe('BBC News');
    // Sealed: the stored column holds neither the address nor its path.
    expect(JSON.stringify(row)).not.toContain('abcdef123456');
    const page = await (await h.get('/admin/news')).text();
    expect(page).toContain('BBC News');
    expect(page).toContain(new URL(news.base).host);
    expect(page).not.toContain('abcdef123456');
    expect(page).toContain('30 headlines');
  });

  it('says why a feed was not added, on the add page, with what was typed', async () => {
    const news = await site();
    news.routes.set('/home', {
      status: 200,
      body: '<!DOCTYPE html><html><body>Welcome</body></html>',
      type: 'text/html',
    });
    const h = await harness();
    const page = async (fields: Record<string, string>): Promise<string> => {
      const response = await h.form('/admin/news', fields);
      expect(response.status).toBe(400);
      return response.text();
    };
    // On this machine, and not allowed to reach it: the switch to turn on is named.
    const local = await page({ url: `${news.base}${FEED_PATH}` });
    expect(local).toContain(`“${networkAccessLabel('allowPrivateNetwork')}”`);
    expect(local).toContain(`“${networkAccessLabel('allowHttp')}”`);
    expect(local).toContain(`${news.base}${FEED_PATH}`);
    // A site's front page rather than its feed.
    expect(await page({ url: `${news.base}/home`, allow_lan: 'on', allow_http: 'on' })).toContain(
      'That address is a web page, not a feed.',
    );
    // An address that is not there.
    expect(await page({ url: `${news.base}/gone.xml`, allow_lan: 'on', allow_http: 'on' })).toContain(
      'does not exist on the site any more',
    );
    expect(await page({ url: 'javascript:alert(1)' })).toContain('http or https');
    expect(h.db.prepare('SELECT count(*) AS n FROM news_feeds').get()).toEqual({ n: 0 });
  });
});

describe('reading feeds', () => {
  it('keeps the last good headlines when a read fails, says why, and logs the host alone', async () => {
    const news = await site();
    news.routes.set(FEED_PATH, { status: 200, body: fixture('npr-news.rss.xml') });
    const h = await harness();
    expect((await h.form('/admin/news', { url: `${news.base}${FEED_PATH}`, allow_lan: 'on', allow_http: 'on' })).status).toBe(302);
    expect(newsHeadlines(h.db)).toHaveLength(10);

    news.routes.set(FEED_PATH, { status: 503 });
    const lines: string[] = [];
    const later = Date.now() + NEWS_REFRESH_MS;
    await syncNewsFeeds({ db: h.db, fetcher: createFetcher(), keyring: h.keyring, now: later, timezone: 'Europe/London' }, (line) =>
      lines.push(line),
    );
    expect(newsHeadlines(h.db)).toHaveLength(10);
    const page = await (await h.get('/admin/news')).text();
    expect(page).toContain('Not read last time');
    expect(page).toContain('The site refused it (503).');
    expect(page).toContain('keeps showing the 10 headlines it had');
    expect(lines.join('\n')).toContain(new URL(news.base).host);
    expect(lines.join('\n')).not.toContain('abcdef123456');
  });

  it('asks again with the ETag it was given, and an unchanged feed costs nothing more', async () => {
    const news = await site();
    news.routes.set(FEED_PATH, { status: 200, body: fixture('npr-news.rss.xml') });
    const h = await harness();
    await h.form('/admin/news', { url: `${news.base}${FEED_PATH}`, allow_lan: 'on', allow_http: 'on' });
    const context = { db: h.db, fetcher: createFetcher(), keyring: h.keyring, timezone: 'Europe/London' };
    // Not due yet: nothing is asked.
    await syncNewsFeeds({ ...context, now: Date.now() + 60_000 });
    expect(news.requests).toHaveLength(1);
    await syncNewsFeeds({ ...context, now: Date.now() + NEWS_REFRESH_MS });
    expect(news.requests).toHaveLength(2);
    expect(news.requests[1]?.ifNoneMatch).toBeDefined();
    expect(newsHeadlines(h.db)).toHaveLength(10);
    expect(h.db.prepare('SELECT last_error AS e FROM news_feeds').get()).toEqual({ e: null });
  });

  it('merges every feed newest first, and the wall is handed headlines and no address', async () => {
    const news = await site();
    news.routes.set(FEED_PATH, { status: 200, body: fixture('bbc-news.rss.xml') });
    news.routes.set('/npr.xml', { status: 200, body: fixture('npr-news.rss.xml') });
    const h = await harness();
    await h.form('/admin/news', { url: `${news.base}${FEED_PATH}`, allow_lan: 'on', allow_http: 'on' });
    await h.form('/admin/news', { url: `${news.base}/npr.xml`, name: 'NPR', allow_lan: 'on', allow_http: 'on' });
    const headlines = newsHeadlines(h.db);
    const dated = headlines.filter((headline) => headline.at !== undefined).map((headline) => headline.at as number);
    expect(dated).toEqual([...dated].sort((a, b) => b - a));
    expect(new Set(headlines.map((headline) => headline.source))).toEqual(new Set(['BBC News', 'NPR']));

    h.place({});
    const { body, text } = await h.manifest();
    const panel = body.panels['news'] as { headlines: { key: string; link?: string }[] };
    expect(panel.headlines.length).toBeGreaterThan(0);
    expect(panel.headlines.every((headline) => /^nh-[0-9a-f]{12}$/.test(headline.key))).toBe(true);
    // The story's own address travels, for a code; the feed's address never does.
    expect(text).not.toContain('abcdef123456');
    expect(text).not.toContain(news.base);
    expect(body.layout.portrait.widgets.some((widget) => widget.type === 'news')).toBe(true);
  });

  it('leaves a News widget out until a feed has headlines, and removing the feed takes them away', async () => {
    const news = await site();
    news.routes.set(FEED_PATH, { status: 200, body: fixture('npr-news.rss.xml') });
    const h = await harness();
    h.place({});
    expect((await h.manifest()).body.layout.portrait.widgets.some((widget) => widget.type === 'news')).toBe(false);
    await h.form('/admin/news', { url: `${news.base}${FEED_PATH}`, allow_lan: 'on', allow_http: 'on' });
    expect((await h.manifest()).body.layout.portrait.widgets.some((widget) => widget.type === 'news')).toBe(true);
    const id = (h.db.prepare('SELECT id FROM news_feeds').get() as { id: string }).id;
    const removed = await h.form(`/admin/news/${id}/remove`, {});
    expect(removed.headers.get('location')).toContain('saved=news-feed-removed');
    expect(newsHeadlines(h.db)).toEqual([]);
    expect((await h.manifest()).body.panels['news']).toBeUndefined();
  });
});
