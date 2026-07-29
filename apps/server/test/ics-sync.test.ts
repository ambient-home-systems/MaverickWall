import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchOutcome, FetchRequest, Fetcher, JobRecord } from '@maverick-wall/core';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createKeyring, loadOrCreateMasterKey } from '../src/secrets/keyring.js';
import { createIcsSyncHandler, toEventRow } from '../src/jobs/ics-sync.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TZ = 'America/New_York';
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'BEGIN:VEVENT',
  'UID:one@test',
  'SUMMARY:Dentist',
  `DTSTART;TZID=America/New_York:${stamp(2)}T090000`,
  `DTEND;TZID=America/New_York:${stamp(2)}T100000`,
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:two@test',
  'SUMMARY:Bin day',
  `DTSTART;VALUE=DATE:${stamp(3)}`,
  `DTEND;VALUE=DATE:${stamp(4)}`,
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** A date inside the sync window, as YYYYMMDD. */
function stamp(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function stubFetcher(outcomes: FetchOutcome[]): Fetcher & { seen: FetchRequest[] } {
  const seen: FetchRequest[] = [];
  return {
    seen,
    async fetch(request: FetchRequest): Promise<FetchOutcome> {
      seen.push(request);
      return outcomes[Math.min(seen.length - 1, outcomes.length - 1)]!;
    },
  };
}

function ok(body: string, etag?: string): FetchOutcome {
  return {
    status: 'ok',
    body,
    contentType: 'text/calendar',
    finalUrl: 'https://example.com/cal.ics',
    byteSize: body.length,
    ...(etag ? { etag } : {}),
  };
}

function harness(outcomes: FetchOutcome[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ics-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const keyring = createKeyring(loadOrCreateMasterKey(dataDir).key);
  const sealed = keyring.encrypt('https://example.com/cal.ics', 'calendar-source-url');
  db.prepare(
    `INSERT INTO calendar_sources (id, name, url_encrypted, created_at, updated_at)
     VALUES ('src1', 'Family', ?, 0, 0)`,
  ).run(sealed);

  const fetcher = stubFetcher(outcomes);
  const handler = createIcsSyncHandler({ db, fetcher, keyring, timezone: () => TZ });
  const job: JobRecord = { key: 'ics-sync:src1', kind: 'ics-sync', nextRunAt: 0, consecutiveFailures: 0 };

  const events = () =>
    db.prepare('SELECT * FROM calendar_events_cache ORDER BY starts_at').all() as Record<string, unknown>[];
  const source = () =>
    db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get('src1') as Record<string, unknown>;

  return { db, keyring, fetcher, handler, job, events, source, dataDir };
}

describe('the row mapping', () => {
  // Pure, so the off-by-one that matters most is tested without a database.
  it('reports the inclusive last day of an all-day event', () => {
    const row = toEventRow(
      {
        uid: 'a',
        title: 'Bin day',
        startUtc: new Date('2026-03-15T04:00:00Z'),
        endUtc: new Date('2026-03-16T04:00:00Z'),
        allDay: true,
        sourceTzid: TZ,
        status: 'CONFIRMED',
        isRecurringInstance: false,
      },
      'src1',
      TZ,
    );
    // Using endUtc directly here would put every all-day event on one day too
    // many, which is the single most common ICS bug.
    expect(row.startLocalDate).toBe('2026-03-15');
    expect(row.endLocalDate).toBe('2026-03-15');
  });

  it('never steps the end date before the start', () => {
    const row = toEventRow(
      {
        uid: 'a',
        title: 'Instant',
        startUtc: new Date('2026-06-15T13:00:00Z'),
        endUtc: new Date('2026-06-15T13:00:00Z'),
        allDay: false,
        sourceTzid: TZ,
        status: 'CONFIRMED',
        isRecurringInstance: false,
      },
      'src1',
      TZ,
    );
    expect(row.endLocalDate).toBe('2026-06-15');
  });
});

describe('a successful sync', () => {
  it('expands the feed into the cache', async () => {
    const { handler, job, events, source } = harness([ok(ICS, '"v1"')]);
    expect(await handler(job)).toEqual({ status: 'ok' });

    const rows = events();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row['title'])).toEqual(['Dentist', 'Bin day']);
    expect(source()['event_count']).toBe(2);
    expect(source()['last_error']).toBe(null);
    expect(source()['consecutive_failures']).toBe(0);
  });

  it('stores the ETag and sends it back next time', async () => {
    const { handler, job, fetcher, source } = harness([
      ok(ICS, '"v1"'),
      { status: 'not-modified', etag: '"v1"' },
    ]);
    await handler(job);
    expect(source()['etag']).toBe('"v1"');

    await handler(job);
    expect(fetcher.seen[1]?.conditional?.etag).toBe('"v1"');
  });

  it('records the host but never the path', async () => {
    // The path carries the credential. Only the host is safe to show.
    const { handler, job, source } = harness([ok(ICS)]);
    await handler(job);
    expect(source()['url_host']).toBe('example.com');
  });

  it('replaces the previous expansion rather than appending', async () => {
    const smaller = ICS.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r\n/, '');
    const { handler, job, events } = harness([ok(ICS), ok(smaller)]);
    await handler(job);
    expect(events()).toHaveLength(2);
    await handler(job);
    expect(events()).toHaveLength(1);
  });
});

describe('an unchanged feed', () => {
  it('costs one round trip and leaves the cache alone', async () => {
    const { handler, job, events } = harness([ok(ICS, '"v1"'), { status: 'not-modified' }]);
    await handler(job);
    const before = events();
    expect(await handler(job)).toEqual({ status: 'ok' });
    expect(events()).toEqual(before);
  });
});

describe('failure keeps the calendar on the wall', () => {
  // Rule nine, decided here. Every path below must leave the previous
  // expansion in place: a wall showing yesterday's events with a warning beats
  // an empty grid.

  it('survives an unreachable feed', async () => {
    const { handler, job, events, source } = harness([
      ok(ICS),
      { status: 'failed', code: 'network-error', message: 'connect ECONNREFUSED' },
    ]);
    await handler(job);
    expect(events()).toHaveLength(2);

    const result = await handler(job);
    expect(result.status).toBe('failed');
    expect(events()).toHaveLength(2);
    expect(source()['consecutive_failures']).toBe(1);
    expect(String(source()['last_error'])).toContain('ECONNREFUSED');
  });

  it('survives a feed that turns into an HTML error page', async () => {
    const { handler, job, events } = harness([
      ok(ICS),
      { status: 'ok', body: '<html>Not found</html>', contentType: 'text/html', finalUrl: 'x', byteSize: 22 },
    ]);
    await handler(job);
    expect((await handler(job)).status).toBe('failed');
    expect(events()).toHaveLength(2);
  });

  it('survives an SSRF rejection', async () => {
    const { handler, job, events } = harness([
      ok(ICS),
      { status: 'rejected', code: 'address-rejected', message: 'resolves to 127.0.0.1' },
    ]);
    await handler(job);
    expect((await handler(job)).status).toBe('failed');
    expect(events()).toHaveLength(2);
  });

  it('passes an upstream Retry-After through to the scheduler', async () => {
    const { handler, job } = harness([
      { status: 'failed', code: 'http-error', message: 'rate limited', httpStatus: 429, retryAfterSeconds: 600 },
    ]);
    const result = await handler(job);
    expect(result.status === 'failed' && result.retryAfterSeconds).toBe(600);
  });

  it('explains a URL that can no longer be decrypted', async () => {
    // The realistic case: a backup restored without /data/.secret. The events
    // already cached stay; only re-entering the address can fix it.
    const { db, handler, job, events } = harness([ok(ICS)]);
    await handler(job);
    expect(events()).toHaveLength(2);

    db.prepare("UPDATE calendar_sources SET url_encrypted = 'mw1.corrupted' WHERE id = 'src1'").run();
    const result = await handler(job);
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('entering again');
    expect(events()).toHaveLength(2);
  });
});

describe('sources that should not sync', () => {
  it('skips a disabled source', async () => {
    const { db, handler, job, fetcher } = harness([ok(ICS)]);
    db.prepare("UPDATE calendar_sources SET enabled = 0 WHERE id = 'src1'").run();
    expect((await handler(job)).status).toBe('skipped');
    expect(fetcher.seen).toHaveLength(0);
  });

  it('skips a job whose source was deleted', async () => {
    const { db, handler, job } = harness([ok(ICS)]);
    db.prepare("DELETE FROM calendar_sources WHERE id = 'src1'").run();
    expect((await handler(job)).status).toBe('skipped');
  });
});
