import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { pollExternalModules } from '../src/modules/external/index.js';
import { panelDataSchema } from '../src/modules/external/panel-data.js';
import { recipeSchema, runRecipePanel } from '../src/modules/external/recipe.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import {
  createExternalModule,
  createRecipeModule,
  writeExternalModulePanel,
  writeModuleVariantPanel,
} from '../src/api/external-modules.js';
import { moduleImageHandle } from '../src/api/module-image-handle.js';
import { moduleVariantKey } from '../src/api/module-variant.js';

/**
 * Contract 2's QR code, countdown, timeline and picture (plan item M7.5).
 *
 * The schema is held at its edges with a control on each side. The picture is
 * held end to end: a service module on a real loopback server names a picture
 * by its address, the real job polls it through the real fetcher, and a paired
 * wall is handed a handle and never the address; the picture is fetched once,
 * sniffed, kept, served by that handle and no other, and forgotten when the
 * module stops naming it. A recipe's picture is fetched under the recipe's own
 * policy, so one on the household's network is never asked for unless the
 * recipe opted in.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const PNG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'addon', 'maverick-wall', 'icon.png'));
const roots: string[] = [];
const servers: Server[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
});

const parses = (panel: unknown): boolean => panelDataSchema.safeParse(panel).success;

describe('the contract 2 kinds', () => {
  it('takes a QR code up to what one code holds, and keeps its text exactly', () => {
    expect(parses({ kind: 'qr', text: 'a'.repeat(213), label: 'Guest' })).toBe(true);
    expect(parses({ kind: 'qr', text: 'a'.repeat(214) })).toBe(false);
    // Bytes, not characters: 107 two-byte letters are 214 bytes.
    expect(parses({ kind: 'qr', text: 'é'.repeat(106) })).toBe(true);
    expect(parses({ kind: 'qr', text: 'é'.repeat(107) })).toBe(false);
    expect(parses({ kind: 'qr', text: '' })).toBe(false);
    const vcard = 'BEGIN:VCARD\nFN:Dr Smith\nEND:VCARD';
    const parsed = panelDataSchema.parse({ kind: 'qr', text: vcard });
    expect(parsed).toEqual({ kind: 'qr', text: vcard });
  });

  it('takes a countdown only to an instant whose zone is stated', () => {
    expect(parses({ kind: 'countdown', label: 'Bins', at: '2026-10-16T07:00:00+01:00' })).toBe(true);
    expect(parses({ kind: 'countdown', label: 'Bins', at: '2026-10-16T06:00Z' })).toBe(true);
    expect(parses({ kind: 'countdown', label: 'Bins', at: '2026-10-16T07:00:00' })).toBe(false);
    expect(parses({ kind: 'countdown', label: 'Bins', at: '2026-10-16' })).toBe(false);
    expect(parses({ kind: 'countdown', label: 'Bins', at: '2026-13-40T07:00:00Z' })).toBe(false);
    expect(parses({ kind: 'countdown', label: 'Bins', at: 1_790_000_000_000 })).toBe(false);
  });

  it('takes a timeline in order of time, and refuses one out of order rather than sorting it', () => {
    const items = [
      { at: '2026-10-16T07:00:00Z', label: 'Bins' },
      { at: '2026-10-16T07:00:00Z', label: 'Recycling', tone: 'active' },
      { at: '2026-10-16T09:30:00+01:00', label: 'Dentist', detail: 'Dr Smith' },
    ];
    expect(parses({ kind: 'timeline', items })).toBe(true);
    expect(parses({ kind: 'timeline', items: [...items].reverse() })).toBe(false);
    expect(parses({ kind: 'timeline', items: [] })).toBe(false);
    expect(parses({ kind: 'timeline', items: Array.from({ length: 13 }, () => items[0]) })).toBe(false);
    expect(parses({ kind: 'timeline', items: [{ ...items[0], tone: 'red' }] })).toBe(false);
  });

  it('takes a picture by an http or https address with no name or password in it', () => {
    expect(parses({ kind: 'image', url: 'https://example.com/a.png', caption: 'Radar' })).toBe(true);
    expect(parses({ kind: 'image', url: 'http://192.168.1.4/snap.jpg' })).toBe(true);
    expect(parses({ kind: 'image', url: 'https://me:secret@example.com/a.png' })).toBe(false);
    expect(parses({ kind: 'image', url: 'ftp://example.com/a.png' })).toBe(false);
    expect(parses({ kind: 'image', url: 'data:image/png;base64,AAAA' })).toBe(false);
    expect(parses({ kind: 'image', url: 'a.png' })).toBe(false);
    expect(parses({ kind: 'image', url: 'https://example.com/a.png', image: 'x' })).toBe(false);
  });

  it('builds each from a recipe, putting a source’s list into time order', () => {
    const recipe = recipeSchema.parse({
      name: 'Schedule',
      contract: 1,
      fetch: { url: 'https://example.com/s' },
      panel: { kind: 'timeline', title: 'Today', items: { for: 'events', at: '{at}', label: '{name}' } },
    });
    const built = runRecipePanel(
      recipe,
      { events: [{ at: '2026-10-16T12:00:00Z', name: 'Lunch' }, { at: '2026-10-16T07:00:00Z', name: 'Bins' }] },
      Date.now(),
    );
    expect(built).toEqual({
      ok: true,
      panel: {
        kind: 'timeline',
        title: 'Today',
        items: [
          { at: '2026-10-16T07:00:00Z', label: 'Bins' },
          { at: '2026-10-16T12:00:00Z', label: 'Lunch' },
        ],
      },
    });
    const qr = recipeSchema.parse({
      name: 'Link',
      contract: 1,
      fetch: { url: 'https://example.com/s' },
      panel: { kind: 'qr', text: '{link}', label: 'Scan me' },
    });
    expect(runRecipePanel(qr, { link: 'https://example.com/x' }, Date.now())).toEqual({
      ok: true,
      panel: { kind: 'qr', text: 'https://example.com/x', label: 'Scan me' },
    });
    const countdown = recipeSchema.parse({
      name: 'Launch',
      contract: 1,
      fetch: { url: 'https://example.com/s' },
      panel: { kind: 'countdown', label: '{name}', at: '{net}' },
    });
    expect(runRecipePanel(countdown, { name: 'Falcon 9', net: '2026-10-20T14:00:00Z' }, Date.now())).toEqual({
      ok: true,
      panel: { kind: 'countdown', label: 'Falcon 9', at: '2026-10-20T14:00:00Z' },
    });
    // A source's time the schema cannot read is the recipe's error, not a panel.
    expect(runRecipePanel(countdown, { name: 'Falcon 9', net: 'soon' }, Date.now()).ok).toBe(false);
  });
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly dataDir: string;
  readonly poll: () => Promise<void>;
  readonly manifest: () => Promise<string>;
  readonly media: (name: string) => Promise<Response>;
}

async function harness(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-contract2-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const fetcher = createFetcher();
  const keyring = createKeyring(randomBytes(32));
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'c'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
    clientAddress: () => `10.77.0.${++n}`,
    setupToken: createSetupTokenHolder(() => {}),
    dataDir,
  });
  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('kitchen', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);
  const call = (path: string): Promise<Response> =>
    app.fetch(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${issued.token}` } }));
  return {
    db,
    dataDir,
    poll: () => pollExternalModules(db, fetcher, keyring),
    manifest: async () => (await call('/d/manifest')).text(),
    media: (name: string) => call(`/d/media/${name}`),
  };
}

/** A module service on loopback: its panel names a picture, and every request is counted. */
async function service(): Promise<{ base: string; asked: string[]; panel: { value: unknown } }> {
  const asked: string[] = [];
  const panel: { value: unknown } = { value: undefined };
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    asked.push(path);
    if (path === '/panel') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(panel.value));
    } else if (path.startsWith('/pic.png')) {
      response.setHeader('content-type', 'image/png');
      response.end(PNG);
    } else if (path === '/pic.svg') {
      response.setHeader('content-type', 'image/png');
      response.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  return { base, asked, panel };
}

const pictureFetches = (asked: readonly string[]): number => asked.filter((path) => path.startsWith('/pic')).length;

describe('a module’s picture', () => {
  it('reaches a wall as a handle, fetched once, sniffed, kept, and forgotten when it is no longer named', async () => {
    const h = await harness();
    const s = await service();
    s.panel.value = { kind: 'image', title: 'Radar', url: `${s.base}/pic.png?t=1`, caption: 'Rain at 14:00' };
    createExternalModule(h.db, { id: 'radar', url: s.base, name: 'Radar' });
    await h.poll();

    const manifest = await h.manifest();
    const handle = moduleImageHandle('radar', `${s.base}/pic.png?t=1`);
    expect(manifest).toContain(handle);
    expect(manifest).toContain('Rain at 14:00');
    // Rule 12's shape, for a module: no address, no host, no port.
    expect(manifest).not.toContain(s.base);
    expect(manifest).not.toContain('127.0.0.1');
    expect(manifest).not.toContain('pic.png');
    expect(pictureFetches(s.asked)).toBe(0);

    const first = await h.media(handle);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/png');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await first.arrayBuffer()).equals(PNG)).toBe(true);
    const second = await h.media(handle);
    expect(second.status).toBe(200);
    await second.arrayBuffer();
    expect(pictureFetches(s.asked)).toBe(1);

    // A guessed handle, and one of the right shape for another module, serve nothing and fetch nothing.
    expect((await h.media('0'.repeat(64) + '.jpg')).status).toBe(404);
    expect((await h.media(moduleImageHandle('other', `${s.base}/pic.png?t=1`))).status).toBe(404);
    expect(pictureFetches(s.asked)).toBe(1);

    // The module moves on to a new picture: the old handle serves nothing, and its copy goes.
    s.panel.value = { kind: 'image', url: `${s.base}/pic.png?t=2` };
    h.db.prepare(`UPDATE external_modules SET last_polled_at = 0`).run();
    await h.poll();
    const next = moduleImageHandle('radar', `${s.base}/pic.png?t=2`);
    expect(await h.manifest()).toContain(next);
    expect((await h.media(handle)).status).toBe(404);
    expect(existsSync(join(h.dataDir, 'module-images', handle))).toBe(false);
    expect((await h.media(next)).status).toBe(200);
    expect(readdirSync(join(h.dataDir, 'module-images'))).toEqual([next]);
  });

  it('refuses a body that is not a picture by its bytes, whatever its type says', async () => {
    const h = await harness();
    const s = await service();
    createExternalModule(h.db, { id: 'bad', url: s.base, name: 'Bad' });
    writeExternalModulePanel(h.db, 'bad', { kind: 'image', url: `${s.base}/pic.svg` });
    const handle = moduleImageHandle('bad', `${s.base}/pic.svg`);
    expect(await h.manifest()).toContain(handle);
    expect((await h.media(handle)).status).toBe(404);
    expect(s.asked).toContain('/pic.svg');
    expect(existsSync(join(h.dataDir, 'module-images', handle))).toBe(false);
  });

  it('serves a widget’s own panel’s picture by its handle too', async () => {
    const h = await harness();
    const s = await service();
    createExternalModule(h.db, { id: 'cams', url: s.base, name: 'Cameras' });
    const key = moduleVariantKey('cams', { camera: 'garden' });
    writeModuleVariantPanel(h.db, 'cams', key, { kind: 'image', url: `${s.base}/pic.png?garden` }, Date.now());
    const handle = moduleImageHandle('cams', `${s.base}/pic.png?garden`);
    const manifest = await h.manifest();
    expect(manifest).toContain(handle);
    expect(manifest).not.toContain(s.base);
    expect((await h.media(handle)).status).toBe(200);
  });

  it('is fetched under a recipe’s own policy, so a picture on the household’s network is never asked for unless it opted in', async () => {
    const h = await harness();
    const s = await service();
    const recipe = (allowLan: boolean): unknown => ({
      name: 'Snapshot',
      contract: 1,
      fetch: { url: 'https://example.com/snap.json', allowLan },
      panel: { kind: 'image', url: '{url}' },
    });
    createRecipeModule(h.db, { id: 'closed', name: 'Closed', url: 'https://example.com/snap.json', recipe: recipe(false), config: {} });
    writeExternalModulePanel(h.db, 'closed', { kind: 'image', url: `${s.base}/pic.png?closed` });
    expect((await h.media(moduleImageHandle('closed', `${s.base}/pic.png?closed`))).status).toBe(404);
    expect(pictureFetches(s.asked)).toBe(0);

    // The control: the same picture, from a recipe that opted into the LAN.
    createRecipeModule(h.db, { id: 'open', name: 'Open', url: 'https://example.com/snap.json', recipe: recipe(true), config: {} });
    writeExternalModulePanel(h.db, 'open', { kind: 'image', url: `${s.base}/pic.png?open` });
    expect((await h.media(moduleImageHandle('open', `${s.base}/pic.png?open`))).status).toBe(200);
    expect(pictureFetches(s.asked)).toBe(1);
  });
});
