import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateInterrupts, type Signal } from '@maverick-wall/core';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { clean, parseAlerts, parseZones, reconcile } from '../src/modules/weather/alerts.js';
import { alertSignals, applyAlerts, expireAlerts, knownAlerts } from '../src/modules/weather/alert-store.js';
import { createAlertJobHandler } from '../src/modules/weather/alert-job.js';
import { readRules, seedDefaultRules } from '../src/api/rules.js';
import { createFetcher } from '../src/net/fetcher.js';
import type { SqliteDatabase } from '../src/db/open.js';
import type { JobRecord } from '@maverick-wall/core';

/**
 * National Weather Service alerts.
 *
 * The CAP shapes here are taken from real `api.weather.gov` responses. That
 * matters more than usual: the fields this depends on — `references` arriving
 * as one comma-separated string, `expires` and `ends` being different things,
 * `messageType` carrying Cancel — are all things a hand-invented fixture would
 * get comfortably wrong in exactly the direction that makes the tests pass.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const IN_AN_HOUR = new Date(Date.now() + 3_600_000).toISOString();

/**
 * One CAP feature, shaped as api.weather.gov actually returns it.
 *
 * `over` merges into `properties`, which is the only part any test varies.
 */
function feature(over: Record<string, unknown> = {}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
      '@id': 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.aaa',
      id: 'urn:oid:2.49.0.1.840.0.aaa',
      areaDesc: 'Howard, MD; Montgomery, MD',
      sent: '2026-08-02T18:04:00-04:00',
      effective: '2026-08-02T18:04:00-04:00',
      onset: '2026-08-02T18:04:00-04:00',
      expires: IN_AN_HOUR,
      ends: IN_AN_HOUR,
      status: 'Actual',
      messageType: 'Alert',
      category: 'Met',
      severity: 'Extreme',
      certainty: 'Observed',
      urgency: 'Immediate',
      event: 'Tornado Warning',
      sender: 'w-nws.webmaster@noaa.gov',
      senderName: 'NWS Baltimore/Washington',
      headline: 'Tornado Warning issued August 2 at 6:04PM EDT by NWS Baltimore/Washington',
      description:
        'At 604 PM EDT, a severe thunderstorm capable of producing a tornado was\nlocated near Columbia.\n\nHAZARD...Tornado.',
      instruction:
        'TAKE COVER NOW! Move to a basement or an interior room on the lowest\nfloor of a sturdy building.',
    response: 'Shelter',
    ...((over['properties'] as Record<string, unknown> | undefined) ?? {}),
  };
  // A key explicitly set to undefined means "not present", which is how the
  // `expires`/`ends` test asks for a document that omits one.
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) delete properties[key];
  }
  return { id: properties['id'], type: 'Feature', properties };
}

function collection(features: Record<string, unknown>[]): string {
  return JSON.stringify({ '@context': {}, type: 'FeatureCollection', features });
}

describe('parsing CAP', () => {
  it('reads a real tornado warning', () => {
    const [alert] = parseAlerts(collection([feature()]), 'MDC027');
    expect(alert).toMatchObject({
      id: 'urn:oid:2.49.0.1.840.0.aaa',
      event: 'Tornado Warning',
      severity: 'Extreme',
      urgency: 'Immediate',
      certainty: 'Observed',
      messageType: 'Alert',
      senderName: 'NWS Baltimore/Washington',
      zoneCode: 'MDC027',
    });
    // Hard-wrapped for teletype width, and useless on a wall like that.
    expect(alert?.instruction).toBe(
      'TAKE COVER NOW! Move to a basement or an interior room on the lowest floor of a sturdy building.',
    );
    expect(alert?.expiresAt).toBe(Date.parse(IN_AN_HOUR));
  });

  it('falls back to `ends` when there is no `expires`', () => {
    // They are not the same thing: `expires` is when the message stops being
    // authoritative, `ends` is when the hazard is forecast to stop.
    const [alert] = parseAlerts(
      collection([feature({ properties: { expires: undefined, ends: IN_AN_HOUR } })]),
      null,
    );
    expect(alert?.expiresAt).toBe(Date.parse(IN_AN_HOUR));
  });

  it('skips one unreadable feature and keeps the rest', () => {
    /*
     * During a severe weather outbreak the collection is at its largest and the
     * chance of one odd entry is at its highest — which is precisely when
     * losing the other nine matters.
     */
    const alerts = parseAlerts(
      collection([
        feature(),
        { type: 'Feature' } as Record<string, unknown>,
        feature({ properties: { id: 'urn:oid:2.49.0.1.840.0.bbb', event: 'Flood Warning' } }),
      ]),
      null,
    );
    expect(alerts.map((alert) => alert.event)).toEqual(['Tornado Warning', 'Flood Warning']);
  });

  it('refuses anything that is not a collection', () => {
    expect(parseAlerts('not json', null)).toEqual([]);
    expect(parseAlerts('null', null)).toEqual([]);
    expect(parseAlerts('{"detail":"Not Found"}', null)).toEqual([]);
  });

  it('takes both zones out of a points document', () => {
    const body = JSON.stringify({
      properties: {
        forecastZone: 'https://api.weather.gov/zones/forecast/MDZ011',
        county: 'https://api.weather.gov/zones/county/MDC027',
      },
    });
    expect(parseZones(body)).toEqual({ forecast: 'MDZ011', county: 'MDC027' });
    // A household needs both: flood warnings in particular are issued by
    // county, and watching only the forecast zone misses them.
    expect(parseZones('{"properties":{}}')).toBeUndefined();
  });
});

describe('sanitising what a stranger wrote', () => {
  it('strips the invisible characters, not just the obvious ones', () => {
    // A bidi override in a headline can reverse the reading order of the
    // sentence around it, which on a warning is worth refusing outright.
    expect(clean('Tornado‮Warning', 100)).toBe('TornadoWarning');
    expect(clean('Flood​Warning', 100)).toBe('FloodWarning');
    expect(clean('Bellringing', 100)).toBe('Bellringing');
    expect(clean('﻿Winter Storm', 100)).toBe('Winter Storm');
  });

  it('caps length and says it did', () => {
    const long = 'A'.repeat(500);
    const capped = clean(long, 100);
    expect(capped).toHaveLength(100);
    expect(capped?.endsWith('…')).toBe(true);
  });

  it('treats a string of nothing as nothing', () => {
    expect(clean('​​', 100)).toBeNull();
    expect(clean('   ', 100)).toBeNull();
    expect(clean(42, 100)).toBeNull();
  });
});

describe('reconciling a message stream into state', () => {
  const held = [{ id: 'urn:oid:2.49.0.1.840.0.aaa', sent: '2026-08-02T18:04:00-04:00' }];

  it('supersedes what an Update references', () => {
    const update = parseAlerts(
      collection([
        feature({
          properties: {
            id: 'urn:oid:2.49.0.1.840.0.ccc',
            messageType: 'Update',
            sent: '2026-08-02T18:20:00-04:00',
            references:
              'w-nws.webmaster@noaa.gov,urn:oid:2.49.0.1.840.0.aaa,2026-08-02T18:04:00-04:00',
          },
        }),
      ]),
      'MDC027',
    );
    const { upsert, remove } = reconcile(update, held);
    expect(upsert.map((alert) => alert.id)).toEqual(['urn:oid:2.49.0.1.840.0.ccc']);
    expect(remove).toContain('urn:oid:2.49.0.1.840.0.aaa');
  });

  it('withdraws what a Cancel names, including itself', () => {
    const cancel = parseAlerts(
      collection([
        feature({
          properties: {
            id: 'urn:oid:2.49.0.1.840.0.ddd',
            messageType: 'Cancel',
            references:
              'w-nws.webmaster@noaa.gov,urn:oid:2.49.0.1.840.0.aaa,2026-08-02T18:04:00-04:00',
          },
        }),
      ]),
      'MDC027',
    );
    const { upsert, remove } = reconcile(cancel, held);
    expect(upsert).toEqual([]);
    expect(remove).toContain('urn:oid:2.49.0.1.840.0.aaa');
    expect(remove).toContain('urn:oid:2.49.0.1.840.0.ddd');
  });

  it('drops what the zone stopped listing', () => {
    /*
     * `/alerts/active` is authoritative about what is in force, so absence is
     * a withdrawal — and it is the only signal for an alert cancelled while
     * this wall was offline and so never saw the Cancel.
     */
    const { remove } = reconcile([], held);
    expect(remove).toEqual(['urn:oid:2.49.0.1.840.0.aaa']);
  });

  it('will not let an out-of-order poll resurrect a stale copy', () => {
    const older = parseAlerts(
      collection([feature({ properties: { sent: '2026-08-02T17:00:00-04:00', severity: 'Minor' } })]),
      null,
    );
    const newer = parseAlerts(
      collection([feature({ properties: { sent: '2026-08-02T19:00:00-04:00', severity: 'Extreme' } })]),
      null,
    );
    const { upsert } = reconcile([...newer, ...older], []);
    expect(upsert).toHaveLength(1);
    expect(upsert[0]?.severity).toBe('Extreme');
  });
});

// ---------------------------------------------------------------------------

interface FakeNws {
  base: string;
  readonly paths: string[];
  readonly agents: string[];
  status: number;
  etag: string;
  body: () => string;
}

/**
 * A weather service that behaves like the real one.
 *
 * It answers 403 without a descriptive User-Agent, exactly as api.weather.gov
 * does — the single most likely thing to be silently broken, and one a
 * permissive fake would never catch.
 */
async function fakeNws(): Promise<FakeNws> {
  const state: FakeNws = {
    base: '',
    paths: [],
    agents: [],
    status: 200,
    etag: '"v1"',
    body: () => collection([feature()]),
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '';
    state.paths.push(url);
    const agent = request.headers['user-agent'] ?? '';
    state.agents.push(agent);

    if (!agent.includes('MaverickWall') || !agent.includes('+http')) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end('{"detail":"User-Agent header is required"}');
      return;
    }

    if (url.startsWith('/points/')) {
      response.writeHead(200, { 'content-type': 'application/geo+json' });
      response.end(
        JSON.stringify({
          properties: {
            forecastZone: 'https://api.weather.gov/zones/forecast/MDZ011',
            county: 'https://api.weather.gov/zones/county/MDC027',
          },
        }),
      );
      return;
    }

    if (state.status !== 200) {
      response.writeHead(state.status, { 'content-type': 'application/json' });
      response.end('{"detail":"upstream"}');
      return;
    }

    if (request.headers['if-none-match'] === state.etag) {
      response.writeHead(304, { etag: state.etag });
      response.end();
      return;
    }

    response.writeHead(200, { 'content-type': 'application/geo+json', etag: state.etag });
    response.end(state.body());
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  state.base = `http://127.0.0.1:${port}`;
  return state;
}

function database(): SqliteDatabase {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-alerts-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const at = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, latitude, longitude, alerts_enabled, created_at, updated_at)
     VALUES ('singleton', 39.2, -76.8, 1, ?, ?)`,
  ).run(at, at);
  seedDefaultRules(db);
  return db;
}

describe('the alert store', () => {
  it('serves a reconnecting display from the manifest, not from a push', () => {
    /*
     * The whole reason alerts are persisted. A wall that reloads in the middle
     * of a tornado warning has to get it from the document it polls — waiting
     * for the next push means it shows nothing until the next message, which
     * may be twenty minutes.
     */
    const db = database();
    const alerts = parseAlerts(collection([feature()]), 'MDC027');
    applyAlerts(db, alerts, []);

    const signals = alertSignals(db, Date.now());
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: 'nws',
      title: 'Tornado Warning',
      severity: 'Extreme',
      urgency: 'Immediate',
      area: 'Howard, MD; Montgomery, MD',
      sender: 'NWS Baltimore/Washington',
    });
    // The instruction leads, because it is the only line that says what to do.
    expect(signals[0]?.headline).toContain('TAKE COVER NOW');
    db.close();
  });

  it('clears on its own expiry even if no poll ever comes', () => {
    const db = database();
    const past = new Date(Date.now() - 60_000).toISOString();
    applyAlerts(db, parseAlerts(collection([feature({ properties: { expires: past, ends: past } })]), 'MDC027'), []);

    // Not returned as a signal, and swept from the table.
    expect(alertSignals(db, Date.now())).toEqual([]);
    expect(expireAlerts(db, Date.now())).toBe(1);
    db.close();
  });

  it('replaces rather than accumulates when the same alert is updated', () => {
    const db = database();
    const first = parseAlerts(collection([feature()]), 'MDC027');
    applyAlerts(db, first, []);
    const second = parseAlerts(
      collection([feature({ properties: { severity: 'Severe', sent: '2026-08-02T19:00:00-04:00' } })]),
      'MDC027',
    );
    applyAlerts(db, second, []);

    const held = knownAlerts(db, 'MDC027');
    expect(held).toHaveLength(1);
    expect(alertSignals(db, Date.now())[0]?.severity).toBe('Severe');
    db.close();
  });
});

describe('the polling job, against a real server', () => {
  const job = (db: SqliteDatabase, nws: FakeNws): ReturnType<typeof createAlertJobHandler> =>
    createAlertJobHandler({
      db,
      // Point the guard at the fake by rewriting only the origin: everything
      // else — the path, the headers, the conditional GET — is the real code.
      fetcher: {
        fetch: (request) =>
          createFetcher().fetch({
            ...request,
            url: request.url.replace('https://api.weather.gov', nws.base),
            policy: { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true },
          }),
      },
    });

  const record: JobRecord = {
    key: 'alerts-sync',
    kind: 'alerts-sync',
    nextRunAt: 0,
    consecutiveFailures: 0,
  };

  it('resolves both zones once, then polls them', async () => {
    const db = database();
    const nws = await fakeNws();
    expect(await job(db, nws)(record)).toEqual({ status: 'ok' });

    // The current form. `?active=true&zone=` is deprecated and redirects.
    expect(nws.paths.some((path) => path === '/alerts/active/zone/MDZ011')).toBe(true);
    expect(nws.paths.some((path) => path === '/alerts/active/zone/MDC027')).toBe(true);
    // And the agent NWS insists on, or the fake would have answered 403.
    expect(nws.agents.every((agent) => agent.includes('MaverickWall'))).toBe(true);

    const before = nws.paths.length;
    await job(db, nws)(record);
    // Points is not asked again. A household does not move.
    expect(nws.paths.slice(before).some((path) => path.startsWith('/points/'))).toBe(false);
    db.close();
  });

  it('costs a 304 when nothing has changed', async () => {
    const db = database();
    const nws = await fakeNws();
    await job(db, nws)(record);
    const stored = db.prepare('SELECT etag FROM alert_zones').all() as { etag: string | null }[];
    expect(stored.every((row) => row.etag === '"v1"')).toBe(true);

    // Second run sends the validator, so a quiet zone is one conditional GET.
    await job(db, nws)(record);
    expect(alertSignals(db, Date.now())).toHaveLength(1);
    db.close();
  });

  it('keeps the warning on the wall when the service falls over', async () => {
    const db = database();
    const nws = await fakeNws();
    await job(db, nws)(record);
    expect(alertSignals(db, Date.now())).toHaveLength(1);

    // 503 is what NWS does during exactly the weather this exists for.
    nws.status = 503;
    const result = await job(db, nws)(record);
    expect(result.status).toBe('failed');
    // Rule nine: backing off costs freshness, never the warning already shown.
    expect(alertSignals(db, Date.now())).toHaveLength(1);
    db.close();
  });

  it('reports a 429 as a failure so the scheduler backs off', async () => {
    const db = database();
    const nws = await fakeNws();
    nws.status = 429;
    const result = await job(db, nws)(record);
    expect(result.status).toBe('failed');
    db.close();
  });

  it('drops an alert the zone stops listing', async () => {
    const db = database();
    const nws = await fakeNws();
    await job(db, nws)(record);
    expect(alertSignals(db, Date.now())).toHaveLength(1);

    nws.etag = '"v2"';
    nws.body = () => collection([]);
    await job(db, nws)(record);
    expect(alertSignals(db, Date.now())).toEqual([]);
    db.close();
  });

  it('drives the shipped rules end to end', async () => {
    const db = database();
    const nws = await fakeNws();
    await job(db, nws)(record);

    const { active } = evaluateInterrupts({
      rules: readRules(db),
      signals: alertSignals(db, Date.now()) as Signal[],
      now: Date.now(),
      localHhmm: '14:00',
    });

    // An Extreme tornado warning, all the way from a socket to the wall.
    expect(active[0]).toMatchObject({
      source: 'nws',
      title: 'Tornado Warning',
      action: 'takeover_and_wake',
      wakeScreen: true,
      piercesNightMode: true,
      dismissible: false,
    });
    expect(active[0]?.headline).toContain('TAKE COVER NOW');
    db.close();
  });

  it('does nothing at all when the household turned alerts off', async () => {
    const db = database();
    db.prepare(`UPDATE household_settings SET alerts_enabled = 0`).run();
    const nws = await fakeNws();
    const result = await job(db, nws)(record);
    expect(result.status).toBe('skipped');
    expect(nws.paths).toEqual([]);
    db.close();
  });
});
