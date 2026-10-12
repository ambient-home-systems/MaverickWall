import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { haModule } from '../src/modules/homeassistant/index.js';
import { pictureKey } from '../src/modules/homeassistant/entities.js';
import {
  HISTORY_BUCKET_MS,
  HISTORY_POINTS,
  historyPath,
  historyWindowEnd,
  parseHistory,
  seriesFrom,
  storedSeries,
} from '../src/modules/homeassistant/history.js';
import { displayConfig, haReadingHandle } from '../src/api/manifest.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import { isDone, percentOf, sparkHeights, sparkRuns, statusParts } from '../src/api/status-card.js';
import { ARTWORK, TOKEN, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * Sparklines from Home Assistant's history (plan item M6.10) and the status
 * card (plan item M6.8), against the real app, a real database and the
 * stand-in Home Assistant.
 *
 * What never happens: a household that never asked is sent a series or a
 * picture, or has its house asked for its history; a history request is
 * anything but a GET; an entity id, a picture's address or its token reaches a
 * wall. And what does: a day as forty-eight half-hour means, read at most once
 * a half hour; a card's subject and progress leaving as handles; and a card's
 * own picture, served by the media route, only beside the card that drew it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
const KITCHEN = 'sensor.kitchen_temperature';
const LAMP = 'light.living_room';
const LAMP_PICTURE = '/api/image_proxy/light.living_room?token=picture-token-that-must-not-travel';

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

describe('a day as half-hour means', () => {
  const end = Date.UTC(2026, 9, 12, 12, 0, 0);
  const start = end - HISTORY_POINTS * HISTORY_BUCKET_MS;

  it('weights each number by how long it held, and leaves a half hour with none empty', () => {
    const changes = [
      // Before the window: 10 until a third of the way into the first half hour.
      { at: start - 3_600_000, value: 10 },
      { at: start + HISTORY_BUCKET_MS / 3, value: 40 },
      // Unavailable for the whole of the third half hour.
      { at: start + 2 * HISTORY_BUCKET_MS, value: null },
      { at: start + 3 * HISTORY_BUCKET_MS, value: 20 },
    ];
    const series = seriesFrom(changes, end);
    expect(series).toHaveLength(HISTORY_POINTS);
    // A third at 10 and two thirds at 40 is 30, not either of them.
    expect(series[0]).toBe(30);
    expect(series[1]).toBe(40);
    expect(series[2]).toBeNull();
    expect(series[3]).toBe(20);
    expect(series[HISTORY_POINTS - 1]).toBe(20);
  });

  it('knows nothing before the first change', () => {
    const series = seriesFrom([{ at: end - HISTORY_BUCKET_MS, value: 5 }], end);
    expect(series.slice(0, HISTORY_POINTS - 1).every((v) => v === null)).toBe(true);
    expect(series[HISTORY_POINTS - 1]).toBe(5);
  });

  it('rounds to four figures, so a series does not move in its fifteenth', () => {
    expect(seriesFrom([{ at: start - 1, value: 1013.2468 }], end)[0]).toBe(1013);
  });

  it('ends on the last half-hour boundary, so it moves at most twice an hour', () => {
    expect(historyWindowEnd(end + 29 * 60_000)).toBe(end);
    expect(historyWindowEnd(end + 30 * 60_000)).toBe(end + HISTORY_BUCKET_MS);
  });

  it('reads core’s minimal answer, a number or a gap, in order', () => {
    const body = JSON.stringify([
      [
        { entity_id: KITCHEN, state: '19.5', last_changed: '2026-10-12T10:00:00+00:00', attributes: {} },
        { state: 'unavailable', last_changed: '2026-10-12T11:00:00+00:00' },
        { state: '20', last_changed: '2026-10-12T10:30:00+00:00' },
        { state: 'not a row' },
      ],
    ]);
    expect(parseHistory(body)).toEqual([
      { at: Date.parse('2026-10-12T10:00:00Z'), value: 19.5 },
      { at: Date.parse('2026-10-12T10:30:00Z'), value: 20 },
      { at: Date.parse('2026-10-12T11:00:00Z'), value: null },
    ]);
    expect(parseHistory('not json')).toEqual([]);
  });

  it('asks for one entity, the window, the least it needs, and no attributes', () => {
    const path = historyPath(KITCHEN, end);
    expect(path.startsWith('/history/period/')).toBe(true);
    const url = new URL(path, 'http://ha.local');
    expect(url.searchParams.get('filter_entity_id')).toBe(KITCHEN);
    expect(Date.parse(decodeURIComponent(url.pathname.slice('/history/period/'.length)))).toBe(end - 24 * 3_600_000);
    expect(url.searchParams.get('end_time')).toBe(new Date(end).toISOString());
    expect(url.searchParams.has('minimal_response')).toBe(true);
    expect(url.searchParams.has('no_attributes')).toBe(true);
  });

  it('refuses a stored series of any other shape, and one with no number in it', () => {
    expect(storedSeries(JSON.stringify(new Array(HISTORY_POINTS).fill(1)))).toHaveLength(HISTORY_POINTS);
    expect(storedSeries(JSON.stringify(new Array(HISTORY_POINTS - 1).fill(1)))).toBeUndefined();
    expect(storedSeries(JSON.stringify(new Array(HISTORY_POINTS).fill(null)))).toBeUndefined();
    expect(storedSeries(JSON.stringify(['1', ...new Array(HISTORY_POINTS - 1).fill(1)]))).toBeUndefined();
    expect(storedSeries(null)).toBeUndefined();
  });
});

describe('the card and the line, as decisions', () => {
  const r = (key: string, value: string, extra: Record<string, unknown> = {}) => ({ key, value, ...extra });

  it('takes the subject it names, else the first it shows, and up to four others', () => {
    const all = [r('a', '1'), r('b', '2'), r('c', '3'), r('d', '4'), r('e', '5'), r('f', '6'), r('g', '7')];
    expect(statusParts(all, all, {})?.subject.key).toBe('a');
    const parts = statusParts(all, all, { subject: 'c' });
    expect(parts?.subject.key).toBe('c');
    expect(parts?.details.map((d) => d.key)).toEqual(['a', 'b', 'd', 'e']);
    // A subject the widget does not show is still the card's subject.
    expect(statusParts(all, [all[0]!], { subject: 'g' })?.subject.key).toBe('g');
    // One it does not know is the first it shows.
    expect(statusParts(all, all, { subject: 'nope' })?.subject.key).toBe('a');
    expect(statusParts(all, [], {})).toBeUndefined();
  });

  it('reads progress from the reading it names, else the subject’s own level, and refuses one out of range', () => {
    const all = [r('w', 'Running'), r('p', '45 %', { unit: '%' }), r('bad', '140', { unit: '%' }), r('b', 'Open', { level: 30 })];
    expect(statusParts(all, all, { subject: 'w', progress: 'p' })?.progress).toBe(45);
    expect(statusParts(all, all, { subject: 'b' })?.progress).toBe(30);
    expect(statusParts(all, all, { subject: 'w' })?.progress).toBeUndefined();
    expect(statusParts(all, all, { subject: 'w', progress: 'bad' })?.progress).toBeUndefined();
    // A wall joins the unit on, a panel does not: both are forty-five.
    expect(percentOf(r('x', '45', { unit: '%' }))).toBe(45);
    // A progress reading is not also drawn as one of the card's details.
    expect(statusParts(all, all, { subject: 'w', progress: 'p' })?.details.map((d) => d.key)).not.toContain('p');
  });

  it('is finished when it says the chosen words, whatever their capitals, and never with none chosen', () => {
    expect(isDone(r('w', 'Complete'), { doneState: 'complete' })).toBe(true);
    expect(isDone(r('w', ' Complete '), { doneState: 'Complete' })).toBe(true);
    expect(isDone(r('w', 'Running'), { doneState: 'Complete' })).toBe(false);
    expect(isDone(r('w', 'Complete'), {})).toBe(false);
  });

  it('draws a day from its least to its most, level when flat, split at its gaps, and nothing for fewer than two numbers', () => {
    expect(sparkHeights([1, null, 3, 2])).toEqual([0, null, 1, 0.5]);
    expect(sparkHeights([4, 4, null])).toEqual([0.5, 0.5, null]);
    expect(sparkHeights([4, null])).toBeUndefined();
    expect(sparkHeights(undefined)).toBeUndefined();
    expect(sparkRuns([0, 1, null, 0.5, null, null, 0.2, 0.3])).toEqual([
      [[0, 0], [1, 1]],
      [[3, 0.5]],
      [[6, 0.2], [7, 0.3]],
    ]);
  });
});

describe('the settings', () => {
  it('takes a subject and a progress only as entity ids, finished words without control characters, and the status look', () => {
    expect(widgetConfigBody.safeParse({ variant: 'status', subject: KITCHEN, progress: 'sensor.washer_progress' }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ subject: 'Kitchen temperature' }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ doneState: 'Complete', subjectPicture: true, sparkline: true }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ doneState: 'Done\u0007' }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ doneState: 'x'.repeat(41) }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ sparkline: 'yes' }).success).toBe(false);
  });

  it('sends a card’s subject and progress to a wall as handles, never as entity ids (rule 12)', () => {
    const out = JSON.stringify(
      displayConfig('homeassistant', { variant: 'status', subject: KITCHEN, progress: 'sensor.washer_progress' }),
    );
    expect(out).not.toContain('sensor.');
    expect(out).toContain(haReadingHandle(KITCHEN));
    expect(out).toContain(haReadingHandle('sensor.washer_progress'));
  });
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly ha: FakeHa;
  readonly wall: (path: string) => Promise<Response>;
  readonly poll: () => Promise<void>;
  readonly place: (config: Record<string, unknown>) => void;
  readonly at: { now: number };
}

async function harness(): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-spark-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const keyring = createKeyring(randomBytes(32));
  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
    clientAddress: () => `10.52.${n}.1`,
    setupToken,
    dataDir,
  });
  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
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
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', { name: 'Household', email: `spark${n}@home.local`, password: 'correct-horse-battery', confirm: 'correct-horse-battery' });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });
  const watched = await call('/admin/home-assistant/entities/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities: [{ entity_id: KITCHEN }, { entity_id: LAMP }], display_mode: 'label_value' }),
  });
  expect(watched.status).toBe(200);
  const display = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('wall', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(display.tokenHash, stamp, stamp, stamp);
  const at = { now: Date.now() };
  const context = { db, fetcher, keyring, timezone: 'Europe/London', get now(): number { return at.now; } };
  return {
    db,
    ha,
    at,
    wall: async (path) => app.fetch(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${display.token}` } })),
    poll: () => (haModule.job as { run: (c: unknown) => Promise<void> }).run(context),
    place: (config) => {
      db.prepare(`DELETE FROM layout_widgets WHERE id = 'w-ha'`).run();
      db.prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES ('w-ha', 'wall', 'portrait', 'homeassistant', 0, 0, 1, 1, 0, ?, ?, ?)`,
      ).run(JSON.stringify(config), stamp, stamp);
    },
  };
}

interface ManifestReading {
  readonly key: string;
  readonly series?: (number | null)[];
  readonly picture?: string;
}

const manifestOf = async (h: Harness): Promise<{ text: string; readings: ManifestReading[] }> => {
  const text = await (await h.wall('/d/manifest')).text();
  const parsed = JSON.parse(text) as { panels: { home?: { readings: ManifestReading[] } } };
  return { text, readings: parsed.panels.home?.readings ?? [] };
};

const historyRequests = (h: Harness): string[] => h.ha.paths.filter((path) => path.startsWith('/api/history/'));

describe('the house’s history, read for the readings a sparkline asks for', () => {
  it('asks nothing and sends nothing for a household that never asked', async () => {
    const h = await harness();
    h.ha.history[KITCHEN] = [{ state: '19', last_changed: new Date(h.at.now - 3 * 3_600_000).toISOString() }];
    h.place({});
    await h.poll();
    expect(historyRequests(h)).toEqual([]);
    const { text } = await manifestOf(h);
    expect(text).not.toContain('"series"');
    expect(text).not.toContain('"picture"');
  });

  it('reads a sensor’s day once a half hour, sends it as forty-eight points, and nothing for a light', async () => {
    const h = await harness();
    const end = historyWindowEnd(h.at.now);
    h.ha.history[KITCHEN] = [
      { state: '18', last_changed: new Date(end - 30 * 3_600_000).toISOString() },
      { state: '21', last_changed: new Date(end - 2 * 3_600_000).toISOString() },
    ];
    h.place({ sparkline: true });
    await h.poll();
    expect(historyRequests(h)).toHaveLength(1);
    expect(historyRequests(h)[0]).toContain(`filter_entity_id=${encodeURIComponent(KITCHEN)}`);
    // A read, never a write: nothing here is a POST.
    expect(h.ha.posts).toEqual([]);

    const { text, readings } = await manifestOf(h);
    const kitchen = readings.find((reading) => reading.key === haReadingHandle(KITCHEN));
    expect(kitchen?.series).toHaveLength(HISTORY_POINTS);
    expect(kitchen?.series?.[0]).toBe(18);
    expect(kitchen?.series?.[HISTORY_POINTS - 1]).toBe(21);
    // A light's "on" has no line.
    expect(readings.find((reading) => reading.key === haReadingHandle(LAMP))?.series).toBeUndefined();
    expect(text).not.toContain(KITCHEN);

    // The same half hour: nothing asked again.
    h.at.now = end + HISTORY_BUCKET_MS - 1;
    await h.poll();
    expect(historyRequests(h)).toHaveLength(1);
    // The next: asked once more.
    h.at.now = end + HISTORY_BUCKET_MS;
    await h.poll();
    expect(historyRequests(h)).toHaveLength(2);
  });

  it('keeps the line it had when the house will not answer, and forgets it once no widget asks', async () => {
    const h = await harness();
    h.ha.history[KITCHEN] = [{ state: '19', last_changed: new Date(h.at.now - 30 * 3_600_000).toISOString() }];
    h.place({ variant: 'tile', sparkline: true, readings: [KITCHEN] });
    await h.poll();
    expect((await manifestOf(h)).readings[0]?.series).toHaveLength(HISTORY_POINTS);

    h.ha.history[KITCHEN] = [];
    h.at.now += HISTORY_BUCKET_MS;
    h.ha.down = true;
    await h.poll();
    h.ha.down = false;
    expect((await manifestOf(h)).readings[0]?.series).toHaveLength(HISTORY_POINTS);

    h.place({ variant: 'tile', readings: [KITCHEN] });
    await h.poll();
    const after = await manifestOf(h);
    expect(after.text).not.toContain('"series"');
    expect(h.db.prepare('SELECT count(*) AS n FROM ha_entity_cache WHERE history IS NOT NULL').get()).toEqual({ n: 0 });
  });

  it('reads only the readings a sparkline widget shows, and a status card’s subject', async () => {
    const h = await harness();
    h.ha.history[KITCHEN] = [{ state: '19', last_changed: new Date(h.at.now - 30 * 3_600_000).toISOString() }];
    h.place({ sparkline: true, readings: [LAMP] });
    await h.poll();
    expect(historyRequests(h)).toEqual([]);
    h.place({ variant: 'status', sparkline: true, readings: [LAMP], subject: KITCHEN });
    await h.poll();
    expect(historyRequests(h)).toHaveLength(1);
  });
});

describe('a status card’s own picture', () => {
  it('reaches a wall as a handle only beside a card that draws it, and is served by the media route', async () => {
    const h = await harness();
    h.place({ variant: 'status', subject: LAMP });
    await h.poll();
    expect((await manifestOf(h)).text).not.toContain('"picture"');

    h.place({ variant: 'status', subject: LAMP, subjectPicture: true });
    const { text, readings } = await manifestOf(h);
    const lamp = readings.find((reading) => reading.key === haReadingHandle(LAMP));
    expect(lamp?.picture).toBe(`${pictureKey(LAMP_PICTURE)}.jpg`);
    // Never the address, its token, or the entity id.
    expect(text).not.toContain('image_proxy');
    expect(text).not.toContain('picture-token-that-must-not-travel');
    expect(text).not.toContain(LAMP);

    const served = await h.wall(`/d/media/${lamp?.picture}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(ARTWORK)).toBe(true);

    // A guessed handle serves nothing, and nor does one no card draws any more.
    expect((await h.wall(`/d/media/${'0'.repeat(64)}.jpg`)).status).toBe(404);
    h.place({ variant: 'status', subject: LAMP });
    expect((await h.wall(`/d/media/${lamp?.picture}`)).status).toBe(404);
  });
});
