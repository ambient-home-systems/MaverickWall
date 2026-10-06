import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { issueDisplayToken } from '../src/auth/tokens.js';
import { issueCompanionToken } from '../src/api/companion.js';
import { parseBackground, type Manifest } from '../src/api/manifest.js';
import { backgroundSchema } from '../src/api/widget-schema.js';
import { localEpochDay, rotationIndex, rotationSteps } from '../src/api/picture-rotation.js';
import { rotationPictures } from '../src/wallpapers.js';

/**
 * Rotating wallpapers and Next picture (plan items M4.10, M1.4, M2.3): the
 * arithmetic a wall and the server share, the background the schema accepts and
 * the manifest carries, and moving a wall on from a phone or the admin.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const roots: string[] = [];
let household = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the arithmetic', () => {
  it('is one text on the server and on the wall', () => {
    const between = (path: string): string => {
      const text = readFileSync(path, 'utf8');
      const start = text.indexOf('/* rotation-parity:start */');
      const end = text.indexOf('/* rotation-parity:end */');
      expect(start, path).toBeGreaterThan(-1);
      return text.slice(start, end);
    };
    expect(between(join(HERE, '..', '..', 'display', 'src', 'picture-rotation.ts'))).toBe(
      between(join(HERE, '..', 'src', 'api', 'picture-rotation.ts')),
    );
  });

  it('counts whole periods, and from a press once there has been one', () => {
    const at = Date.UTC(2026, 9, 6, 10, 7, 0);
    expect(rotationSteps(15, at, 'UTC', undefined, 0)).toBe(Math.floor(at / 900_000));
    // Pressed at 10:07 onto step 8: still 8 until 10:22, then 9.
    expect(rotationSteps(15, at + 14 * 60_000, 'UTC', at, 8)).toBe(8);
    expect(rotationSteps(15, at + 15 * 60_000, 'UTC', at, 8)).toBe(9);
  });

  it('changes a daily rotation at the wall’s own midnight, not UTC’s, and across a clock change', () => {
    // 22:30 and 23:30 UTC on 5 October are 23:30 and 00:30 in London: one UTC
    // day, two of the wall's.
    const lateEvening = Date.UTC(2026, 9, 5, 22, 30);
    const pastMidnight = Date.UTC(2026, 9, 5, 23, 30);
    expect(Math.floor(lateEvening / 86_400_000)).toBe(Math.floor(pastMidnight / 86_400_000));
    expect(rotationSteps(1440, pastMidnight, 'Europe/London', undefined, 0)).toBe(
      rotationSteps(1440, lateEvening, 'Europe/London', undefined, 0) + 1,
    );
    // 25 October is twenty-five hours long in London: 23:30 BST on the 24th
    // and 23:30 GMT on the 25th are twenty-five hours apart and one day.
    const saturday = Date.UTC(2026, 9, 24, 22, 30);
    const sunday = Date.UTC(2026, 9, 25, 23, 30);
    expect(sunday - saturday).toBe(25 * 3_600_000);
    expect(localEpochDay(sunday, 'Europe/London')).toBe(localEpochDay(saturday, 'Europe/London') + 1);
    // And in a zone `Intl` does not know, it is UTC rather than a throw.
    expect(localEpochDay(saturday, 'Not/AZone')).toBe(Math.floor(saturday / 86_400_000));
  });

  it('lands on a picture for any step, including a negative one', () => {
    expect([0, 1, 2, 3, 7, -1].map((steps) => rotationIndex(3, steps))).toEqual([0, 1, 2, 0, 1, 2]);
    expect(rotationIndex(0, 5)).toBe(0);
  });
});

describe('a rotating background', () => {
  it('is accepted for a collection with pictures to rotate between, and refused for one without', () => {
    expect(backgroundSchema.safeParse({ type: 'rotation', collection: 'gradient', tone: 'dark', every: 60 }).success).toBe(true);
    expect(backgroundSchema.safeParse({ type: 'rotation', collection: 'all', tone: 'light', every: 1440 }).success).toBe(true);
    // contour/light has one picture: that is a wallpaper, not a rotation.
    const single = backgroundSchema.safeParse({ type: 'rotation', collection: 'contour', tone: 'light', every: 60 });
    expect(single.success).toBe(false);
    expect(backgroundSchema.safeParse({ type: 'rotation', collection: 'gradient', tone: 'dark', every: 7 }).success).toBe(false);
    expect(backgroundSchema.safeParse({ type: 'rotation', collection: 'cats', tone: 'dark', every: 60 }).success).toBe(false);
    expect(
      backgroundSchema.safeParse({ type: 'rotation', collection: 'gradient', tone: 'dark', every: 60, pictures: [] }).success,
    ).toBe(false);
  });

  it('reaches a wall as every picture’s files, in the catalogue’s order', () => {
    const resolved = parseBackground(JSON.stringify({ type: 'rotation', collection: 'gradient', tone: 'dark', every: 15 }));
    expect(resolved?.type).toBe('rotation');
    if (resolved?.type !== 'rotation') return;
    expect(resolved.every).toBe(15);
    expect(resolved.pictures.map((one) => one.id)).toEqual(rotationPictures('gradient', 'dark').map((one) => one.id));
    expect(resolved.pictures.every((one) => /\.jpg$/.test(one.small) && /\.jpg$/.test(one.large))).toBe(true);
    // A stored row a later catalogue left with one picture is that wallpaper.
    expect(parseBackground(JSON.stringify({ type: 'rotation', collection: 'contour', tone: 'light', every: 60 }))?.type).toBe(
      'wallpaper',
    );
    expect(parseBackground(JSON.stringify({ type: 'rotation', collection: 'gradient', tone: 'dark', every: 9 }))).toBeUndefined();
  });
});

const START = Date.UTC(2026, 9, 6, 9, 0, 0);

async function harness(): Promise<{
  db: SqliteDatabase;
  clock: { at: number };
  phone: (path: string, body: unknown) => Promise<Response>;
  admin: (path: string, init?: RequestInit) => Promise<Response>;
  form: (path: string, fields: Record<string, string>) => Promise<Response>;
  manifest: (wall: 'kitchen' | 'hall') => Promise<Manifest>;
}> {
  const n = ++household;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-rotation-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(START, START);
  const clock = { at: Date.now() };
  const keyring = createKeyring(randomBytes(32));
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'n'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => `10.21.${n}.1`,
    setupToken,
    dataDir,
    now: () => clock.at,
  });
  const jar = new Map<string, string>();
  const admin = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
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
    admin(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await admin(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: `rotation${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  const userId = (db.prepare('SELECT id FROM user').get() as { id: string }).id;
  clock.at = START;
  const token = issueCompanionToken(db, keyring, userId, clock.at);
  const tokens: Record<string, string> = {};
  for (const [id, name, background] of [
    ['kitchen', 'Kitchen', JSON.stringify({ type: 'rotation', collection: 'gradient', tone: 'dark', every: 15 })],
    ['hall', 'Hall', JSON.stringify({ type: 'wallpaper', id: 'dusk' })],
  ] as const) {
    const issued = issueDisplayToken();
    tokens[id] = issued.token;
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, layout_mode, layout_background, token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, 'panels', 'freeform', ?, ?, ?, ?)`,
    ).run(id, name, issued.tokenHash, background, START, START, START);
  }
  return {
    db,
    clock,
    phone: (path, body) =>
      Promise.resolve(
        app.fetch(
          new Request(`http://localhost${path}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        ),
      ),
    admin,
    form,
    manifest: async (wall) =>
      (await (
        await app.fetch(new Request('http://localhost/d/manifest', { headers: { authorization: `Bearer ${tokens[wall]}` } }))
      ).json()) as Manifest,
  };
}

describe('Next picture', () => {
  it('moves a rotating wall on one step from now, and the wall is told where to count from', async () => {
    const h = await harness();
    const before = await h.manifest('kitchen');
    expect(before.layout.portrait.background?.type).toBe('rotation');
    expect(before.screen).not.toHaveProperty('picturePressedAt');

    const response = await h.phone('/companion/walls/next-picture', { wall: 'Kitchen' });
    expect(await response.json()).toEqual({ ok: true, moved: 1, message: 'Kitchen moves on to its next picture in a moment.' });
    const after = await h.manifest('kitchen');
    const steps = rotationSteps(15, START, 'Europe/London', undefined, 0);
    expect(after.screen).toMatchObject({ picturePressedAt: START, pictureStep: steps + 1 });

    // Pressed again ten minutes later: one more step, counted from then.
    h.clock.at = START + 10 * 60_000;
    await h.phone('/companion/walls/next-picture', { wall: 'Kitchen' });
    expect((await h.manifest('kitchen')).screen).toMatchObject({ picturePressedAt: START + 10 * 60_000, pictureStep: steps + 2 });
  });

  it('says a wall whose background does not rotate has no next picture, and moves every rotating one when none is named', async () => {
    const h = await harness();
    const still = await h.phone('/companion/walls/next-picture', { wall: 'Hall' });
    expect(still.status).toBe(409);
    expect(((await still.json()) as { message: string }).message).toBe(
      'Hall’s background does not rotate. Choose Rotating wallpapers for it in its layout.',
    );
    expect(await (await h.phone('/companion/walls/next-picture', {})).json()).toMatchObject({ ok: true, moved: 1 });
    expect(h.db.prepare(`SELECT id FROM screens WHERE picture_step IS NOT NULL`).all()).toEqual([{ id: 'kitchen' }]);
    h.db.prepare(`UPDATE screens SET layout_background = NULL WHERE id = 'kitchen'`).run();
    expect((await h.phone('/companion/walls/next-picture', {})).status).toBe(404);
  });

  it('is on a rotating wall’s menu, and not on one that does not rotate', async () => {
    const h = await harness();
    expect(await (await h.admin('/admin/walls/kitchen')).text()).toContain('action="admin/screens/kitchen/next-picture"');
    expect(await (await h.admin('/admin/walls/hall')).text()).not.toContain('next-picture');
    expect((await h.form('/admin/screens/kitchen/next-picture', {})).headers.get('location')).toContain('saved=picture-next');
    expect((await h.form('/admin/screens/hall/next-picture', {})).headers.get('location')).not.toContain('saved=');
  });
});
